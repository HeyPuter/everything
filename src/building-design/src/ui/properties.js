/**
 * Properties palette: type selector, selection filter, Edit Type, and the
 * instance parameters of the selection (or of the active view when nothing
 * is selected, or of the type being placed while a tool is active).
 * Edits apply when a field is committed (Enter, blur or change).
 */
import { h, clear } from './dom.js';
import { icon, KIND_ICON } from './icons.js';
import { showMenu } from './menu.js';
import { instanceParams, paramValue, paramPatch, isReadOnly, GROUPS } from '../core/props.js';
import { TYPE_KIND, KIND_LABEL, FAMILY_BY_KIND } from '../core/catalog.js';
import { formatLength, formatArea, formatVolume, parseLength } from '../core/units.js';
import { isView, VIEW_LABEL } from '../core/doc.js';
import { swapGroupType } from '../core/groups.js';
import { paramDescriptors } from '../core/params.js';


export class PropertiesPanel {
  constructor(app, body) {
    this.app = app;
    this.body = body;
    this.collapsed = new Set(loadCollapsed());
    this.filter = null;
  }

  /** Elements the palette currently edits. */
  targets() {
    const app = this.app;
    const sel = [...app.selection].map((id) => app.doc.get(id)).filter(Boolean);
    if (!sel.length) return { mode: app.tool && app.tool.placingKind ? 'tool' : 'view', items: [] };
    const kinds = [...new Set(sel.map((e) => e.kind))];
    if (this.filter && !kinds.includes(this.filter)) this.filter = null;
    const k = this.filter || (kinds.length === 1 ? kinds[0] : null);
    return { mode: 'sel', items: k ? sel.filter((e) => e.kind === k) : sel, kinds, all: sel, kind: k };
  }

  render() {
    if (this.deferred) return;
    const active = document.activeElement;
    if (!active || active === document.body || (active !== this.body && this.body.contains(active))) {
      // Rebuilding would drop the focused field, or the field Tab is moving to while a
      // `change` commits (focus is on <body> then), so let focus settle, rebuild, restore it.
      this.deferred = true;
      setTimeout(() => {
        this.deferred = false;
        this.renderNow();
      }, 0);
      return;
    }
    this.renderNow();
  }

  renderNow() {
    const active = document.activeElement;
    const focusables = () => [...this.body.querySelectorAll('button, input, select, textarea, [tabindex]')];
    const inside = active && active !== this.body && this.body.contains(active);
    const key = inside ? { id: active.id, idx: focusables().indexOf(active) } : null;
    const scroll = this.body.scrollTop;
    this.build();
    if (key) {
      const el = (key.id && this.body.querySelector(`#${CSS.escape(key.id)}`)) || focusables()[key.idx];
      el?.focus({ preventScroll: true });
    }
    this.body.scrollTop = scroll;
  }

  build() {
    const app = this.app;
    const doc = app.doc;
    clear(this.body);
    if (!doc) return;
    const t = this.targets();
    const wrap = h('div.props');
    // What the palette shows: selection, tool type, or the active view.
    let items = t.items;
    let typeKind = null;
    let typeItem = null;
    let typeIcon = 'sliders';
    let famLabel = '';
    let nameLabel = '';
    const toolKind = app.tool?.placingKind;
    if (t.mode === 'sel') {
      const kind = t.kind;
      typeKind = kind ? TYPE_KIND[kind] : null;
      const typeIds = typeKind ? [...new Set(items.map((e) => e.typeId))] : [];
      typeItem = typeIds.length === 1 ? doc.get(typeIds[0]) : null;
      typeIcon = KIND_ICON[kind] || 'sliders';
      if (typeItem) {
        famLabel = typeItem.familyName || FAMILY_BY_KIND[typeItem.kind] || KIND_LABEL[kind];
        nameLabel = typeItem.name;
      } else if (typeKind) {
        famLabel = KIND_LABEL[kind];
        nameLabel = typeIds.length > 1 ? 'Varies' : '';
      } else if (kind && isView(items[0])) {
        famLabel = VIEW_LABEL[kind];
        nameLabel = items.length === 1 ? items[0].name : `${items.length} views`;
      } else {
        famLabel = kind ? KIND_LABEL[kind] || kind : 'Multiple Categories';
        nameLabel = kind ? (items.length > 1 ? `${items.length} selected` : items[0].name || '') : `${t.all.length} selected`;
      }
    } else if (t.mode === 'tool' && toolKind) {
      typeKind = TYPE_KIND[toolKind];
      typeItem = app.currentType(toolKind);
      typeIcon = KIND_ICON[toolKind] || 'sliders';
      famLabel = typeItem ? typeItem.familyName || FAMILY_BY_KIND[typeItem.kind] || KIND_LABEL[toolKind] : KIND_LABEL[toolKind];
      nameLabel = typeItem?.name || '';
    } else {
      const view = app.activeView;
      if (view) {
        items = [view];
        typeIcon = KIND_ICON[view.kind] || 'sliders';
        famLabel = VIEW_LABEL[view.kind] || 'View';
        nameLabel = view.name;
      }
    }

    const canPickType = !!typeKind && (t.mode === 'tool' || items.length > 0);
    const typeSel = h(
      canPickType ? 'button.type-sel' : 'div.type-sel',
      canPickType
        ? {
            type: 'button',
            'aria-haspopup': 'menu',
            onClick: (e) => this.typeMenu(e.currentTarget, typeKind, t.mode === 'tool' ? toolKind : t.kind, items, typeItem),
          }
        : {},
      h('span.type-sel-ico', icon(typeIcon, 24)),
      h('span.type-sel-text', h('span.type-sel-fam', famLabel), ' ', h('span.type-sel-name', nameLabel || ' ')),
      canPickType ? h('span.sr-only', ', change type') : null,
      canPickType ? icon('chevron-down', 14) : null,
    );
    wrap.append(typeSel);

    // Filter and Edit Type.
    const bar = h('div.props-bar');
    if (t.mode === 'sel' && t.kinds.length > 1) {
      const sel = h('select.input', { 'aria-label': 'Show properties of' });
      sel.append(h('option', { value: '' }, `Common (${t.all.length})`));
      for (const k of t.kinds) sel.append(h('option', { value: k, selected: k === this.filter }, `${pluralLabel(k)} (${t.all.filter((e) => e.kind === k).length})`));
      sel.addEventListener('change', () => {
        this.filter = sel.value || null;
        this.render();
      });
      bar.append(sel);
    } else {
      const what = t.mode === 'sel' ? `${pluralLabel(t.kind)} (${items.length})` : t.mode === 'tool' ? `New ${KIND_LABEL[toolKind] || ''}` : `${famLabel}: ${nameLabel}`;
      bar.append(h('span.grow', { style: { fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, what));
    }
    bar.append(h('button.btn.sm', { type: 'button', disabled: !typeItem, onClick: () => app.editTypeDialog(typeItem) }, icon('types', 14), 'Edit Type'));
    wrap.append(bar);

    const body = h('div.props-body');
    if (t.mode === 'tool') body.append(h('p.props-empty', 'Choose the type above. Options for placing are in the options bar.'));
    else if (t.mode === 'sel' && !t.kind) body.append(this.renderParams([commentsParam()], t.all));
    else if (items.length) body.append(this.renderParams([...instanceParams(items[0]), ...paramDescriptors(doc, items[0])], items));
    wrap.append(body);
    this.body.append(wrap);
  }

  renderParams(params, items) {
    const app = this.app;
    const ctx = { doc: app.doc, scene: app.scene, app, items };
    const frag = h('div');
    for (const group of GROUPS.concat(['Materials and Finishes'])) {
      const list = params.filter((p) => p.group === group);
      if (!list.length) continue;
      const open = !this.collapsed.has(group);
      const head = h(
        'button.pgroup-head',
        {
          type: 'button',
          'aria-expanded': String(open),
          onClick: () => {
            if (this.collapsed.has(group)) this.collapsed.delete(group);
            else this.collapsed.add(group);
            saveCollapsed([...this.collapsed]);
            this.render();
          },
        },
        icon('chevron-down', 13),
        group,
      );
      frag.append(head);
      if (!open) continue;
      for (const p of list) frag.append(this.row(p, items, ctx));
    }
    return frag;
  }

  row(p, items, ctx) {
    const app = this.app;
    const values = items.map((el) => paramValue(p, el, ctx));
    const same = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));
    const value = same ? values[0] : undefined;
    const ro = items.some((el) => isReadOnly(p, el, ctx));
    const id = `prop-${p.key.replace(/[^\w-]/g, '_')}`;
    const label = h('label.prow-label', { for: id, title: p.label }, p.label);
    const cell = h('div.prow-value');
    const commit = (raw) => {
      if (p.action) return app.run(p.action, { value: raw });
      const label2 = `Change ${p.label}`;
      app.commit(label2, () => {
        for (const el of items) {
          const cur = app.doc.get(el.id);
          const patch = paramPatch(p, cur, raw, ctx);
          if (patch) app.doc.update(el.id, patch);
        }
      });
    };
    const units = app.doc.units;
    const fmtVal = (v, format) => {
      if (v == null || v === '') return '';
      if (format === 'area') return formatArea(v, units);
      if (format === 'volume') return formatVolume(v, units);
      if (format === 'text') return String(v);
      if (typeof v === 'number') return formatLength(v, units);
      return String(v);
    };
    if (p.type === 'readonly' || (ro && p.type !== 'bool')) {
      cell.append(h('span.ro-text', { id }, same ? fmtVal(value, p.format || (p.type === 'length' ? 'length' : p.type === 'readonly' ? p.format : 'text')) : 'Varies'));
      return h('div.prow.ro', label, cell);
    }
    switch (p.type) {
      case 'length':
      case 'number':
      case 'angle':
      case 'text': {
        const show = (v) => (v == null ? '' : p.type === 'length' ? formatLength(+v, units) : p.type === 'angle' ? `${Math.round(+v * 1000) / 1000}°` : String(v));
        const input = h('input.input', { id, type: 'text', value: same ? show(value) : '', placeholder: same ? '' : 'Varies', spellcheck: 'false', 'data-key': p.key });
        const apply = () => {
          const raw = input.value.trim();
          if (!same && raw === '') return;
          if (same && raw === show(value)) return;
          let v = raw;
          if (p.type === 'length') {
            v = parseLength(raw, units);
            if (!Number.isFinite(v)) {
              input.setAttribute('aria-invalid', 'true');
              app.toast(`"${raw}" is not a valid length.`, { kind: 'error' });
              return;
            }
          } else if (p.type === 'number' || p.type === 'angle') {
            v = parseFloat(raw.replace('°', ''));
            if (!Number.isFinite(v)) {
              input.setAttribute('aria-invalid', 'true');
              return;
            }
          }
          input.removeAttribute('aria-invalid');
          commit(v);
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            apply();
            input.blur();
          } else if (e.key === 'Escape') {
            input.value = same ? show(value) : '';
            input.blur();
          }
        });
        input.addEventListener('change', apply);
        cell.append(input);
        break;
      }
      case 'textarea': {
        const ta = h('textarea.input', { id, rows: 2, 'data-key': p.key });
        ta.value = same ? value ?? '' : '';
        ta.addEventListener('keydown', (e) => e.stopPropagation());
        ta.addEventListener('change', () => commit(ta.value));
        cell.append(ta);
        break;
      }
      case 'bool': {
        const cb = h('input', { id, type: 'checkbox', checked: !!value, disabled: ro, 'aria-checked': same ? String(!!value) : 'mixed' });
        if (!same) cb.indeterminate = true;
        cb.addEventListener('change', () => commit(cb.checked));
        cell.append(cb);
        return h(`div.prow${ro ? '.ro' : ''}`, label, cell);
      }
      case 'select': {
        const sel = h('select.input', { id, 'data-key': p.key });
        if (!same) sel.append(h('option', { value: '', selected: true }, 'Varies'));
        for (const o of p.options(ctx)) sel.append(h('option', { value: o.value, selected: same && String(o.value) === String(value) }, o.label));
        sel.addEventListener('change', () => sel.value !== '' && commit(isNaN(+sel.value) || typeof value === 'string' ? sel.value : +sel.value));
        cell.append(sel);
        break;
      }
      case 'level':
      case 'levelOpt': {
        const sel = h('select.input', { id, 'data-key': p.key });
        if (!same) sel.append(h('option', { value: '__', selected: true }, 'Varies'));
        if (p.type === 'levelOpt') sel.append(h('option', { value: '', selected: same && !value }, p.none || 'None'));
        for (const l of app.doc.levels()) sel.append(h('option', { value: l.id, selected: same && l.id === value }, l.name));
        sel.addEventListener('change', () => sel.value !== '__' && commit(sel.value || null));
        cell.append(sel);
        break;
      }
      case 'material': {
        const sel = h('select.input', { id });
        for (const m of app.doc.all('material')) sel.append(h('option', { value: m.id, selected: m.id === value }, m.name));
        sel.addEventListener('change', () => commit(sel.value));
        cell.append(sel);
        break;
      }
      case 'button':
        cell.append(h('button.btn.sm', { id, type: 'button', onClick: () => app.run(p.action, { items }) }, p.text || 'Edit...'));
        break;
      default:
        cell.append(h('span.ro-text', String(value ?? '')));
    }
    return h('div.prow', label, cell);
  }

  /** Type picker: all types of the category, with search. */
  typeMenu(anchor, typeKind, kind, items, current) {
    const app = this.app;
    const types = app.doc.all(typeKind);
    const byFamily = new Map();
    for (const t of types) {
      const fam = t.familyName || FAMILY_BY_KIND[t.kind] || '';
      if (!byFamily.has(fam)) byFamily.set(fam, []);
      byFamily.get(fam).push(t);
    }
    const entries = [];
    for (const [fam, list] of byFamily) {
      entries.push({ header: fam });
      for (const t of list)
        entries.push({
          label: t.name,
          checked: current?.id === t.id,
          radio: true,
          action: () => {
            if (items.length && app.selection.size && kind === 'group') app.commit('Change group type', () => swapGroupType(app.doc, items.map((el) => el.id), t));
            else if (items.length && app.selection.size) app.commit('Change type', () => items.forEach((el) => app.doc.update(el.id, { typeId: t.id })));
            app.setCurrentType(kind, t.id);
            this.render();
          },
        });
    }
    showMenu(anchor, entries, { label: `${KIND_LABEL[kind] || ''} types`, className: 'type-menu' });
  }
}

function commentsParam() {
  return { key: 'comments', label: 'Comments', group: 'Identity Data', type: 'text' };
}

export function pluralLabel(kind) {
  const l = KIND_LABEL[kind] || VIEW_LABEL[kind] || kind || 'Elements';
  if (l.endsWith('y') && !l.endsWith('ay')) return `${l.slice(0, -1)}ies`;
  if (l.endsWith('s')) return l;
  return `${l}s`;
}

function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem('bd.propsCollapsed') || '[]');
  } catch {
    return [];
  }
}

function saveCollapsed(v) {
  try {
    localStorage.setItem('bd.propsCollapsed', JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

