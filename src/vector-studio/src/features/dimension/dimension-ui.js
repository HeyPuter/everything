/**
 * Dimension Options (selected dimensions, with a live preview in one undo
 * step; or the options for new dimensions and the tool's settings) and the
 * Properties panel sections: the selected dimension's value and common
 * options, and the Dimension tool's settings while it is active.
 */
import { h } from '../../lib/dom.js';
import { segmented, selectField, numberField } from '../../ui/widgets.js';
import { allFamilies } from '../type/fonts.js';
import { DIM_UNITS, DIM_DEFAULTS, END_STYLES, KIND_LABELS, dimOptions, layoutIn, dimensionLayout, createDimension, isAttached, displayUnit, arcPoints } from './dimension-model.js';
import { toolSettings, setToolSettings, newDimOptions, selectedDimensions } from './dimension-tool.js';

const UNIT_OPTIONS = [{ value: 'auto', label: 'Document / Scale' }, ...Object.entries(DIM_UNITS).map(([value, u]) => ({ value, label: u.label }))];
const SCALE_UNITS = Object.entries(DIM_UNITS)
  .filter(([k]) => k !== 'ftin' && k !== 'px')
  .map(([value, u]) => ({ value, label: u.abbr }));
const PRECISION = [0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: p ? `0.${'0'.repeat(p - 1)}1` : '1' }));
const POSITIONS = [
  { value: 'above', label: 'Above the line' },
  { value: 'center', label: 'In the line' },
  { value: 'below', label: 'Below the line' },
];
const ORIENTATIONS = [
  { value: 'aligned', label: 'Along the line' },
  { value: 'horizontal', label: 'Horizontal' },
];
const LINEAR = [
  { value: 'aligned', label: 'Aligned' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
];

let fid = 0;
const nextId = () => `dimf-${++fid}`;

function row(label, control, { id } = {}) {
  const cid = id || control.id || (control.id = nextId());
  return h('div.form-row', h('label', { for: cid }, label), control);
}

function select(options, value, label) {
  return h('select.select', { id: nextId(), 'aria-label': label }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
}

function num(value, label, { min = 0, max = 1000, step = 0.25 } = {}) {
  return h('input.dim-num', { id: nextId(), type: 'number', value: String(Number(Number(value).toFixed(3))), min, max, step, 'aria-label': label });
}

function check(value, label) {
  const id = nextId();
  const input = h('input', { type: 'checkbox', id, checked: Boolean(value) });
  return { input, el: h('div.form-row.check', input, h('label', { for: id }, label)) };
}

const sameAll = (list, f) => list.every((x) => f(x) === f(list[0]));

/** A small drawing of a sample dimension with the given options (inline SVG). */
export function dimensionSample(o, kind = 'linear') {
  const W = 260;
  const H = 96;
  const node =
    kind === 'angular'
      ? createDimension('angular', { vertex: { x: 70, y: 80 }, p1: { x: 230, y: 80 }, p2: { x: 160, y: 12 } }, { at: { x: 160, y: 45 }, dim: o })
      : kind === 'radial'
        ? createDimension('radial', { p1: { x: 90, y: 50 }, p2: { x: 124, y: 30 } }, { orient: 'radius', at: { x: 170, y: 4 }, dim: o })
        : createDimension('linear', { p1: { x: 40, y: 78 }, p2: { x: 220, y: 78 } }, { orient: 'horizontal', at: { x: 130, y: 52 }, dim: o });
  const lay = dimensionLayout(node);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'dim-sample');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Sample: ${lay.text}`);
  const el = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.append(e);
    return e;
  };
  if (kind === 'linear') for (const x of [40, 220]) el('rect', { x: x - 2, y: 78, width: 4, height: 14, class: 'dim-sample-object' });
  if (kind === 'radial') el('circle', { cx: 90, cy: 50, r: 39.4, class: 'dim-sample-object', fill: 'none' });
  if (kind === 'angular') el('path', { d: 'M230 80H70L160 12', class: 'dim-sample-object', fill: 'none' });
  const stroke = { stroke: o.lineColor, 'stroke-width': o.lineWidth, fill: 'none' };
  for (const [a, b] of lay.segments) el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...stroke });
  for (const arc of lay.arcs) el('polyline', { points: arcPoints(arc.cx, arc.cy, arc.r, arc.a0, arc.sweep).map((p) => `${p.x},${p.y}`).join(' '), ...stroke });
  for (const e of lay.ends) {
    const L = o.endSize;
    const n = { x: -e.uy, y: e.ux };
    const B = { x: e.x - e.ux * L, y: e.y - e.uy * L };
    if (o.ends === 'arrow') el('polygon', { points: `${e.x},${e.y} ${B.x + n.x * L * 0.3},${B.y + n.y * L * 0.3} ${B.x - n.x * L * 0.3},${B.y - n.y * L * 0.3}`, fill: o.lineColor });
    else if (o.ends === 'open') el('polyline', { points: `${B.x + n.x * L * 0.36},${B.y + n.y * L * 0.36} ${e.x},${e.y} ${B.x - n.x * L * 0.36},${B.y - n.y * L * 0.36}`, ...stroke });
    else if (o.ends === 'tick') {
      const v = { x: (e.ux + n.x) / Math.SQRT2, y: (e.uy + n.y) / Math.SQRT2 };
      el('line', { x1: e.x - (v.x * L) / 2, y1: e.y - (v.y * L) / 2, x2: e.x + (v.x * L) / 2, y2: e.y + (v.y * L) / 2, ...stroke, 'stroke-width': o.lineWidth * 1.6 });
    } else if (o.ends === 'dot') el('circle', { cx: e.x, cy: e.y, r: Math.max(0.75, L / 5), fill: o.lineColor });
  }
  const L = lay.label;
  const t = el('text', { x: 0, y: o.fontSize * 0.35, 'text-anchor': 'middle', 'font-family': o.fontFamily, 'font-size': o.fontSize, fill: o.textColor, transform: `translate(${L.x} ${L.y}) rotate(${(L.angle * 180) / Math.PI})` });
  t.textContent = lay.text;
  return svg;
}

/**
 * Dimension Options. With `nodes`, edits them (preview while open, one
 * undo step); otherwise sets the options for new dimensions, and with
 * `tool` the Dimension tool's settings too. Returns the options or null.
 */
export async function dimensionOptionsDialog(app, { nodes = [], tool = false } = {}) {
  const ed = app.editor;
  const doc = ed?.doc;
  const editing = Boolean(nodes.length && doc);
  const o = editing ? dimOptions(nodes[0].dim) : newDimOptions(app);
  const ts = toolSettings(app);
  const kinds = new Set(nodes.map((n) => n.kind));
  const sampleKind = editing ? nodes[0].kind : ts.kind;
  const families = allFamilies().map((f) => f.family);
  if (!families.includes(o.fontFamily)) families.unshift(o.fontFamily);

  // ---- controls ----
  const c = {
    units: select(UNIT_OPTIONS, o.units, 'Units'),
    precision: select(PRECISION, String(o.precision), 'Precision'),
    showUnits: check(o.showUnits, 'Show the unit'),
    scaleOn: check(o.scale.on, 'Use a drawing scale'),
    paper: num(o.scale.paper, 'Drawing length', { min: 0.0001, max: 100000 }),
    paperUnit: select(SCALE_UNITS, o.scale.paperUnit, 'Drawing unit'),
    real: num(o.scale.real, 'Real length', { min: 0.0001, max: 100000 }),
    realUnit: select(SCALE_UNITS, o.scale.realUnit, 'Real unit'),
    prefix: h('input', { id: nextId(), type: 'text', value: o.prefix, spellcheck: false, autocomplete: 'off' }),
    suffix: h('input', { id: nextId(), type: 'text', value: o.suffix, spellcheck: false, autocomplete: 'off' }),
    symbol: check(o.symbol, 'Radius and diameter symbols (R, Ø)'),
    fontFamily: select(families.map((f) => ({ value: f, label: f })), o.fontFamily, 'Font'),
    fontSize: num(o.fontSize, 'Font size', { min: 1, max: 500, step: 0.5 }),
    textColor: h('input', { id: nextId(), type: 'color', value: o.textColor }),
    labelPosition: select(POSITIONS, o.labelPosition, 'Label position'),
    labelOrientation: select(ORIENTATIONS, o.labelOrientation, 'Label orientation'),
    lineColor: h('input', { id: nextId(), type: 'color', value: o.lineColor }),
    lineWidth: num(o.lineWidth, 'Line weight', { min: 0.1, max: 50 }),
    ends: select(Object.entries(END_STYLES).map(([value, label]) => ({ value, label })), o.ends, 'Ends'),
    endSize: num(o.endSize, 'End size', { min: 1, max: 100, step: 0.5 }),
    extension: check(o.extension, 'Extension lines'),
    extGap: num(o.extGap, 'Gap from object', { min: 0, max: 500 }),
    extOvershoot: num(o.extOvershoot, 'Past the line', { min: 0, max: 500 }),
    centerMark: check(o.centerMark, 'Center mark (radial)'),
  };
  // Type-specific controls.
  const linearOnly = editing && kinds.size === 1 && kinds.has('linear');
  const radialOnly = editing && kinds.size === 1 && kinds.has('radial');
  const orient = linearOnly ? select(sameAll(nodes, (n) => n.orient) && nodes[0].orient === 'rotated' ? [...LINEAR, { value: 'rotated', label: 'Rotated' }] : LINEAR, sameAll(nodes, (n) => n.orient) ? nodes[0].orient : '', 'Measure') : null;
  const radial = radialOnly ? select([{ value: 'radius', label: 'Radius' }, { value: 'diameter', label: 'Diameter' }], sameAll(nodes, (n) => n.orient) ? nodes[0].orient : '', 'Measure') : null;
  const toolKind = tool ? select(Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })), ts.kind, 'Type') : null;
  const toolOrient = tool ? select([{ value: 'auto', label: 'Auto' }, ...LINEAR], ts.orient, 'Linear') : null;
  const toolRadial = tool ? select([{ value: 'radius', label: 'Radius' }, { value: 'diameter', label: 'Diameter' }], ts.radial, 'Radial') : null;
  const toolAssoc = tool ? check(ts.associative, 'Attach to measured objects') : null;
  const preview = editing ? check(true, 'Preview') : null;

  const sampleBox = h('div.dim-sample-box');
  const scaleRow = h('div.form-row', h('span.form-label', 'Scale'), h('div.dim-scale', c.paper, c.paperUnit, h('span', { 'aria-hidden': 'true' }, '='), c.real, c.realUnit));
  const body = h(
    'div.form.dim-options',
    sampleBox,
    tool ? [h('h3.form-heading', 'Tool'), row('Type', toolKind), row('Linear', toolOrient), row('Radial', toolRadial), toolAssoc.el] : null,
    orient ? row('Measure', orient) : null,
    radial ? row('Measure', radial) : null,
    h('h3.form-heading', 'Value'),
    row('Units', c.units),
    row('Precision', c.precision),
    c.showUnits.el,
    c.scaleOn.el,
    scaleRow,
    row('Prefix', c.prefix),
    row('Suffix', c.suffix),
    !editing || kinds.has('radial') ? c.symbol.el : null,
    h('h3.form-heading', 'Label'),
    row('Font', c.fontFamily),
    row('Size (pt)', c.fontSize),
    row('Color', c.textColor),
    row('Position', c.labelPosition),
    row('Orientation', c.labelOrientation),
    h('h3.form-heading', 'Lines'),
    row('Color', c.lineColor),
    row('Weight (pt)', c.lineWidth),
    row('Ends', c.ends),
    row('End size (pt)', c.endSize),
    c.extension.el,
    row('Gap from object (pt)', c.extGap),
    row('Past the line (pt)', c.extOvershoot),
    !editing || kinds.has('radial') ? c.centerMark.el : null,
    preview ? preview.el : null,
  );

  const n = (el, fallback) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  const read = () => ({
    units: c.units.value,
    precision: Number(c.precision.value),
    showUnits: c.showUnits.input.checked,
    scale: { on: c.scaleOn.input.checked, paper: Math.max(0.0001, n(c.paper, 1)), paperUnit: c.paperUnit.value, real: Math.max(0.0001, n(c.real, 1)), realUnit: c.realUnit.value },
    prefix: c.prefix.value,
    suffix: c.suffix.value,
    symbol: c.symbol.input.checked,
    fontFamily: c.fontFamily.value,
    fontSize: Math.max(1, n(c.fontSize, o.fontSize)),
    textColor: c.textColor.value,
    labelPosition: c.labelPosition.value,
    labelOrientation: c.labelOrientation.value,
    lineColor: c.lineColor.value,
    lineWidth: Math.max(0.1, n(c.lineWidth, o.lineWidth)),
    ends: c.ends.value,
    endSize: Math.max(1, n(c.endSize, o.endSize)),
    extension: c.extension.input.checked,
    extGap: Math.max(0, n(c.extGap, o.extGap)),
    extOvershoot: Math.max(0, n(c.extOvershoot, o.extOvershoot)),
    centerMark: c.centerMark.input.checked,
  });
  const patchFor = (node, v) => {
    const p = { dim: { ...dimOptions(node.dim), ...v } };
    if (orient?.value && node.kind === 'linear' && orient.value !== node.orient) p.orient = orient.value;
    if (radial?.value && node.kind === 'radial') p.orient = radial.value;
    return p;
  };
  let tx = null;
  const sync = () => {
    const v = read();
    const scaleOn = v.scale.on;
    for (const el of [c.paper, c.paperUnit, c.real, c.realUnit]) el.disabled = !scaleOn;
    c.extGap.disabled = c.extOvershoot.disabled = !v.extension;
    c.showUnits.input.disabled = v.units === 'ftin';
    sampleBox.replaceChildren(dimensionSample(dimOptions(v), sampleKind));
    if (!editing) return;
    tx?.cancel();
    tx = null;
    if (!preview.input.checked) return;
    tx = doc.begin('Dimension Options');
    for (const node of nodes) if (doc.has(node.id)) doc.update(node.id, patchFor(node, v));
  };
  body.addEventListener('input', sync);
  body.addEventListener('change', sync);
  sync();
  let ok;
  try {
    ok = await app.dialogs.open({
      title: editing ? 'Dimension Options' : tool ? 'Dimension Tool Options' : 'Dimension Options (New Dimensions)',
      body,
      className: 'dim-dialog',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'OK', primary: true, value: true },
      ],
    });
  } finally {
    tx?.cancel();
    tx = null;
  }
  if (!ok) return null;
  const v = read();
  if (editing) {
    doc.transact('Dimension Options', () => {
      for (const node of nodes) if (doc.has(node.id)) doc.update(node.id, patchFor(doc.get(node.id), v));
    });
  }
  // The options last chosen are used for new dimensions too.
  app.prefs.set('dimensionOptions', v);
  if (tool) setToolSettings(app, { kind: toolKind.value, orient: toolOrient.value, radial: toolRadial.value, associative: toolAssoc.input.checked });
  return v;
}

// ---- Properties panel ----

function update(app, patchOf, label, coalesce = null) {
  const ed = app.editor;
  const dims = selectedDimensions(ed);
  if (!dims.length) return;
  ed.doc.transact(label, () => dims.forEach((d) => ed.doc.update(d.id, patchOf(d))), { coalesce });
}

const setOpt = (app, key, value, label = 'Dimension Options', coalesce = null) => update(app, (d) => ({ dim: { ...dimOptions(d.dim), [key]: value } }), label, coalesce);

/** The selected dimensions' section: value, type, units, precision, label position, ends, size and actions. */
export function dimensionSection() {
  return {
    id: 'dimension',
    title: 'Dimension',
    when: (ed) => selectedDimensions(ed).length > 0 && selectedDimensions(ed).length === ed.selection.size,
    build(app) {
      const value = h('output.dim-value', { 'aria-live': 'polite' });
      const units = selectField('Units', UNIT_OPTIONS, 'auto', (v) => setOpt(app, 'units', v));
      const precision = selectField('Precision', PRECISION, '2', (v) => setOpt(app, 'precision', Number(v)));
      const measure = selectField('Measure', [...LINEAR, { value: 'radius', label: 'Radius' }, { value: 'diameter', label: 'Diameter' }], 'aligned', (v) =>
        update(app, (d) => (d.kind === 'linear' && LINEAR.some((x) => x.value === v)) || (d.kind === 'radial' && (v === 'radius' || v === 'diameter')) ? { orient: v } : {}, 'Dimension Type'),
      );
      const position = segmented(
        'Label position',
        POSITIONS.map((p) => ({ value: p.value, text: { above: 'Above', center: 'In line', below: 'Below' }[p.value], label: p.label })),
        'above',
        (v) => setOpt(app, 'labelPosition', v),
      );
      const ends = selectField('Ends', Object.entries(END_STYLES).map(([v, l]) => ({ value: v, label: l })), 'arrow', (v) => setOpt(app, 'ends', v));
      const size = numberField({ label: 'Font size', kind: 'number', value: DIM_DEFAULTS.fontSize, min: 1, max: 500, step: 0.5, onCommit: (v, opts) => setOpt(app, 'fontSize', v, 'Dimension Font Size', opts?.live ? 'dim-size' : null) });
      const scale = h('p.dim-scale-note');
      const measureRow = h('div.prop-row', h('span.prop-label', 'Measure'), measure.el);
      const btn = (label, cmd) => h('button.btn', { type: 'button', onclick: () => app.commands.run(cmd) }, label);
      const detach = btn('Detach', 'dimension.detach');
      const el = h(
        'div.dim-section',
        h('div.prop-row', h('span.prop-label', 'Value'), value),
        measureRow,
        h('div.prop-row', h('span.prop-label', 'Units'), units.el),
        h('div.prop-row', h('span.prop-label', 'Precision'), precision.el),
        h('div.prop-row', h('span.prop-label', 'Label'), position.el),
        h('div.prop-row', h('span.prop-label', 'Ends'), ends.el),
        h('div.prop-row', h('span.prop-label', 'Font size'), size.el),
        scale,
        h('div.quick-actions', btn('Options…', 'dimension.options'), detach, btn('Expand', 'object.expand')),
      );
      return {
        el,
        refresh() {
          const ed = app.editor;
          const dims = selectedDimensions(ed);
          if (!dims.length) return;
          const os = dims.map((d) => dimOptions(d.dim));
          const one = (k) => (os.every((x) => x[k] === os[0][k]) ? os[0][k] : '');
          value.textContent = dims.length === 1 ? layoutIn(ed.doc, dims[0]).text : `${dims.length} dimensions`;
          units.set(one('units'));
          precision.set(String(one('precision')));
          position.set(one('labelPosition'));
          ends.set(one('ends'));
          size.set(os.every((x) => x.fontSize === os[0].fontSize) ? os[0].fontSize : 'mixed');
          const kinds = new Set(dims.map((d) => d.kind));
          measureRow.hidden = kinds.size !== 1 || kinds.has('angular');
          measure.set(dims.every((d) => d.orient === dims[0].orient) ? dims[0].orient : '');
          const sc = os[0].scale;
          scale.textContent = sc.on ? `Scale ${sc.paper} ${DIM_UNITS[sc.paperUnit]?.abbr} = ${sc.real} ${DIM_UNITS[sc.realUnit]?.abbr} · ${DIM_UNITS[displayUnit(os[0], ed.doc.root.units)].label}` : `Shown in ${DIM_UNITS[displayUnit(os[0], ed.doc.root.units)].label.toLowerCase()}`;
          detach.hidden = !dims.some(isAttached);
        },
      };
    },
  };
}

/** The Dimension tool's settings, shown while it is active with no dimension selected. */
export function dimensionToolSection() {
  let appRef = null;
  return {
    id: 'dimension-tool',
    title: 'Dimension Tool',
    noSelection: true,
    when: (ed) => appRef?.toolId === 'dimension' && !(selectedDimensions(ed).length && selectedDimensions(ed).length === ed.selection.size),
    build(app) {
      appRef = app;
      const kind = segmented('Dimension type', Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label, text: label })), 'linear', (v) => setToolSettings(app, { kind: v }));
      const orient = selectField('Linear orientation', [{ value: 'auto', label: 'Auto' }, ...LINEAR], 'auto', (v) => setToolSettings(app, { orient: v }));
      const radial = selectField('Radial', [{ value: 'radius', label: 'Radius' }, { value: 'diameter', label: 'Diameter' }], 'radius', (v) => setToolSettings(app, { radial: v }));
      const assocId = nextId();
      const assoc = h('input', { type: 'checkbox', id: assocId, onchange: () => setToolSettings(app, { associative: assoc.checked }) });
      const orientRow = h('div.prop-row', h('span.prop-label', 'Orientation'), orient.el);
      const radialRow = h('div.prop-row', h('span.prop-label', 'Measure'), radial.el);
      const el = h(
        'div.dim-section',
        kind.el,
        orientRow,
        radialRow,
        h('div.check-row', assoc, h('label', { for: assocId }, 'Attach to measured objects')),
        h('div.quick-actions', h('button.btn', { type: 'button', onclick: () => dimensionOptionsDialog(app, { tool: true }) }, 'Tool Options…')),
      );
      return {
        el,
        refresh() {
          const s = toolSettings(app);
          kind.set(s.kind);
          orient.set(s.orient);
          radial.set(s.radial);
          assoc.checked = s.associative;
          orientRow.hidden = s.kind !== 'linear';
          radialRow.hidden = s.kind !== 'radial';
        },
      };
    },
  };
}
