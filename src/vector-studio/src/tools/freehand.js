/**
 * Freehand tools: Pencil (N), Paintbrush (B), Smooth and Path Eraser.
 *
 * Pointer samples (including coalesced events for high-rate pens) are
 * simplified with Ramer-Douglas-Peucker and fitted with cubic Beziers
 * (Schneider), so a stroke becomes a few smooth anchors rather than
 * hundreds of points. Fidelity (accurate .. smooth) sets the tolerance.
 */
import { Tool, tol } from './tool.js';
import { createPath } from '../model/nodes.js';
import { fitCurve, simplifyPolyline, flattenPath, nearestOnPath, insertAnchor, pointAt, segmentPoints, segmentCount } from '../model/bezier.js';
import { newPathStyle } from './pen.js';
import { isSmooth, mirrorAngle } from './direct-selection.js';
import { removeEmptyContainers } from '../ops/object-ops.js';

/** Fit tolerance in document units for a fidelity value 0 (accurate) .. 100 (smooth). */
export function fidelityTolerance(fidelity, zoom) {
  const px = 0.5 + (fidelity / 100) * 9.5;
  return px / zoom;
}

export class PencilTool extends Tool {
  static id = 'pencil';
  static label = 'Pencil Tool';
  static shortcut = 'N';
  static icon = 'tool-pencil';
  static hint = 'Drag to draw a freeform path | Hold Option at the end to close it | Drag near a selected path end to continue it';
  static brush = false;

  constructor(app) {
    super(app);
    this.points = null;
    this.fidelity = 50;
    this.keepSelected = true;
  }

  activate() {
    this.setCursor('var(--cursor-pencil)');
    this.status();
  }

  deactivate() {
    this.points = null;
  }

  onPointerDown(e) {
    if (!this.editor.canDrawInTarget()) {
      this.app.notify('The target layer is locked or hidden.');
      return;
    }
    this.points = [{ x: e.x, y: e.y }];
    this.continueFrom = this.#endpointNear(e);
  }

  /** A selected open path whose end is near the pointer (to extend it). */
  #endpointNear(e) {
    const editor = this.editor;
    for (const id of editor.selection) {
      const n = editor.doc.get(id);
      if (!n || n.type !== 'path' || n.closed || n.anchors.length < 2) continue;
      const last = n.anchors[n.anchors.length - 1];
      const first = n.anchors[0];
      if (Math.hypot(last.x - e.x, last.y - e.y) < tol(editor, 8)) return { id, end: 'end' };
      if (Math.hypot(first.x - e.x, first.y - e.y) < tol(editor, 8)) return { id, end: 'start' };
    }
    return null;
  }

  onPointerMove(e) {
    if (!this.points) return;
    const samples = e.native?.getCoalescedEvents?.() || [];
    if (samples.length > 1) {
      for (const s of samples) {
        const p = this.app.eventToDoc(s);
        this.points.push(p);
      }
    } else this.points.push({ x: e.x, y: e.y });
    this.alt = e.alt;
    this.overlay();
  }

  onPointerUp(e) {
    const pts = this.points;
    this.points = null;
    if (!pts || pts.length < 2) {
      this.overlay();
      return;
    }
    const editor = this.editor;
    const t = fidelityTolerance(this.fidelity, editor.view.zoom);
    const simplified = simplifyPolyline(pts, t * 0.5);
    let anchors = fitCurve(simplified, t * t);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const close = e.alt || Math.hypot(first.x - last.x, first.y - last.y) < tol(editor, 4);
    const doc = editor.doc;
    doc.transact(this.constructor.label.replace(' Tool', ''), () => {
      if (this.continueFrom && doc.has(this.continueFrom.id)) {
        const base = doc.get(this.continueFrom.id);
        let baseAnchors = base.anchors;
        if (this.continueFrom.end === 'start') baseAnchors = baseAnchors.slice().reverse().map((a) => ({ ...a, ix: a.ox, iy: a.oy, ox: a.ix, oy: a.iy }));
        const joint = baseAnchors[baseAnchors.length - 1];
        const rest = anchors.slice(1);
        const merged = baseAnchors.slice(0, -1).concat([{ ...joint, ox: anchors[0].ox, oy: anchors[0].oy }], rest);
        doc.update(base.id, { anchors: merged, shape: undefined });
        editor.select([base.id]);
        return;
      }
      if (close && anchors.length > 2) {
        // Merge the final anchor into the first.
        const lastA = anchors.pop();
        anchors[0] = { ...anchors[0], ix: lastA.ix, iy: lastA.iy };
      }
      const style = this.pathStyle();
      const node = createPath(anchors, close && anchors.length > 2, style);
      doc.insert(node, editor.targetLayer().id);
      if (this.keepSelected) editor.select([node.id]);
      else editor.clearSelection();
    });
    this.overlay();
  }

  pathStyle() {
    // The Pencil draws with the current stroke and no fill unless "Fill new pencil strokes" is on.
    const style = newPathStyle(this.editor);
    if (!this.app.prefs.get('fillNewPencil')) style.fill = null;
    if (!style.stroke) style.stroke = { type: 'solid', color: '#000000' };
    return style;
  }

  drawOverlay(ctx, editor) {
    const pts = this.points;
    if (!pts || pts.length < 2) return;
    ctx.save();
    const st = editor.style.stroke;
    ctx.strokeStyle = st?.type === 'solid' ? st.color : '#000000';
    ctx.lineWidth = Math.max(1, (editor.style.strokeWidth || 1) * editor.view.zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = editor.view.toScreen(p.x, p.y);
      if (i) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  async openOptions() {
    const v = await this.app.dialogs.form({
      title: `${this.constructor.label.replace(' Tool', '')} Tool Options`,
      fields: [
        { key: 'fidelity', label: 'Fidelity (Accurate to Smooth)', type: 'range', min: 0, max: 100, value: this.fidelity },
        { key: 'keepSelected', label: 'Keep selected', type: 'checkbox', value: this.keepSelected },
      ],
    });
    if (!v) return;
    this.fidelity = v.fidelity;
    this.keepSelected = v.keepSelected;
  }
}

export class PaintbrushTool extends PencilTool {
  static id = 'paintbrush';
  static label = 'Paintbrush Tool';
  static shortcut = 'B';
  static icon = 'tool-paintbrush';
  static hint = 'Drag to paint a stroke with round caps | [ and ] change the stroke weight';
  static brush = true;

  activate() {
    this.setCursor('var(--cursor-brush)');
    this.status();
  }

  pathStyle() {
    const style = newPathStyle(this.editor);
    style.fill = null;
    style.stroke = this.editor.style.stroke || this.editor.style.fill || { type: 'solid', color: '#000000' };
    style.strokeCap = 'round';
    style.strokeJoin = 'round';
    return style;
  }

  onKeyDown(ev) {
    if (ev.key === '[' || ev.key === ']') {
      const w = Math.max(0.25, (this.editor.style.strokeWidth || 1) + (ev.key === ']' ? 1 : -1));
      this.editor.setStyle({ strokeWidth: w });
      this.app.notify(`Brush size ${w} pt`, { polite: true });
      return true;
    }
    return false;
  }
}

/** Smooth tool: drag along a selected path to simplify and smooth that part. */
export class SmoothTool extends Tool {
  static id = 'smooth';
  static label = 'Smooth Tool';
  static shortcut = '';
  static icon = 'tool-smooth';
  static hint = 'Drag along a selected path to smooth it';

  /** Fidelity 0 (accurate) to 100 (smooth), from Smooth Tool Options. */
  get fidelity() {
    const v = Number(this.app.prefs.get('smoothFidelity'));
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50;
  }

  async openOptions() {
    const v = await this.app.dialogs.form({
      title: 'Smooth Tool Options',
      fields: [{ key: 'fidelity', label: 'Fidelity (Accurate to Smooth)', type: 'range', min: 0, max: 100, value: this.fidelity }],
    });
    if (v) this.app.prefs.set('smoothFidelity', v.fidelity);
  }

  activate() {
    this.setCursor('var(--cursor-pencil)');
    this.status();
  }

  onPointerDown(e) {
    const editor = this.editor;
    // Each stroke re-fits the selected paths from their state when it started, over everything it swept.
    this.stroke = { orig: new Map(), marks: new Map() };
    for (const id of editor.selection) {
      const n = editor.doc.get(id);
      if (n?.type === 'path' && n.anchors.length >= 3 && !editor.doc.isLocked(id)) this.stroke.orig.set(id, n);
    }
    this.tx = this.doc.begin('Smooth');
    this.smoothAt(e);
  }

  onPointerMove(e) {
    if (this.tx) this.smoothAt(e);
  }

  onPointerUp() {
    this.tx?.commit();
    this.tx = null;
    this.stroke = null;
  }

  cancel() {
    this.tx?.cancel();
    this.tx = null;
    this.stroke = null;
  }

  /**
   * Smooth only the stretch of path the pointer has swept: the anchors it
   * passed are re-fitted between the nearest anchors outside it, which keep
   * their position and their handles on the far side.
   */
  smoothAt(e) {
    const editor = this.editor;
    const r = tol(editor, 12);
    for (const [id, n] of this.stroke.orig) {
      const near = nearestOnPath(n.anchors, n.closed, e.x, e.y);
      if (!near || near.d > r) continue;
      const marks = this.stroke.marks.get(id) || { lo: Infinity, hi: -Infinity };
      this.stroke.marks.set(id, marks);
      const count = n.anchors.length;
      // The swept segments, widened over anchors within reach of the pointer.
      let i0 = near.index;
      let i1 = near.index + 1;
      if (Math.hypot(n.anchors[i0].x - e.x, n.anchors[i0].y - e.y) < r && (n.closed || i0 > 0)) i0--;
      const j = i1 % count;
      if (Math.hypot(n.anchors[j].x - e.x, n.anchors[j].y - e.y) < r && (n.closed || i1 < count - 1)) i1++;
      marks.lo = Math.min(marks.lo, i0);
      marks.hi = Math.max(marks.hi, i1);
      const lo = marks.lo;
      const hi = Math.min(marks.hi, lo + count);
      if (hi - lo < 2) continue;
      const at = (i) => n.anchors[((i % count) + count) % count];
      const run = [];
      for (let i = lo; i <= hi; i++) run.push(at(i));
      // Fidelity sets how far the refit may stray from the stroke (a third of the reach at 50).
      const t = r * (0.08 + this.fidelity * 0.005);
      const fitted = fitCurve(simplifyPolyline(flattenPath(run, false, 0.5), t), t ** 2);
      if (fitted.length >= run.length || fitted.length < 2) continue;
      const first = { ...run[0], ox: fitted[0].ox, oy: fitted[0].oy };
      const last = { ...run[run.length - 1], ix: fitted[fitted.length - 1].ix, iy: fitted[fitted.length - 1].iy };
      // Ends that were smooth stay smooth.
      if (isSmooth(run[0])) mirrorAngle(first, 'out');
      if (isSmooth(run[run.length - 1])) mirrorAngle(last, 'in');
      const middle = [first, ...fitted.slice(1, -1), last];
      let anchors;
      if (n.closed) {
        // Rebuild from the window start: the window, then the untouched rest.
        const rest = [];
        for (let i = hi + 1; i < lo + count; i++) rest.push(at(i));
        anchors = hi - lo >= count ? middle.slice(0, -1) : [...middle, ...rest];
        if (anchors.length < 3) continue;
      } else anchors = [...n.anchors.slice(0, lo), ...middle, ...n.anchors.slice(hi + 1)];
      editor.doc.update(id, { anchors, shape: undefined });
    }
  }
}

/** Path Eraser: drag over a selected path to erase the parts under the pointer, splitting it. */
export class PathEraserTool extends Tool {
  static id = 'path-eraser';
  static label = 'Path Eraser Tool';
  static shortcut = '';
  static icon = 'tool-path-eraser';
  static hint = 'Drag along a selected path to erase parts of it';

  activate() {
    this.setCursor('var(--cursor-eraser)');
    this.status();
  }

  onPointerDown(e) {
    this.tx = this.doc.begin('Erase');
    this.eraseAt(e);
  }

  onPointerMove(e) {
    if (this.tx) this.eraseAt(e);
  }

  onPointerUp() {
    this.tx?.commit();
    this.tx = null;
  }

  eraseAt(e) {
    const editor = this.editor;
    const doc = editor.doc;
    const r = tol(editor, 6);
    const ids = [...editor.selection];
    for (const id of ids) {
      const n = doc.get(id);
      if (!n || n.type !== 'path' || doc.isLocked(id)) continue;
      const runs = eraseAround(n.anchors, n.closed, e.x, e.y, r);
      if (!runs) continue;
      const parent = doc.get(n.parent);
      const index = parent.children.indexOf(id);
      doc.remove(id);
      if (!runs.length) removeEmptyContainers(doc, [parent.id], editor.isolation);
      const added = [];
      runs.forEach((run, i) => {
        const piece = createPath(run, false, {}, {});
        Object.assign(piece, { ...n, id: piece.id, anchors: run, closed: false, shape: undefined });
        doc.insert(piece, parent.id, index + i);
        added.push(piece.id);
      });
      editor.select(added, { add: true });
    }
  }
}

/**
 * Erase the part of a path inside a circle around (px, py), cutting through
 * segments (not just whole anchors). Returns the open pieces that remain, or
 * null when the circle misses the path.
 */
export function eraseAround(anchors, closed, px, py, r) {
  const near = nearestOnPath(anchors, closed, px, py);
  if (!near || near.d > r) return null;
  let list = anchors;
  let g = near.index + near.t;
  const count = list.length;
  if (closed) {
    // Start the loop opposite the cut so the erased span does not wrap past the start.
    const shift = (near.index + Math.ceil(count / 2)) % count;
    list = [...list.slice(shift), ...list.slice(0, shift)];
    g = (((g - shift) % count) + count) % count;
  }
  const segs = segmentCount(list, closed);
  const pt = (s) => {
    const i = Math.min(segs - 1, Math.floor(s));
    return pointAt(segmentPoints(list, i), s - i);
  };
  const inside = (s) => {
    const p = pt(s);
    return Math.hypot(p.x - px, p.y - py) <= r;
  };
  const step = 0.02;
  let g0 = g;
  let g1 = g;
  while (g0 > 0 && inside(Math.max(0, g0 - step))) g0 = Math.max(0, g0 - step);
  while (g1 < segs && inside(Math.min(segs, g1 + step))) g1 = Math.min(segs, g1 + step);
  if (closed && g0 <= 0 && g1 >= segs) return [];
  // Cut at g1 first, then at g0 (re-parameterized when both fall in one segment).
  const cut = (lst, s) => {
    const i = Math.min(segment(lst), Math.floor(s));
    const t = s - i;
    if (t < 1e-6) return { list: lst, k: i };
    if (t > 1 - 1e-6) return { list: lst, k: (i + 1) % lst.length };
    return { list: insertAnchor(lst, closed, i, t), k: i + 1 };
  };
  const segment = (lst) => segmentCount(lst, closed) - 1;
  const i1 = Math.min(segs - 1, Math.floor(g1));
  const i0 = Math.min(segs - 1, Math.floor(g0));
  const a = cut(list, g1);
  let s0 = g0;
  if (i0 === i1 && g1 - i1 > 1e-6 && g1 - i1 < 1 - 1e-6) s0 = i0 + (g0 - i0) / (g1 - i1);
  const b = cut(a.list, s0);
  const all = b.list;
  const kb = b.k;
  const kf = a.k + (b.list.length - a.list.length);
  const retractOut = (p) => ({ ...p, ox: p.x, oy: p.y });
  const retractIn = (p) => ({ ...p, ix: p.x, iy: p.y });
  const head = all.slice(0, kb + 1);
  const tail = all.slice(kf);
  if (head.length) head[head.length - 1] = retractOut(head[head.length - 1]);
  if (tail.length) tail[0] = retractIn(tail[0]);
  if (closed) {
    const run = [...tail, ...head];
    return run.length > 1 ? [run] : [];
  }
  return [head, tail].filter((run) => run.length > 1);
}
