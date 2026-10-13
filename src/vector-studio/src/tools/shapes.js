/**
 * Shape tools: Rectangle (M), Rounded Rectangle, Ellipse (L), Polygon,
 * Star, Line Segment (\), Arc, Spiral, Rectangular Grid and Polar Grid.
 *
 * Drag to draw (Shift constrains to a square/circle or 45 degrees, Alt
 * draws from the center, Space held moves the shape being drawn); click
 * without dragging to enter exact values.
 * While dragging a polygon or star the Up/Down arrow keys change the number
 * of sides or points; for a rounded rectangle they change the radius (Left
 * and Right Arrow give square or fully rounded corners).
 */
import { Tool, fmt, constrain45, constrainAngle } from './tool.js';
import { createPath, createGroup, createCompound } from '../model/nodes.js';
import * as S from '../model/shapes.js';
import { buildSnapIndex, snapPoint } from './snap.js';
import { newPathStyle } from './pen.js';
import { rotate } from '../lib/matrix.js';
import { transformAnchors } from '../model/bezier.js';

/**
 * Drawing planes: a feature can have the shape tools draw onto a plane
 * (the perspective grid). Each provider is (editor, tool) => plane | null,
 * a plane being { toPlane(x, y) -> point | null, insert(doc, node, parentId,
 * descendants) -> id to select }. Shapes are then built in plane
 * coordinates and inserted through the plane.
 */
export const drawingPlanes = new Set();

function drawingPlane(editor, tool) {
  for (const fn of drawingPlanes) {
    const plane = fn(editor, tool);
    if (plane) return plane;
  }
  return null;
}

/**
 * A group of paths (and compound paths, `{ compound: [anchors...] }`) built
 * by a grid tool: { group, descendants } ready for doc.insert.
 */
function buildGroup(items, base) {
  const descendants = [];
  const kids = items.map((n) => {
    if (n.compound) {
      const parts = n.compound.map((anchors) => createPath(anchors, true, {}));
      const c = createCompound(parts.map((p) => p.id), { ...base, ...n.style }, { fillRule: 'evenodd' });
      for (const p of parts) p.parent = c.id;
      descendants.push(...parts);
      return c;
    }
    return createPath(n.anchors, n.closed, { ...base, ...n.style });
  });
  const group = createGroup(kids.map((k) => k.id));
  for (const k of kids) k.parent = group.id;
  descendants.push(...kids);
  return { group, descendants };
}

class DragShapeTool extends Tool {
  static fromCenter = false;

  constructor(app) {
    super(app);
    this.drag = null;
    this.cursor = 'crosshair';
  }

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  deactivate() {
    this.cancel();
  }

  onPointerDown(e) {
    const editor = this.editor;
    if (!editor.canDrawInTarget()) {
      this.app.notify('The target layer is locked or hidden.');
      return;
    }
    const snap = buildSnapIndex(editor);
    const plane = drawingPlane(editor, this);
    const p = this.toPlane(plane, snapPoint(editor, e.x, e.y, snap));
    if (!p) return;
    this.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, sx0: e.sx, sy0: e.sy, snap, tx: null, id: null, moved: false, shift: e.shift, alt: e.alt, plane };
  }

  /** A document point in the drawing plane's coordinates (itself without a plane). */
  toPlane(plane, p) {
    return plane ? plane.toPlane(p.x, p.y) : { x: p.x, y: p.y };
  }

  /** Insert a new shape (and descendants) in the target layer, through the drawing plane if any. Returns the id to select. */
  place(doc, node, descendants, plane) {
    if (plane) return plane.insert(doc, node, this.editor.targetLayer().id, descendants);
    return this.editor.insertDrawn(node, descendants);
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const editor = this.editor;
    if (!d.moved && Math.hypot(e.sx - d.sx0, e.sy - d.sy0) < 3) return;
    d.moved = true;
    const last = this.toPlane(d.plane, d.last || e);
    const cur = this.toPlane(d.plane, e);
    if (!last || !cur) return;
    d.last = { x: e.x, y: e.y };
    if (this.app.input?.spaceDown) {
      // Holding Space repositions the shape being drawn instead of resizing it.
      const dx = cur.x - last.x;
      const dy = cur.y - last.y;
      d.x0 += dx;
      d.y0 += dy;
      d.x += dx;
      d.y += dy;
      this.update(e);
      return;
    }
    const s = snapPoint(editor, e.x, e.y, d.snap);
    const p = this.toPlane(d.plane, s);
    if (!p) return;
    editor.alignmentGuides = { lines: s.lines, labels: s.labels };
    d.x = p.x;
    d.y = p.y;
    d.shift = e.shift;
    d.alt = e.alt;
    d.mod = e.mod;
    this.update(e);
  }

  /** Box from the drag with Shift (square) and Alt (from center) applied. */
  box(d) {
    let w = d.x - d.x0;
    let h = d.y - d.y0;
    if (d.shift) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    if (d.alt || this.constructor.fromCenter) return { x: d.x0 - Math.abs(w), y: d.y0 - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 };
    return { x: Math.min(d.x0, d.x0 + w), y: Math.min(d.y0, d.y0 + h), w: Math.abs(w), h: Math.abs(h) };
  }

  update(e) {
    const d = this.drag;
    const editor = this.editor;
    const doc = editor.doc;
    const built = this.build(d);
    if (!built) return;
    if (!d.tx) {
      d.tx = doc.begin(this.constructor.label.replace(' Tool', ''));
      const nodes = Array.isArray(built) ? built : [built];
      if (nodes.length === 1 && !nodes[0].compound) {
        const node = createPath(nodes[0].anchors, nodes[0].closed, newPathStyle(editor), { shape: nodes[0].shape });
        if (nodes[0].style) Object.assign(node, nodes[0].style);
        d.select = this.place(doc, node, [], d.plane);
        d.id = node.id;
      } else {
        const { group, descendants } = buildGroup(nodes, newPathStyle(editor));
        d.select = this.place(doc, group, descendants, d.plane);
        d.id = group.id;
      }
      editor.select([d.select]);
    } else if (!Array.isArray(built)) {
      doc.update(d.id, { anchors: built.anchors, shape: built.shape, closed: built.closed, ...(built.style || {}) });
    } else {
      // Grids: rebuild children in place (counts and options can change with keys).
      const g = doc.get(d.id);
      const same = g.children.length === built.length && built.every((n, i) => !n.compound && doc.get(g.children[i])?.type === 'path');
      if (!same) {
        for (const c of g.children) doc.remove(c);
        const { group, descendants } = buildGroup(built, newPathStyle(editor));
        for (const c of group.children) {
          const node = descendants.find((n) => n.id === c);
          doc.insert(node, d.id, Infinity, descendants.filter((n) => n.parent === node.id));
        }
      } else {
        g.children.forEach((c, i) => doc.update(c, { anchors: built[i].anchors, closed: built[i].closed, ...(built[i].style || {}) }));
      }
    }
    const b = this.box(d);
    editor.feedback = e ? { sx: e.sx, sy: e.sy, text: `W: ${fmt(editor, b.w)}\nH: ${fmt(editor, b.h)}` } : editor.feedback;
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    const editor = this.editor;
    editor.feedback = null;
    editor.alignmentGuides = null;
    if (!d) return;
    if (!d.moved) {
      this.clickPlane = d.plane;
      this.clickDialog(d.x0, d.y0, e);
      return;
    }
    d.tx?.commit();
    this.overlay();
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    if (this.drag?.moved && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      if (this.arrow(ev.key === 'ArrowUp' ? 1 : -1)) {
        this.update(null);
        return true;
      }
    }
    return false;
  }

  arrow() {
    return false;
  }

  /** While a shape is being dragged its keys (F, X, C, R, ...) come before command shortcuts. */
  claimsKey() {
    return Boolean(this.drag?.moved);
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    d?.tx?.cancel();
    if (this.editor) {
      this.editor.feedback = null;
      this.editor.alignmentGuides = null;
    }
    this.overlay();
  }

  /** Insert a shape built from exact values (click without drag). */
  insertExact(built) {
    const editor = this.editor;
    const doc = editor.doc;
    const plane = this.clickPlane;
    this.clickPlane = null;
    let id;
    doc.transact(this.constructor.label.replace(' Tool', ''), () => {
      const nodes = Array.isArray(built) ? built : [built];
      if (nodes.length === 1 && !nodes[0].compound) {
        const node = createPath(nodes[0].anchors, nodes[0].closed, { ...newPathStyle(editor), ...nodes[0].style }, { shape: nodes[0].shape });
        id = this.place(doc, node, [], plane);
      } else {
        const { group, descendants } = buildGroup(nodes, newPathStyle(editor));
        id = this.place(doc, group, descendants, plane);
      }
    });
    editor.select([id]);
  }

  async clickDialog() {}
}

export class RectangleTool extends DragShapeTool {
  static id = 'rectangle';
  static label = 'Rectangle Tool';
  static shortcut = 'M';
  static icon = 'tool-rectangle';
  static hint = 'Drag to draw a rectangle | Shift for a square | Option to draw from the center | Click to enter a size';

  get radius() {
    return 0;
  }

  set radius(_v) {}

  build(d) {
    const b = this.box(d);
    const r = this.radius;
    const shape = { kind: 'rect', cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, radii: [r, r, r, r], angle: 0 };
    return { anchors: S.rectangle(b.x, b.y, b.w, b.h, r), closed: true, shape };
  }

  async clickDialog(x, y, e) {
    const last = this.app.prefs.get('lastRect') || { w: 100, h: 100 };
    const v = await this.app.dialogs.form({
      title: this.constructor.label.replace(' Tool', ''),
      fields: [
        { key: 'w', label: 'Width', type: 'length', value: last.w },
        { key: 'h', label: 'Height', type: 'length', value: last.h },
        ...(this.radius || this.constructor.id === 'rounded-rectangle' ? [{ key: 'r', label: 'Corner Radius', type: 'length', value: this.radius }] : []),
      ],
    });
    if (!v || !(v.w > 0) || !(v.h > 0)) return;
    this.app.prefs.set('lastRect', { w: v.w, h: v.h });
    const r = v.r ?? this.radius;
    if (v.r != null) this.radius = v.r;
    // The click is the top-left corner, or the center with Alt.
    if (e?.alt) ({ x, y } = { x: x - v.w / 2, y: y - v.h / 2 });
    this.insertExact({ anchors: S.rectangle(x, y, v.w, v.h, r), closed: true, shape: { kind: 'rect', cx: x + v.w / 2, cy: y + v.h / 2, w: v.w, h: v.h, radii: [r, r, r, r], angle: 0 } });
  }
}

export class RoundedRectangleTool extends RectangleTool {
  static id = 'rounded-rectangle';
  static label = 'Rounded Rectangle Tool';
  static shortcut = '';
  static icon = 'tool-rounded-rectangle';
  static hint = 'Drag to draw a rounded rectangle | Up/Down Arrow changes the corner radius while dragging';

  /** The corner radius is the Corner Radius preference, which the arrow keys also change. */
  get radius() {
    const r = Number(this.app?.prefs?.get('cornerRadius'));
    return Number.isFinite(r) && r >= 0 ? r : 12;
  }

  set radius(v) {
    if (this.app?.prefs) this.app.prefs.set('cornerRadius', Math.max(0, v));
  }

  arrow(dir) {
    this.radius = Math.max(0, this.radius + dir);
    return true;
  }

  onKeyDown(ev) {
    // Left Arrow: square corners; Right Arrow: the largest radius for the current size.
    if (this.drag?.moved && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      const b = this.box(this.drag);
      this.radius = ev.key === 'ArrowLeft' ? 0 : Math.min(b.w, b.h) / 2;
      this.update(null);
      return true;
    }
    return super.onKeyDown(ev);
  }
}

export class EllipseTool extends DragShapeTool {
  static id = 'ellipse';
  static label = 'Ellipse Tool';
  static shortcut = 'L';
  static icon = 'tool-ellipse';
  static hint = 'Drag to draw an ellipse | Shift for a circle | Option to draw from the center | Click to enter a size';

  build(d) {
    const b = this.box(d);
    return { anchors: S.ellipse(b.x, b.y, b.w, b.h), closed: true, shape: { kind: 'ellipse', cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: 0 } };
  }

  async clickDialog(x, y, e) {
    const last = this.app.prefs.get('lastEllipse') || { w: 100, h: 100 };
    const v = await this.app.dialogs.form({
      title: 'Ellipse',
      fields: [
        { key: 'w', label: 'Width', type: 'length', value: last.w },
        { key: 'h', label: 'Height', type: 'length', value: last.h },
      ],
    });
    if (!v || !(v.w > 0) || !(v.h > 0)) return;
    this.app.prefs.set('lastEllipse', { w: v.w, h: v.h });
    if (e?.alt) ({ x, y } = { x: x - v.w / 2, y: y - v.h / 2 });
    this.insertExact({ anchors: S.ellipse(x, y, v.w, v.h), closed: true, shape: { kind: 'ellipse', cx: x + v.w / 2, cy: y + v.h / 2, w: v.w, h: v.h, angle: 0 } });
  }
}

/** Angle in degrees from the drag start to the pointer, for polygons and stars. */
function dragAngle(d) {
  const a = (Math.atan2(d.y - d.y0, d.x - d.x0) * 180) / Math.PI + 90;
  return d.shift ? 0 : a;
}

export class PolygonTool extends DragShapeTool {
  static id = 'polygon';
  static label = 'Polygon Tool';
  static shortcut = '';
  static icon = 'tool-polygon';
  static hint = 'Drag from the center to draw a polygon | Up/Down Arrow changes the number of sides | Shift keeps it upright';
  sides = 6;

  build(d) {
    const r = Math.hypot(d.x - d.x0, d.y - d.y0);
    if (r <= 0) return null;
    const angle = dragAngle(d);
    const shape = { kind: 'polygon', cx: d.x0, cy: d.y0, r, sides: this.sides, angle };
    return { anchors: S.shapeAnchors(shape), closed: true, shape };
  }

  arrow(dir) {
    this.sides = Math.max(3, Math.min(1000, this.sides + dir));
    return true;
  }

  async clickDialog(x, y) {
    const v = await this.app.dialogs.form({
      title: 'Polygon',
      fields: [
        { key: 'r', label: 'Radius', type: 'length', value: 50 },
        { key: 'sides', label: 'Sides', type: 'number', value: this.sides, min: 3, max: 1000, step: 1 },
      ],
    });
    if (!v || !(v.r > 0)) return;
    this.sides = Math.round(v.sides);
    const shape = { kind: 'polygon', cx: x, cy: y, r: v.r, sides: this.sides, angle: 0 };
    this.insertExact({ anchors: S.shapeAnchors(shape), closed: true, shape });
  }
}

export class StarTool extends DragShapeTool {
  static id = 'star';
  static label = 'Star Tool';
  static shortcut = '';
  static icon = 'tool-star';
  static hint = 'Drag from the center to draw a star | Up/Down Arrow changes the number of points | Shift keeps it upright | Command keeps the inner radius | Option straightens the sides';
  points = 5;
  ratio = 0.5;

  build(d) {
    const r1 = Math.hypot(d.x - d.x0, d.y - d.y0);
    if (r1 <= 0) return null;
    const angle = dragAngle(d);
    let r2 = r1 * this.ratio;
    if (d.mod) {
      // Command holds the inner radius while the outer one follows the pointer.
      d.innerR ??= d.lastR2 ?? r2;
      r2 = d.innerR;
    } else {
      if (d.innerR != null) this.ratio = Math.min(1, d.innerR / r1);
      d.innerR = null;
      // Option lines up opposite sides of the points (a regular star).
      if (d.alt) r2 = S.regularStarInner(r1, this.points);
    }
    d.lastR2 = r2;
    const shape = { kind: 'star', cx: d.x0, cy: d.y0, r1, r2, points: this.points, angle };
    return { anchors: S.shapeAnchors(shape), closed: true, shape };
  }

  arrow(dir) {
    this.points = Math.max(3, Math.min(1000, this.points + dir));
    return true;
  }

  async clickDialog(x, y) {
    const v = await this.app.dialogs.form({
      title: 'Star',
      fields: [
        { key: 'r1', label: 'Radius 1', type: 'length', value: 50 },
        { key: 'r2', label: 'Radius 2', type: 'length', value: 25 },
        { key: 'points', label: 'Points', type: 'number', value: this.points, min: 3, max: 1000, step: 1 },
      ],
    });
    if (!v || !(v.r1 > 0)) return;
    this.points = Math.round(v.points);
    const shape = { kind: 'star', cx: x, cy: y, r1: v.r1, r2: Math.max(0, v.r2), points: this.points, angle: 0 };
    this.insertExact({ anchors: S.shapeAnchors(shape), closed: true, shape });
  }
}

/**
 * Shape tools with an options dialog (double-click the tool, or click the
 * canvas to draw from exact values): the options live in preferences under
 * `toolOptions.<id>` so they persist between sessions.
 */
class OptionsShapeTool extends DragShapeTool {
  static defaults = {};

  get options() {
    return { ...this.constructor.defaults, ...(this.app.prefs.get(`toolOptions.${this.constructor.id}`) || {}) };
  }

  setOptions(patch) {
    this.app.prefs.set(`toolOptions.${this.constructor.id}`, { ...this.options, ...patch });
  }

  /** Dialog fields: [field] built from the current options. */
  optionFields() {
    return [];
  }

  /** Options from dialog values. */
  readOptions(v) {
    return v;
  }

  get optionsTitle() {
    return `${this.constructor.label.replace(' Tool', '')} Tool Options`;
  }

  async openOptions() {
    const v = await this.app.dialogs.form({ title: this.optionsTitle, fields: this.optionFields() });
    if (v) this.setOptions(this.readOptions(v));
    return v;
  }

  async clickDialog(x, y, e) {
    const v = await this.openOptions();
    if (v) this.insertExact(this.exact(x, y, this.options, e));
  }

  /** Paint for the new artwork: a Fill option keeps the current fill, else none. */
  fillStyle(fill) {
    return fill ? {} : { fill: null };
  }
}

export class LineTool extends OptionsShapeTool {
  static id = 'line';
  static label = 'Line Segment Tool';
  static shortcut = '\\';
  static icon = 'tool-line';
  static hint = 'Drag to draw a line | Shift constrains to 45 degrees | Option draws from the center | Click to enter a length';
  static defaults = { len: 100, angle: 0, fill: false };

  get optionsTitle() {
    return 'Line Segment Tool Options';
  }

  optionFields() {
    const o = this.options;
    return [
      { key: 'len', label: 'Length', type: 'length', value: o.len, min: 0 },
      { key: 'angle', label: 'Angle', type: 'angle', value: o.angle },
      { key: 'fill', label: 'Fill Line', type: 'checkbox', value: o.fill },
    ];
  }

  readOptions(v) {
    return { len: v.len, angle: v.angle, fill: Boolean(v.fill) };
  }

  build(d) {
    let { x, y } = d;
    if (d.shift) ({ x, y } = constrain45(d.x0, d.y0, x, y, constrainAngle(this.app)));
    let x1 = d.x0;
    let y1 = d.y0;
    if (d.alt) {
      x1 = 2 * d.x0 - x;
      y1 = 2 * d.y0 - y;
    }
    return { anchors: S.line(x1, y1, x, y), closed: false, shape: { kind: 'line', x1, y1, x2: x, y2: y }, style: this.fillStyle(this.options.fill) };
  }

  update(e) {
    super.update(e);
    const d = this.drag;
    if (d && e) {
      const len = Math.hypot(d.x - d.x0, d.y - d.y0);
      const ang = (-Math.atan2(d.y - d.y0, d.x - d.x0) * 180) / Math.PI;
      this.editor.feedback = { sx: e.sx, sy: e.sy, text: `D: ${fmt(this.editor, len)}\n${Number(ang.toFixed(1))}°` };
    }
  }

  async clickDialog(x, y) {
    const v = await this.openOptions();
    if (!v || !(v.len > 0)) return;
    const a = (-v.angle * Math.PI) / 180;
    const x2 = x + Math.cos(a) * v.len;
    const y2 = y + Math.sin(a) * v.len;
    this.insertExact({ anchors: S.line(x, y, x2, y2), closed: false, shape: { kind: 'line', x1: x, y1: y, x2, y2 }, style: this.fillStyle(v.fill) });
  }
}

/**
 * Arc tool: while dragging, Up/Down Arrow change the slope, X flips it
 * between convex and concave, C toggles an open or closed arc and F swaps
 * the base axis.
 */
export class ArcTool extends OptionsShapeTool {
  static id = 'arc';
  static label = 'Arc Tool';
  static shortcut = '';
  static icon = 'tool-arc';
  static hint = 'Drag to draw an arc | Shift for equal sides | Up/Down Arrow change the slope | X flips the slope, C closes the arc, F swaps the base axis';
  static defaults = { lx: 100, ly: 100, closed: false, base: 'x', slope: 50, fill: false };

  get optionsTitle() {
    return 'Arc Segment Tool Options';
  }

  optionFields() {
    const o = this.options;
    return [
      { key: 'lx', label: 'Length X-Axis', type: 'length', value: o.lx, min: 0 },
      { key: 'ly', label: 'Length Y-Axis', type: 'length', value: o.ly, min: 0 },
      { key: 'closed', label: 'Type', type: 'radio', value: o.closed ? 'closed' : 'open', options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }] },
      { key: 'base', label: 'Base Along', type: 'radio', value: o.base, options: [{ value: 'x', label: 'X Axis' }, { value: 'y', label: 'Y Axis' }] },
      { key: 'slope', label: 'Slope (concave -100 to convex 100)', type: 'range', value: o.slope, min: -100, max: 100 },
      { key: 'fill', label: 'Fill Arc', type: 'checkbox', value: o.fill },
    ];
  }

  readOptions(v) {
    // `concave` is accepted for scripts and older callers.
    const slope = v.concave != null && v.slope == null ? (v.concave ? -50 : 50) : Number(v.slope ?? this.options.slope);
    return { lx: v.lx, ly: v.ly, closed: v.closed === 'closed' || v.closed === true, base: v.base === 'y' ? 'y' : 'x', slope: Math.max(-100, Math.min(100, slope)), fill: Boolean(v.fill) };
  }

  /** The arc's shape options while drawing (keys change them for this drag and the next ones). */
  arcOpts() {
    const o = this.options;
    return { slope: o.slope, base: o.base, closed: o.closed };
  }

  build(d) {
    let { x, y } = d;
    if (d.shift) {
      const s = Math.max(Math.abs(x - d.x0), Math.abs(y - d.y0));
      x = d.x0 + Math.sign(x - d.x0 || 1) * s;
      y = d.y0 + Math.sign(y - d.y0 || 1) * s;
    }
    let x0 = d.x0;
    let y0 = d.y0;
    if (d.alt) {
      // Option draws from the center of the arc's box.
      x0 = 2 * d.x0 - x;
      y0 = 2 * d.y0 - y;
    }
    const o = this.arcOpts();
    return { anchors: S.arc(x0, y0, x, y, o), closed: o.closed, style: this.fillStyle(this.options.fill || o.closed) };
  }

  update(e) {
    const d = this.drag;
    // Changing between open and closed while dragging needs a fresh path.
    if (d?.id && this.editor.doc.get(d.id)?.closed !== this.arcOpts().closed) {
      this.editor.doc.update(d.id, { closed: this.arcOpts().closed });
    }
    super.update(e);
  }

  exact(x, y, o) {
    return { anchors: S.arc(x, y, x + o.lx, y + o.ly, o), closed: o.closed, style: this.fillStyle(o.fill || o.closed) };
  }

  async clickDialog(x, y) {
    const v = await this.openOptions();
    const o = this.options;
    if (!v || !(o.lx > 0) || !(o.ly > 0)) return;
    this.insertExact(this.exact(x, y, o));
  }

  onKeyDown(ev) {
    if (this.drag?.moved) {
      const o = this.options;
      const k = ev.key?.toLowerCase();
      let patch = null;
      if (k === 'x') patch = { slope: -o.slope };
      else if (k === 'c') patch = { closed: !o.closed };
      else if (k === 'f') patch = { base: o.base === 'y' ? 'x' : 'y' };
      else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') patch = { slope: Math.max(-100, Math.min(100, o.slope + (ev.key === 'ArrowUp' ? 10 : -10))) };
      if (patch) {
        this.setOptions(patch);
        this.update(null);
        return true;
      }
    }
    return super.onKeyDown(ev);
  }
}

/**
 * Spiral tool: drag from the center; Up/Down Arrow add or remove segments,
 * R reverses the winding and Command while dragging changes the decay.
 */
export class SpiralTool extends OptionsShapeTool {
  static id = 'spiral';
  static label = 'Spiral Tool';
  static shortcut = '';
  static icon = 'tool-spiral';
  static hint = 'Drag from the center to draw a spiral | Up/Down Arrow adds or removes segments | R reverses the winding | Command+Drag changes the decay';
  static defaults = { r: 50, decay: 80, segments: 10, clockwise: true };

  get optionsTitle() {
    return 'Spiral';
  }

  get segments() {
    return this.options.segments;
  }

  get decay() {
    return this.options.decay / 100;
  }

  optionFields() {
    const o = this.options;
    return [
      { key: 'r', label: 'Radius', type: 'length', value: o.r, min: 0 },
      { key: 'decay', label: 'Decay', type: 'percent', value: o.decay, min: 5, max: 150 },
      { key: 'segments', label: 'Segments', type: 'number', value: o.segments, min: 2, max: 1000, step: 1 },
      { key: 'style', label: 'Style', type: 'radio', value: o.clockwise ? 'cw' : 'ccw', options: [{ value: 'cw', label: 'Clockwise' }, { value: 'ccw', label: 'Counterclockwise' }] },
    ];
  }

  readOptions(v) {
    return { r: v.r, decay: Math.max(5, Math.min(99, v.decay)), segments: Math.max(2, Math.min(1000, Math.round(v.segments))), clockwise: v.style ? v.style !== 'ccw' : this.options.clockwise };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (d?.moved && e.mod && !this.app.input?.spaceDown) {
      // Command drags change the decay instead of the size and angle.
      d.decayFrom ??= { sy: e.sy, decay: this.options.decay };
      const decay = Math.max(5, Math.min(99, d.decayFrom.decay + (d.decayFrom.sy - e.sy) / 4));
      this.setOptions({ decay: Math.round(decay * 10) / 10 });
      this.update(e);
      this.editor.feedback = { sx: e.sx, sy: e.sy, text: `Decay: ${this.options.decay}%` };
      return;
    }
    if (d) d.decayFrom = null;
    super.onPointerMove(e);
  }

  build(d) {
    const r = Math.hypot(d.x - d.x0, d.y - d.y0);
    if (r <= 0) return null;
    const o = this.options;
    const ang = Math.atan2(d.y - d.y0, d.x - d.x0) + Math.PI / 2;
    const pts = S.spiral(d.x0, d.y0, r, o.decay / 100, o.segments, o.clockwise);
    return { anchors: transformAnchors(pts, rotate((ang * 180) / Math.PI, d.x0, d.y0)), closed: false, style: { fill: null } };
  }

  arrow(dir) {
    this.setOptions({ segments: Math.max(2, Math.min(1000, this.options.segments + dir)) });
    return true;
  }

  exact(x, y, o) {
    return { anchors: S.spiral(x, y, o.r, o.decay / 100, o.segments, o.clockwise), closed: false, style: { fill: null } };
  }

  async clickDialog(x, y) {
    const v = await this.openOptions();
    if (!v || !(this.options.r > 0)) return;
    this.insertExact(this.exact(x, y, this.options));
  }

  onKeyDown(ev) {
    if (this.drag?.moved && ev.key?.toLowerCase() === 'r') {
      this.setOptions({ clockwise: !this.options.clockwise });
      this.update(null);
      return true;
    }
    return super.onKeyDown(ev);
  }
}

/** Grid tools: skew keys while dragging (`skewKeys`: key -> [option, step]). */
class GridTool extends OptionsShapeTool {
  static skewKeys = {};

  onKeyDown(ev) {
    const sk = this.drag?.moved && this.constructor.skewKeys[ev.key?.toLowerCase()];
    if (sk) {
      const [key, step] = sk;
      this.setOptions({ [key]: Math.max(-100, Math.min(100, (this.options[key] || 0) + step)) });
      this.update(null);
      return true;
    }
    return super.onKeyDown(ev);
  }

  async clickDialog(x, y) {
    const v = await this.openOptions();
    const o = this.options;
    if (!v || !(o.w > 0) || !(o.h > 0)) return;
    this.insertExact(this.build({ x0: x, y0: y, x: x + o.w, y: y + o.h }));
  }
}

/**
 * Rectangular Grid: Up/Down Arrow change the rows, Left/Right the columns;
 * F and V skew the rows, X and C the columns.
 */
export class RectGridTool extends GridTool {
  static id = 'rect-grid';
  static label = 'Rectangular Grid Tool';
  static shortcut = '';
  static icon = 'tool-rect-grid';
  static hint = 'Drag to draw a grid | Up/Down Arrow changes rows, Left/Right columns | F/V skew the rows, X/C the columns';
  static defaults = { w: 100, h: 100, rows: 4, cols: 4, rowSkew: 0, colSkew: 0, frame: true, fill: false };
  static skewKeys = { f: ['rowSkew', -10], v: ['rowSkew', 10], x: ['colSkew', -10], c: ['colSkew', 10] };

  optionFields() {
    const o = this.options;
    return [
      { key: 'w', label: 'Width', type: 'length', value: o.w, min: 0 },
      { key: 'h', label: 'Height', type: 'length', value: o.h, min: 0 },
      { key: 'rows', label: 'Horizontal Dividers', type: 'number', value: o.rows, min: 0, max: 999, step: 1 },
      { key: 'rowSkew', label: 'Horizontal Skew (top -100 to bottom 100)', type: 'range', value: o.rowSkew, min: -100, max: 100 },
      { key: 'cols', label: 'Vertical Dividers', type: 'number', value: o.cols, min: 0, max: 999, step: 1 },
      { key: 'colSkew', label: 'Vertical Skew (left -100 to right 100)', type: 'range', value: o.colSkew, min: -100, max: 100 },
      { key: 'frame', label: 'Use Outside Rectangle as Frame', type: 'checkbox', value: o.frame },
      { key: 'fill', label: 'Fill Grid', type: 'checkbox', value: o.fill },
    ];
  }

  readOptions(v) {
    const o = this.options;
    return {
      w: v.w,
      h: v.h,
      rows: Math.max(0, Math.round(v.rows)),
      cols: Math.max(0, Math.round(v.cols)),
      rowSkew: Number(v.rowSkew ?? o.rowSkew),
      colSkew: Number(v.colSkew ?? o.colSkew),
      frame: v.frame ?? o.frame,
      fill: v.fill ?? o.fill,
    };
  }

  build(d) {
    const b = this.box(d);
    const o = this.options;
    const g = S.rectGrid(b.x, b.y, b.w, b.h, o.rows + 1, o.cols + 1, { rowSkew: o.rowSkew, colSkew: o.colSkew });
    const line = { fill: null };
    // Without the frame option the outside is four separate lines.
    const frame = o.frame
      ? [{ anchors: g.frame, closed: true, style: this.fillStyle(o.fill) }]
      : [[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => ({ anchors: S.line(g.frame[i].x, g.frame[i].y, g.frame[j].x, g.frame[j].y), closed: false, style: line }));
    return [...frame, ...g.lines.map((l) => ({ anchors: l, closed: false, style: line }))];
  }

  arrow(dir) {
    this.setOptions({ rows: Math.max(0, this.options.rows + dir) });
    return true;
  }

  onKeyDown(ev) {
    if (this.drag?.moved && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      this.setOptions({ cols: Math.max(0, this.options.cols + (ev.key === 'ArrowRight' ? 1 : -1)) });
      this.update(null);
      return true;
    }
    return super.onKeyDown(ev);
  }
}

/**
 * Polar Grid: Up/Down Arrow change the concentric dividers, Left/Right the
 * radial ones; X and C skew the rings, F and V the radial dividers.
 */
export class PolarGridTool extends GridTool {
  static id = 'polar-grid';
  static label = 'Polar Grid Tool';
  static shortcut = '';
  static icon = 'tool-polar-grid';
  static hint = 'Drag to draw a polar grid | Up/Down Arrow changes rings, Left/Right dividers | X/C skew the rings, F/V the dividers';
  static defaults = { w: 100, h: 100, rings: 5, dividers: 5, ringSkew: 0, radialSkew: 0, compound: false, fill: false };
  static skewKeys = { x: ['ringSkew', -10], c: ['ringSkew', 10], f: ['radialSkew', -10], v: ['radialSkew', 10] };

  optionFields() {
    const o = this.options;
    return [
      { key: 'w', label: 'Width', type: 'length', value: o.w, min: 0 },
      { key: 'h', label: 'Height', type: 'length', value: o.h, min: 0 },
      { key: 'rings', label: 'Concentric Dividers', type: 'number', value: o.rings, min: 0, max: 999, step: 1 },
      { key: 'ringSkew', label: 'Concentric Skew (in -100 to out 100)', type: 'range', value: o.ringSkew, min: -100, max: 100 },
      { key: 'dividers', label: 'Radial Dividers', type: 'number', value: o.dividers, min: 0, max: 999, step: 1 },
      { key: 'radialSkew', label: 'Radial Skew (bottom -100 to top 100)', type: 'range', value: o.radialSkew, min: -100, max: 100 },
      { key: 'compound', label: 'Create Compound Path from Ellipses', type: 'checkbox', value: o.compound },
      { key: 'fill', label: 'Fill Grid', type: 'checkbox', value: o.fill },
    ];
  }

  readOptions(v) {
    const o = this.options;
    return {
      w: v.w,
      h: v.h,
      rings: Math.max(0, Math.round(v.rings)),
      dividers: Math.max(0, Math.round(v.dividers)),
      ringSkew: Number(v.ringSkew ?? o.ringSkew),
      radialSkew: Number(v.radialSkew ?? o.radialSkew),
      compound: v.compound ?? o.compound,
      fill: v.fill ?? o.fill,
    };
  }

  build(d) {
    const b = this.box(d);
    const o = this.options;
    const g = S.polarGrid(b.x, b.y, b.w, b.h, o.rings, o.dividers, { ringSkew: o.ringSkew, radialSkew: o.radialSkew });
    const rings = g.circles.map((c) => ({ anchors: c, closed: true, style: this.fillStyle(o.fill) }));
    const lines = g.lines.map((l) => ({ anchors: l, closed: false, style: { fill: null } }));
    if (o.compound && rings.length > 1) return [...lines, { compound: rings.map((r) => r.anchors), style: this.fillStyle(o.fill) }];
    return [...rings, ...lines];
  }

  arrow(dir) {
    this.setOptions({ rings: Math.max(0, this.options.rings + dir) });
    return true;
  }

  onKeyDown(ev) {
    if (this.drag?.moved && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      this.setOptions({ dividers: Math.max(0, this.options.dividers + (ev.key === 'ArrowRight' ? 1 : -1)) });
      this.update(null);
      return true;
    }
    return super.onKeyDown(ev);
  }
}
