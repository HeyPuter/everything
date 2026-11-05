// Components panel: search the built-in and project libraries, preview the
// symbol and footprint, and place parts. Double click, Enter or the Place
// button starts placement in the active schematic or board.

import { h, clear, announce } from '../dom.js';
import { icon } from '../icons.js';
import { BUILTIN_COMPONENTS, CATEGORIES, searchComponents } from '../../model/library/builtin.js';
import { drawSymbolPreview, drawFootprintPreview } from '../preview.js';
import { resolvedTheme } from '../../app/theme.js';
import { contextMenu } from '../menu.js';

const MAX_ROWS = 300;

export class ComponentsPanel {
  constructor(app) {
    this.app = app;
    this.source = 'all';
    this.category = '';
    this.query = '';
    this.selected = null;
    this.el = h('section.panel', { 'aria-labelledby': 'comp-title' });
    this.search = h('input', { type: 'search', placeholder: 'Search components', 'aria-label': 'Search components', autocomplete: 'off', spellcheck: 'false' });
    this.cat = h('select.field', { 'aria-label': 'Category', style: { margin: '0 8px 6px', width: 'calc(100% - 16px)' } });
    this.list = h('ul.list', { role: 'listbox', 'aria-label': 'Components', tabindex: 0 });
    this.symCanvas = h('canvas', { 'aria-hidden': 'true' });
    this.fpCanvas = h('canvas', { 'aria-hidden': 'true' });
    this.detail = h('div.comp-detail', { 'aria-live': 'polite' });
    this.el.append(
      h('div.panel-head', h('h2#comp-title', 'Components'),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'New component', 'data-tip': 'New component', onClick: () => app.commands.run('lib.newComponent') }, icon('plus', 15)),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Footprint wizard', 'data-tip': 'Footprint wizard', onClick: () => app.commands.run('lib.footprintWizard') }, icon('wand', 15))),
      h('label.panel-search', icon('search', 14), this.search),
      this.cat,
      h('div.comp-preview', this.symCanvas, this.fpCanvas),
      this.detail,
      h('div.panel-scroll', this.list),
    );
    this.search.addEventListener('input', () => { this.query = this.search.value; this.renderList(); });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.list.focus(); this._move(1); }
      if (e.key === 'Enter') { e.preventDefault(); if (!this.selected) this._move(1); this.place(); }
    });
    this.cat.addEventListener('change', () => { this.category = this.cat.value; this.renderList(); });
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.place(); }
    });
    window.addEventListener('themechange', () => this._preview());
    new ResizeObserver(() => this._preview()).observe(this.symCanvas);
    app.on?.('project', () => this.refresh());
  }

  /** All definitions visible in the browser: project library first. */
  defs() {
    const proj = this.app.project ? Object.values(this.app.project.library) : [];
    const projIds = new Set(proj.map((d) => d.id));
    const user = this.app.userLibrary?.all() || [];
    const userIds = new Set(user.map((d) => d.id));
    const out = [];
    if (this.source !== 'builtin') out.push(...proj.map((d) => ({ def: d, src: 'Project' })), ...user.filter((d) => !projIds.has(d.id)).map((d) => ({ def: d, src: 'My library' })));
    if (this.source !== 'project') out.push(...BUILTIN_COMPONENTS.filter((d) => !projIds.has(d.id) && !userIds.has(d.id)).map((d) => ({ def: d, src: 'Built-in' })));
    return out;
  }

  refresh() {
    const cats = new Set(CATEGORIES.map((c) => c.id || c.name || c));
    for (const { def } of this.defs()) if (def.category) cats.add(def.category);
    clear(this.cat);
    this.cat.append(h('option', { value: '' }, 'All categories'), ...[...cats].map((c) => h('option', { value: c, selected: c === this.category }, catLabel(c))));
    this.renderList();
  }

  renderList() {
    const entries = this.defs();
    const bySrc = new Map(entries.map((e) => [e.def, e.src]));
    let defs = entries.map((e) => e.def);
    defs = this.query.trim() ? searchComponents(this.query, this.category || null, defs) : defs.filter((d) => !this.category || d.category === this.category);
    clear(this.list);
    if (!defs.length) {
      this.list.append(h('li.panel-empty', { role: 'presentation' }, 'No components match. Try another search, or create a component with the footprint and symbol wizards.'));
      this.select(null, false);
      return;
    }
    let lastSrc = null;
    for (const def of defs.slice(0, MAX_ROWS)) {
      const src = bySrc.get(def);
      if (!this.query && src !== lastSrc) { this.list.append(h('li.list-group-head', { role: 'presentation' }, src)); lastSrc = src; }
      const li = h('li.list-row', { role: 'option', id: `cmp-${def.id}`, 'aria-selected': String(this.selected?.id === def.id) },
        icon(def.footprint ? 'component' : 'symbol', 15),
        h('div.grow', h('div', def.name), h('div.sub', [def.footprint?.name, def.value, def.description].filter(Boolean).join(' . '))));
      li.addEventListener('click', () => this.select(def));
      li.addEventListener('dblclick', () => { this.select(def); this.place(); });
      li.addEventListener('contextmenu', (e) => { this.select(def); contextMenu(e, [
        { label: '&Place', icon: 'plus', run: () => this.place() },
        { label: '&Edit a copy', icon: 'pencil', run: () => this.app.openComponentEditor?.(def.id, { copyFrom: def }) },
      ]); });
      this.list.append(li);
    }
    if (defs.length > MAX_ROWS) this.list.append(h('li.panel-empty.small', { role: 'presentation' }, `${defs.length - MAX_ROWS} more. Refine the search to see them.`));
    if (!this.selected || !defs.includes(this.selected)) this.select(defs[0], false);
  }

  select(def, scroll = true) {
    this.selected = def;
    for (const li of this.list.querySelectorAll('[role="option"]')) li.setAttribute('aria-selected', String(li.id === `cmp-${def?.id}`));
    if (def) this.list.setAttribute('aria-activedescendant', `cmp-${def.id}`);
    else this.list.removeAttribute('aria-activedescendant');
    if (scroll) this.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    this._preview();
  }

  _move(d) {
    const opts = [...this.list.querySelectorAll('[role="option"]')];
    if (!opts.length) return;
    const i = opts.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    const next = opts[Math.max(0, Math.min(opts.length - 1, i + d))];
    const def = this.defs().map((e) => e.def).find((x) => `cmp-${x.id}` === next.id);
    if (def) { this.select(def); announce(def.name); }
  }

  _preview() {
    const def = this.selected;
    const theme = resolvedTheme();
    drawSymbolPreview(this.symCanvas, def, theme);
    drawFootprintPreview(this.fpCanvas, def, theme);
    clear(this.detail);
    if (!def) return;
    this.detail.append(
      h('h3', def.name),
      def.description ? h('p', def.description) : null,
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
        def.footprint ? h('span.chip', def.footprint.name) : h('span.chip', 'No footprint'),
        h('span.chip', `${def.symbol?.pins?.length || 0} pins`),
        h('span', { style: { flex: '1' } }),
        h('button.btn.sm.primary', { type: 'button', onClick: () => this.place() }, 'Place')),
    );
  }

  place() {
    const def = this.selected;
    if (!def) return;
    const ed = this.app.activeEditor;
    if (!ed) { this.app.toast('Open a schematic or board to place components.', { kind: 'info' }); return; }
    if (ed.kind === 'sch') ed.placePart(def);
    else if (ed.kind === 'pcb') {
      if (!def.footprint) { this.app.toast(`${def.name} has no footprint to place on a board.`, { kind: 'warning' }); return; }
      ed.placeComponent(def);
    } else return;
    if (this.app.isCompact) this.app.closeDrawers();
  }
}

function catLabel(c) {
  const found = CATEGORIES.find((x) => (x.id || x.name || x) === c);
  return found?.label || found?.name || c;
}
