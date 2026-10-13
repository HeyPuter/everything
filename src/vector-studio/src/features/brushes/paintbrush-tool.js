/**
 * Paintbrush tool (B) with brushes: strokes are painted with the current
 * brush (chosen in the Brushes panel), pen pressure is recorded for brushes
 * that vary with pressure and drawing speed for brushes that vary with
 * velocity, and with "Edit selected paths" a stroke drawn
 * along a selected path reshapes that part of it instead of making a new
 * path. Double-click the tool for its options.
 */
import { PaintbrushTool, fidelityTolerance } from '../../tools/freehand.js';
import { tol } from '../../tools/tool.js';
import { createPath } from '../../model/nodes.js';
import { fitCurve, simplifyPolyline, nearestOnPath, insertAnchor } from '../../model/bezier.js';
import { newPathStyle } from '../../tools/pen.js';
import { brushById } from './brush-model.js';
import { brushState } from './brush-actions.js';

const DEFAULTS = { fidelity: 50, fill: false, keepSelected: true, editSelected: true, within: 12 };

/** Pressure samples [[t, p]] along a stroke's points (by length), thinned to at most `max`. */
export function pressureSamples(points, pressures, max = 24) {
  if (!pressures || pressures.length !== points.length || points.length < 2) return null;
  const lens = [0];
  for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const L = lens[lens.length - 1];
  if (!(L > 0)) return null;
  const out = [];
  for (let k = 0; k < max; k++) {
    const target = (L * k) / (max - 1);
    let i = 0;
    while (i < lens.length - 2 && lens[i + 1] < target) i++;
    const f = lens[i + 1] > lens[i] ? (target - lens[i]) / (lens[i + 1] - lens[i]) : 0;
    const p = pressures[i] + (pressures[i + 1] - pressures[i]) * Math.min(1, Math.max(0, f));
    out.push([Math.round((target / L) * 1000) / 1000, Math.round(p * 1000) / 1000]);
  }
  return out;
}

/** Screen speed (pixels per millisecond) that counts as fast (velocity 1). */
const FAST = 2.5;

/**
 * Drawing speed (0 slow .. 1 fast) at each stroke point from timestamps:
 * the screen speed over the neighboring points, smoothed.
 */
export function velocities(points, times, zoom = 1) {
  if (!times || times.length !== points.length || points.length < 2) return null;
  const n = points.length;
  const raw = points.map((_, i) => {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    let d = 0;
    for (let k = a; k < b; k++) d += Math.hypot(points[k + 1].x - points[k].x, points[k + 1].y - points[k].y);
    const dt = Math.max(1, times[b] - times[a]);
    return Math.min(1, (d * zoom) / dt / FAST);
  });
  return raw.map((_, i) => {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
      sum += raw[k];
      c++;
    }
    return sum / c;
  });
}

/** Global position (segment index + t) of the nearest point on a path. */
function locate(anchors, closed, x, y) {
  const n = nearestOnPath(anchors, closed, x, y);
  return n ? { u: n.index + n.t, index: n.index, t: n.t, d: n.d } : null;
}

/**
 * Replace the part of an open path between two located positions by new
 * anchors (oriented from a to b). Returns the new anchor list.
 */
export function reshapeSection(anchors, a, b, fresh) {
  let [lo, hi, pts] = a.u <= b.u ? [a, b, fresh] : [b, a, fresh.slice().reverse().map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }))];
  // Insert the later position first so the earlier index stays valid.
  let list = anchors;
  let hiIndex;
  if (hi.t > 1e-6 && hi.t < 1 - 1e-6) {
    list = insertAnchor(list, false, hi.index, hi.t);
    hiIndex = hi.index + 1;
  } else hiIndex = hi.t >= 1 - 1e-6 ? hi.index + 1 : hi.index;
  let loIndex;
  if (lo.t > 1e-6 && lo.t < 1 - 1e-6) {
    list = insertAnchor(list, false, lo.index, lo.t);
    loIndex = lo.index + 1;
    hiIndex += 1;
  } else loIndex = lo.t >= 1 - 1e-6 ? lo.index + 1 : lo.index;
  return [...list.slice(0, loIndex), ...pts, ...list.slice(hiIndex + 1)];
}

export class BrushPaintbrushTool extends PaintbrushTool {
  static hint = 'Drag to paint with the current brush | Draw along a selected path to reshape it | [ and ] change the stroke weight | Double-click the tool for options';

  constructor(app) {
    super(app);
    const saved = app.prefs.get('paintbrushOptions') || {};
    this.opts = { ...DEFAULTS, ...saved };
    this.fidelity = this.opts.fidelity;
    this.keepSelected = this.opts.keepSelected;
  }

  onPointerDown(e) {
    super.onPointerDown(e);
    this.pressures = e.pointerType === 'pen' ? [e.pressure ?? 0.5] : null;
    this.times = this.points ? this.points.map(() => e.native?.timeStamp ?? performance.now()) : null;
  }

  onPointerMove(e) {
    if (!this.points) return;
    const before = this.points.length;
    super.onPointerMove(e);
    const samples = e.native?.getCoalescedEvents?.() || [];
    const added = this.points.length - before;
    if (this.pressures) {
      for (let i = 0; i < added; i++) this.pressures.push(samples.length > 1 && samples[i] ? samples[i].pressure ?? e.pressure : e.pressure ?? 0.5);
    }
    if (this.times) {
      const now = e.native?.timeStamp ?? performance.now();
      for (let i = 0; i < added; i++) this.times.push(samples.length > 1 && samples[i]?.timeStamp ? samples[i].timeStamp : now);
    }
  }

  /** A selected open path near both ends of the stroke (or near its start), for reshaping. */
  editTarget(first, last) {
    if (!this.opts.editSelected) return null;
    const ed = this.editor;
    const reach = tol(ed, this.opts.within);
    for (const id of ed.selection) {
      const n = ed.doc.get(id);
      if (!n || n.type !== 'path' || n.closed || n.anchors.length < 2 || ed.doc.isLocked(id)) continue;
      const a = locate(n.anchors, false, first.x, first.y);
      if (!a || a.d > reach) continue;
      const b = locate(n.anchors, false, last.x, last.y);
      return { node: n, a, b: b && b.d <= reach ? b : null };
    }
    return null;
  }

  onPointerUp(e) {
    const pts = this.points;
    const pressures = this.pressures;
    const times = this.times;
    this.pressures = null;
    this.times = null;
    if (!pts || pts.length < 2) {
      super.onPointerUp(e);
      return;
    }
    const target = this.editTarget(pts[0], pts[pts.length - 1]);
    const endpoint = target && (target.a.u < 1e-3 || target.a.u > target.node.anchors.length - 1 - 1e-3);
    if (!target || (endpoint && !target.b)) {
      // A new stroke (or one continuing an end of a selected path: the base tool handles it).
      this.lastPressure = pressureSamples(pts, pressures);
      this.lastVelocity = pressureSamples(pts, velocities(pts, times, this.editor?.view.zoom || 1));
      super.onPointerUp(e);
      this.lastPressure = null;
      this.lastVelocity = null;
      return;
    }
    this.points = null;
    const ed = this.editor;
    const t = fidelityTolerance(this.fidelity, ed.view.zoom);
    const fresh = fitCurve(simplifyPolyline(pts, t * 0.5), t * t);
    const n = target.node;
    let anchors;
    if (target.b) anchors = reshapeSection(n.anchors, target.a, target.b, fresh);
    else {
      // Redraw from where the stroke started to the end of the path.
      const endLoc = { u: n.anchors.length - 1, index: n.anchors.length - 2, t: 1 };
      anchors = reshapeSection(n.anchors, target.a, endLoc, fresh);
    }
    ed.doc.transact('Paintbrush', () => ed.doc.update(n.id, { anchors, shape: undefined, brushPressure: undefined }));
    ed.select([n.id]);
    this.overlay();
  }

  pathStyle() {
    const ed = this.editor;
    const style = newPathStyle(ed);
    style.fill = this.opts.fill ? ed.style.fill || null : null;
    style.stroke = ed.style.stroke || ed.style.fill || { type: 'solid', color: '#000000' };
    if (!(style.strokeWidth > 0)) style.strokeWidth = 1;
    const id = brushState(this.app).currentId;
    if (id && brushById(ed.doc, id)) {
      style.brush = { id, seed: Math.floor(Math.random() * 0x7fffffff) };
      if (this.lastPressure && brushUsesPressure(brushById(ed.doc, id))) style.brushPressure = this.lastPressure;
      // Drawing speed rides on the brush reference (the brush reads it as `velocity`).
      if (this.lastVelocity && brushUsesMode(brushById(ed.doc, id), 'velocity')) style.brush.velocity = this.lastVelocity;
    } else {
      style.strokeCap = 'round';
      style.strokeJoin = 'round';
    }
    return style;
  }

  async openOptions() {
    const o = this.opts;
    const v = await this.app.dialogs.form({
      title: 'Paintbrush Tool Options',
      fields: [
        { key: 'fidelity', label: 'Fidelity (Accurate to Smooth)', type: 'range', min: 0, max: 100, value: o.fidelity },
        { type: 'heading', label: 'Options' },
        { key: 'fill', label: 'Fill new brush strokes', type: 'checkbox', value: o.fill },
        { key: 'keepSelected', label: 'Keep selected', type: 'checkbox', value: o.keepSelected },
        { key: 'editSelected', label: 'Edit selected paths', type: 'checkbox', value: o.editSelected },
        { key: 'within', label: 'Within (pixels)', type: 'range', min: 2, max: 20, value: o.within },
      ],
      extraButtons: [{ label: 'Reset', action: 'reset' }],
    });
    if (!v) return;
    const next = v.__action === 'reset' ? { ...DEFAULTS } : { fidelity: v.fidelity, fill: v.fill, keepSelected: v.keepSelected, editSelected: v.editSelected, within: v.within };
    this.opts = next;
    this.fidelity = next.fidelity;
    this.keepSelected = next.keepSelected;
    this.app.prefs.set('paintbrushOptions', next);
    if (v.__action === 'reset') this.openOptions();
  }
}

/** Whether a brush reads pen pressure anywhere. */
export function brushUsesPressure(b) {
  if (!b) return false;
  if (b.type === 'bristle') return true;
  return brushUsesMode(b, 'pressure');
}

/** Whether any of a brush's variable parameters uses a mode ('pressure', 'velocity', ...). */
export function brushUsesMode(b, mode) {
  return Boolean(b) && Object.values(b).some((v) => v && typeof v === 'object' && v.mode === mode);
}
