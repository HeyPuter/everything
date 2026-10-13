/**
 * Geometry tools: Shape Builder (Shift+M), Scissors (C), Knife, Eraser
 * (Shift+E), Merge Brush (Shift+B) and Join.
 *
 * Heavy work goes through the geometry engine (async; large jobs run in the
 * worker). Tools snapshot the nodes they operate on and drop a result if the
 * document changed meanwhile.
 */
import { Tool, tol } from '../../tools/tool.js';
import { multiply } from '../../lib/matrix.js';
import { createPath } from '../../model/nodes.js';
import { fitCurve, simplifyPolyline, nearestOnPath, insertAnchor, segmentPoints, reverseAnchors, anchor as mkAnchor } from '../../model/bezier.js';
import { rectangle } from '../../model/shapes.js';
import { nodeBounds, rectsIntersect, inflate } from '../../model/geometry.js';
import { tracePath } from '../../render/draw.js';
import { newPathStyle } from '../../tools/pen.js';
import { OP, runGeom, loadGeom } from './engine/index.js';
import { withBusy, isBusy } from './busy.js';
import { geometryLeaves, shapeOf, styleOf, nodeFromSubpaths, replaceWith, snapshot, unchangedSince, solidKey, insertionPoint } from './nodes-io.js';

function withDocTransform(ctx, view, fn) {
  ctx.save();
  const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  fn();
  ctx.restore();
}

let hitCtx = null;
function hctx() {
  if (!hitCtx) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    hitCtx = c.getContext('2d');
  }
  return hitCtx;
}

function path2dOf(subpaths) {
  const p = new Path2D();
  for (const sp of subpaths) tracePath(p, sp.anchors, sp.closed);
  return p;
}

/** All visible, unlocked path/compound leaves in the document (paint order). */
function editableLeaves(doc) {
  return doc.leaves().filter((n) => (n.type === 'path' || n.type === 'compound') && !doc.isHidden(n.id) && !doc.isLocked(n.id));
}

function polylineBounds(pts, pad = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Pointer samples including coalesced events. */
function samples(tool, e) {
  const list = e.native?.getCoalescedEvents?.() || [];
  if (list.length > 1) return list.map((s) => tool.app.eventToDoc(s));
  return [{ x: e.x, y: e.y }];
}

function drawPolyline(ctx, editor, pts, color, width = 1, dash = []) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = editor.view.toScreen(p.x, p.y);
    if (i) ctx.lineTo(s.x, s.y);
    else ctx.moveTo(s.x, s.y);
  });
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Shape Builder

export class ShapeBuilderTool extends Tool {
  static id = 'shape-builder';
  static label = 'Shape Builder Tool';
  static shortcut = 'Shift+M';
  static icon = 'tool-shape-builder';
  static hint = 'Drag across regions to merge them | Click a region to separate it | Option: drag or click to delete regions';

  constructor(app) {
    super(app);
    this.faces = null; // [{ owner, cover, subpaths, path, bounds }]
    this.facesKey = null;
    this.leaves = [];
    this.hoverFace = -1;
    this.drag = null;
    this.alt = false;
  }

  activate() {
    this.setCursor('var(--cursor-shape-builder)');
    this.status();
    this.refreshFaces();
    this.offSel = this.editor?.on?.('selection', () => this.refreshFaces());
    this.offDoc = this.editor?.on?.('doc-change', (ev) => ev?.commit && this.refreshFaces());
  }

  deactivate() {
    this.offSel?.();
    this.offDoc?.();
    this.offSel = this.offDoc = null;
    this.faces = null;
    this.facesKey = null;
    this.drag = null;
    this.hoverFace = -1;
  }

  /** (Re)compute faces for the selected shapes when they changed. */
  async refreshFaces() {
    const editor = this.editor;
    if (!editor) return;
    const leaves = geometryLeaves(editor.doc, editor.topSelection());
    const key = leaves.map((n) => n.id).join('|');
    const same = this.facesKey === key && this.leaves.length === leaves.length && this.leaves.every((n, i) => n === leaves[i]);
    if (same) return;
    this.facesKey = key;
    this.leaves = leaves;
    this.faces = null;
    this.hoverFace = -1;
    if (leaves.length < 1) {
      this.status('Select two or more overlapping shapes, then drag across regions to merge them');
      this.overlay();
      return;
    }
    const doc = editor.doc;
    const shapes = leaves.map((n) => shapeOf(doc, n, { string: n.type === 'path' && !n.closed && !n.fill }));
    try {
      const records = await runGeom(OP.DIVIDE, shapes, []);
      if (this.facesKey !== key || this.app.tool !== this) return;
      this.faces = records.map((r) => ({ ...r, path: path2dOf(r.subpaths), bounds: subpathBounds(r.subpaths) }));
      this.status();
      this.overlay();
    } catch (err) {
      this.app.notify(err.message, { error: true });
    }
  }

  faceAt(x, y) {
    if (!this.faces) return -1;
    const ctx = hctx();
    for (let i = this.faces.length - 1; i >= 0; i--) {
      const f = this.faces[i];
      const b = f.bounds;
      if (!b || x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
      if (ctx.isPointInPath(f.path, x, y, 'nonzero')) return i;
    }
    return -1;
  }

  onHover(e) {
    const i = this.faceAt(e.x, e.y);
    this.alt = e.alt;
    if (i !== this.hoverFace) {
      this.hoverFace = i;
      this.overlay();
    }
  }

  onPointerDown(e) {
    if (!this.faces || isBusy()) return;
    this.alt = e.alt;
    this.drag = { faces: new Set(), first: -1, pts: [{ x: e.x, y: e.y }] };
    this.#touch(e.x, e.y);
  }

  #touch(x, y) {
    const i = this.faceAt(x, y);
    if (i >= 0 && !this.drag.faces.has(i)) {
      this.drag.faces.add(i);
      if (this.drag.first < 0) this.drag.first = i;
    }
  }

  onPointerMove(e) {
    if (!this.drag) return;
    for (const p of samples(this, e)) {
      // Sample along the move so fast drags still pass through small regions.
      const last = this.drag.pts[this.drag.pts.length - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x - last.x, p.y - last.y) / tol(this.editor, 3)));
      for (let s = 1; s <= steps; s++) this.#touch(last.x + ((p.x - last.x) * s) / steps, last.y + ((p.y - last.y) * s) / steps);
      this.drag.pts.push(p);
    }
    this.alt = e.alt;
    this.overlay();
  }

  async onPointerUp(e) {
    const drag = this.drag;
    this.drag = null;
    this.overlay();
    if (!drag || !drag.faces.size) return;
    await this.apply([...drag.faces], drag.first, e.alt || this.alt);
  }

  /** Merge (or delete) faces. Exported behavior is tested through applyShapeBuilder. */
  async apply(touched, first, erase) {
    const editor = this.editor;
    const doc = editor.doc;
    const leaves = this.leaves;
    const faces = this.faces;
    const snap = snapshot(doc, leaves);
    const plan = shapeBuilderPlan(faces, touched, first, erase);
    if (!plan) return;
    const records = await withBusy(this.app, 'Shape Builder', () => runGeom(OP.UNITE_GROUPS, plan.shapes, []));
    if (!unchangedSince(doc, snap)) return;
    const affected = plan.affected.map((i) => leaves[i]);
    const ids = [];
    doc.transact(erase ? 'Shape Builder Delete' : 'Shape Builder Merge', () => {
      const where = insertionPoint(doc, affected);
      const items = [];
      for (const rec of records) {
        const group = plan.groupOfShape[rec.owner];
        const styleNode = group === 'merge' ? leaves[plan.mergeOwner] : leaves[group];
        const built = nodeFromSubpaths(rec.subpaths, styleOf(styleNode));
        if (built) items.push({ built, order: group === 'merge' ? Infinity : group });
      }
      items.sort((a, b) => a.order - b.order);
      ids.push(...replaceWith(doc, affected, items.map((i) => i.built), where));
    });
    const keep = leaves.filter((n) => !plan.affected.includes(leaves.indexOf(n)) && doc.has(n.id)).map((n) => n.id);
    editor.select([...keep, ...ids]);
  }

  onKeyDown(ev) {
    if (ev.key === 'Alt' && !this.alt) {
      this.alt = true;
      this.overlay();
    }
    return false;
  }

  cancel() {
    this.drag = null;
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    if (!this.faces) return;
    const color = '#4f80ff';
    const del = '#e5484d';
    const list = this.drag ? [...this.drag.faces] : this.hoverFace >= 0 ? [this.hoverFace] : [];
    withDocTransform(ctx, editor.view, () => {
      for (const i of list) {
        const f = this.faces[i];
        if (!f) continue;
        ctx.fillStyle = this.alt ? 'rgba(229, 72, 77, 0.28)' : 'rgba(79, 128, 255, 0.28)';
        ctx.fill(f.path, 'nonzero');
        ctx.strokeStyle = this.alt ? del : color;
        ctx.lineWidth = 1.5 / editor.view.zoom;
        ctx.setLineDash([4 / editor.view.zoom, 3 / editor.view.zoom]);
        ctx.stroke(f.path);
      }
    });
    if (this.drag) drawPolyline(ctx, editor, this.drag.pts, this.alt ? del : color, 1.5);
  }
}

function subpathBounds(subpaths) {
  const pts = [];
  for (const sp of subpaths) for (const a of sp.anchors) pts.push({ x: a.x, y: a.y }, { x: a.ix, y: a.iy }, { x: a.ox, y: a.oy });
  return pts.length ? polylineBounds(pts) : null;
}

/**
 * Plan a Shape Builder edit. `faces` are Divide records ({ owner, cover,
 * subpaths }), `touched` face indices, `first` the face where the drag
 * started. Returns the engine shapes for UNITE_GROUPS plus bookkeeping:
 *   affected      leaf indices whose geometry changes
 *   groupOfShape  shape index -> 'merge' | leaf index (result style source)
 *   mergeOwner    leaf whose style the merged shape takes
 */
export function shapeBuilderPlan(faces, touched, first, erase) {
  const touchedSet = new Set(touched);
  const affected = new Set();
  for (const i of touched) for (const c of faces[i].cover) affected.add(c);
  if (!affected.size) return null;
  const shapes = [];
  const groupOfShape = [];
  const keyOf = new Map();
  const add = (face, group) => {
    if (!keyOf.has(group)) keyOf.set(group, keyOf.size);
    shapes.push({ subpaths: face.subpaths, filled: true, evenodd: false, string: false, key: keyOf.get(group) });
    groupOfShape.push(group);
  };
  faces.forEach((f, i) => {
    if (touchedSet.has(i)) {
      if (!erase) add(f, 'merge');
      return;
    }
    if (affected.has(f.owner)) add(f, f.owner);
  });
  return { shapes, groupOfShape, affected: [...affected].sort((a, b) => a - b), mergeOwner: faces[first >= 0 ? first : touched[0]].owner };
}

// ---------------------------------------------------------------------------
// Scissors

/** Split anchors at segment `index`/t (or at an existing anchor). Returns arrays of { anchors, closed }. */
export function splitPathAt(anchors, closed, index, t) {
  let list = anchors;
  let k;
  const eps = 1e-6;
  if (t <= eps) k = index;
  else if (t >= 1 - eps) k = (index + 1) % anchors.length;
  else {
    list = insertAnchor(anchors, closed, index, t);
    k = index + 1;
  }
  const n = list.length;
  const retractIn = (a) => ({ ...a, ix: a.x, iy: a.y });
  const retractOut = (a) => ({ ...a, ox: a.x, oy: a.y });
  if (closed) {
    const rotated = [...list.slice(k), ...list.slice(0, k)];
    const out = [retractIn(rotated[0]), ...rotated.slice(1), retractOut({ ...rotated[0] })];
    return [{ anchors: out, closed: false }];
  }
  if (k <= 0 || k >= n - 1) return null;
  return [
    { anchors: [...list.slice(0, k), retractOut(list[k])], closed: false },
    { anchors: [retractIn(list[k]), ...list.slice(k + 1)], closed: false },
  ];
}

export class ScissorsTool extends Tool {
  static id = 'scissors';
  static label = 'Scissors Tool';
  static shortcut = 'C';
  static icon = 'tool-scissors';
  static hint = 'Click a path to split it at that point';

  activate() {
    this.setCursor('var(--cursor-scissors)');
    this.status();
  }

  /** The nearest editable path under the pointer: { node, index, t }. */
  pick(x, y) {
    const editor = this.editor;
    const doc = editor.doc;
    const r = tol(editor, 6);
    let best = null;
    const consider = (n) => {
      if (n.type !== 'path' || n.anchors.length < 2) return;
      const b = nodeBounds(doc, n);
      if (!b || !rectsIntersect(inflate(b, r), { x, y, w: 0, h: 0 })) return;
      const hit = nearestOnPath(n.anchors, n.closed, x, y);
      if (hit && hit.d <= r && (!best || hit.d < best.d)) best = { node: n, index: hit.index, t: hit.t, d: hit.d };
    };
    for (const n of doc.leaves()) {
      if (doc.isHidden(n.id) || doc.isLocked(n.id)) continue;
      if (n.type === 'compound') for (const c of n.children) consider(doc.get(c));
      else consider(n);
    }
    return best;
  }

  onHover(e) {
    const hit = this.pick(e.x, e.y);
    this.hover = hit ? segmentPointAt(hit) : null;
    this.overlay();
  }

  onPointerDown(e) {
    const hit = this.pick(e.x, e.y);
    if (!hit) {
      this.app.notify('Click on a path segment or anchor point to split it.', { polite: true });
      return;
    }
    const { node } = hit;
    const pieces = splitPathAt(node.anchors, node.closed, hit.index, hit.t);
    if (!pieces) {
      this.app.notify('Cannot split an open path at its endpoint.');
      return;
    }
    const doc = this.doc;
    const editor = this.editor;
    const ids = [];
    doc.transact('Split Path', () => {
      const parent = doc.get(node.parent);
      const index = parent.children.indexOf(node.id);
      doc.remove(node.id);
      pieces.forEach((p, i) => {
        const piece = { ...node, id: createPath([], false).id, anchors: p.anchors, closed: false, shape: undefined };
        doc.insert(piece, parent.id, index + i);
        ids.push(piece.id);
      });
    });
    // Select the new endpoints so they can be dragged or joined next.
    editor.clearSelection();
    if (pieces.length === 1) editor.selectAnchors(ids[0], [0, pieces[0].anchors.length - 1]);
    else {
      editor.selectAnchors(ids[0], [pieces[0].anchors.length - 1]);
      editor.selectAnchors(ids[1], [0], { add: true });
    }
  }

  drawOverlay(ctx, editor) {
    if (!this.hover) return;
    const s = editor.view.toScreen(this.hover.x, this.hover.y);
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function segmentPointAt(hit) {
  const c = segmentPoints(hit.node.anchors, hit.index);
  const t = hit.t;
  const mt = 1 - t;
  return {
    x: mt ** 3 * c[0] + 3 * mt * mt * t * c[2] + 3 * mt * t * t * c[4] + t ** 3 * c[6],
    y: mt ** 3 * c[1] + 3 * mt * mt * t * c[3] + 3 * mt * t * t * c[5] + t ** 3 * c[7],
  };
}

// ---------------------------------------------------------------------------
// Knife

export class KnifeTool extends Tool {
  static id = 'knife';
  static label = 'Knife';
  static shortcut = '';
  static icon = 'tool-knife';
  static hint = 'Drag through filled shapes to cut them | Option: cut in a straight line | Cuts the selection, or everything under the cut when nothing is selected';

  activate() {
    this.setCursor('var(--cursor-knife)');
    this.status();
    loadGeom().catch(() => {});
  }

  onPointerDown(e) {
    if (isBusy()) return;
    this.pts = [{ x: e.x, y: e.y }];
    this.alt = e.alt;
  }

  onPointerMove(e) {
    if (!this.pts) return;
    this.alt = e.alt;
    if (e.alt) this.pts = [this.pts[0], { x: e.x, y: e.y }];
    else this.pts.push(...samples(this, e));
    this.overlay();
  }

  async onPointerUp() {
    const pts = this.pts;
    this.pts = null;
    this.overlay();
    if (!pts || pts.length < 2) return;
    const editor = this.editor;
    const doc = editor.doc;
    const anchors = pts.length === 2 ? pts.map((p) => mkAnchor(p.x, p.y)) : fitCurve(simplifyPolyline(pts, tol(editor, 0.75)), tol(editor, 1.5) ** 2);
    const bounds = polylineBounds(pts);
    const pool = editor.selection.size ? geometryLeaves(doc, editor.topSelection()) : editableLeaves(doc);
    const targets = pool.filter((n) => (n.closed || n.type === 'compound' || n.fill) && rectsIntersect(nodeBounds(doc, n) || { x: 0, y: 0, w: -1, h: -1 }, bounds));
    if (!targets.length) return;
    const shapes = [...targets.map((n) => shapeOf(doc, n)), { subpaths: [{ anchors, closed: false }], filled: false, string: true }];
    const snap = snapshot(doc, targets);
    const records = await withBusy(this.app, 'Knife', () => runGeom(OP.SLICE_EACH, shapes, []));
    if (!unchangedSince(doc, snap)) return;
    const ids = [];
    doc.transact('Knife', () => {
      targets.forEach((n, i) => {
        const recs = records.filter((r) => r.owner === i);
        if (!recs.length || recs.some((r) => r.unchanged)) return;
        const style = styleOf(n);
        const items = recs.map((r) => nodeFromSubpaths(r.subpaths, style)).filter(Boolean);
        const parent = doc.get(n.parent);
        ids.push(...replaceWith(doc, [n], items, { parentId: parent.id, index: parent.children.indexOf(n.id) + 1 }));
      });
    });
    if (ids.length) editor.select(ids);
  }

  cancel() {
    this.pts = null;
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    if (this.pts) drawPolyline(ctx, editor, this.pts, '#e5484d', 1.25);
  }
}

// ---------------------------------------------------------------------------
// Brush-based tools (Eraser, Merge Brush)

class RoundBrushTool extends Tool {
  static sizePref = 'brushSize';
  static defaultSize = 10;

  constructor(app) {
    super(app);
    this.pts = null;
    this.cursorPt = null;
  }

  get size() {
    return this.app.prefs.get(this.constructor.sizePref) || this.constructor.defaultSize;
  }

  set size(v) {
    this.app.prefs.set(this.constructor.sizePref, Math.max(0.5, Math.min(1000, v)));
  }

  activate() {
    this.setCursor('crosshair');
    this.status();
    loadGeom().catch(() => {});
  }

  deactivate() {
    this.pts = null;
    this.cursorPt = null;
  }

  onHover(e) {
    this.cursorPt = { x: e.x, y: e.y };
    this.overlay();
  }

  onPointerDown(e) {
    if (isBusy()) return;
    this.pts = [{ x: e.x, y: e.y }];
    this.alt = e.alt;
  }

  onPointerMove(e) {
    this.cursorPt = { x: e.x, y: e.y };
    if (!this.pts) {
      this.overlay();
      return;
    }
    this.pts.push(...samples(this, e));
    this.overlay();
  }

  onKeyDown(ev) {
    if (ev.key === '[' || ev.key === ']') {
      const s = this.size;
      const step = s < 10 ? 1 : s < 50 ? 5 : 10;
      this.size = s + (ev.key === ']' ? step : -step);
      this.app.notify(`${this.constructor.label.replace(' Tool', '')} size ${this.size} pt`, { polite: true });
      this.overlay();
      return true;
    }
    return false;
  }

  cancel() {
    this.pts = null;
    this.overlay();
  }

  /** The brush path as anchors (smoothed), for the stroke expansion. */
  brushAnchors() {
    const pts = this.pts;
    const editor = this.editor;
    if (pts.length === 1) return [mkAnchor(pts[0].x, pts[0].y), mkAnchor(pts[0].x + 0.01, pts[0].y)];
    return fitCurve(simplifyPolyline(pts, tol(editor, 0.75)), tol(editor, 1) ** 2);
  }

  /** Expand the brush path into a filled outline (round caps and joins). */
  async brushOutline() {
    const anchors = this.brushAnchors();
    const recs = await runGeom(OP.STROKE, [{ subpaths: [{ anchors, closed: false }], filled: false }], [this.size, 1, 1, 4, 0, 0]);
    return recs[0]?.subpaths || [];
  }

  brushColor() {
    return '#4f80ff';
  }

  drawOverlay(ctx, editor) {
    const z = editor.view.zoom;
    if (this.pts && this.pts.length) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      drawPolyline(ctx, editor, this.pts.length > 1 ? this.pts : [this.pts[0], { x: this.pts[0].x + 0.01, y: this.pts[0].y }], this.brushColor(), Math.max(1, this.size * z));
      ctx.restore();
    }
    const c = this.cursorPt;
    if (c) {
      const s = editor.view.toScreen(c.x, c.y);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1.5, (this.size * z) / 2) + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#000000';
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1.5, (this.size * z) / 2), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  async openOptions() {
    const label = this.constructor.label.replace(' Tool', '');
    const v = await this.app.dialogs.form({
      title: `${label} Tool Options`,
      fields: [{ key: 'size', label: 'Size', type: 'length', value: this.size, min: 0.5, max: 1000 }],
    });
    if (v) this.size = v.size;
  }
}

export class EraserTool extends RoundBrushTool {
  static id = 'eraser';
  static label = 'Eraser Tool';
  static shortcut = 'Shift+E';
  static icon = 'tool-eraser';
  static hint = 'Drag to erase | [ and ] change the size | Option+drag erases a rectangle | Erases the selection, or everything unlocked when nothing is selected';
  static sizePref = 'eraserSize';

  activate() {
    super.activate();
    this.setCursor('none');
  }

  brushColor() {
    return '#e5484d';
  }

  onPointerMove(e) {
    if (this.pts && e.alt) {
      this.alt = true;
      this.pts = [this.pts[0], { x: e.x, y: e.y }];
      this.cursorPt = { x: e.x, y: e.y };
      this.overlay();
      return;
    }
    super.onPointerMove(e);
  }

  async onPointerUp() {
    const pts = this.pts;
    if (!pts) return;
    const editor = this.editor;
    const doc = editor.doc;
    const rect = this.alt && pts.length === 2;
    const hadSelection = editor.selection.size > 0;
    try {
      const pad = rect ? 0 : this.size / 2;
      const bounds = polylineBounds(pts, pad);
      const pool = hadSelection ? geometryLeaves(doc, editor.topSelection()) : editableLeaves(doc);
      const targets = pool.filter((n) => {
        const b = nodeBounds(doc, n);
        const sw = n.stroke ? (n.strokeWidth || 0) / 2 : 0;
        return b && rectsIntersect(inflate(b, sw), bounds);
      });
      if (!targets.length) return;
      const snap = snapshot(doc, targets);
      const records = await withBusy(this.app, 'Erase', async () => {
        let cutter;
        if (rect) {
          const r = polylineBounds(pts);
          cutter = [{ anchors: rectangle(r.x, r.y, r.w, r.h), closed: true }];
        } else cutter = await this.brushOutline();
        if (!cutter.length) return [];
        const shapes = [...targets.map((n) => shapeOf(doc, n, { string: n.type === 'path' && !n.closed && !n.fill })), { subpaths: cutter, filled: true }];
        return runGeom(OP.SUBTRACT_EACH, shapes, []);
      });
      if (!unchangedSince(doc, snap)) return;
      const ids = [];
      let changed = false;
      doc.transact('Erase', () => {
        targets.forEach((n, i) => {
          const recs = records.filter((r) => r.owner === i);
          if (!recs.length || recs.some((r) => r.unchanged)) {
            if (doc.has(n.id) && hadSelection) ids.push(n.id);
            return;
          }
          changed = true;
          const style = styleOf(n);
          const items = recs.filter((r) => r.subpaths.length).map((r) => nodeFromSubpaths(r.subpaths, style)).filter(Boolean);
          const parent = doc.get(n.parent);
          ids.push(...replaceWith(doc, [n], items, { parentId: parent.id, index: parent.children.indexOf(n.id) + 1 }));
        });
      });
      if (changed && hadSelection) editor.select(ids.filter((id) => doc.has(id)));
    } finally {
      this.pts = null;
      this.alt = false;
      this.overlay();
    }
  }
}

export class BlobBrushTool extends RoundBrushTool {
  static id = 'blob-brush';
  static label = 'Merge Brush Tool';
  static shortcut = 'Shift+B';
  static icon = 'tool-blob-brush';
  static hint = 'Paint filled shapes that merge with overlapping shapes of the same color | [ and ] change the size';
  static sizePref = 'blobBrushSize';

  activate() {
    super.activate();
    this.setCursor('none');
  }

  /** The blob paint: the stroke color (or the fill when the stroke is None). */
  paint() {
    const st = this.editor.style;
    return st.stroke || st.fill || { type: 'solid', color: '#000000' };
  }

  brushColor() {
    const p = this.paint();
    return p.type === 'solid' ? p.color : '#000000';
  }

  async onPointerUp() {
    const pts = this.pts;
    if (!pts) return;
    const editor = this.editor;
    const doc = editor.doc;
    try {
      if (!editor.canDrawInTarget()) {
        this.app.notify('The target layer is locked or hidden.');
        return;
      }
      const paint = this.paint();
      const style = { ...newPathStyle(editor), fill: paint, stroke: null };
      const key = solidKey({ fill: paint });
      const bounds = polylineBounds(pts, this.size / 2);
      const layer = editor.targetLayer();
      // Merge with overlapping blobs: same solid fill, no stroke, in the target layer.
      const candidates = key
        ? editableLeaves(doc).filter((n) => doc.layerOf(n.id)?.id === layer.id && !(n.stroke && n.strokeWidth > 0) && solidKey(n) === key && rectsIntersect(nodeBounds(doc, n) || { x: 0, y: 0, w: -1, h: -1 }, bounds))
        : [];
      const snap = snapshot(doc, candidates);
      const result = await withBusy(this.app, 'Merge Brush', async () => {
        const outline = await this.brushOutline();
        if (!outline.length) return null;
        if (!candidates.length) return { subpaths: outline, merged: [] };
        const blob = { subpaths: outline, filled: true };
        // Which candidates really overlap the new stroke (unchanged = no overlap)?
        const test = await runGeom(OP.DIVIDE_BELOW, [...candidates.map((n) => shapeOf(doc, n)), blob], []);
        const touched = candidates.filter((_, i) => test.some((r) => r.owner === i && !r.unchanged));
        if (!touched.length) return { subpaths: outline, merged: [] };
        const recs = await runGeom(OP.UNITE, [...touched.map((n) => shapeOf(doc, n)), blob], []);
        return { subpaths: recs[0]?.subpaths || outline, merged: touched };
      });
      if (!result || !unchangedSince(doc, snap)) return;
      const { merged, subpaths } = result;
      let id;
      doc.transact('Merge Brush', () => {
        const built = nodeFromSubpaths(subpaths, merged.length ? { ...styleOf(merged[merged.length - 1]) } : style);
        if (!built) return;
        if (merged.length) id = replaceWith(doc, merged, [built], insertionPoint(doc, merged))[0];
        else {
          id = editor.insertDrawn(built.node, built.descendants);
        }
      });
      if (id) editor.select([id]);
    } finally {
      this.pts = null;
      this.overlay();
    }
  }
}

// ---------------------------------------------------------------------------
// Join tool

/** Join two open paths at the given ends (or close one path). Returns new anchors. */
export function joinEnds(a, aEnd, b, bEnd) {
  let A = aEnd === 'start' ? reverseAnchors(a) : a.slice();
  let B = bEnd === 'end' ? reverseAnchors(b) : b.slice();
  const p = A[A.length - 1];
  const q = B[0];
  if (Math.hypot(p.x - q.x, p.y - q.y) < 0.01) {
    A = A.slice(0, -1);
    B = [{ ...q, ix: p.ix, iy: p.iy }, ...B.slice(1)];
  }
  return [...A, ...B];
}

export class JoinTool extends Tool {
  static id = 'join';
  static label = 'Join Tool';
  static shortcut = '';
  static icon = 'tool-join';
  static hint = 'Scrub over the gap between two open path ends to join them';

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  onPointerDown(e) {
    this.pts = [{ x: e.x, y: e.y }];
  }

  onPointerMove(e) {
    if (!this.pts) return;
    this.pts.push(...samples(this, e));
    this.overlay();
  }

  /** Open path ends near the scrub, nearest first: [{ node, end, d }]. */
  endsNear(pts) {
    const editor = this.editor;
    const doc = editor.doc;
    const r = tol(editor, 10);
    const bounds = polylineBounds(pts, r);
    const pool = editor.selection.size ? geometryLeaves(doc, editor.topSelection()) : editableLeaves(doc);
    const out = [];
    for (const n of pool) {
      if (n.type !== 'path' || n.closed || n.anchors.length < 2) continue;
      for (const end of ['start', 'end']) {
        const a = end === 'start' ? n.anchors[0] : n.anchors[n.anchors.length - 1];
        if (a.x < bounds.x || a.y < bounds.y || a.x > bounds.x + bounds.w || a.y > bounds.y + bounds.h) continue;
        let d = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const q = pts[Math.min(i + 1, pts.length - 1)];
          d = Math.min(d, segDist(a, p, q));
        }
        if (d <= r) out.push({ node: n, end, d });
      }
    }
    return out.sort((x, y) => x.d - y.d);
  }

  onPointerUp() {
    const pts = this.pts;
    this.pts = null;
    this.overlay();
    if (!pts || pts.length < 2) return;
    const ends = this.endsNear(pts);
    if (ends.length < 2) {
      this.app.notify('Scrub across the gap between two open path ends.', { polite: true });
      return;
    }
    const [e1, e2] = ends;
    const editor = this.editor;
    const doc = editor.doc;
    doc.transact('Join', () => {
      if (e1.node.id === e2.node.id) {
        const n = e1.node;
        let anchors = n.anchors;
        const f = anchors[0];
        const l = anchors[anchors.length - 1];
        if (Math.hypot(f.x - l.x, f.y - l.y) < 0.01 && anchors.length > 2) {
          anchors = anchors.slice(0, -1);
          anchors[0] = { ...anchors[0], ix: l.ix, iy: l.iy };
        }
        doc.update(n.id, { anchors, closed: true, shape: undefined });
        editor.select([n.id]);
        return;
      }
      const anchors = joinEnds(e1.node.anchors, e1.end, e2.node.anchors, e2.end);
      doc.update(e1.node.id, { anchors, shape: undefined });
      doc.remove(e2.node.id);
      editor.select([e1.node.id]);
    });
  }

  cancel() {
    this.pts = null;
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    if (this.pts) drawPolyline(ctx, editor, this.pts, '#4f80ff', 2);
  }
}

function segDist(a, p, q) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((a.x - p.x) * dx + (a.y - p.y) * dy) / l2)) : 0;
  return Math.hypot(a.x - p.x - dx * t, a.y - p.y - dy * t);
}

export const GEOMETRY_TOOLS = [ShapeBuilderTool, ScissorsTool, KnifeTool, EraserTool, BlobBrushTool, JoinTool];

