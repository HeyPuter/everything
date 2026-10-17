/**
 * Database pages: views (table, board, list, gallery, calendar), filters,
 * sorts, search, and editing properties and values. Each row is a page;
 * opening it shows its properties above its own content (RowProperties).
 */
import { h, debounce, announce, fill } from '../lib/dom.js';
import { icon, pageIcon } from '../lib/icons.js';
import { COLORS, safeUrl } from '../lib/sanitize.js';
import * as D from '../data/database.js';
import { getPage, updatePage, displayTitle } from '../data/tree.js';
import { openMenu } from './menu.js';
import { Popover } from './popover.js';
import { prefs, setPref } from './prefs.js';
import { promptDialog, confirmDialog } from './dialog.js';

const capital = (s) => s[0].toUpperCase() + s.slice(1);

/* ---------- values ---------- */

export function tag(option) {
  return h('span.tag', { 'data-c': option?.color || 'gray' }, option?.name || '');
}

/** Read-only display of a value. */
export function valueView(prop, value) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return h('span.cell-empty');
  switch (prop.type) {
    case 'select':
    case 'status':
      return tag(D.optionOf(prop, value));
    case 'multi':
      return h('span.tags', ...(Array.isArray(value) ? value : []).map((v) => D.optionOf(prop, v)).filter(Boolean).map(tag));
    case 'checkbox':
      return h('span.check-view', { 'data-on': String(!!value) }, value ? icon('check', 12, { stroke: 3 }) : null);
    case 'url': {
      const url = safeUrl(value);
      return url ? h('a.cell-link', { href: url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, String(value).replace(/^https?:\/\//, '')) : h('span', String(value));
    }
    case 'email':
      return h('a.cell-link', { href: `mailto:${value}`, onclick: (e) => e.stopPropagation() }, String(value));
    default:
      return h('span.cell-text', D.formatValue(prop, value));
  }
}

/**
 * An editor for one value. ctx: { doc, space, rowId, page, readOnly, onOpen }.
 * Returns an element; changes save themselves.
 */
export function valueEditor(prop, value, ctx) {
  const { doc, rowId, readOnly } = ctx;
  const set = (v) => D.setValue(doc, rowId, prop.id, v);
  if (prop.type === 'title') {
    const input = h('input.cell-input.title-input', { type: 'text', value: ctx.page?.title || '', placeholder: 'Untitled', 'aria-label': prop.name, readOnly });
    const save = debounce(() => updatePage(ctx.space.tree, rowId, { title: input.value.trim().slice(0, 300) }, ctx.by), 300);
    input.addEventListener('input', save);
    input.addEventListener('blur', () => save.flush());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        save.flush();
        if (!readOnly) ctx.onEnter?.();
      }
    });
    const open = h('button.cell-open', { type: 'button', 'aria-label': `Open ${ctx.page?.title || 'Untitled'}`, onclick: () => ctx.onOpen?.() }, icon('arrowUpRight', 13), h('span', 'Open'));
    return h('div.title-cell', ctx.page ? pageIcon(ctx.page, 16) : null, input, open);
  }
  if (readOnly || prop.type === 'created' || prop.type === 'edited') return h('div.cell-ro', valueView(prop, value));
  switch (prop.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone': {
      const input = h('input.cell-input', { type: prop.type === 'url' ? 'url' : prop.type === 'email' ? 'email' : prop.type === 'phone' ? 'tel' : 'text', value: value ?? '', 'aria-label': prop.name, placeholder: prop.type === 'text' ? '' : 'Empty' });
      const save = debounce(() => set(input.value.slice(0, 2000)), 400);
      input.addEventListener('input', save);
      input.addEventListener('blur', () => save.flush());
      const wrap = h('div.cell-edit', input);
      if (prop.type === 'url' && value && safeUrl(value)) wrap.append(h('a.cell-go', { href: safeUrl(value), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open link' }, icon('externalLink', 13)));
      return wrap;
    }
    case 'number': {
      const input = h('input.cell-input.num', { type: 'number', step: 'any', value: value ?? '', 'aria-label': prop.name });
      input.addEventListener('change', () => set(input.value === '' ? null : Number(input.value)));
      return h('div.cell-edit', input);
    }
    case 'date': {
      const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const day = valid(String(value || '').slice(0, 10)) ? String(value).slice(0, 10) : '';
      // A four-digit year: without max, Chrome lets the year run to six digits.
      const input = h(`input.cell-input.date${day ? '' : '.empty'}`, { type: 'date', value: day, min: '1000-01-01', max: '9999-12-31', 'aria-label': prop.name });
      input.addEventListener('change', () => {
        const v = valid(input.value) ? input.value : null;
        if (input.value && !v) return;
        input.classList.toggle('empty', !v);
        set(v);
      });
      return h('div.cell-edit', input);
    }
    case 'checkbox': {
      const input = h('input.cell-check', { type: 'checkbox', checked: !!value, 'aria-label': prop.name });
      input.addEventListener('change', () => set(input.checked));
      return h('div.cell-edit.center', input);
    }
    case 'select':
    case 'status':
    case 'multi': {
      const btn = h('button.cell-select', { type: 'button', 'aria-label': `${prop.name}: ${D.valueText(prop, value) || 'empty'}`, 'aria-haspopup': 'dialog', 'data-fkey': `cell-${rowId}-${prop.id}` }, valueView(prop, value));
      btn.addEventListener('click', () => openOptionPicker(btn, doc, prop.id, rowId));
      return btn;
    }
    default:
      return h('div.cell-ro', valueView(prop, value));
  }
}

/** Choose (or create) options for a select, status or multi-select value. */
export function openOptionPicker(anchor, doc, propId, rowId) {
  const list = h('div.option-list', { role: 'listbox', 'aria-label': 'Options' });
  const input = h('input.field.picker-search', { type: 'text', placeholder: 'Search or create an option', 'aria-label': 'Search or create an option', autocomplete: 'off' });
  const render = () => {
    const prop = D.getProp(doc, propId);
    if (!prop) return pop.close();
    const row = D.listRows(doc).find((r) => r.id === rowId);
    const value = row?.values[propId];
    const chosen = new Set(prop.type === 'multi' ? value || [] : value ? [value] : []);
    const q = input.value.trim().toLowerCase();
    const opts = (prop.options || []).filter((o) => !q || o.name.toLowerCase().includes(q));
    const items = opts.map((o) => {
      const b = h('button.option', { type: 'button', role: 'option', 'aria-selected': String(chosen.has(o.id)) }, tag(o), chosen.has(o.id) ? icon('check', 14, { cls: 'option-check' }) : null);
      b.addEventListener('click', () => toggle(o.id));
      const edit = h('button.icon-btn.option-edit', { type: 'button', 'aria-label': `Edit ${o.name}`, onclick: (e) => {
          e.stopPropagation();
          editOption(e.currentTarget, doc, propId, o.id, render);
        } }, icon('more', 14));
      return h('div.option-row', b, edit);
    });
    if (q && !(prop.options || []).some((o) => o.name.toLowerCase() === q)) {
      const b = h('button.option.create', { type: 'button' }, h('span', 'Create'), tag({ name: input.value.trim(), color: COLORS[(prop.options || []).length % COLORS.length] }));
      b.addEventListener('click', () => {
        const id = D.ensureOption(doc, propId, input.value);
        input.value = '';
        toggle(id);
      });
      items.push(b);
    }
    if (chosen.size) items.push(h('button.option.clear', { type: 'button', onclick: () => {
        D.setValue(doc, rowId, propId, null);
        render();
      } }, icon('x', 14), 'Clear'));
    list.replaceChildren(...items);
    if (!items.length) list.append(h('p.picker-empty', 'No options yet. Type to create one.'));
  };
  const toggle = (id) => {
    const prop = D.getProp(doc, propId);
    const row = D.listRows(doc).find((r) => r.id === rowId);
    if (prop.type === 'multi') {
      const cur = new Set(row?.values[propId] || []);
      cur.has(id) ? cur.delete(id) : cur.add(id);
      D.setValue(doc, rowId, propId, [...cur]);
      render();
      input.focus();
    } else {
      D.setValue(doc, rowId, propId, row?.values[propId] === id ? null : id);
      pop.close();
    }
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      list.querySelector('.option')?.click();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector('.option')?.focus();
    }
  });
  list.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('.option')];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = opts[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
      else if (e.key === 'ArrowUp') input.focus();
    }
  });
  const pop = new Popover({ anchor, content: h('div.option-picker', input, list), className: 'picker-pop', label: 'Options' });
  render();
  input.focus();
  return pop;
}

function editOption(anchor, doc, propId, optionId, after) {
  const prop = D.getProp(doc, propId);
  const option = prop.options.find((o) => o.id === optionId);
  const save = (patch) => {
    const p = D.getProp(doc, propId);
    D.updateProp(doc, propId, { options: p.options.map((o) => (o.id === optionId ? { ...o, ...patch } : o)) });
    after();
  };
  openMenu(anchor, [
    { label: 'Rename', icon: 'pencil', run: async () => {
        const name = await promptDialog({ title: 'Rename option', label: 'Name', value: option.name });
        if (name) save({ name: name.slice(0, 100) });
      } },
    { label: 'Color', icon: 'palette', submenu: () => COLORS.map((c) => ({ label: capital(c), icon: h('span.swatch.bg', { 'data-c': c }), checked: option.color === c, run: () => save({ color: c }) })) },
    { type: 'sep' },
    { label: 'Delete option', icon: 'trash', danger: true, run: () => {
        const p = D.getProp(doc, propId);
        D.updateProp(doc, propId, { options: p.options.filter((o) => o.id !== optionId) });
        for (const r of D.listRows(doc)) {
          const v = r.values[propId];
          if (v === optionId) D.setValue(doc, r.id, propId, null);
          else if (Array.isArray(v) && v.includes(optionId)) D.setValue(doc, r.id, propId, v.filter((x) => x !== optionId));
        }
        after();
      } },
  ], { label: option.name });
}

/* ---------- the database view ---------- */

export class DatabaseView {
  constructor(app, space, dbId, doc, { readOnly = false } = {}) {
    this.app = app;
    this.ws = app.ws;
    this.space = space;
    this.dbId = dbId;
    this.doc = doc;
    this.readOnly = readOnly;
    this.search = '';
    this.month = null;
    this.el = h('section.database', { 'aria-label': 'Database' });
    this.onChange = () => this.renderSoon();
    doc.getMap('db').observeDeep(this.onChange);
    space.tree.getMap('pages').observeDeep(this.onChange);
    this.el.addEventListener('focusout', (e) => {
      if (this.deferred && !this.el.contains(e.relatedTarget)) {
        this.deferred = false;
        this.renderSoon();
      }
    });
  }

  destroy() {
    this.destroyed = true;
    this.doc.getMap('db').unobserveDeep(this.onChange);
    this.space.tree.getMap('pages').unobserveDeep(this.onChange);
  }

  setReadOnly(ro) {
    this.readOnly = ro;
    this.render();
  }

  focus() {
    this.el.querySelector('.view-tab[aria-selected="true"]')?.focus();
  }

  renderSoon() {
    if (this.queued || this.destroyed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.destroyed) return;
      // Editing a value keeps its field; the view catches up afterwards.
      if (this.el.contains(document.activeElement) && document.activeElement.matches('input, [contenteditable="true"]')) {
        this.deferred = true;
        return;
      }
      this.render();
    });
  }

  get views() {
    return D.listViews(this.doc);
  }

  get view() {
    const views = this.views;
    const saved = prefs().dbViews?.[this.dbId];
    return views.find((v) => v.id === saved) || views[0] || null;
  }

  setView(id) {
    const inTabs = !!document.activeElement?.closest?.('.view-tabs');
    setPref('dbViews', { ...(prefs().dbViews || {}), [this.dbId]: id });
    this.render();
    if (inTabs) this.el.querySelector(`[data-fkey="tab-${CSS.escape(id)}"]`)?.focus();
  }

  pageOf = (id) => getPage(this.space.tree, id);

  rows() {
    return D.queryRows(this.doc, this.view, this.pageOf, { search: this.search });
  }

  visibleProps(view = this.view) {
    const hidden = new Set(view?.hidden || []);
    return D.listProps(this.doc).filter((p) => !hidden.has(p.id));
  }

  render() {
    if (!D.isDatabase(this.doc)) {
      // In a shared space the creator sets the database up; its document can
      // arrive after the page itself, so wait instead of creating a rival one.
      if (this.readOnly || this.space.kind === 'shared') {
        this.el.replaceChildren(h('p.db-empty', this.space.kind === 'shared' ? 'Loading this database...' : 'This database is empty.'));
        return;
      }
      D.initDatabase(this.doc);
      return;
    }
    const view = this.view;
    const focusKey = document.activeElement?.closest?.('[data-fkey]')?.dataset.fkey;
    // TODO: add virtualization. Every view builds a DOM node per row and
    // rebuilds them all on each change, which gets slow past a few thousand rows.
    this.el.replaceChildren(this.tabs(view), this.toolbar(view), this.chips(view), this.body(view));
    if (focusKey) this.el.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  tabs(current) {
    const list = h('div.view-tabs', { role: 'tablist', 'aria-label': 'Views' });
    for (const v of this.views) {
      const selected = v.id === current?.id;
      const tab = h('button.view-tab', { type: 'button', role: 'tab', 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', 'data-fkey': `tab-${v.id}` }, icon(D.VIEW_TYPES[v.type]?.icon || 'table', 15), h('span', v.name));
      tab.addEventListener('click', () => (selected && !this.readOnly ? this.viewMenu(tab, v) : this.setView(v.id)));
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.readOnly) this.viewMenu(tab, v);
      });
      list.append(tab);
    }
    list.addEventListener('keydown', (e) => {
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.click();
      }
    });
    const add = this.readOnly ? null : h('button.icon-btn.view-add', { type: 'button', 'aria-label': 'Add a view', 'data-tip': 'Add a view' }, icon('plus', 16));
    add?.addEventListener('click', () =>
      openMenu(add, Object.entries(D.VIEW_TYPES).map(([type, v]) => ({ label: v.label, icon: v.icon, run: () => this.setView(D.addView(this.doc, { type })) })), { label: 'Add a view' }),
    );
    return h('div.db-tabs-row', list, add);
  }

  toolbar(view) {
    const search = h('input.db-search', { type: 'search', placeholder: 'Search', value: this.search, 'aria-label': 'Search this database', 'data-fkey': 'search' });
    search.addEventListener('input', debounce(() => {
      this.search = search.value;
      this.render();
    }, 200));
    const filterBtn = h('button.btn.small.ghost', { type: 'button', 'aria-haspopup': 'dialog', 'data-fkey': 'filter', hidden: this.readOnly }, icon('filter', 15), 'Filter');
    filterBtn.addEventListener('click', () => this.openFilters(filterBtn));
    const sortBtn = h('button.btn.small.ghost', { type: 'button', 'aria-haspopup': 'dialog', 'data-fkey': 'sort', hidden: this.readOnly }, icon('arrowUpDown', 15), 'Sort');
    sortBtn.addEventListener('click', () => this.openSorts(sortBtn));
    const propsBtn = h('button.btn.small.ghost', { type: 'button', 'aria-haspopup': 'menu', 'data-fkey': 'props' }, icon('columns', 15), 'Properties');
    propsBtn.addEventListener('click', () => this.propertiesMenu(propsBtn));
    const newBtn = this.readOnly ? null : h('button.btn.small.primary', { type: 'button', 'data-fkey': 'new' }, icon('plus', 15), 'New');
    newBtn?.addEventListener('click', () => this.addRow({ open: view?.type !== 'table' }));
    return h('div.db-toolbar', h('div.db-toolbar-left', search), h('div.db-toolbar-right', filterBtn, sortBtn, propsBtn, newBtn));
  }

  chips(view) {
    const props = new Map(D.listProps(this.doc).map((p) => [p.id, p]));
    const chips = [];
    for (const s of view?.sorts || []) {
      const p = props.get(s.prop);
      if (p) chips.push(h('button.chip', { type: 'button', onclick: (e) => this.openSorts(e.currentTarget) }, icon(s.dir === 'desc' ? 'arrowDown' : 'arrowUp', 13), `${p.name}`));
    }
    for (const f of view?.filters || []) {
      const p = props.get(f.prop);
      if (!p) continue;
      const val = ['empty', 'not_empty', 'checked', 'unchecked'].includes(f.op) ? '' : ['select', 'status', 'multi'].includes(p.type) ? D.optionOf(p, f.value)?.name || '' : f.value || '';
      chips.push(h('button.chip', { type: 'button', onclick: (e) => this.openFilters(e.currentTarget) }, icon('filter', 13), `${p.name} ${D.FILTER_LABELS[f.op] || ''} ${val}`.trim()));
    }
    return chips.length ? h('div.db-chips', ...chips) : h('div.db-chips.empty');
  }

  body(view) {
    if (!view) return h('p.db-empty', 'No views.');
    const rows = this.rows();
    switch (view.type) {
      case 'board':
        return this.board(view, rows);
      case 'list':
        return this.list(view, rows);
      case 'gallery':
        return this.gallery(view, rows);
      case 'calendar':
        return this.calendar(view, rows);
      default:
        return this.table(view, rows);
    }
  }

  cellCtx(row) {
    return {
      doc: this.doc,
      space: this.space,
      rowId: row.id,
      page: row.page,
      readOnly: this.readOnly,
      by: this.ws.by,
      onOpen: () => this.app.open(this.space, row.id),
    };
  }

  async addRow({ values = {}, open = false, after = null, focus = true } = {}) {
    const defaults = D.defaultsFor(this.doc, this.view);
    const id = await this.ws.addRow(this.space, this.dbId, { values: { ...defaults, ...values }, after });
    announce('Row added');
    if (open) this.app.open(this.space, id, { focusTitle: true });
    else if (focus) {
      this.render();
      this.el.querySelector(`[data-row="${id}"] .title-input`)?.focus();
    }
    return id;
  }

  /* table */
  table(view, rows) {
    const props = this.visibleProps(view);
    const widths = view.widths || {};
    const head = h(
      'tr',
      ...props.map((p) => {
        const th = h('th', { scope: 'col', style: { width: `${widths[p.id] || (p.type === 'title' ? 260 : 170)}px` } });
        const btn = h('button.col-head', { type: 'button', 'data-fkey': `col-${p.id}`, 'aria-haspopup': 'menu', disabled: this.readOnly }, icon(D.PROP_TYPES[p.type]?.icon || 'text', 14), h('span', p.name));
        btn.addEventListener('click', () => this.propMenu(btn, p));
        th.append(btn);
        if (!this.readOnly) {
          const grip = h('span.col-resize', { 'aria-hidden': 'true' });
          grip.addEventListener('pointerdown', (e) => this.resizeColumn(e, th, p.id));
          th.append(grip);
        }
        return th;
      }),
      this.readOnly ? null : h('th.add-col', h('button.icon-btn', { type: 'button', 'aria-label': 'Add a property', 'data-tip': 'Add a property', onclick: (e) => this.addPropMenu(e.currentTarget) }, icon('plus', 16))),
    );
    const body = h(
      'tbody',
      ...rows.map((r) =>
        h(
          'tr',
          { 'data-row': r.id },
          ...props.map((p) => {
            const ctx = { ...this.cellCtx(r), onEnter: this.readOnly ? null : () => this.addRow({ after: r.id }) };
            return h(`td.cell-${p.type}`, valueEditor(p, D.cellValue(r, p, r.page), ctx));
          }),
          this.readOnly ? null : h('td.row-menu-cell', h('button.icon-btn.row-menu', { type: 'button', 'aria-label': `Options for ${displayTitle(r.page)}`, onclick: (e) => this.rowMenu(e.currentTarget, r) }, icon('more', 15))),
        ),
      ),
    );
    const table = h('table.db-table', { 'aria-label': view.name }, h('thead', head), body);
    const foot = this.readOnly ? null : h('button.db-new-row', { type: 'button', onclick: () => this.addRow() }, icon('plus', 15), 'New');
    const count = h('div.db-count', `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`);
    return h('div.db-view.table-view', h('div.db-table-scroll', table), foot, count, rows.length || this.readOnly ? null : null);
  }

  resizeColumn(e, th, propId) {
    e.preventDefault();
    const start = e.clientX;
    const w0 = th.getBoundingClientRect().width;
    let w = w0;
    const move = (ev) => {
      w = Math.max(80, Math.min(600, w0 + ev.clientX - start));
      th.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const view = this.view;
      D.updateView(this.doc, view.id, { widths: { ...(view.widths || {}), [propId]: Math.round(w) } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  rowMenu(anchor, r) {
    openMenu(anchor, [
      { label: 'Open', icon: 'arrowUpRight', run: () => this.app.open(this.space, r.id) },
      { label: 'Insert below', icon: 'plus', run: () => this.addRow({ after: r.id }) },
      { label: 'Copy link', icon: 'link', run: () => this.app.copyLink(this.space, r.id) },
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, run: () => this.app.trashPage(this.space, r.id) },
    ], { label: 'Row actions' });
  }

  addPropMenu(anchor, after = null) {
    openMenu(
      anchor,
      Object.entries(D.PROP_TYPES)
        .filter(([t]) => t !== 'title')
        .map(([type, v]) => ({
          label: v.label,
          icon: v.icon,
          run: () => {
            D.addProp(this.doc, { type, after });
            announce(`${v.label} property added`);
          },
        })),
      { label: 'Property type', filter: true, filterPlaceholder: 'Search types' },
    );
  }

  propMenu(anchor, p) {
    const view = this.view;
    const items = [
      { label: 'Rename', icon: 'pencil', run: async () => {
          const name = await promptDialog({ title: 'Rename property', label: 'Name', value: p.name });
          if (name) D.updateProp(this.doc, p.id, { name: name.slice(0, 100) });
        } },
    ];
    if (p.type !== 'title') {
      items.push({
        label: 'Type',
        icon: D.PROP_TYPES[p.type]?.icon || 'text',
        submenu: () => Object.entries(D.PROP_TYPES).filter(([t]) => t !== 'title').map(([type, v]) => ({ label: v.label, icon: v.icon, checked: p.type === type, radio: true, run: () => D.updateProp(this.doc, p.id, { type }) })),
      });
    }
    if (['select', 'multi', 'status'].includes(p.type)) items.push({ label: 'Edit options', icon: 'tags', run: () => this.editOptions(anchor, p.id) });
    items.push(
      { type: 'sep' },
      { label: 'Sort ascending', icon: 'arrowUp', run: () => D.updateView(this.doc, view.id, { sorts: [{ prop: p.id, dir: 'asc' }] }) },
      { label: 'Sort descending', icon: 'arrowDown', run: () => D.updateView(this.doc, view.id, { sorts: [{ prop: p.id, dir: 'desc' }] }) },
      { label: 'Filter', icon: 'filter', run: () => {
          D.updateView(this.doc, view.id, { filters: [...(view.filters || []), { prop: p.id, op: D.FILTER_OPS[D.filterKind(p.type)][0], value: '' }] });
          queueMicrotask(() => this.openFilters(this.el.querySelector('[data-fkey="filter"]')));
        } },
    );
    if (p.type !== 'title') {
      items.push(
        { label: 'Hide in view', icon: 'eyeOff', run: () => D.updateView(this.doc, view.id, { hidden: [...new Set([...(view.hidden || []), p.id])] }) },
        { label: 'Insert property right', icon: 'arrowRight', run: () => this.addPropMenu(anchor, p.id) },
        { type: 'sep' },
        { label: 'Delete property', icon: 'trash', danger: true, run: async () => {
            if (await confirmDialog({ title: `Delete ${p.name}?`, message: 'Its values in every row are removed too.', confirm: 'Delete', danger: true })) D.deleteProp(this.doc, p.id);
          } },
      );
    }
    openMenu(anchor, items, { label: p.name });
  }

  editOptions(anchor, propId) {
    const render = () => {
      const p = D.getProp(this.doc, propId);
      fill(body,
        ...(p.options || []).map((o) =>
          h('div.option-row', tag(o), h('button.icon-btn.option-edit', { type: 'button', 'aria-label': `Edit ${o.name}`, onclick: (e) => editOption(e.currentTarget, this.doc, propId, o.id, render) }, icon('more', 14))),
        ),
        form,
      );
    };
    const input = h('input.field', { type: 'text', placeholder: 'New option', 'aria-label': 'New option' });
    const form = h('form.option-add', input, h('button.btn.small', { type: 'submit' }, 'Add'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) D.ensureOption(this.doc, propId, input.value);
      input.value = '';
      render();
      input.focus();
    });
    const body = h('div.option-editor');
    new Popover({ anchor, content: h('div.option-picker', h('p.picker-label', 'Options'), body), className: 'picker-pop', label: 'Edit options' });
    render();
    input.focus();
  }

  propertiesMenu(anchor) {
    const view = this.view;
    openMenu(
      anchor,
      [
        { type: 'header', label: 'Shown in this view' },
        ...D.listProps(this.doc).map((p) => ({
          label: p.name,
          icon: D.PROP_TYPES[p.type]?.icon,
          checked: !(view.hidden || []).includes(p.id),
          disabled: p.type === 'title' || this.readOnly,
          keep: true,
          run: () => {
            const v = this.view;
            const hidden = new Set(v.hidden || []);
            hidden.has(p.id) ? hidden.delete(p.id) : hidden.add(p.id);
            D.updateView(this.doc, v.id, { hidden: [...hidden] });
          },
        })),
        ...(this.readOnly ? [] : [{ type: 'sep' }, { label: 'New property', icon: 'plus', run: () => this.addPropMenu(anchor) }]),
      ],
      { label: 'Properties' },
    );
  }

  viewMenu(anchor, v) {
    const props = D.listProps(this.doc);
    const items = [
      { label: 'Rename', icon: 'pencil', run: async () => {
          const name = await promptDialog({ title: 'Rename view', label: 'Name', value: v.name });
          if (name) D.updateView(this.doc, v.id, { name: name.slice(0, 80) });
        } },
      { label: 'Layout', icon: D.VIEW_TYPES[v.type]?.icon, submenu: () => Object.entries(D.VIEW_TYPES).map(([type, x]) => ({ label: x.label, icon: x.icon, checked: v.type === type, radio: true, run: () => {
            const patch = { type };
            if (type === 'board' && !v.groupBy) patch.groupBy = props.find((p) => ['status', 'select'].includes(p.type))?.id || null;
            if (type === 'calendar' && !v.dateProp) patch.dateProp = props.find((p) => p.type === 'date')?.id || null;
            D.updateView(this.doc, v.id, patch);
          } })) },
    ];
    if (v.type === 'board') {
      items.push({ label: 'Group by', icon: 'columns', submenu: () => props.filter((p) => ['select', 'status', 'multi', 'checkbox'].includes(p.type)).map((p) => ({ label: p.name, checked: v.groupBy === p.id, radio: true, run: () => D.updateView(this.doc, v.id, { groupBy: p.id }) })) });
    }
    if (v.type === 'calendar') {
      items.push({ label: 'Show by', icon: 'calendar', submenu: () => props.filter((p) => ['date', 'created', 'edited'].includes(p.type)).map((p) => ({ label: p.name, checked: v.dateProp === p.id, radio: true, run: () => D.updateView(this.doc, v.id, { dateProp: p.id }) })) });
    }
    items.push({ type: 'sep' }, { label: 'Delete view', icon: 'trash', danger: true, disabled: this.views.length <= 1, run: () => D.deleteView(this.doc, v.id) && this.render() });
    openMenu(anchor, items, { label: v.name });
  }

  /* filters and sorts */
  openFilters(anchor) {
    if (this.readOnly) return this.app.toast('Only people who can edit this database can change its filters.');
    const body = h('div.filter-editor');
    const render = () => {
      const view = this.view;
      const props = D.listProps(this.doc);
      const filters = view.filters || [];
      // Handlers read the current filters, not the ones drawn last.
      const now = () => this.view?.filters || [];
      const save = (next) => D.updateView(this.doc, view.id, { filters: next });
      fill(body,
        ...filters.map((f, i) => {
          const prop = props.find((p) => p.id === f.prop) || props[0];
          const kind = D.filterKind(prop.type);
          const propSel = h('select.field.small', { 'aria-label': 'Property' }, ...props.map((p) => h('option', { value: p.id, selected: p.id === prop.id }, p.name)));
          propSel.addEventListener('change', () => {
            const np = props.find((p) => p.id === propSel.value);
            save(now().map((x, j) => (j === i ? { prop: np.id, op: D.FILTER_OPS[D.filterKind(np.type)][0], value: '' } : x)));
            render();
          });
          const opSel = h('select.field.small', { 'aria-label': 'Condition' }, ...D.FILTER_OPS[kind].map((op) => h('option', { value: op, selected: op === f.op }, D.FILTER_LABELS[op])));
          opSel.addEventListener('change', () => {
            save(now().map((x, j) => (j === i ? { ...x, op: opSel.value } : x)));
            render();
          });
          let valueEl = null;
          if (!['empty', 'not_empty', 'checked', 'unchecked'].includes(f.op)) {
            if (kind === 'select' || kind === 'multi') {
              valueEl = h('select.field.small', { 'aria-label': 'Value' }, h('option', { value: '' }, 'Any'), ...(prop.options || []).map((o) => h('option', { value: o.id, selected: o.id === f.value }, o.name)));
              valueEl.addEventListener('change', () => save(now().map((x, j) => (j === i ? { ...x, value: valueEl.value } : x))));
            } else {
              valueEl = h('input.field.small', { type: kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text', value: f.value ?? '', 'aria-label': 'Value', placeholder: 'Value' });
              valueEl.addEventListener('input', debounce(() => save(now().map((x, j) => (j === i ? { ...x, value: valueEl.value } : x))), 300));
            }
          }
          const remove = h('button.icon-btn', { type: 'button', 'aria-label': 'Remove filter', onclick: () => {
              save(now().filter((_, j) => j !== i));
              render();
            } }, icon('x', 15));
          return h('div.filter-row', propSel, opSel, valueEl, remove);
        }),
        filters.length ? null : h('p.picker-empty', 'No filters. Show only rows that match conditions you add here.'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => {
            const p = props[0];
            save([...now(), { prop: p.id, op: D.FILTER_OPS[D.filterKind(p.type)][0], value: '' }]);
            render();
            body.querySelector('.filter-row:last-of-type select')?.focus();
          } }, icon('plus', 15), 'Add a filter'),
      );
    };
    new Popover({ anchor, content: h('div.filter-pop', h('p.picker-label', 'Filters'), body), className: 'picker-pop wide', label: 'Filters' });
    render();
    (body.querySelector('select, input, button') || body).focus();
  }

  openSorts(anchor) {
    if (this.readOnly) return this.app.toast('Only people who can edit this database can change its sorts.');
    const body = h('div.filter-editor');
    const render = () => {
      const view = this.view;
      const props = D.listProps(this.doc);
      const sorts = view.sorts || [];
      const now = () => this.view?.sorts || [];
      const save = (next) => D.updateView(this.doc, view.id, { sorts: next });
      fill(body,
        ...sorts.map((s, i) => {
          const propSel = h('select.field.small', { 'aria-label': 'Property' }, ...props.map((p) => h('option', { value: p.id, selected: p.id === s.prop }, p.name)));
          propSel.addEventListener('change', () => save(now().map((x, j) => (j === i ? { ...x, prop: propSel.value } : x))));
          const dirSel = h('select.field.small', { 'aria-label': 'Direction' }, h('option', { value: 'asc', selected: s.dir !== 'desc' }, 'Ascending'), h('option', { value: 'desc', selected: s.dir === 'desc' }, 'Descending'));
          dirSel.addEventListener('change', () => save(now().map((x, j) => (j === i ? { ...x, dir: dirSel.value } : x))));
          return h('div.filter-row', propSel, dirSel, h('button.icon-btn', { type: 'button', 'aria-label': 'Remove sort', onclick: () => {
              save(now().filter((_, j) => j !== i));
              render();
            } }, icon('x', 15)));
        }),
        sorts.length ? null : h('p.picker-empty', 'No sorts. Rows keep the order they were added in.'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => {
            save([...now(), { prop: props[0].id, dir: 'asc' }]);
            render();
          } }, icon('plus', 15), 'Add a sort'),
      );
    };
    new Popover({ anchor, content: h('div.filter-pop', h('p.picker-label', 'Sorts'), body), className: 'picker-pop wide', label: 'Sorts' });
    render();
    (body.querySelector('select, button') || body).focus();
  }

  /* board */
  board(view, rows) {
    const props = D.listProps(this.doc);
    const groupProp = props.find((p) => p.id === view.groupBy);
    if (!groupProp) {
      return h('div.db-view.db-empty-state', icon('kanban', 22), h('p', 'Boards group rows by a Select, Status or Checkbox property.'), this.readOnly ? null : h('button.btn.small', { type: 'button', onclick: () => {
          const id = D.addProp(this.doc, { name: 'Status', type: 'status' });
          D.updateView(this.doc, view.id, { groupBy: id });
        } }, icon('plus', 15), 'Add a Status property'));
    }
    const shown = this.visibleProps(view).filter((p) => p.type !== 'title' && p.id !== groupProp.id);
    const groups = D.groupRows(rows, groupProp).filter((g) => g.id !== null || g.rows.length || groupProp.type === 'checkbox');
    const board = h('div.board', { role: 'list', 'aria-label': view.name });
    for (const g of groups) {
      const col = h('div.board-col', { role: 'listitem', 'aria-label': `${g.name}, ${g.rows.length} ${g.rows.length === 1 ? 'card' : 'cards'}`, 'data-group': g.id === null ? '' : String(g.id) });
      col.append(h('header.board-head', tag({ name: g.name, color: g.color }), h('span.board-count', String(g.rows.length))));
      const cards = h('div.board-cards');
      for (const r of g.rows) cards.append(this.card(r, shown, { groupProp, group: g }));
      col.append(cards);
      if (!this.readOnly) col.append(h('button.db-new-row.small', { type: 'button', onclick: () => this.addRow({ values: D.defaultsFor(this.doc, view, g.id), open: true }) }, icon('plus', 15), 'New'));
      board.append(col);
    }
    return h('div.db-view.board-view', board);
  }

  card(r, shown, { groupProp = null, group = null, cover = false } = {}) {
    const page = r.page;
    const props = shown
      .map((p) => [p, D.cellValue(r, p, page)])
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && v !== false)
      .map(([p, v]) => h('div.card-prop', { title: p.name }, valueView(p, v)));
    const card = h(
      'div.card',
      { 'data-row': r.id, 'data-fkey': `card-${r.id}` },
      cover ? h('div.card-cover', pageIcon(page, 28)) : null,
      h('button.card-title', { type: 'button', onclick: () => this.app.open(this.space, r.id) }, page?.icon ? pageIcon(page, 15) : null, h('span', displayTitle(page))),
      props.length ? h('div.card-props', ...props) : null,
      this.readOnly ? null : h('button.icon-btn.card-menu', { type: 'button', 'aria-label': `Options for ${displayTitle(page)}`, onclick: (e) => this.cardMenu(e.currentTarget, r, groupProp) }, icon('more', 14)),
    );
    if (groupProp && !this.readOnly) card.addEventListener('pointerdown', (e) => this.dragCard(e, card, r, groupProp));
    return card;
  }

  cardMenu(anchor, r, groupProp) {
    const items = [
      { label: 'Open', icon: 'arrowUpRight', run: () => this.app.open(this.space, r.id) },
      { label: 'Copy link', icon: 'link', run: () => this.app.copyLink(this.space, r.id) },
    ];
    if (groupProp) {
      // The keyboard (and touch) way to move a card between columns.
      const columns = groupProp.type === 'checkbox' ? [{ id: true, name: 'Checked' }, { id: false, name: 'Unchecked' }] : [{ id: null, name: `No ${groupProp.name}` }, ...(groupProp.options || [])];
      const current = groupProp.type === 'multi' ? (r.values[groupProp.id] || [])[0] ?? null : groupProp.type === 'checkbox' ? !!r.values[groupProp.id] : r.values[groupProp.id] ?? null;
      items.push({ label: 'Move to', icon: 'arrowRight', submenu: () => columns.map((o) => ({ label: o.name, checked: current === o.id, radio: true, run: () => {
        D.setValue(this.doc, r.id, groupProp.id, groupProp.type === 'multi' ? (o.id ? [o.id] : null) : o.id);
        announce(`Moved to ${o.name}`);
      } })) });
      const card = this.el.querySelector(`.card[data-row="${CSS.escape(r.id)}"]`);
      const prev = card?.previousElementSibling?.dataset.row;
      const next = card?.nextElementSibling?.dataset.row;
      items.push(
        { label: 'Move up', icon: 'arrowUp', disabled: !prev, run: () => D.moveRow(this.doc, r.id, { before: prev }) },
        { label: 'Move down', icon: 'arrowDown', disabled: !next, run: () => D.moveRow(this.doc, r.id, { after: next }) },
      );
    }
    items.push({ type: 'sep' }, { label: 'Delete', icon: 'trash', danger: true, run: () => this.app.trashPage(this.space, r.id) });
    openMenu(anchor, items, { label: 'Card actions' });
  }

  dragCard(e, card, r, groupProp) {
    if (e.button !== 0 || e.target.closest('.card-menu') || e.pointerType === 'touch') return;
    const sx = e.clientX;
    const sy = e.clientY;
    let ghost = null;
    let target = null;
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!ghost) {
        ghost = card.cloneNode(true);
        ghost.classList.add('card-ghost');
        ghost.style.width = `${card.offsetWidth}px`;
        document.body.append(ghost);
        card.classList.add('dragging');
      }
      ghost.style.transform = `translate(${ev.clientX - 20}px, ${ev.clientY - 16}px) rotate(2deg)`;
      for (const c of this.el.querySelectorAll('.board-col.drop')) c.classList.remove('drop');
      const col = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.board-col');
      target = null;
      if (col && this.el.contains(col)) {
        col.classList.add('drop');
        const cards = [...col.querySelectorAll('.card:not(.dragging)')];
        const before = cards.find((c) => ev.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
        target = { group: col.dataset.group, before: before?.dataset.row || null, after: !before ? cards.at(-1)?.dataset.row || null : null };
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost?.remove();
      card.classList.remove('dragging');
      for (const c of this.el.querySelectorAll('.board-col.drop')) c.classList.remove('drop');
      if (!ghost || !target) return;
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 50);
      const raw = target.group;
      const value = groupProp.type === 'checkbox' ? raw === 'true' : raw === '' ? null : raw;
      if (groupProp.type === 'multi') D.setValue(this.doc, r.id, groupProp.id, value ? [value] : null);
      else D.setValue(this.doc, r.id, groupProp.id, value);
      if (target.before || target.after) D.moveRow(this.doc, r.id, target.before ? { before: target.before } : { after: target.after });
      announce('Card moved');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* list and gallery */
  list(view, rows) {
    const shown = this.visibleProps(view).filter((p) => p.type !== 'title');
    const ul = h('ul.db-list', { 'aria-label': view.name });
    for (const r of rows) {
      const props = shown.map((p) => [p, D.cellValue(r, p, r.page)]).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
      const li = h(
        'li.db-list-row',
        { 'data-row': r.id },
        h('button.list-title', { type: 'button', 'data-fkey': `row-${r.id}`, onclick: () => this.app.open(this.space, r.id) }, pageIcon(r.page, 16), h('span', displayTitle(r.page))),
        h('span.list-props', ...props.slice(0, 4).map(([p, v]) => h('span.list-prop', { title: p.name }, valueView(p, v)))),
        this.readOnly ? null : h('button.icon-btn.row-menu', { type: 'button', 'aria-label': `Options for ${displayTitle(r.page)}`, onclick: (e) => this.rowMenu(e.currentTarget, r) }, icon('more', 15)),
      );
      ul.append(li);
    }
    if (!rows.length) ul.append(h('li.db-list-empty', this.search ? 'No rows match your search.' : 'No rows yet.'));
    return h('div.db-view.list-view', ul, this.readOnly ? null : h('button.db-new-row', { type: 'button', onclick: () => this.addRow({ open: true }) }, icon('plus', 15), 'New'));
  }

  gallery(view, rows) {
    const shown = this.visibleProps(view).filter((p) => p.type !== 'title');
    const grid = h('div.gallery', { role: 'list', 'aria-label': view.name });
    for (const r of rows) grid.append(h('div', { role: 'listitem' }, this.card(r, shown, { cover: true })));
    if (!this.readOnly) grid.append(h('button.gallery-new', { type: 'button', onclick: () => this.addRow({ open: true }) }, icon('plus', 18), 'New'));
    return h('div.db-view.gallery-view', grid);
  }

  /* calendar */
  calendar(view, rows) {
    const props = D.listProps(this.doc);
    const dateProp = props.find((p) => p.id === view.dateProp);
    if (!dateProp) {
      return h('div.db-view.db-empty-state', icon('calendar', 22), h('p', 'Calendars place rows on the days of a Date property.'), this.readOnly ? null : h('button.btn.small', { type: 'button', onclick: () => {
          const id = D.addProp(this.doc, { name: 'Date', type: 'date' });
          D.updateView(this.doc, view.id, { dateProp: id });
        } }, icon('plus', 15), 'Add a Date property'));
    }
    const now = new Date();
    const month = this.month || new Date(now.getFullYear(), now.getMonth(), 1);
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const byDay = new Map();
    for (const r of rows) {
      const v = D.cellValue(r, dateProp, r.page);
      if (!v) continue;
      const key = typeof v === 'number' ? dayKey(new Date(v)) : String(v).slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    }
    const first = new Date(month);
    const startOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(1 - startOffset);
    const label = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const nav = h(
      'div.cal-nav',
      h('h3.cal-title', { 'aria-live': 'polite' }, label),
      h('button.btn.small.ghost', { type: 'button', 'data-fkey': 'cal-today', onclick: () => {
          this.month = new Date(now.getFullYear(), now.getMonth(), 1);
          this.render();
        } }, 'Today'),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Previous month', 'data-fkey': 'cal-prev', onclick: () => {
          this.month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
          this.render();
        } }, icon('chevronLeft', 16)),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Next month', 'data-fkey': 'cal-next', onclick: () => {
          this.month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
          this.render();
        } }, icon('chevronRight', 16)),
    );
    const names = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));
    const grid = h('div.cal-grid', { role: 'group', 'aria-label': label }, h('div.cal-row.cal-names', { 'aria-hidden': 'true' }, ...names.map((n) => h('div.cal-name', n))));
    const today = dayKey(now);
    for (let w = 0; w < 6; w++) {
      const rowEl = h('div.cal-row');
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + w * 7 + d);
        const key = dayKey(day);
        const items = byDay.get(key) || [];
        const cell = h(
          `div.cal-day${day.getMonth() !== month.getMonth() ? '.other' : ''}${key === today ? '.today' : ''}`,
          { role: 'group', 'aria-label': `${day.toLocaleDateString(undefined, { dateStyle: 'full' })}, ${items.length} ${items.length === 1 ? 'item' : 'items'}` },
          h('span.cal-num', String(day.getDate())),
          ...items.slice(0, 4).map((r) => h('button.cal-item', { type: 'button', onclick: () => this.app.open(this.space, r.id) }, displayTitle(r.page))),
          items.length > 4
            ? h('button.cal-more', { type: 'button', onclick: (e) => openMenu(e.currentTarget, items.map((r) => ({ label: displayTitle(r.page), icon: pageIcon(r.page, 16), run: () => this.app.open(this.space, r.id) })), { label: day.toLocaleDateString(undefined, { dateStyle: 'medium' }) }) }, `${items.length - 4} more`)
            : null,
          this.readOnly || !['date'].includes(dateProp.type) ? null : h('button.icon-btn.cal-add', { type: 'button', 'aria-label': `Add on ${day.toLocaleDateString()}`, onclick: () => this.addRow({ values: { [dateProp.id]: key }, open: true }) }, icon('plus', 13)),
        );
        rowEl.append(cell);
      }
      grid.append(rowEl);
    }
    return h('div.db-view.calendar-view', nav, grid);
  }
}

/** The properties shown above a database row's content. */
export class RowProperties {
  constructor(app, space, dbId, rowId, { readOnly = false } = {}) {
    this.app = app;
    this.space = space;
    this.dbId = dbId;
    this.rowId = rowId;
    this.readOnly = readOnly;
    this.el = h('section.row-props', { 'aria-label': 'Properties' });
    this.onChange = () => {
      if (this.el.contains(document.activeElement) && document.activeElement.matches('input')) {
        this.deferred = true;
        return;
      }
      this.render();
    };
    this.el.addEventListener('focusout', (e) => {
      if (this.deferred && !this.el.contains(e.relatedTarget)) {
        this.deferred = false;
        this.render();
      }
    });
  }

  async mount() {
    try {
      this.doc = await this.space.doc(this.dbId);
    } catch {
      return;
    }
    if (this.destroyed) return;
    this.space.hold(this.dbId);
    this.holding = true;
    this.doc.getMap('db').observeDeep(this.onChange);
    this.render();
  }

  setReadOnly(ro) {
    this.readOnly = ro;
    this.render();
  }

  render() {
    if (!this.doc) return;
    const row = D.listRows(this.doc).find((r) => r.id === this.rowId);
    const page = getPage(this.space.tree, this.rowId);
    const db = getPage(this.space.tree, this.dbId);
    if (!row) return this.el.replaceChildren();
    const props = D.listProps(this.doc).filter((p) => p.type !== 'title');
    const ctx = { doc: this.doc, space: this.space, rowId: this.rowId, page, readOnly: this.readOnly, by: this.app.ws.by };
    const back = h('a.row-db-link', { href: '#', onclick: (e) => {
        e.preventDefault();
        this.app.open(this.space, this.dbId);
      } }, icon('database', 14), h('span', displayTitle(db)));
    fill(this.el,
      back,
      h('dl.prop-list', ...props.flatMap((p) => [h('dt.prop-name', icon(D.PROP_TYPES[p.type]?.icon || 'text', 14), h('span', p.name)), h('dd.prop-value', valueEditor(p, D.cellValue(row, p, page), ctx))])),
      this.readOnly ? null : h('button.btn.small.ghost.add-prop', { type: 'button', onclick: (e) => {
          openMenu(e.currentTarget, Object.entries(D.PROP_TYPES).filter(([t]) => t !== 'title').map(([type, v]) => ({ label: v.label, icon: v.icon, run: () => D.addProp(this.doc, { type }) })), { label: 'Property type' });
        } }, icon('plus', 14), 'Add a property'),
    );
  }

  destroy() {
    this.destroyed = true;
    if (this.holding) this.space.release(this.dbId);
    this.doc?.getMap('db').unobserveDeep(this.onChange);
  }
}
