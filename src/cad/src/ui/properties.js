/**
 * Properties palette: shows and edits the properties of the selection
 * (grouped by object type) or, with nothing selected, the current
 * properties for new objects.
 */
import { h, clear, nextId } from './dom.js';
import { icon } from './icons.js';
import { colorLabel, colorCss } from '../core/colors.js';
import { LINEWEIGHTS, LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT } from '../core/schema.js';
import {
  formatLinear,
  formatAngle,
  formatDirection,
  parseLength,
  parseAngle,
} from '../core/units.js';
import { lengthOf, areaOf } from '../core/geom/index.js';
import { dimensionText } from '../core/dims.js';
import { patternNames } from '../core/hatch/patterns.js';
import { lwLabel } from './combos.js';
import { preserveFocus, keepScroll } from './focus.js';

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

const TYPE_LABEL = {
  line: 'Line',
  xline: 'Construction line',
  ray: 'Ray',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
  polyline: 'Polyline',
  spline: 'Spline',
  point: 'Point',
  text: 'Text',
  mtext: 'Multiline text',
  dimension: 'Dimension',
  leader: 'Leader',
  hatch: 'Hatch',
  insert: 'Block reference',
};

// Field helpers. kind: length | angle | number | text | textarea | select | bool | ro
const L = (label, key, extra) => ({ label, kind: 'length', get: (e) => e[key], set: (e, v) => ({ [key]: v }), ...extra });
const A = (label, key, extra) => ({ label, kind: 'angle', get: (e) => e[key], set: (e, v) => ({ [key]: v }), ...extra });
const RO = (label, get, kind = 'length') => ({ label, kind: 'ro', fmt: kind, get });
/** Obliquing angles are limited to ±85 degrees, as in AutoCAD: the slant grows as tan(angle). */
const MAX_OBLIQUE = (85 * Math.PI) / 180;
const obliqueOk = (a) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) <= MAX_OBLIQUE + 1e-9;

const GEOMETRY = {
  line: [
    L('Start X', 'x1'),
    L('Start Y', 'y1'),
    L('End X', 'x2'),
    L('End Y', 'y2'),
    RO('Delta X', (e) => e.x2 - e.x1),
    RO('Delta Y', (e) => e.y2 - e.y1),
    {
      label: 'Length',
      kind: 'length',
      get: (e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1),
      set: (e, v) => {
        const l = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1;
        return { x2: e.x1 + ((e.x2 - e.x1) / l) * v, y2: e.y1 + ((e.y2 - e.y1) / l) * v };
      },
      min: 1e-12,
    },
    {
      label: 'Angle',
      kind: 'angle',
      get: (e) => norm(Math.atan2(e.y2 - e.y1, e.x2 - e.x1)),
      set: (e, v) => {
        const l = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        return { x2: e.x1 + Math.cos(v) * l, y2: e.y1 + Math.sin(v) * l };
      },
    },
  ],
  xline: [L('Base point X', 'x'), L('Base point Y', 'y'), { label: 'Direction', kind: 'angle', get: (e) => norm(Math.atan2(e.dy, e.dx)), set: (e, v) => ({ dx: Math.cos(v), dy: Math.sin(v) }) }],
  circle: [
    L('Center X', 'cx'),
    L('Center Y', 'cy'),
    L('Radius', 'r', { min: 1e-12 }),
    { label: 'Diameter', kind: 'length', get: (e) => e.r * 2, set: (e, v) => ({ r: v / 2 }), min: 1e-12 },
    { label: 'Circumference', kind: 'length', get: (e) => e.r * TAU, set: (e, v) => ({ r: v / TAU }), min: 1e-12 },
    { label: 'Area', kind: 'area', get: (e) => Math.PI * e.r * e.r, set: (e, v) => ({ r: Math.sqrt(v / Math.PI) }), min: 1e-12 },
  ],
  arc: [
    L('Center X', 'cx'),
    L('Center Y', 'cy'),
    L('Radius', 'r', { min: 1e-12 }),
    A('Start angle', 'start'),
    A('End angle', 'end'),
    RO('Total angle', (e) => norm(e.end - e.start) || TAU, 'angle'),
    RO('Arc length', (e) => e.r * (norm(e.end - e.start) || TAU)),
  ],
  ellipse: [
    L('Center X', 'cx'),
    L('Center Y', 'cy'),
    { label: 'Major radius', kind: 'length', get: (e) => Math.hypot(e.mx, e.my), set: (e, v) => { const m = Math.hypot(e.mx, e.my) || 1; return { mx: (e.mx / m) * v, my: (e.my / m) * v }; }, min: 1e-12 },
    { label: 'Minor radius', kind: 'length', get: (e) => Math.hypot(e.mx, e.my) * e.ratio, set: (e, v) => ({ ratio: Math.min(1, v / (Math.hypot(e.mx, e.my) || 1)) }), min: 1e-12 },
    { label: 'Radius ratio', kind: 'number', get: (e) => e.ratio, set: (e, v) => ({ ratio: Math.min(1, Math.max(1e-6, v)) }) },
    A('Start parameter', 'start'),
    A('End parameter', 'end'),
  ],
  polyline: [
    { label: 'Vertices', kind: 'ro', fmt: 'int', get: (e) => e.pts.length / 3 },
    { label: 'Global width', kind: 'length', get: (e) => e.width || 0, set: (e, v) => ({ width: Math.max(0, v) }) },
    { label: 'Closed', kind: 'bool', get: (e) => !!e.closed, set: (e, v) => ({ closed: v }) },
    RO('Length', (e) => safe(() => lengthOf(e))),
    RO('Area', (e) => (e.closed ? safe(() => areaOf(e)) : NaN), 'area'),
  ],
  spline: [
    { label: 'Degree', kind: 'ro', fmt: 'int', get: (e) => e.degree },
    { label: 'Fit points', kind: 'ro', fmt: 'int', get: (e) => (e.fit?.length || 0) / 2 },
    { label: 'Control points', kind: 'ro', fmt: 'int', get: (e) => e.ctrl.length / 2 },
    { label: 'Closed', kind: 'ro', fmt: 'bool', get: (e) => !!e.closed },
    RO('Length', (e) => safe(() => lengthOf(e))),
  ],
  point: [L('Position X', 'x'), L('Position Y', 'y')],
  text: [
    { label: 'Contents', kind: 'text', get: (e) => e.value, set: (e, v) => ({ value: v }) },
    { label: 'Style', kind: 'select', options: (d) => [...d.textStyles.keys()], get: (e) => e.style, set: (e, v) => ({ style: v }) },
    {
      label: 'Justify',
      kind: 'select',
      options: () => ['left|baseline', 'center|baseline', 'right|baseline', 'left|middle', 'center|middle', 'right|middle', 'left|top', 'center|top', 'right|top', 'left|bottom', 'center|bottom', 'right|bottom'],
      label2: (v) => v.replace('|', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      get: (e) => `${e.halign || 'left'}|${e.valign || 'baseline'}`,
      set: (e, v) => {
        const [halign, valign] = v.split('|');
        return { halign, valign };
      },
    },
    L('Height', 'h', { min: 1e-9 }),
    A('Rotation', 'rot'),
    { label: 'Width factor', kind: 'number', get: (e) => e.widthFactor ?? 1, set: (e, v) => ({ widthFactor: Math.max(0.01, v) }) },
    A('Obliquing', 'oblique', { valid: obliqueOk }),
    L('Position X', 'x'),
    L('Position Y', 'y'),
  ],
  mtext: [
    { label: 'Contents', kind: 'textarea', get: (e) => e.value, set: (e, v) => ({ value: v }) },
    { label: 'Style', kind: 'select', options: (d) => [...d.textStyles.keys()], get: (e) => e.style, set: (e, v) => ({ style: v }) },
    {
      label: 'Attachment',
      kind: 'select',
      options: () => ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'],
      label2: (v) => ({ t: 'Top', m: 'Middle', b: 'Bottom' })[v[0]] + ' ' + ({ l: 'left', c: 'center', r: 'right' })[v[1]],
      get: (e) => e.attach || 'tl',
      set: (e, v) => ({ attach: v }),
    },
    L('Text height', 'h', { min: 1e-9 }),
    A('Rotation', 'rot'),
    L('Defined width', 'width'),
    { label: 'Line spacing factor', kind: 'number', get: (e) => e.lineSpacing ?? 1, set: (e, v) => ({ lineSpacing: Math.max(0.25, v) }) },
    L('Position X', 'x'),
    L('Position Y', 'y'),
  ],
  dimension: [
    { label: 'Dim style', kind: 'select', options: (d) => [...d.dimStyles.keys()], get: (e) => e.style, set: (e, v) => ({ style: v }) },
    { label: 'Type', kind: 'ro', fmt: 'text', get: (e) => e.dimType[0].toUpperCase() + e.dimType.slice(1) },
    { label: 'Measurement', kind: 'ro', fmt: 'dim', get: (e) => e },
    { label: 'Text override', kind: 'text', get: (e) => e.text || '', set: (e, v) => ({ text: v }), placeholder: 'Measured value' },
  ],
  leader: [
    { label: 'Text', kind: 'text', get: (e) => e.text || '', set: (e, v) => ({ text: v }) },
    L('Text height', 'h', { min: 1e-9 }),
    { label: 'Dim style', kind: 'select', options: (d) => [...d.dimStyles.keys()], get: (e) => e.style, set: (e, v) => ({ style: v }) },
  ],
  hatch: [
    { label: 'Pattern', kind: 'select', options: () => patternNames(), get: (e) => e.pattern, set: (e, v) => ({ pattern: v }) },
    { label: 'Scale', kind: 'number', get: (e) => e.scale ?? 1, set: (e, v) => ({ scale: Math.max(1e-6, v) }) },
    A('Angle', 'angle'),
    { label: 'Loops', kind: 'ro', fmt: 'int', get: (e) => e.loops?.length || 0 },
    RO('Area', (e) => safe(() => areaOf(e)), 'area'),
  ],
  insert: [
    { label: 'Name', kind: 'select', options: (d) => [...d.blocks.keys()], get: (e) => e.name, set: (e, v) => ({ name: v }) },
    L('Position X', 'x'),
    L('Position Y', 'y'),
    { label: 'Scale X', kind: 'number', get: (e) => e.sx ?? 1, set: (e, v) => (v ? { sx: v } : {}) },
    { label: 'Scale Y', kind: 'number', get: (e) => e.sy ?? 1, set: (e, v) => (v ? { sy: v } : {}) },
    A('Rotation', 'rot'),
  ],
};
GEOMETRY.ray = GEOMETRY.xline;

function safe(fn) {
  try {
    return fn();
  } catch {
    return NaN;
  }
}

/** The drawing each rendered selection belongs to. */
const owners = new WeakMap();

export class PropertiesPalette {
  constructor(app) {
    this.app = app;
    this.filter = 'all';
    this.collapsed = loadCollapsed();
    this.typeSelect = h('select.input.sm', { 'aria-label': 'Objects to show' });
    this.typeSelect.addEventListener('change', () => {
      this.filter = this.typeSelect.value;
      this.render();
    });
    this.body = h('div.props-body');
    this.el = h(
      'div.props',
      h(
        'div.props-head',
        this.typeSelect,
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Quick select', 'data-tip': 'Quick select', onClick: () => app.run('QSELECT') }, icon('quick-select', 16)),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Select all', 'data-tip': 'Select all', onClick: () => app.run('SELECTALL') }, icon('select-all', 16)),
      ),
      this.body,
    );
  }

  /** Re-render if visible. */
  refresh() {
    if (!this.el.isConnected) return;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      const force = this._forceRender;
      preserveFocus(this.el, () => this.render());
      this._forceRender = false;
      const a = document.activeElement;
      if (force && this.el.contains(a) && a.matches('input[type=text]')) a.select();
    });
  }

  render() {
    if (!this.app.doc) return;
    const app = this.app;
    const doc = app.doc;
    if (!doc) return;
    // Keep focus on an input that is being edited, unless the fields belong
    // to a drawing that is no longer active.
    if (!this._forceRender && doc === this._doc && this.el.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    const d = doc.drawing;
    const sel = [...doc.selection].map((id) => d.get(id)).filter(Boolean);
    const groups = new Map();
    for (const e of sel) {
      if (!groups.has(e.type)) groups.set(e.type, []);
      groups.get(e.type).push(e);
    }
    clear(this.typeSelect);
    if (!sel.length) {
      this.typeSelect.append(h('option', { value: 'none' }, 'No selection'));
      this.typeSelect.disabled = true;
    } else {
      this.typeSelect.disabled = groups.size === 1;
      if (groups.size > 1) this.typeSelect.append(h('option', { value: 'all' }, `All (${sel.length})`));
      for (const [t, list] of groups) this.typeSelect.append(h('option', { value: t }, `${TYPE_LABEL[t] ?? t} (${list.length})`));
      if (this.filter !== 'all' && !groups.has(this.filter)) this.filter = 'all';
      if (groups.size === 1) this.filter = [...groups.keys()][0];
      this.typeSelect.value = this.filter;
    }
    // The dock scrolls the palette.
    const restoreScroll = keepScroll(this.el.parentElement);
    clear(this.body);
    this._doc = doc;
    if (!sel.length) {
      this.body.append(this.section('General', this.currentFields()));
      this.body.append(this.section('View', this.viewFields(), true));
      restoreScroll();
      return;
    }
    const ents = this.filter === 'all' ? sel : groups.get(this.filter) || sel;
    // Fields commit to the drawing they were built for, even if another one
    // has become active since (see apply).
    owners.set(ents, d);
    this.body.append(this.section('General', this.generalFields(ents)));
    if (this.filter !== 'all' || groups.size === 1) {
      const type = ents[0].type;
      const fields = GEOMETRY[type] || [];
      const geo = fields.map((f) => this.entityField(f, ents));
      const title = ['text', 'mtext'].includes(type) ? 'Text' : type === 'dimension' || type === 'leader' ? 'Annotation' : type === 'hatch' ? 'Pattern' : type === 'insert' ? 'Block' : 'Geometry';
      this.body.append(this.section(title, geo));
      if (type === 'polyline' && ents.length === 1) this.body.append(this.section('Vertices', this.vertexFields(ents[0]), true));
    }
    restoreScroll();
  }

  section(title, rows, startCollapsed = false) {
    const open = !(this.collapsed[title] ?? startCollapsed);
    const det = h('details.props-sec', { open }, h('summary.props-sum', h('span', title)), h('div.props-grid', rows));
    det.addEventListener('toggle', () => {
      this.collapsed[title] = !det.open;
      saveCollapsed(this.collapsed);
    });
    return det;
  }

  row(label, control) {
    const id = nextId('prop');
    // A stable key per field so focus survives re-rendering.
    control.dataset.key = `prop:${label}`;
    if (control instanceof HTMLElement && (control.matches('input, select, textarea') || control.querySelector('input, select'))) {
      const target = control.matches('input, select, textarea') ? control : control.querySelector('input, select');
      target.id = id;
    }
    return [h('label.props-label', { for: id }, label), h('div.props-val', control)];
  }

  /** Commit a patch function to every entity in `ents` as one step. */
  apply(ents, patchFn, label = 'Change properties') {
    const d = owners.get(ents) ?? this.app.doc.drawing;
    d.transaction(label, () => {
      for (const e of ents) {
        const cur = d.get(e.id);
        if (!cur) continue;
        const p = patchFn(cur);
        if (p && Object.keys(p).length) d.update(e.id, p);
      }
    });
  }

  generalFields(ents) {
    const d = this.app.doc.drawing;
    const common = (k) => {
      const v = ents[0][k];
      return ents.every((e) => e[k] === v) ? v : undefined;
    };
    const rows = [];
    rows.push(...this.row('Color', this.colorControl(common('color'), (v) => this.apply(ents, () => ({ color: v }), 'Change color'))));
    rows.push(
      ...this.row(
        'Layer',
        this.select([...d.layers.keys()], common('layer'), (v) => this.apply(ents, () => ({ layer: v }), 'Change layer')),
      ),
    );
    rows.push(
      ...this.row(
        'Linetype',
        this.select(['ByLayer', 'ByBlock', ...d.linetypes.keys()], common('linetype'), (v) => this.apply(ents, () => ({ linetype: v }), 'Change linetype')),
      ),
    );
    rows.push(...this.row('Linetype scale', this.numberInput(common('ltscale') ?? (ents.every((e) => e.ltscale === undefined) ? 1 : undefined), (v) => v > 0 && this.apply(ents, () => ({ ltscale: v })))));
    rows.push(
      ...this.row(
        'Lineweight',
        this.select([LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT, ...LINEWEIGHTS], common('lineweight'), (v) => this.apply(ents, () => ({ lineweight: Number(v) })), lwLabel),
      ),
    );
    return rows;
  }

  currentFields() {
    const app = this.app;
    const d = app.doc.drawing;
    const hd = d.header;
    const rows = [];
    rows.push(...this.row('Color', this.colorControl(hd.ccolor, (v) => app.applyProperty('color', v))));
    rows.push(...this.row('Layer', this.select([...d.layers.keys()], hd.clayer, (v) => app.setCurrentLayer(v))));
    rows.push(...this.row('Linetype', this.select(['ByLayer', 'ByBlock', ...d.linetypes.keys()], hd.cltype, (v) => app.applyProperty('linetype', v))));
    rows.push(...this.row('Lineweight', this.select([LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT, ...LINEWEIGHTS], hd.clweight, (v) => app.applyProperty('lineweight', Number(v)), lwLabel)));
    rows.push(...this.row('Global linetype scale', this.numberInput(hd.ltscale, (v) => v > 0 && d.transaction('Linetype scale', () => d.setHeader({ ltscale: v })))));
    rows.push(...this.row('Text height', this.lengthInput(hd.textHeight, (v) => v > 0 && d.transaction('Text height', () => d.setHeader({ textHeight: v })))));
    return rows;
  }

  viewFields() {
    const cam = this.app.camera;
    const hd = this.app.doc.drawing.header;
    const rows = [];
    rows.push(...this.row('Center X', h('output.props-ro', formatLinear(cam.cx, hd))));
    rows.push(...this.row('Center Y', h('output.props-ro', formatLinear(cam.cy, hd))));
    rows.push(...this.row('Width', h('output.props-ro', formatLinear(cam.width / cam.scale, hd))));
    rows.push(...this.row('Height', h('output.props-ro', formatLinear(cam.height / cam.scale, hd))));
    return rows;
  }

  vertexFields(ent) {
    const d = this.app.doc.drawing;
    const rows = [];
    const n = Math.min(ent.pts.length / 3, 200);
    for (let i = 0; i < n; i++) {
      const set = (k) => (v) => {
        const pts = d.get(ent.id).pts.slice();
        pts[i * 3 + k] = v;
        d.transaction('Edit vertex', () => d.update(ent.id, { pts }));
      };
      rows.push(...this.row(`Vertex ${i + 1} X`, this.lengthInput(ent.pts[i * 3], set(0))));
      rows.push(...this.row(`Vertex ${i + 1} Y`, this.lengthInput(ent.pts[i * 3 + 1], set(1))));
    }
    return rows;
  }

  entityField(f, ents) {
    const d = this.app.doc.drawing;
    const hd = d.header;
    const vals = ents.map((e) => safe(() => f.get(e)));
    const same = vals.every((v) => v === vals[0] || (typeof v === 'number' && Math.abs(v - vals[0]) < 1e-12));
    const v = same ? vals[0] : undefined;
    if (f.kind === 'ro') {
      let text = '';
      if (v === undefined) text = 'Varies';
      else if (f.fmt === 'angle') text = formatAngle(v, hd, { symbol: true });
      else if (f.fmt === 'int') text = String(v);
      else if (f.fmt === 'bool') text = v ? 'Yes' : 'No';
      else if (f.fmt === 'text') text = String(v);
      else if (f.fmt === 'area') text = Number.isFinite(v) ? v.toFixed(hd.linearPrecision ?? 4) : '';
      else if (f.fmt === 'dim') {
        const ds = d.dimStyles.get(v.style) ?? d.dimStyles.get('Standard');
        text = dimensionText({ ...v, text: '' }, ds, hd);
      } else text = Number.isFinite(v) ? formatLinear(v, hd) : '';
      return this.row(f.label, h('output.props-ro', text));
    }
    const commit = (val) => this.apply(ents, (e) => f.set(e, val));
    let control;
    switch (f.kind) {
      case 'length':
        control = this.lengthInput(v, (x) => (f.min === undefined || x >= f.min) && commit(x));
        break;
      case 'area':
        control = this.numberInput(v, (x) => x > 0 && commit(x));
        break;
      case 'angle':
        control = this.angleInput(v, (x) => (!f.valid || f.valid(x)) && commit(x));
        break;
      case 'number':
        control = this.numberInput(v, commit);
        break;
      case 'text':
        control = this.textInput(v, commit, f.placeholder);
        break;
      case 'textarea':
        control = this.textArea(v, commit);
        break;
      case 'bool':
        control = this.select([true, false], v, (x) => commit(x === 'true' || x === true), (b) => (b ? 'Yes' : 'No'));
        break;
      case 'select':
        control = this.select(f.options(d), v, commit, f.label2);
        break;
    }
    return this.row(f.label, control);
  }

  // Controls ------------------------------------------------------------------

  _input(value, display, parse, onCommit, attrs = {}) {
    const inp = h('input.input.sm', { type: 'text', value: display(value), placeholder: value === undefined ? 'Varies' : '', spellcheck: 'false', ...attrs });
    let orig = inp.value;
    const reject = () => {
      inp.value = orig;
      inp.setAttribute('aria-invalid', 'true');
      setTimeout(() => inp.removeAttribute('aria-invalid'), 1200);
      return false;
    };
    // Returns false when the value was rejected (unparsable, or out of range: onCommit returns false).
    const commit = () => {
      if (inp.value === orig) return true;
      const v = parse(inp.value);
      if (v === null || (typeof v === 'number' && !Number.isFinite(v))) return reject();
      const prev = orig;
      orig = inp.value;
      if (onCommit(v) !== false) return true;
      orig = prev;
      return reject();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const ok = commit();
        inp.select();
        if (!ok) return;
        // Show the formatted value and the values that depend on it.
        this._forceRender = true;
        this.refresh();
      } else if (e.key === 'Escape') {
        inp.value = orig;
        inp.select();
      }
    });
    inp.addEventListener('blur', () => {
      commit();
      this.refresh();
    });
    return inp;
  }

  lengthInput(v, onCommit) {
    const hd = this.app.doc.drawing.header;
    return this._input(v, (x) => (x === undefined || !Number.isFinite(x) ? '' : formatLinear(x, hd)), (s) => parseLength(s, hd), onCommit, { inputmode: 'decimal' });
  }

  angleInput(v, onCommit) {
    const hd = this.app.doc.drawing.header;
    return this._input(v, (x) => (x === undefined || !Number.isFinite(x) ? '' : formatDirection(x, hd)), (s) => parseAngle(s, hd), onCommit, { inputmode: 'decimal' });
  }

  numberInput(v, onCommit) {
    return this._input(v, (x) => (x === undefined || !Number.isFinite(x) ? '' : String(+x.toFixed(6))), (s) => (s.trim() === '' ? null : Number(s)), onCommit, { inputmode: 'decimal' });
  }

  textInput(v, onCommit, placeholder) {
    const inp = this._input(v, (x) => x ?? '', (s) => s, onCommit);
    if (placeholder && v !== undefined) inp.placeholder = placeholder;
    return inp;
  }

  textArea(v, onCommit) {
    const ta = h('textarea.input.sm', { rows: 3, spellcheck: 'true' });
    ta.value = v ?? '';
    let orig = ta.value;
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => {
      if (ta.value !== orig) {
        orig = ta.value;
        onCommit(ta.value);
      }
      this.refresh();
    });
    return ta;
  }

  select(options, value, onChange, labelFn) {
    const sel = h('select.input.sm');
    if (value === undefined) sel.append(h('option', { value: '', disabled: true, selected: true }, 'Varies'));
    // A value the list lacks (an imported hatch pattern, a missing style) is still shown.
    else if (!options.some((o) => String(o) === String(value))) options = [value, ...options];
    for (const o of options) {
      sel.append(h('option', { value: String(o), selected: value !== undefined && String(o) === String(value) }, labelFn ? labelFn(o) : String(o)));
    }
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const match = options.find((o) => String(o) === raw);
      onChange(match ?? raw);
    });
    return sel;
  }

  colorControl(value, onChange) {
    const app = this.app;
    const btn = h(
      'button.input.sm.color-field',
      {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-label': `Color: ${value === undefined ? 'varies' : colorLabel(value)}`,
        onClick: async () => {
          const c = await app.colorDialog(value);
          if (c !== null && c !== undefined) onChange(c);
        },
      },
      value === undefined ? null : h('span.swatch', { style: { background: colorCss(value) } }),
      h('span', value === undefined ? 'Varies' : colorLabel(value)),
    );
    return btn;
  }
}

function loadCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem('cad.propsCollapsed') || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function saveCollapsed(c) {
  try {
    localStorage.setItem('cad.propsCollapsed', JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
