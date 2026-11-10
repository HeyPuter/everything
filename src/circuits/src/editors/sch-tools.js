// Schematic placement tools. Each tool previews into the overlay batch and
// commits through one store transaction per placed object, so every
// placement is a separate undo step.
//
// Common keys while placing: Space rotates, X / Y mirror, Tab edits the
// object's properties before placing it, Esc or right click stops.

import { uid } from '../core/emitter.js';
import { pack } from '../render/color.js';
import { cornerPoint, simplifyPolyline } from '../core/geom.js';
import { mil } from '../core/units.js';
import { drawSchObject } from '../render/sch-scene.js';
import { rotateSch, mirrorSch, SCH_TEXT, WIRE_W, BUS_W, LINE_W } from '../model/sch.js';
import { nextDesignator } from '../model/annotate.js';
import { promptDialog, formDialog } from '../ui/dialog.js';

const CORNERS = ['90start', '90end', '45start', '45end', 'any'];
const CORNER_LABEL = { '90start': '90 degrees, horizontal first', '90end': '90 degrees, vertical first', '45start': '45 degrees start', '45end': '45 degrees end', any: 'any angle' };

// Keys that turn what a placing tool holds. The drawing tools have nothing to
// turn but still take them, or they would fall through to the commands that
// rotate and mirror the selection left from before the tool started.
const TURN_KEYS = new Set(['Space', 'Shift+Space', 'X', 'Y']);

/** Increments the trailing number of a label: NET1 -> NET2, D0 -> D1. */
export function incrementName(s) {
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return s;
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}

function crosshair(b, ed, x, y) {
  const s = 12 * ed.nmPerPx;
  const c = pack(ed.palette.crosshair, 0.8);
  b.line(x - s, y, x + s, y, 0, c);
  b.line(x, y - s, x, y + s, 0, c);
}

/** Places copies of a template object; Space/X/Y/Tab adjust it. */
class PlaceTool {
  constructor(editor, { name, hint, template, onPlaced }) {
    this.editor = editor;
    this.name = name;
    this.cursor = 'crosshair';
    this._hint = hint;
    this.template = { ...template, x: 0, y: 0 };
    this.onPlaced = onPlaced;
  }
  hint() { return this._hint; }
  current() {
    const c = this.editor.cursor;
    return { ...this.template, x: c.x, y: c.y };
  }
  click(ev) {
    const obj = { ...this.template, x: ev.x, y: ev.y, id: uid() };
    this.editor.doc.store.transact(`Place ${this.name}`, (s) => s.add(this.finalize(obj)));
    this.onPlaced?.(this);
    this.editor.announce(`${this.name} placed`);
  }
  finalize(o) { return o; }
  key(e, combo) {
    if (combo === 'Space') { this.template = rotateSch(this.template, 0, 0, 90); return true; }
    if (combo === 'Shift+Space') { this.template = rotateSch(this.template, 0, 0, 270); return true; }
    if (combo === 'X') { this.template = mirrorSch(this.template, 0, 0, 'x'); return true; }
    if (combo === 'Y') { this.template = mirrorSch(this.template, 0, 0, 'y'); return true; }
    if (combo === 'Tab') { this.editTemplate?.(); return true; }
    if (combo === 'Escape') { this.editor.endTool(); return true; }
    return false;
  }
  rightClick() { this.editor.endTool(); return true; }
  drawOverlay(b) {
    if (!this.editor.cursor.inside) return;
    const o = this.current();
    drawSchObject(b, o, this.editor.lib, this.editor.palette, pack(this.editor.palette.preview, 0.85));
  }
}

export class PlacePartTool extends PlaceTool {
  constructor(editor, def, { repeat = true } = {}) {
    super(editor, {
      name: def.name,
      hint: 'Click to place. Space rotates, X / Y mirror, Tab edits, Esc stops',
      template: { t: 'part', comp: def.id, rot: 0, mirror: false, designator: '', value: def.value ?? '' },
    });
    this.def = def;
    this.repeat = repeat;
    this.nextDes();
  }
  nextDes() {
    this.template.designator = nextDesignator(this.editor.project.sheetObjects(), this.def.prefix || 'U');
  }
  finalize(o) { return { ...o, uid: uid('u'), params: { ...(this.def.params || {}) } }; }
  click(ev) {
    super.click(ev);
    if (!this.repeat) { this.editor.endTool(); return; }
    this.nextDes();
  }
  async editTemplate() {
    const v = await formDialog({
      title: `Place ${this.def.name}`,
      fields: [
        { key: 'designator', label: 'Designator', type: 'text', value: this.template.designator, required: true },
        { key: 'value', label: 'Value', type: 'text', value: this.template.value },
      ],
      confirm: 'Apply',
    });
    if (v) Object.assign(this.template, v);
    this.editor.canvas.focus();
  }
}

export class LabelTool extends PlaceTool {
  constructor(editor) {
    super(editor, { name: 'net label', hint: 'Click on a wire or pin to name its net. Tab edits the name, Space rotates', template: { t: 'label', rot: 0, text: editor.lastLabel || 'NET1' } });
  }
  click(ev) {
    super.click(ev);
    this.editor.lastLabel = this.template.text = incrementName(this.template.text);
  }
  async editTemplate() {
    const v = await promptDialog({ title: 'Net label', label: 'Net name', value: this.template.text, validate: (t) => (!t ? 'Enter a net name' : /\s/.test(t) ? 'Net names cannot contain spaces' : null) });
    if (v) this.template.text = v;
    this.editor.canvas.focus();
  }
}

export class PowerTool extends PlaceTool {
  constructor(editor, { net = 'VCC', style = 'bar' } = {}) {
    super(editor, { name: style === 'gnd' ? 'ground port' : 'power port', hint: 'Click to place. Tab changes the net name and style, Space rotates', template: { t: 'power', rot: 0, net, style } });
  }
  async editTemplate() {
    const v = await formDialog({
      title: 'Power port',
      fields: [
        { key: 'net', label: 'Net', type: 'text', value: this.template.net, required: true },
        { key: 'style', label: 'Style', type: 'select', value: this.template.style, options: [['bar', 'Bar'], ['arrow', 'Arrow'], ['circle', 'Circle'], ['wave', 'Wave'], ['gnd', 'Power ground'], ['signalgnd', 'Signal ground'], ['earth', 'Earth']] },
      ],
      confirm: 'Apply',
    });
    if (v) Object.assign(this.template, v);
    this.editor.canvas.focus();
  }
}

export class PortTool extends PlaceTool {
  constructor(editor) {
    super(editor, { name: 'port', hint: 'Click to place. Ports join nets of the same name across sheets. Tab edits', template: { t: 'port', rot: 0, name: 'PORT1', io: 'bidir' } });
  }
  click(ev) { super.click(ev); this.template.name = incrementName(this.template.name); }
  async editTemplate() {
    const v = await formDialog({
      title: 'Port',
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: this.template.name, required: true },
        { key: 'io', label: 'Direction', type: 'select', value: this.template.io, options: [['unspec', 'Unspecified'], ['in', 'Input'], ['out', 'Output'], ['bidir', 'Bidirectional']] },
      ],
      confirm: 'Apply',
    });
    if (v) Object.assign(this.template, v);
    this.editor.canvas.focus();
  }
}

export class MarkerTool extends PlaceTool {
  constructor(editor, kind) {
    super(editor, { name: kind === 'junction' ? 'junction' : 'no ERC marker', hint: kind === 'junction' ? 'Click where crossing wires should connect' : 'Click on a pin to suppress its unconnected warning', template: { t: kind } });
  }
  key(e, combo) { if (['Space', 'X', 'Y', 'Tab'].includes(combo)) return true; return super.key(e, combo); }
}

export class TextTool extends PlaceTool {
  constructor(editor) {
    super(editor, { name: 'text', hint: 'Click to place text. Tab edits it first, Space rotates', template: { t: 'text', rot: 0, text: 'Text', size: SCH_TEXT } });
  }
  async click(ev) {
    const text = await promptDialog({ title: 'Text', label: 'Text', value: this.template.text === 'Text' ? '' : this.template.text, validate: (t) => (!t ? 'Enter some text' : null) });
    this.editor.canvas.focus();
    if (!text) return;
    this.template.text = text;
    this.editor.doc.store.transact('Place text', (s) => s.add({ ...this.template, x: ev.x, y: ev.y, id: uid() }));
  }
  async editTemplate() {
    const v = await promptDialog({ title: 'Text', label: 'Text', value: this.template.text });
    if (v) this.template.text = v;
    this.editor.canvas.focus();
  }
}

/**
 * Wires, buses and graphic lines. Click to start and to add corners; the
 * last segment follows the corner style (Shift+Space cycles it). Clicking a
 * pin, wire or other connection ends the wire there. Backspace removes the
 * last corner; double click, right click or Esc finishes.
 */
export class WireTool {
  constructor(editor, kind = 'wire') {
    this.editor = editor;
    this.kind = kind;
    this.name = kind;
    this.cursor = 'crosshair';
    this.pts = null;
    this.clicks = []; // pts length before each click, so Backspace undoes a whole click
    this.corner = editor.app.settings.get('schCorner') || '90start';
    this.snapPins = kind !== 'gline';
  }
  hint() {
    const what = this.kind === 'gline' ? 'line' : this.kind;
    return this.pts
      ? `Click to add a corner, click a connection or double click to finish. Shift+Space: ${CORNER_LABEL[this.corner]}. Backspace undoes a corner`
      : `Click to start a ${what}. Esc stops`;
  }
  _path(x, y) {
    if (!this.pts) return null;
    const n = this.pts.length;
    const ax = this.pts[n - 2], ay = this.pts[n - 1];
    const c = cornerPoint(ax, ay, x, y, this.corner);
    return c ? [...this.pts, c[0], c[1], x, y] : [...this.pts, x, y];
  }
  click(ev) {
    const { x, y } = ev;
    if (!this.pts) { this.pts = [x, y]; this.clicks = []; this.editor.updateHint(); return; }
    const path = this._path(x, y);
    const n = this.pts.length;
    if (this.pts[n - 2] === x && this.pts[n - 1] === y) { this.finish(); return; }
    this.clicks.push(n);
    this.pts = path;
    // Ending on an existing connection finishes the wire automatically.
    if (this.snapPins && this.editor.isConnectionPoint(x, y, this.kind)) this.finish();
  }
  dblclick() { this.finish(); }
  rightClick() {
    if (this.pts) { this.finish(); return true; }
    this.editor.endTool();
    return true;
  }
  finish() {
    if (this.pts && this.pts.length >= 4) {
      const pts = simplifyPolyline(this.pts);
      if (pts.length >= 4) {
        const obj = this.kind === 'gline' ? { t: 'gline', pts, w: LINE_W } : { t: this.kind, pts };
        this.editor.doc.store.transact(`Place ${this.kind === 'gline' ? 'line' : this.kind}`, (s) => s.add({ ...obj, id: uid() }));
      }
    }
    this.pts = null;
    this.editor.updateHint();
  }
  key(e, combo) {
    if (combo === 'Shift+Space') {
      this.corner = CORNERS[(CORNERS.indexOf(this.corner) + 1) % CORNERS.length];
      this.editor.app.settings.set('schCorner', this.corner);
      this.editor.updateHint();
      return true;
    }
    if (combo === 'Backspace') {
      // Drop the last click together with the corner it added. Swallowed
      // even with nothing left, so one press too many does not fall through
      // to Delete and remove the selection.
      if (!this.pts) return true;
      if (this.clicks.length) this.pts = this.pts.slice(0, this.clicks.pop()); else this.pts = null;
      this.editor.updateHint();
      return true;
    }
    if (combo === 'Enter' && this.pts) { this.finish(); return true; }
    if (combo === 'Escape') {
      if (this.pts) this.finish(); else this.editor.endTool();
      return true;
    }
    return TURN_KEYS.has(combo);
  }
  deactivate() { this.finish(); }
  drawOverlay(b) {
    const ed = this.editor;
    const c = ed.cursor;
    const col = pack(ed.palette.preview);
    const w = this.kind === 'bus' ? BUS_W : this.kind === 'gline' ? LINE_W : WIRE_W;
    if (this.pts) {
      const path = this._path(c.x, c.y);
      b.polyline(path, w, col);
    }
    if (c.inside) {
      crosshair(b, ed, c.x, c.y);
      if (c.target) b.ring(c.x, c.y, mil(30), mil(6), pack(ed.palette.highlight));
    }
  }
}

/** Rectangles and circles: press-drag or click twice. */
export class ShapeTool {
  constructor(editor, kind) {
    this.editor = editor;
    this.kind = kind;
    this.name = kind === 'grect' ? 'rectangle' : 'circle';
    this.cursor = 'crosshair';
    this.start = null;
  }
  hint() { return this.start ? 'Click to set the size' : `Click or drag to draw a ${this.name}`; }
  _obj(x, y) {
    const s = this.start;
    if (this.kind === 'grect') return { t: 'grect', x1: s.x, y1: s.y, x2: x, y2: y, w: LINE_W };
    return { t: 'gcircle', cx: s.x, cy: s.y, r: Math.round(Math.hypot(x - s.x, y - s.y)), w: LINE_W };
  }
  commit(x, y) {
    const o = this._obj(x, y);
    this.start = null;
    if ((o.t === 'grect' && (o.x1 === o.x2 || o.y1 === o.y2)) || (o.t === 'gcircle' && !o.r)) return;
    this.editor.doc.store.transact(`Place ${this.name}`, (s) => s.add({ ...o, id: uid() }));
    this.editor.updateHint();
  }
  click(ev) {
    if (!this.start) { this.start = { x: ev.x, y: ev.y }; this.editor.updateHint(); } else this.commit(ev.x, ev.y);
  }
  dragStart(ev) { this.start = { x: ev.x, y: ev.y }; }
  drag() {}
  dragEnd(ev) { if (this.start) this.commit(ev.x, ev.y); }
  rightClick() { if (this.start) { this.start = null; this.editor.updateHint(); } else this.editor.endTool(); return true; }
  key(e, combo) {
    if (combo === 'Escape') { if (this.start) { this.start = null; this.editor.updateHint(); } else this.editor.endTool(); return true; }
    return TURN_KEYS.has(combo);
  }
  drawOverlay(b) {
    const c = this.editor.cursor;
    if (this.start) drawSchObject(b, this._obj(c.x, c.y), this.editor.lib, this.editor.palette, pack(this.editor.palette.preview));
    if (c.inside) crosshair(b, this.editor, c.x, c.y);
  }
}

export { crosshair };
