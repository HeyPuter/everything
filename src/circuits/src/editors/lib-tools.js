// Component editor tools: pins, pads and drawing primitives. Each placement
// is one undo step. Space rotates, Tab edits the next object's settings,
// Esc or right click stops.

import { uid } from '../core/emitter.js';
import { pack } from '../render/color.js';
import { mm, formatLength, parseLength } from '../core/units.js';
import { polyArea, simplifyPolyline } from '../core/geom.js';
import { formDialog, promptDialog } from '../ui/dialog.js';
import { PIN_TYPES, PIN_TYPE_LABELS } from '../model/schema.js';
import { SCH_TEXT } from '../model/sch.js';
import { nextLabel } from './lib-model.js';

const DEG = Math.PI / 180;
const norm = (a) => ((a % 360) + 360) % 360;

function crosshair(b, ed, x, y) {
  const s = 12 * ed.nmPerPx;
  const c = pack(ed.palette.crosshair || ed.palette.selection, 0.85);
  b.line(x - s, y, x + s, y, 0, c);
  b.line(x, y - s, x, y + s, 0, c);
}

/** Length input; values below min (positive lengths by default) are refused. */
const lengthField = (key, label, value, units, min = 1) => ({
  key, label: `${label} (${units})`, type: 'text', value: formatLength(value, units, { suffix: false }),
  parse: (v) => { const n = parseLength(v, units); return n !== null && n >= min ? n : null; },
  error: min > 0 ? 'enter a length greater than zero' : 'enter a length',
});

/** Places pins; numbers and names count up after each one. */
export class PinTool {
  constructor(editor) {
    this.editor = editor;
    this.name = 'pin';
    this.abId = 'pin';
    this.cursor = 'crosshair';
    this.template = editor.nextPinTemplate();
  }
  hint() { return `Click to place pin ${this.template.num} (${this.template.name || 'no name'}). Space rotates, Tab edits, Esc stops`; }
  click(ev) {
    const pin = { ...this.template, id: uid(), x: ev.x, y: ev.y };
    this.editor.doc.store.transact('Place pin', (s) => s.add(pin));
    this.template = { ...this.template, num: nextLabel(this.template.num), name: nextLabel(this.template.name) };
    this.editor.updateHint();
  }
  async edit() {
    const t = this.template;
    const v = await formDialog({
      title: 'Next pin', confirm: 'Apply',
      fields: [
        { key: 'num', label: 'Number', type: 'text', value: t.num, required: true },
        { key: 'name', label: 'Name', type: 'text', value: t.name },
        { key: 'type', label: 'Electrical type', type: 'select', value: t.type, options: PIN_TYPES.map((p) => [p, PIN_TYPE_LABELS[p]]) },
        lengthField('length', 'Length', t.length, 'mil'),
      ],
    });
    if (v) this.template = { ...t, ...v };
    this.editor.updateHint();
    this.editor.canvas.focus();
  }
  key(e, combo) {
    if (combo === 'Space') { this.template = { ...this.template, rot: norm(this.template.rot + 90) }; return true; }
    if (combo === 'Shift+Space') { this.template = { ...this.template, rot: norm(this.template.rot + 270) }; return true; }
    if (combo === 'Tab') { this.edit(); return true; }
    if (combo === 'Escape') { this.editor.endTool(); return true; }
    return false;
  }
  rightClick() { this.editor.endTool(); return true; }
  drawOverlay(b) {
    const c = this.editor.cursor;
    if (!c.inside) return;
    this.editor.drawObject(b, { ...this.template, t: 'pin', x: c.x, y: c.y }, pack(this.editor.palette.preview || this.editor.palette.selection, 0.9));
    crosshair(b, this.editor, c.x, c.y);
  }
}

/** Places pads; numbers count up after each one. */
export class PadTool {
  constructor(editor) {
    this.editor = editor;
    this.name = 'pad';
    this.abId = 'pad';
    this.cursor = 'crosshair';
  }
  get template() { return this.editor.padTemplate; }
  hint() {
    const t = this.template;
    return `Click to place pad ${t.num}: ${t.shape}, ${formatLength(t.w, 'mm')} x ${formatLength(t.shape === 'round' ? t.w : t.h, 'mm')}${t.side === 'thru' ? `, hole ${formatLength(t.drill, 'mm')}` : ''}. Tab edits, Space rotates`;
  }
  click(ev) {
    const pad = { ...this.template, t: 'pad', id: uid(), x: ev.x, y: ev.y };
    this.editor.doc.store.transact('Place pad', (s) => s.add(pad));
    this.editor.padTemplate = { ...this.template, num: nextLabel(this.template.num) };
    this.editor.updateHint();
  }
  async edit() {
    const v = await padDialog(this.template, 'Next pad');
    if (v) this.editor.padTemplate = { ...this.template, ...v };
    this.editor.updateHint();
    this.editor.canvas.focus();
  }
  key(e, combo) {
    if (combo === 'Space') { this.editor.padTemplate = { ...this.template, rot: norm((this.template.rot || 0) + 90) }; return true; }
    if (combo === 'Tab') { this.edit(); return true; }
    if (combo === 'Escape') { this.editor.endTool(); return true; }
    return false;
  }
  rightClick() { this.editor.endTool(); return true; }
  drawOverlay(b) {
    const c = this.editor.cursor;
    if (!c.inside) return;
    this.editor.drawObject(b, { ...this.template, t: 'pad', x: c.x, y: c.y }, pack(this.editor.palette.preview || this.editor.palette.selection, 0.8));
    crosshair(b, this.editor, c.x, c.y);
  }
}

export async function padDialog(t, title = 'Pad') {
  const v = await formDialog({
    title, confirm: 'Apply',
    fields: [
      { key: 'num', label: 'Number', type: 'text', value: t.num ?? '' },
      { key: 'shape', label: 'Shape', type: 'select', value: t.shape, options: [['round', 'Round'], ['rect', 'Rectangle'], ['roundrect', 'Rounded rectangle'], ['oval', 'Oval']] },
      lengthField('w', 'Width', t.w, 'mm'),
      lengthField('h', 'Height', t.h ?? t.w, 'mm'),
      { key: 'rot', label: 'Rotation (degrees)', type: 'number', value: t.rot || 0 },
      { key: 'side', label: 'Side', type: 'select', value: t.side, options: [['top', 'Top (surface mount)'], ['thru', 'Through hole'], ['bottom', 'Bottom (surface mount)']] },
      lengthField('drill', 'Hole', t.drill || 0, 'mm', 0),
      { key: 'plated', label: 'Plated hole', type: 'bool', value: t.plated !== false },
    ],
  });
  if (!v) return null;
  v.rot = ((v.rot % 360) + 360) % 360;
  if (v.side !== 'thru') v.drill = 0;
  else if (!(v.drill > 0)) v.drill = Math.round(Math.min(v.w, v.h) * 0.5);
  return v;
}

/**
 * Drawing tools: line (chained), rect, circle, arc (center, start, end),
 * poly (click corners, double click or Enter closes), text.
 */
export class ShapeTool {
  constructor(editor, kind) {
    this.editor = editor;
    this.kind = kind;
    this.name = kind;
    this.abId = kind;
    this.cursor = 'crosshair';
    this.pts = [];
  }
  hint() {
    const k = this.kind, n = this.pts.length / 2;
    if (k === 'arc') return ['Click the arc center', 'Click the start point (sets the radius)', 'Click the end point (counter-clockwise)'][n];
    if (k === 'poly') return n ? 'Click to add corners, double click or Enter to close' : 'Click the first corner';
    if (k === 'text') return 'Click to place text';
    if (k === 'circle') return n ? 'Click to set the radius' : 'Click the circle center';
    return n ? 'Click to finish' : `Click to start the ${k === 'rect' ? 'rectangle' : 'line'}`;
  }
  _style() { return this.editor.graphicStyle(this.kind); }
  _shape(x, y) {
    const p = this.pts, s = this._style();
    switch (this.kind) {
      case 'line': return { t: 'line', x1: p[0], y1: p[1], x2: x, y2: y, ...s };
      case 'rect': return { t: 'rect', x1: Math.min(p[0], x), y1: Math.min(p[1], y), x2: Math.max(p[0], x), y2: Math.max(p[1], y), ...s };
      case 'circle': return { t: 'circle', cx: p[0], cy: p[1], r: Math.round(Math.hypot(x - p[0], y - p[1])), ...s };
      case 'poly': return { t: 'poly', pts: [...p, x, y], ...s };
      case 'arc': {
        const r = Math.round(Math.hypot(p[2] - p[0], p[3] - p[1]));
        const a0 = norm(Math.atan2(p[3] - p[1], p[2] - p[0]) / DEG);
        let sweep = p.length >= 4 && (x !== p[2] || y !== p[3]) ? norm(Math.atan2(y - p[1], x - p[0]) / DEG - a0) : 0;
        if (sweep < 1) sweep = 360;
        return { t: 'arc', cx: p[0], cy: p[1], r, a0: Math.round(a0 * 100) / 100, sweep: Math.round(sweep * 100) / 100, ...s };
      }
      default: return null;
    }
  }
  _commit(o, label) {
    this.editor.doc.store.transact(label, (s) => s.add({ ...o, id: uid() }));
  }
  async click(ev) {
    const { x, y } = ev;
    const k = this.kind;
    if (k === 'text') {
      const text = await promptDialog({ title: 'Text', label: 'Text', value: '', validate: (v) => (!v ? 'Enter some text' : null) });
      this.editor.canvas.focus();
      if (text) this._commit({ t: 'text', x, y, text, size: this.editor.mode === 'symbol' ? SCH_TEXT : mm(1), rot: 0, ...this._style() }, 'Place text');
      return;
    }
    if (!this.pts.length) { this.pts = [x, y]; this.editor.updateHint(); return; }
    if (k === 'poly') {
      const n = this.pts.length;
      if (n >= 6 && x === this.pts[0] && y === this.pts[1]) { this.finish(); return; }
      if (x !== this.pts[n - 2] || y !== this.pts[n - 1]) this.pts.push(x, y);
      this.editor.updateHint();
      return;
    }
    if (k === 'arc' && this.pts.length === 2) {
      if (x === this.pts[0] && y === this.pts[1]) return;
      this.pts.push(x, y);
      this.editor.updateHint();
      return;
    }
    const o = this._shape(x, y);
    const empty = (o.t === 'line' && o.x1 === o.x2 && o.y1 === o.y2) || (o.t === 'rect' && (o.x1 === o.x2 || o.y1 === o.y2)) || ((o.t === 'circle' || o.t === 'arc') && !o.r);
    if (!empty) this._commit(o, `Place ${k}`);
    // Lines chain from the last point.
    this.pts = k === 'line' && !empty ? [x, y] : [];
    this.editor.updateHint();
  }
  finish() {
    if (this.kind === 'poly' && this.pts.length >= 6) {
      const pts = simplifyPolyline(this.pts);
      if (pts.length >= 6 && Math.abs(polyArea(pts)) > 0) this._commit({ t: 'poly', pts, ...this._style() }, 'Place polygon');
    }
    this.pts = [];
    this.editor.updateHint();
  }
  dblclick() { if (this.kind === 'poly') this.finish(); else if (this.kind === 'line') { this.pts = []; this.editor.updateHint(); } }
  rightClick() {
    if (this.kind === 'poly' && this.pts.length >= 6) this.finish();
    else if (this.pts.length) { this.pts = []; this.editor.updateHint(); } else this.editor.endTool();
    return true;
  }
  key(e, combo) {
    if (combo === 'Enter' && this.kind === 'poly') { this.finish(); return true; }
    if (combo === 'Backspace' && this.pts.length) { this.pts = this.pts.slice(0, -2); this.editor.updateHint(); return true; }
    if (combo === 'Escape') { if (this.pts.length) { this.pts = []; this.editor.updateHint(); } else this.editor.endTool(); return true; }
    return false;
  }
  deactivate() { this.pts = []; }
  drawOverlay(b) {
    const ed = this.editor, c = ed.cursor;
    const col = pack(ed.palette.preview || ed.palette.selection, 0.9);
    if (this.pts.length) {
      if (this.kind === 'arc' && this.pts.length === 2) b.line(this.pts[0], this.pts[1], c.x, c.y, 0, pack(ed.palette.selection, 0.5));
      else {
        const o = this._shape(c.x, c.y);
        if (o) ed.drawObject(b, o, col);
      }
    }
    if (c.inside) crosshair(b, ed, c.x, c.y);
  }
}
