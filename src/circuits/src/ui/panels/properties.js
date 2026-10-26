// Properties panel: edits the selection, or the document when nothing is
// selected. Field specs are built per object type; edits made while typing
// merge into one undo step per field.

import { h, nextId, clear } from '../dom.js';
import { icon } from '../icons.js';
import { formDialog } from '../dialog.js';
import { formatLength, parseLength } from '../../core/units.js';
import { LAYERS, boardLayers, isCopper } from '../../model/layers.js';
import { POWER_STYLES, PIN_TYPE_LABELS } from '../../model/schema.js';
import { SHEET_SIZES } from '../../model/project.js';
import { bboxOfFlat, polyArea } from '../../core/geom.js';
import { placeSymbol } from '../../model/place.js';
import { placedOf } from '../../render/pcb-scene.js';

const MIXED = Symbol('mixed');

const POWER_STYLE_LABELS = { bar: 'Bar', arrow: 'Arrow', circle: 'Circle', wave: 'Wave', gnd: 'Power ground', signalgnd: 'Signal ground', earth: 'Earth' };
const PORT_IO = [['unspec', 'Unspecified'], ['in', 'Input'], ['out', 'Output'], ['bidir', 'Bidirectional']];
const ROT4 = [['0', '0 degrees'], ['90', '90 degrees'], ['180', '180 degrees'], ['270', '270 degrees']];

/** Common value across objects, or MIXED. */
function common(objs, get) {
  const v = get(objs[0]);
  for (let i = 1; i < objs.length; i++) if (get(objs[i]) !== v) return MIXED;
  return v;
}

export class PropertiesPanel {
  constructor(app) {
    this.app = app;
    this.el = h('section.panel', { 'aria-labelledby': 'props-title' });
    this.title = h('h2#props-title', 'Properties');
    this.body = h('div.panel-scroll.props');
    this.el.append(h('div.panel-head', this.title), this.body);
    this.openSections = new Set(['General', 'Location', 'Sheet', 'Board', 'Design rules', 'Parameters', 'Pads']);
  }

  /** Re-renders unless the user is typing in one of our fields. */
  refresh(force = false) {
    if (!force && this.el.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea')) {
      this._pending = true;
      return;
    }
    this._pending = false;
    const ed = this.app.activeEditor;
    clear(this.body);
    if (!ed) {
      this.title.textContent = 'Properties';
      this.body.append(h('div.panel-empty', 'Open a document to see its properties.'));
      return;
    }
    const objs = ed.selectedObjects?.() || [];
    let spec;
    if (ed.kind === 'sch') spec = objs.length ? schSpec(this.app, ed, objs) : sheetSpec(this.app, ed);
    else if (ed.kind === 'pcb') spec = objs.length ? pcbSpec(this.app, ed, objs) : boardSpec(this.app, ed);
    else spec = ed.propertySpec?.() || { title: 'Properties', sections: [] };
    this.title.textContent = spec.title;
    for (const s of spec.sections) this.body.append(this._section(s));
  }

  _section(s) {
    const det = h('details.prop-section', { open: this.openSections.has(s.title) });
    det.addEventListener('toggle', () => { if (det.open) this.openSections.add(s.title); else this.openSections.delete(s.title); });
    const grid = h('div.prop-grid');
    for (const f of s.fields) if (f) grid.append(...this._field(f));
    det.append(h('summary', icon('chevron-right', 13), s.title), grid);
    if (s.extra) det.append(s.extra);
    return det;
  }

  _field(f) {
    const id = nextId('pf');
    const mixed = f.value === MIXED;
    const commit = (v) => { try { f.onChange(v); } catch (err) { this.app.toast(err.message, { kind: 'error' }); } };
    let input;
    switch (f.type) {
      case 'bool': {
        input = h('input', { id, type: 'checkbox', checked: !mixed && !!f.value, disabled: f.readonly });
        if (mixed) input.indeterminate = true;
        input.addEventListener('change', () => commit(input.checked));
        return [h('span'), h('label.check-row', { for: id }, input, f.label)];
      }
      case 'select': {
        input = h('select', { id, disabled: f.readonly },
          mixed ? h('option', { value: '', selected: true, disabled: true }, 'Mixed') : null,
          f.options.map(([v, l]) => h('option', { value: String(v), selected: !mixed && String(v) === String(f.value) }, l)));
        input.addEventListener('change', () => commit(input.value));
        break;
      }
      case 'color': {
        input = h('input', { id, type: 'color', value: mixed ? '#000000' : f.value || '#000000', disabled: f.readonly });
        input.addEventListener('change', () => commit(input.value));
        break;
      }
      case 'button': {
        input = h('button.btn.sm', { id, type: 'button', onClick: f.onClick }, f.text);
        break;
      }
      case 'readonly': {
        input = h('div', { id, class: 'muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: String(f.value ?? '') }, String(f.value ?? ''));
        break;
      }
      case 'textarea': {
        input = h('textarea', { id, rows: 3, placeholder: mixed ? 'Mixed' : '' }, mixed ? '' : f.value ?? '');
        input.addEventListener('input', () => commit(input.value));
        break;
      }
      default: {
        // text, length, number, angle
        const units = this.app.settings.get('units');
        const display = mixed ? '' : f.type === 'length' ? formatLength(f.value, units, { suffix: false }) : f.value ?? '';
        input = h('input', { id, type: 'text', value: display, placeholder: mixed ? 'Mixed' : f.placeholder || '', readonly: f.readonly, inputmode: f.type === 'text' ? null : 'decimal', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': f.type === 'length' ? `${id}-u` : null });
        const parse = (raw) => {
          if (f.type === 'length') return parseLength(raw, units);
          if (f.type === 'number' || f.type === 'angle') { const n = Number(raw); return raw.trim() === '' || !Number.isFinite(n) ? null : n; }
          return raw;
        };
        const apply = (live) => {
          const v = parse(input.value);
          const bad = v === null || (f.validate && f.validate(v));
          input.setAttribute('aria-invalid', bad ? 'true' : 'false');
          if (bad) return;
          if (f.type !== 'text' && live) return; // numbers apply on Enter or blur
          commit(v);
        };
        input.addEventListener('input', () => { if (f.type === 'text' && !f.commitOnBlur) apply(true); else apply(true); });
        input.addEventListener('change', () => apply(false));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); apply(false); input.select(); }
          if (e.key === 'Escape') { e.preventDefault(); input.blur(); this.app.activeEditor?.canvas.focus(); }
        });
        input.addEventListener('blur', () => { if (this._pending) setTimeout(() => this.refresh(), 0); });
        if (f.type === 'length') {
          return [h('label', { for: id }, f.label), h('div.inline', input, h('span.muted.small', { id: `${id}-u`, style: { flex: 'none' } }, units))];
        }
      }
    }
    return [h('label', { for: id, title: f.label }, f.label), input];
  }
}

// ---- Helpers to apply edits ----

function editor(app) { return app.activeEditor; }

function setAll(app, objs, patchOf, label, key) {
  const ed = editor(app);
  ed.doc.store.transact(label, (s) => {
    for (const o of objs) {
      const cur = s.get(o.id);
      if (cur) s.update(o.id, typeof patchOf === 'function' ? patchOf(cur) : patchOf);
    }
  }, { mergeKey: key ? `${key}:${objs.map((o) => o.id).join(',')}` : null });
}

function field(objs, app, { label, type = 'text', get, set, options, validate, readonly }) {
  return {
    label, type, options, validate, readonly,
    value: common(objs, get),
    onChange: (v) => setAll(app, objs, (o) => set(o, v), `Change ${label.toLowerCase()}`, label),
  };
}

// ---- Schematic ----

function sheetSpec(app, ed) {
  const sheet = ed.doc.sheet;
  const upd = (patch, label) => ed.doc.store.transact(label, (s) => s.update('sheet', patch), { mergeKey: `sheet:${label}` });
  return {
    title: 'Sheet',
    sections: [
      {
        title: 'Sheet',
        fields: [
          { label: 'Name', type: 'text', value: ed.doc.name, onChange: (v) => v && app.project.renameDoc(ed.doc.id, v) },
          { label: 'Size', type: 'select', value: sheet.size, options: Object.keys(SHEET_SIZES).map((k) => [k, k]), onChange: (v) => upd({ size: v }, 'Sheet size') },
          { label: 'Orientation', type: 'select', value: sheet.orientation, options: [['landscape', 'Landscape'], ['portrait', 'Portrait']], onChange: (v) => upd({ orientation: v }, 'Orientation') },
          { label: 'Show border', type: 'bool', value: sheet.showBorder !== false, onChange: (v) => upd({ showBorder: v }, 'Border') },
          { label: 'Show title block', type: 'bool', value: sheet.showTitleBlock !== false, onChange: (v) => upd({ showTitleBlock: v }, 'Title block') },
        ],
      },
      {
        title: 'Title block',
        fields: [
          { label: 'Title', type: 'text', value: sheet.title || '', onChange: (v) => upd({ title: v }, 'Title') },
          { label: 'Revision', type: 'text', value: sheet.revision || '', onChange: (v) => upd({ revision: v }, 'Revision') },
          { label: 'Author', type: 'text', value: sheet.author || '', onChange: (v) => upd({ author: v }, 'Author') },
          { label: 'Company', type: 'text', value: sheet.company || '', onChange: (v) => upd({ company: v }, 'Company') },
          { label: 'Sheet number', type: 'text', value: String(sheet.number ?? ''), onChange: (v) => upd({ number: v }, 'Number') },
        ],
      },
      {
        title: 'Grid',
        fields: [
          { label: 'Snap grid', type: 'select', value: String(app.settings.get('schGrid')), options: [[254000, '10 mil'], [1270000, '50 mil'], [2540000, '100 mil']], onChange: (v) => { app.settings.set('schGrid', Number(v)); ed.requestRender(); } },
        ],
      },
    ],
  };
}

function schSpec(app, ed, objs) {
  const types = new Set(objs.map((o) => o.t));
  const t = types.size === 1 ? objs[0].t : null;
  const lib = ed.lib;
  const one = objs.length === 1 ? objs[0] : null;
  const title = t ? `${objs.length > 1 ? `${objs.length} ` : ''}${{ part: 'Part', wire: 'Wire', bus: 'Bus', label: 'Net label', power: 'Power port', port: 'Port', text: 'Text', junction: 'Junction', noerc: 'No ERC marker', gline: 'Line', grect: 'Rectangle', gcircle: 'Circle' }[t]}${objs.length > 1 ? 's' : ''}` : `${objs.length} objects`;
  const sections = [];
  const loc = (x, y) => ({ title: 'Location', fields: [
    field(objs, app, { label: 'X', type: 'length', get: (o) => o[x], set: (o, v) => ({ [x]: v }) }),
    field(objs, app, { label: 'Y', type: 'length', get: (o) => o[y], set: (o, v) => ({ [y]: v }) }),
  ] });
  const rot = field(objs, app, { label: 'Rotation', type: 'select', options: ROT4, get: (o) => String(o.rot || 0), set: (o, v) => ({ rot: Number(v) }) });
  switch (t) {
    case 'part': {
      const def = one ? lib[one.comp] : null;
      sections.push({
        title: 'General',
        fields: [
          one ? field(objs, app, { label: 'Designator', get: (o) => o.designator, set: (o, v) => ({ designator: v.trim() }) }) : null,
          field(objs, app, { label: 'Value', get: (o) => o.value ?? '', set: (o, v) => ({ value: v }) }),
          one ? { label: 'Component', type: 'readonly', value: def?.name || one.comp } : null,
          one ? { label: 'Footprint', type: 'readonly', value: def?.footprint?.name || 'None' } : null,
          one && def?.description ? { label: 'Description', type: 'readonly', value: def.description } : null,
          field(objs, app, { label: 'Do not populate', type: 'bool', get: (o) => !!o.dnp, set: (o, v) => ({ dnp: v }) }),
          field(objs, app, { label: 'Hide designator', type: 'bool', get: (o) => !!o.fields?.designator?.hidden, set: (o, v) => ({ fields: { ...o.fields, designator: { ...fieldOrDefault(o, 'designator', lib), hidden: v } } }) }),
          field(objs, app, { label: 'Hide value', type: 'bool', get: (o) => !!o.fields?.value?.hidden, set: (o, v) => ({ fields: { ...o.fields, value: { ...fieldOrDefault(o, 'value', lib), hidden: v } } }) }),
          one ? { label: 'Library', type: 'button', text: 'Edit component', onClick: () => app.openComponentEditor?.(one.comp) } : null,
        ],
      });
      sections.push({ ...loc('x', 'y'), fields: [...loc('x', 'y').fields, rot, field(objs, app, { label: 'Mirrored', type: 'bool', get: (o) => !!o.mirror, set: (o, v) => ({ mirror: v }) })] });
      if (one) sections.push(paramsSection(app, ed, one, def));
      if (one && def) sections.push(pinsSection(app, ed, one, def));
      break;
    }
    case 'wire': case 'bus': case 'gline': {
      const nl = app.project.netlist().sheets.get(ed.doc.id);
      let len = 0;
      for (const o of objs) for (let i = 2; i < o.pts.length; i += 2) len += Math.hypot(o.pts[i] - o.pts[i - 2], o.pts[i + 1] - o.pts[i - 1]);
      sections.push({ title: 'General', fields: [
        t === 'wire' && one ? { label: 'Net', type: 'readonly', value: nl?.wireNet.get(one.id) || '' } : null,
        { label: 'Length', type: 'readonly', value: formatLength(len, 'mil') },
        one ? { label: 'Vertices', type: 'readonly', value: String(one.pts.length / 2) } : null,
        t === 'gline' ? field(objs, app, { label: 'Width', type: 'length', get: (o) => o.w, set: (o, v) => ({ w: Math.max(0, v) }) }) : null,
      ] });
      break;
    }
    case 'label':
      sections.push({ title: 'General', fields: [field(objs, app, { label: 'Net name', get: (o) => o.text, set: (o, v) => ({ text: v.trim() }), validate: (v) => !v.trim() || /\s/.test(v.trim()) }), rot] });
      sections.push(loc('x', 'y'));
      break;
    case 'power':
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Net', get: (o) => o.net, set: (o, v) => ({ net: v.trim() }), validate: (v) => !v.trim() }),
        field(objs, app, { label: 'Style', type: 'select', options: POWER_STYLES.map((s) => [s, POWER_STYLE_LABELS[s]]), get: (o) => o.style, set: (o, v) => ({ style: v }) }),
        rot,
      ] });
      sections.push(loc('x', 'y'));
      break;
    case 'port':
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Name', get: (o) => o.name, set: (o, v) => ({ name: v.trim() }), validate: (v) => !v.trim() }),
        field(objs, app, { label: 'Direction', type: 'select', options: PORT_IO, get: (o) => o.io, set: (o, v) => ({ io: v }) }),
        rot,
      ] });
      sections.push(loc('x', 'y'));
      break;
    case 'text':
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Text', type: 'textarea', get: (o) => o.text, set: (o, v) => ({ text: v }) }),
        field(objs, app, { label: 'Size', type: 'length', get: (o) => o.size, set: (o, v) => ({ size: Math.max(100_000, v) }) }),
        field(objs, app, { label: 'Rotation', type: 'select', options: ROT4, get: (o) => String(o.rot || 0), set: (o, v) => ({ rot: Number(v) }) }),
      ] });
      sections.push(loc('x', 'y'));
      break;
    case 'grect': case 'gcircle':
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Line width', type: 'length', get: (o) => o.w, set: (o, v) => ({ w: Math.max(0, v) }) }),
        field(objs, app, { label: 'Filled', type: 'bool', get: (o) => !!o.fill, set: (o, v) => ({ fill: v }) }),
        t === 'gcircle' ? field(objs, app, { label: 'Radius', type: 'length', get: (o) => o.r, set: (o, v) => ({ r: Math.max(1, v) }) }) : null,
      ] });
      break;
    case 'junction': case 'noerc':
      sections.push(loc('x', 'y'));
      break;
    default:
      sections.push({ title: 'General', fields: [{ label: 'Selected', type: 'readonly', value: `${objs.length} objects of ${types.size} kinds` }] });
  }
  return { title, sections };
}

function fieldOrDefault(o, name, lib) {
  if (o.fields?.[name]) return o.fields[name];
  const def = lib[o.comp];
  const local = name === 'designator' ? def?.symbol?.designatorPos : def?.symbol?.valuePos;
  return { dx: local?.x ?? 0, dy: local?.y ?? 0 };
}

function paramsSection(app, ed, part, def) {
  const params = { ...(def?.params || {}), ...(part.params || {}) };
  const list = h('div.prop-grid');
  const rows = Object.entries(params);
  const set = (next) => ed.doc.store.transact('Change parameters', (s) => s.update(part.id, { params: next }), { mergeKey: `params:${part.id}` });
  for (const [k, v] of rows) {
    const id = nextId('pp');
    const input = h('input', { id, type: 'text', value: v });
    input.addEventListener('input', () => set({ ...params, [k]: input.value }));
    list.append(h('label', { for: id, title: k }, k), h('div.inline', input,
      h('button.icon-btn.sm', { type: 'button', 'aria-label': `Remove parameter ${k}`, style: { flex: 'none' }, onClick: () => { const n = { ...params }; delete n[k]; set(n); } }, icon('x', 13))));
  }
  const add = h('button.btn.sm', { type: 'button', style: { margin: '0 10px 10px' }, onClick: async () => {
    const v = await formDialog({ title: 'Add parameter', fields: [{ key: 'name', label: 'Name', type: 'text', value: '', required: true }, { key: 'value', label: 'Value', type: 'text', value: '' }], confirm: 'Add' });
    if (v?.name) set({ ...params, [v.name.trim()]: v.value });
  } }, icon('plus', 13), 'Add parameter');
  return { title: 'Parameters', fields: [], extra: h('div', rows.length ? list : h('div.panel-empty.small', 'No parameters'), add) };
}

function pinsSection(app, ed, part, def) {
  const nl = app.project.netlist();
  const table = h('table.grid', h('thead', h('tr', h('th', 'Pin'), h('th', 'Name'), h('th', 'Type'), h('th', 'Net'))),
    h('tbody', placeSymbol(def, part).pins.map((p) => h('tr', h('td', p.num), h('td', p.name), h('td', PIN_TYPE_LABELS[p.type] || p.type), h('td', nl.byPin.get(`${part.id}:${p.num}`) || '')))));
  return { title: 'Pins', fields: [], extra: h('div.table-wrap', { style: { margin: '0 10px 10px', maxHeight: '240px' } }, table) };
}

// ---- Board ----

function layerOptions(ed, filter = () => true) {
  return boardLayers(ed.copperCount).filter(filter).map((l) => [l, LAYERS[l].name]);
}

function netOptions(ed) {
  return [['', 'No net'], ...Object.keys(ed.doc.nets).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((n) => [n, n])];
}

function boardSpec(app, ed) {
  const b = ed.doc.board;
  const r = ed.doc.rules;
  const bb = bboxOfFlat(b.outline);
  const u = app.settings.get('units');
  const updB = (patch, label) => ed.doc.store.transact(label, (s) => s.update('board', patch), { mergeKey: `board:${label}` });
  const a = ed.analysis();
  const comps = [...ed.doc.items()].filter((o) => o.t === 'comp').length;
  const unrouted = [...a.unrouted.values()].reduce((x, y) => x + y, 0);
  return {
    title: 'Board',
    sections: [
      {
        title: 'Board',
        fields: [
          { label: 'Name', type: 'text', value: ed.doc.name, onChange: (v) => v && app.project.renameDoc(ed.doc.id, v) },
          { label: 'Size', type: 'readonly', value: `${formatLength(bb.maxX - bb.minX, u)} x ${formatLength(bb.maxY - bb.minY, u)}` },
          { label: 'Shape', type: 'button', text: 'Set size', onClick: () => app.commands.run('pcb.boardSize') },
          { label: 'Copper layers', type: 'select', value: String(b.copper), options: [['2', '2 layers'], ['4', '4 layers'], ['6', '6 layers']], onChange: (v) => app.commands.run('pcb.setCopper', Number(v)) },
          { label: 'Thickness', type: 'length', value: b.thickness, onChange: (v) => updB({ thickness: Math.max(100_000, v) }, 'Thickness') },
          { label: 'Origin X', type: 'length', value: b.origin?.x || 0, onChange: (v) => updB({ origin: { ...b.origin, x: v } }, 'Origin') },
          { label: 'Origin Y', type: 'length', value: b.origin?.y || 0, onChange: (v) => updB({ origin: { ...b.origin, y: v } }, 'Origin') },
          { label: 'Solder mask', type: 'color', value: b.maskColor, onChange: (v) => updB({ maskColor: v }, 'Mask color') },
          { label: 'Silkscreen', type: 'color', value: b.silkColor, onChange: (v) => updB({ silkColor: v }, 'Silk color') },
          { label: 'Surface finish', type: 'select', value: b.finish || 'ENIG', options: [['ENIG', 'ENIG (gold)'], ['HASL', 'HASL (tin)'], ['OSP', 'OSP (bare copper)']], onChange: (v) => updB({ finish: v }, 'Finish') },
        ],
      },
      {
        title: 'Design rules',
        fields: [
          { label: 'Clearance', type: 'readonly', value: formatLength(r.clearance, u) },
          { label: 'Track width', type: 'readonly', value: formatLength(r.trackWidth, u) },
          { label: 'Via', type: 'readonly', value: `${formatLength(r.viaDiameter, u)} / ${formatLength(r.viaDrill, u)}` },
          { label: 'Rules', type: 'button', text: 'Edit rules', onClick: () => app.commands.run('pcb.rules') },
        ],
      },
      {
        title: 'Status',
        fields: [
          { label: 'Components', type: 'readonly', value: String(comps) },
          { label: 'Nets', type: 'readonly', value: String(Object.keys(ed.doc.nets).length) },
          { label: 'Unrouted', type: 'readonly', value: unrouted ? `${unrouted} connection${unrouted === 1 ? '' : 's'}` : 'Fully routed' },
          { label: 'Rule violations', type: 'readonly', value: String(ed.violations.length) },
        ],
      },
      {
        title: 'Grid',
        fields: [
          { label: 'Snap grid', type: 'length', value: app.settings.get('pcbGrid'), onChange: (v) => { if (v > 0) { app.settings.set('pcbGrid', v); ed.requestRender(); } } },
          { label: 'Grid style', type: 'select', value: app.settings.get('pcbGridStyle'), options: [['lines', 'Lines'], ['dots', 'Dots']], onChange: (v) => app.settings.set('pcbGridStyle', v) },
        ],
      },
    ],
  };
}

function pcbSpec(app, ed, objs) {
  const types = new Set(objs.map((o) => o.t));
  const t = types.size === 1 ? objs[0].t : null;
  const one = objs.length === 1 ? objs[0] : null;
  const o0 = ed.doc.board.origin || { x: 0, y: 0 };
  const names = { comp: 'Component', track: 'Track', arc: 'Arc', via: 'Via', pad: 'Pad', fill: 'Fill', pour: 'Polygon pour', region: 'Region', text: 'Text', dim: 'Dimension' };
  const title = t ? `${objs.length > 1 ? `${objs.length} ` : ''}${names[t]}${objs.length > 1 ? 's' : ''}` : `${objs.length} objects`;
  const sections = [];
  const L = (label, key, opts = {}) => field(objs, app, { label, type: 'length', get: (o) => o[key], set: (o, v) => ({ [key]: opts.min !== undefined ? Math.max(opts.min, v) : v }), ...opts });
  const X = (label, key) => field(objs, app, { label, type: 'length', get: (o) => o[key] - o0.x, set: (o, v) => ({ [key]: v + o0.x }) });
  const Y = (label, key) => field(objs, app, { label, type: 'length', get: (o) => o[key] - o0.y, set: (o, v) => ({ [key]: v + o0.y }) });
  const net = field(objs, app, { label: 'Net', type: 'select', options: netOptions(ed), get: (o) => o.net || '', set: (o, v) => ({ net: v || undefined }) });
  const layer = (filter) => field(objs, app, { label: 'Layer', type: 'select', options: layerOptions(ed, filter), get: (o) => o.layer, set: (o, v) => ({ layer: v }) });
  const u = app.settings.get('units');
  switch (t) {
    case 'comp': {
      const def = one ? ed.lib[one.comp] : null;
      sections.push({ title: 'General', fields: [
        one ? field(objs, app, { label: 'Designator', get: (o) => o.designator, set: (o, v) => ({ designator: v.trim() }) }) : null,
        field(objs, app, { label: 'Value', get: (o) => o.value ?? '', set: (o, v) => ({ value: v }) }),
        one ? { label: 'Footprint', type: 'readonly', value: def?.footprint?.name || one.comp } : null,
        field(objs, app, { label: 'Side', type: 'select', options: [['top', 'Top'], ['bottom', 'Bottom']], get: (o) => o.side, set: (o, v) => (o.side === v ? {} : { side: v, rot: (360 - (o.rot || 0)) % 360 }) }),
        field(objs, app, { label: 'Locked', type: 'bool', get: (o) => !!o.locked, set: (o, v) => ({ locked: v }) }),
        field(objs, app, { label: 'Hide designator', type: 'bool', get: (o) => !!o.fields?.designator?.hidden, set: (o, v) => ({ fields: { ...o.fields, designator: { ...o.fields?.designator, hidden: v } } }) }),
        field(objs, app, { label: 'Show value', type: 'bool', get: (o) => o.fields?.value?.hidden === false, set: (o, v) => ({ fields: { ...o.fields, value: { ...o.fields?.value, hidden: !v } } }) }),
      ] });
      sections.push({ title: 'Location', fields: [X('X', 'x'), Y('Y', 'y'), field(objs, app, { label: 'Rotation', type: 'angle', get: (o) => o.rot || 0, set: (o, v) => ({ rot: ((v % 360) + 360) % 360 }) })] });
      if (one && def) {
        const pads = placedOf(one, ed.lib, ed.copperCount).pads;
        const table = h('table.grid', h('thead', h('tr', h('th', 'Pad'), h('th', 'Net'), h('th', 'Size'))),
          h('tbody', pads.map((p) => h('tr', h('td', p.num), h('td', p.net || ''), h('td', `${formatLength(p.w, u)} x ${formatLength(p.shape === 'round' ? p.w : p.h, u)}`)))));
        sections.push({ title: 'Pads', fields: [], extra: h('div.table-wrap', { style: { margin: '0 10px 10px', maxHeight: '220px' } }, table) });
      }
      break;
    }
    case 'track': {
      let len = 0;
      for (const o of objs) len += Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      sections.push({ title: 'General', fields: [layer(), net, L('Width', 'w', { min: 1000 }), { label: 'Length', type: 'readonly', value: formatLength(len, u) }] });
      if (one) sections.push({ title: 'Location', fields: [X('Start X', 'x1'), Y('Start Y', 'y1'), X('End X', 'x2'), Y('End Y', 'y2')] });
      break;
    }
    case 'arc':
      sections.push({ title: 'General', fields: [layer(), net, L('Width', 'w', { min: 1000 }), L('Radius', 'r', { min: 1000 }),
        field(objs, app, { label: 'Start angle', type: 'angle', get: (o) => o.a0, set: (o, v) => ({ a0: v }) }),
        field(objs, app, { label: 'Sweep', type: 'angle', get: (o) => o.sweep, set: (o, v) => ({ sweep: Math.max(1, Math.min(360, v)) }) })] });
      if (one) sections.push({ title: 'Location', fields: [X('Center X', 'cx'), Y('Center Y', 'cy')] });
      break;
    case 'via':
      sections.push({ title: 'General', fields: [net, L('Diameter', 'd', { min: 1000 }), L('Drill', 'drill', { min: 1000 }),
        field(objs, app, { label: 'Tented', type: 'bool', get: (o) => o.tented !== false, set: (o, v) => ({ tented: v }) })] });
      sections.push({ title: 'Location', fields: [X('X', 'x'), Y('Y', 'y')] });
      break;
    case 'pad':
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Number', get: (o) => o.num || '', set: (o, v) => ({ num: v }) }), net,
        field(objs, app, { label: 'Shape', type: 'select', options: [['round', 'Round'], ['rect', 'Rectangle'], ['roundrect', 'Rounded rectangle'], ['oval', 'Oval']], get: (o) => o.shape, set: (o, v) => ({ shape: v }) }),
        L('Width', 'w', { min: 1000 }), L('Height', 'h', { min: 1000 }),
        field(objs, app, { label: 'Side', type: 'select', options: [['thru', 'Through hole'], ['top', 'Top'], ['bottom', 'Bottom']], get: (o) => o.side, set: (o, v) => ({ side: v }) }),
        L('Drill', 'drill', { min: 0 }),
        field(objs, app, { label: 'Plated', type: 'bool', get: (o) => o.plated !== false, set: (o, v) => ({ plated: v }) }),
        field(objs, app, { label: 'Rotation', type: 'angle', get: (o) => o.rot || 0, set: (o, v) => ({ rot: v }) }),
      ] });
      sections.push({ title: 'Location', fields: [X('X', 'x'), Y('Y', 'y')] });
      break;
    case 'fill':
      sections.push({ title: 'General', fields: [layer(), net] });
      if (one) sections.push({ title: 'Location', fields: [X('Left', 'x1'), Y('Bottom', 'y1'), X('Right', 'x2'), Y('Top', 'y2')] });
      break;
    case 'pour': {
      const area = objs.reduce((s, o) => s + Math.abs(polyArea(o.pts)), 0);
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Name', get: (o) => o.name || '', set: (o, v) => ({ name: v }) }),
        layer((l) => isCopper(l)), net,
        L('Clearance', 'clearance', { min: 0 }),
        field(objs, app, { label: 'Min width', type: 'length', get: (o) => o.minWidth || 0, set: (o, v) => ({ minWidth: Math.max(0, v) }) }),
        field(objs, app, { label: 'Thermal reliefs', type: 'bool', get: (o) => o.thermals !== false, set: (o, v) => ({ thermals: v }) }),
        field(objs, app, { label: 'Remove islands', type: 'bool', get: (o) => o.removeIslands !== false, set: (o, v) => ({ removeIslands: v }) }),
        field(objs, app, { label: 'Priority', type: 'number', get: (o) => o.priority || 0, set: (o, v) => ({ priority: Math.round(v) }) }),
        field(objs, app, { label: 'Shelved', type: 'bool', get: (o) => !!o.shelved, set: (o, v) => ({ shelved: v }) }),
        { label: 'Outline area', type: 'readonly', value: `${(area / 1e12).toFixed(1)} mm2` },
        { label: 'Fill', type: 'button', text: 'Repour now', onClick: () => app.commands.run('pcb.repour') },
      ] });
      break;
    }
    case 'region':
      sections.push({ title: 'General', fields: [layer(), net] });
      break;
    case 'text':
      sections.push({ title: 'General', fields: [
        field(objs, app, { label: 'Text', type: 'textarea', get: (o) => o.text, set: (o, v) => ({ text: v }) }),
        layer((l) => !['multi', 'drill'].includes(l)),
        L('Height', 'h', { min: 100_000 }), L('Stroke width', 'w', { min: 10_000 }),
        field(objs, app, { label: 'Rotation', type: 'angle', get: (o) => o.rot || 0, set: (o, v) => ({ rot: v }) }),
        field(objs, app, { label: 'Mirrored', type: 'bool', get: (o) => !!o.mirror, set: (o, v) => ({ mirror: v }) }),
      ] });
      sections.push({ title: 'Location', fields: [X('X', 'x'), Y('Y', 'y')] });
      break;
    case 'dim':
      sections.push({ title: 'General', fields: [layer(), L('Text height', 'h', { min: 100_000 }), L('Offset', 'offset'),
        one ? { label: 'Length', type: 'readonly', value: formatLength(Math.hypot(one.x2 - one.x1, one.y2 - one.y1), u) } : null] });
      break;
    default: {
      const netted = objs.filter((o) => ['track', 'via', 'arc', 'fill', 'region', 'pour', 'pad'].includes(o.t));
      const copper = objs.filter((o) => (o.t === 'track' || o.t === 'arc') && isCopper(o.layer));
      sections.push({ title: 'General', fields: [
        { label: 'Selected', type: 'readonly', value: [...types].map((x) => names[x] || x).join(', ') },
        netted.length ? field(netted, app, { label: 'Net', type: 'select', options: netOptions(ed), get: (o) => o.net || '', set: (o, v) => ({ net: v || undefined }) }) : null,
        copper.length ? field(copper, app, { label: 'Track width', type: 'length', get: (o) => o.w, set: (o, v) => ({ w: Math.max(1000, v) }) }) : null,
      ] });
    }
  }
  return { title, sections };
}

export { MIXED };
