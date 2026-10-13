/**
 * The Dimension tool and dimension handles.
 *
 * Placing: click the measured points (linear: two points; angular: the
 * corner, then a point on each arm; radial: the center, then a point on the
 * circle, or click a circle or ellipse directly), then move the pointer to
 * place the dimension line and click. Pressing on the last point and
 * dragging places the line in the same gesture, and dragging from the first
 * point to the second is a quick way to give both. Points snap to anchors,
 * object bounds and alignment guides; a point snapped onto an object stays
 * attached to it. Shift constrains to 45° steps from the previous point.
 * Linear dimensions in Auto orientation measure horizontally or vertically
 * when the line is placed above/below or beside the points, and along the
 * points otherwise.
 *
 * Editing: with the Dimension or Direct Selection tool, drag a selected
 * dimension's measured points (they snap and re-attach), its dimension line
 * (offset, arc radius, label lead) or its label (slides along the line).
 */
import { Tool, tol, constrain45, constrainAngle } from '../../tools/tool.js';
import { buildSnapIndex, snapPoint } from '../../tools/snap.js';
import { hitTest } from '../../render/hit.js';
import { layerColor } from '../../render/overlay.js';
import { nodeBounds } from '../../model/geometry.js';
import { isDimension, createDimension, dimOptions, layoutIn, isAttached, movePointPatch, refPoint, formatDimLength, POINTS_NEEDED, KIND_LABELS } from './dimension-model.js';

export const TOOL_DEFAULTS = Object.freeze({ kind: 'linear', orient: 'auto', radial: 'radius', associative: true });

/** The Dimension tool's settings (kind, linear orientation, radial mode, attaching). */
export function toolSettings(app) {
  return { ...TOOL_DEFAULTS, ...(app.prefs.get('dimensionTool') || {}) };
}

export function setToolSettings(app, patch) {
  app.prefs.set('dimensionTool', { ...toolSettings(app), ...patch });
  app.tool?.status?.(app.tool.hintFor?.());
  app.dock?.update?.();
}

/** Display options for new dimensions. */
export function newDimOptions(app) {
  return dimOptions(app.prefs.get('dimensionOptions') || {});
}

/** Snap index of the artwork, leaving dimensions out (their boxes are not useful to measure from). */
function snapIndex(editor, exclude = []) {
  const ids = new Set(exclude);
  editor.doc.walk((n) => {
    if (isDimension(n)) ids.add(n.id);
    return true;
  });
  return buildSnapIndex(editor, ids);
}

export function selectedDimensions(editor) {
  return editor ? editor.selectedNodes().filter((n) => isDimension(n) && !editor.doc.isLocked(n.id)) : [];
}

const LEAF_TYPES = new Set(['path', 'text', 'image', 'instance']);

/**
 * The attachment for a point on artwork: a path anchor ({ id, anchor }) or a
 * point of a leaf object's bounds ({ id, box: [fx, fy] }) within `t`, or null.
 * Anchors win over bounds points at the same spot.
 */
export function findAttachment(doc, p, t, exclude = new Set()) {
  let best = null;
  let bestD = t;
  doc.walk((n) => {
    if (n.hidden || n.locked || exclude.has(n.id) || isDimension(n)) return false;
    if (n.type === 'path') {
      n.anchors.forEach((a, i) => {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d <= bestD) {
          bestD = d;
          best = { id: n.id, anchor: i };
        }
      });
    }
    if (LEAF_TYPES.has(n.type) && !(n.type === 'path' && doc.get(n.parent)?.type === 'compound')) {
      const b = nodeBounds(doc, n);
      if (b && b.w + b.h > 0) {
        for (const fx of [0, 0.5, 1]) {
          for (const fy of [0, 0.5, 1]) {
            const d = Math.hypot(b.x + fx * b.w - p.x, b.y + fy * b.h - p.y);
            if (d < bestD - 1e-9) {
              bestD = d;
              best = { id: n.id, box: [fx, fy] };
            }
          }
        }
      }
    }
    return true;
  });
  return best;
}

/** An ellipse-like closed path under the pointer, measured by a radial dimension: { p1, p2 } with references. */
export function circleAt(editor, e, associative = true) {
  const doc = editor.doc;
  const hit = hitTest(doc, e.x, e.y, tol(editor, 3));
  const n = hit && doc.get(hit.id);
  if (!n || n.type !== 'path' || !n.closed || doc.isLocked(n.id)) return null;
  const b = nodeBounds(doc, n);
  if (!b || b.w < 1e-6 || b.h < 1e-6) return null;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const round = n.shape?.kind === 'ellipse' || (n.anchors.length >= 4 && n.anchors.every((a) => Math.abs(Math.hypot((a.x - cx) / (b.w / 2), (a.y - cy) / (b.h / 2)) - 1) < 0.02));
  if (!round) return null;
  // Clicking the center starts a radial dimension there instead.
  if (Math.hypot(e.x - cx, e.y - cy) <= tol(editor, 6)) return null;
  const t = Math.atan2((e.y - cy) / (b.h / 2), (e.x - cx) / (b.w / 2));
  const fx = 0.5 + 0.5 * Math.cos(t);
  const fy = 0.5 + 0.5 * Math.sin(t);
  return {
    p1: { x: cx, y: cy, ref: associative ? { id: n.id, box: [0.5, 0.5] } : null },
    p2: { x: b.x + fx * b.w, y: b.y + fy * b.h, ref: associative ? { id: n.id, box: [fx, fy] } : null },
  };
}

/** A snapped point for placing or editing ({ x, y, ref, guides }). */
function pickPoint(editor, e, snap, from, { associative = true, exclude = new Set(), app = null } = {}) {
  let x = e.x;
  let y = e.y;
  let guides = { lines: [], labels: [] };
  let snapped = false;
  if (e.shift && from) {
    ({ x, y } = constrain45(from.x, from.y, e.x, e.y, constrainAngle(app)));
  } else {
    const s = snapPoint(editor, x, y, snap);
    x = s.x;
    y = s.y;
    snapped = s.snapped;
    guides = { lines: s.lines, labels: s.labels };
  }
  let ref = null;
  if (associative && !(e.shift && from)) {
    ref = findAttachment(editor.doc, { x, y }, snapped ? 1e-3 : tol(editor, 3), exclude);
    const p = ref && refPoint(editor.doc, ref);
    if (p) ({ x, y } = p);
  }
  return { x, y, ref, guides };
}

const strip = (p) => ({ x: p.x, y: p.y });

/** Linear orientation for Auto: horizontal above/below the points, vertical beside them, aligned otherwise. */
export function autoOrient(p1, p2, at) {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);
  const outY = at.y < minY || at.y > maxY;
  const outX = at.x < minX || at.x > maxX;
  if (outY && !outX) return 'horizontal';
  if (outX && !outY) return 'vertical';
  return 'aligned';
}

// ---- handles ----

const HANDLE = 5;

function nearPolyline(pts, x, y, t) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    if (Math.hypot(x - a.x - k * dx, y - a.y - k * dy) <= t) return true;
  }
  return false;
}

function inLabel(L, x, y, pad) {
  if (!L) return false;
  const c = Math.cos(-L.angle);
  const s = Math.sin(-L.angle);
  const dx = x - L.x;
  const dy = y - L.y;
  const u = dx * c - dy * s;
  const v = dx * s + dy * c;
  return Math.abs(u) <= L.w / 2 + pad && Math.abs(v) <= L.h / 2 + pad;
}

/** The handle of a selected dimension under the pointer: { node, part, lay } or null. */
export function handleAt(editor, e) {
  const view = editor.view;
  for (const d of selectedDimensions(editor).reverse()) {
    const lay = layoutIn(editor.doc, d);
    const keys = d.kind === 'angular' ? ['vertex', 'p1', 'p2'] : ['p1', 'p2'];
    for (const k of keys) {
      const p = lay.effective[k];
      const s = view.toScreen(p.x, p.y);
      if (Math.hypot(s.x - e.sx, s.y - e.sy) <= HANDLE + 1) return { node: d, part: k, lay };
    }
    if (inLabel(lay.label, e.x, e.y, tol(editor, 2))) return { node: d, part: 'label', lay };
    if (lay.track && nearPolyline(lay.track, e.x, e.y, tol(editor, 4))) return { node: d, part: 'line', lay };
  }
  return null;
}

/** Drag a dimension handle: { move(e), up(), cancel() }. */
export function startHandleDrag(app, editor, h, e0) {
  const doc = editor.doc;
  const node = h.node;
  const eff = h.lay.effective;
  const settings = toolSettings(app);
  const snap = snapIndex(editor, [node.id]);
  // Work from the drawn points so attached points that moved stay put.
  const base = { ...node, p1: eff.p1, p2: eff.p2, ...(node.kind === 'angular' ? { vertex: eff.vertex } : {}), at: eff.at };
  let tx = null;
  const fromFor = (part) => {
    if (node.kind === 'linear') return part === 'p1' ? eff.p2 : eff.p1;
    if (node.kind === 'angular') return part === 'vertex' ? null : eff.vertex;
    return part === 'p2' ? eff.p1 : null;
  };
  return {
    move(e) {
      if (!tx) tx = doc.begin('Edit Dimension');
      let patch;
      if (h.part === 'p1' || h.part === 'p2' || h.part === 'vertex') {
        const p = pickPoint(editor, e, snap, fromFor(h.part), { associative: settings.associative, exclude: new Set([node.id]), app });
        editor.alignmentGuides = p.guides;
        const attach = { of: node.id, ...(isAttached(node) ? node.attach : {}), [h.part]: p.ref };
        const any = ['p1', 'p2', 'vertex'].some((k) => attach[k]);
        patch = { p1: base.p1, p2: base.p2, ...(node.kind === 'angular' ? { vertex: base.vertex } : {}), ...movePointPatch(base, h.part, p), attach: any ? attach : null };
      } else if (h.part === 'line') {
        patch = { p1: base.p1, p2: base.p2, ...(node.kind === 'angular' ? { vertex: base.vertex } : {}), at: { x: e.x, y: e.y } };
      } else if (node.kind === 'radial') {
        patch = { p1: base.p1, p2: base.p2, at: { x: e.x, y: e.y } };
      } else if (node.kind === 'angular') {
        const V = eff.vertex;
        const da = Math.atan2(e.y - V.y, e.x - V.x) - Math.atan2(e0.y - V.y, e0.x - V.x);
        const n = Math.atan2(Math.sin(da), Math.cos(da));
        patch = { labelShift: (node.labelShift || 0) + n * h.lay.radius * h.lay.sweepSign };
      } else {
        const d = h.lay.dir;
        patch = { labelShift: (node.labelShift || 0) + (e.x - e0.x) * d.x + (e.y - e0.y) * d.y };
      }
      doc.update(node.id, patch);
      const lay = layoutIn(doc, doc.get(node.id));
      editor.feedback = { sx: e.sx, sy: e.sy, text: lay.text };
    },
    up() {
      editor.feedback = null;
      editor.alignmentGuides = null;
      tx?.commit();
      tx = null;
    },
    cancel() {
      editor.feedback = null;
      editor.alignmentGuides = null;
      tx?.cancel();
      tx = null;
    },
  };
}

/** Direct Selection tool hook: drag the handles of selected dimensions. */
export const dimensionHandleHook = {
  pointerDown(tool, e) {
    const h = handleAt(tool.editor, e);
    return h ? startHandleDrag(tool.app, tool.editor, h, e) : null;
  },
  hover(tool, e) {
    return handleAt(tool.editor, e) ? 'move' : null;
  },
};

/** Measured points (filled when attached to an object), the dimension line and the label of selected dimensions. */
export function drawDimensionHandles(ctx, editor) {
  if (!editor.viewOptions.edges) return;
  const view = editor.view;
  for (const d of selectedDimensions(editor)) {
    const lay = layoutIn(editor.doc, d);
    const color = layerColor(editor, d.id);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    if (lay.track?.length > 1) {
      ctx.beginPath();
      lay.track.forEach((p, i) => {
        const s = view.toScreen(p.x, p.y);
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
    }
    const keys = d.kind === 'angular' ? ['vertex', 'p1', 'p2'] : ['p1', 'p2'];
    for (const k of keys) {
      const p = lay.effective[k];
      const s = view.toScreen(p.x, p.y);
      const attached = isAttached(d) && d.attach[k];
      ctx.beginPath();
      ctx.rect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
      if (attached) ctx.fill();
      else {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.fillStyle = color;
      }
      ctx.stroke();
    }
    const L = lay.label;
    if (L) {
      const s = view.toScreen(L.x, L.y);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 4);
      ctx.lineTo(s.x + 4, s.y);
      ctx.lineTo(s.x, s.y + 4);
      ctx.lineTo(s.x - 4, s.y);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---- the tool ----

const HINTS = {
  linear: 'Click two points, then click to place the dimension line | Drag between the points, or press on the last point and drag | Shift constrains to 45°',
  angular: 'Click the corner, then a point on each arm, then click to place the arc | Shift constrains to 45°',
  radial: 'Click a circle, or its center and then a point on it, then click to place the label | Shift constrains to 45°',
};

export class DimensionTool extends Tool {
  static id = 'dimension';
  static label = 'Dimension Tool';
  static shortcut = '';
  static icon = 'tool-dimension';
  static hint = HINTS.linear;

  constructor(app) {
    super(app);
    this.pick = null;
    this.drag = null;
    this.hoverPoint = null;
    this.hoverSnap = null;
  }

  hintFor() {
    const s = toolSettings(this.app);
    return `${KIND_LABELS[s.kind]}: ${HINTS[s.kind]} | Drag a selected dimension's points, line or label to edit it`;
  }

  activate() {
    this.setCursor('crosshair');
    this.status(this.hintFor());
  }

  deactivate() {
    this.commit();
    this.hoverPoint = null;
    this.hoverSnap = null;
  }

  get settings() {
    return toolSettings(this.app);
  }

  #snapIndex() {
    const ed = this.editor;
    const now = Date.now();
    if (!this.hoverSnap || this.hoverSnap.doc !== ed.doc || now - this.hoverSnap.at > 800) this.hoverSnap = { doc: ed.doc, at: now, index: snapIndex(ed) };
    return this.hoverSnap.index;
  }

  #from() {
    const pk = this.pick;
    return pk?.pts.length ? pk.pts[0] : null;
  }

  #point(e) {
    const pk = this.pick;
    const p = pickPoint(this.editor, e, pk ? pk.snap : this.#snapIndex(), this.#from(), { associative: this.settings.associative, app: this.app });
    this.editor.alignmentGuides = p.guides;
    return { x: p.x, y: p.y, ref: p.ref };
  }

  onHover(e) {
    if (this.pick) {
      this.#track(e);
      return;
    }
    const h = handleAt(this.editor, e);
    this.setCursor(h ? 'move' : 'crosshair');
    this.hoverPoint = h ? null : this.#point(e);
    this.overlay();
  }

  onPointerDown(e) {
    const ed = this.editor;
    const pk = this.pick;
    if (!pk) {
      const h = handleAt(ed, e);
      if (h) {
        // Dragging a handle edits; a click on a measured point starts a new dimension there (chained dimensions).
        this.pending = { h, e };
        return;
      }
      this.#startPick(e);
      return;
    }
    pk.press = { sx: e.sx, sy: e.sy };
    pk.moved = false;
    if (pk.phase === 'points') {
      pk.pts.push(this.#point(e));
      if (pk.pts.length >= POINTS_NEEDED[pk.kind]) this.#beginPlace(e);
      this.overlay();
      return;
    }
    // Placing: the click (or the end of a drag) commits.
    pk.commitOnUp = true;
  }

  #startPick(e, first = null) {
    const ed = this.editor;
    if (!ed.canDrawInTarget()) {
      this.app.notify('The target layer is locked or hidden.');
      return;
    }
    const s = this.settings;
    this.pick = { kind: s.kind, pts: [], snap: snapIndex(ed), press: { sx: e.sx, sy: e.sy }, moved: false, phase: 'points' };
    const circle = s.kind === 'radial' ? circleAt(ed, e, s.associative) : null;
    if (circle) {
      this.pick.pts.push(circle.p1, circle.p2);
      this.#beginPlace(e);
    } else this.pick.pts.push(first || this.#point(e));
    this.hoverPoint = null;
    this.overlay();
  }

  onPointerMove(e) {
    const pend = this.pending;
    if (pend && Math.hypot(e.sx - pend.e.sx, e.sy - pend.e.sy) >= 3) {
      this.pending = null;
      this.drag = startHandleDrag(this.app, this.editor, pend.h, pend.e);
    }
    if (this.drag) {
      this.drag.move(e);
      return;
    }
    const pk = this.pick;
    if (!pk) return;
    if (pk.press && !pk.moved && Math.hypot(e.sx - pk.press.sx, e.sy - pk.press.sy) >= 3) pk.moved = true;
    this.#track(e);
  }

  onPointerUp(e) {
    const pend = this.pending;
    this.pending = null;
    if (pend && !this.drag) {
      const { node, part, lay } = pend.h;
      if (['p1', 'p2', 'vertex'].includes(part) && this.settings.kind !== 'radial') {
        // Start exactly on the clicked point, attached to what it measures.
        const p = lay.effective[part];
        const ref = this.settings.associative && isAttached(node) ? node.attach[part] || null : null;
        this.#startPick(pend.e, { x: p.x, y: p.y, ref });
        if (this.pick) {
          this.pick.press = null;
          this.pick.moved = false;
        }
      }
      return;
    }
    if (this.drag) {
      this.drag.up(e);
      this.drag = null;
      this.overlay();
      return;
    }
    const pk = this.pick;
    if (!pk) return;
    if (pk.phase === 'points' && pk.moved) {
      // Dragging from a point: the release gives the next one.
      pk.pts.push(this.#point(e));
      if (pk.pts.length >= POINTS_NEEDED[pk.kind]) this.#beginPlace(e);
    } else if (pk.phase === 'place' && (pk.commitOnUp || pk.moved)) {
      this.#place(e);
      this.#finish();
      return;
    }
    pk.press = null;
    pk.moved = false;
    this.overlay();
  }

  #track(e) {
    const pk = this.pick;
    if (pk.phase === 'points') {
      pk.hover = this.#point(e);
      const prev = pk.pts[pk.pts.length - 1];
      if (prev) {
        const from = pk.kind === 'linear' ? prev : pk.pts[0];
        const d = Math.hypot(pk.hover.x - from.x, pk.hover.y - from.y);
        const text = pk.kind === 'angular' ? (pk.pts.length === 1 ? 'First arm' : 'Second arm') : formatDimLength(d, newDimOptions(this.app), this.editor.doc.root.units);
        this.editor.feedback = { sx: e.sx, sy: e.sy, text };
      }
      this.overlay();
      return;
    }
    this.#place(e);
  }

  #beginPlace(e) {
    const pk = this.pick;
    const ed = this.editor;
    const doc = ed.doc;
    const s = this.settings;
    const [a, b, c] = pk.pts;
    const pts = pk.kind === 'angular' ? { vertex: a, p1: b, p2: c } : { p1: a, p2: b };
    const degenerate = pk.kind === 'angular' ? Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 || Math.hypot(c.x - a.x, c.y - a.y) < 1e-6 : Math.hypot(b.x - a.x, b.y - a.y) < 1e-6;
    if (degenerate) {
      // Two clicks on the same spot measure nothing: keep the first point and wait for another.
      pk.pts.pop();
      return;
    }
    const refs = { p1: pts.p1.ref || null, p2: pts.p2.ref || null, ...(pts.vertex ? { vertex: pts.vertex.ref || null } : {}) };
    const attach = s.associative && Object.values(refs).some(Boolean) ? refs : null;
    const orient = pk.kind === 'linear' ? (s.orient === 'auto' ? 'aligned' : s.orient) : pk.kind === 'radial' ? s.radial : undefined;
    const node = createDimension(pk.kind, { p1: strip(pts.p1), p2: strip(pts.p2), ...(pts.vertex ? { vertex: strip(pts.vertex) } : {}) }, { orient, attach, dim: newDimOptions(this.app) });
    pk.tx = doc.begin(`${KIND_LABELS[pk.kind]} Dimension`);
    doc.insert(node, ed.targetLayer().id);
    pk.id = node.id;
    pk.phase = 'place';
    pk.auto = pk.kind === 'linear' && s.orient === 'auto';
    pk.hover = null;
    ed.alignmentGuides = null;
    ed.select([node.id]);
    this.#place(e);
  }

  #place(e) {
    const pk = this.pick;
    const ed = this.editor;
    const doc = ed.doc;
    const node = doc.get(pk.id);
    if (!node) return;
    const at = { x: e.x, y: e.y };
    const patch = { at };
    if (pk.auto) patch.orient = autoOrient(node.p1, node.p2, at);
    doc.update(pk.id, patch);
    const lay = layoutIn(doc, doc.get(pk.id));
    ed.feedback = { sx: e.sx, sy: e.sy, text: lay.text };
  }

  #finish() {
    const pk = this.pick;
    this.pick = null;
    const ed = this.editor;
    ed.feedback = null;
    ed.alignmentGuides = null;
    pk.tx?.commit();
    if (pk.id && ed.doc.has(pk.id)) ed.select([pk.id]);
    this.hoverSnap = null;
    this.overlay();
  }

  onKeyDown(ev) {
    const pk = this.pick;
    if (ev.key === 'Escape' && (pk || this.drag)) {
      this.cancel();
      return true;
    }
    if (ev.key === 'Enter' && pk?.phase === 'place') {
      this.#finish();
      return true;
    }
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && pk?.phase === 'points') {
      pk.pts.pop();
      if (!pk.pts.length) this.cancel();
      else this.overlay();
      return true;
    }
    return false;
  }

  cancel() {
    this.pending = null;
    if (this.drag) {
      this.drag.cancel();
      this.drag = null;
    }
    const pk = this.pick;
    this.pick = null;
    pk?.tx?.cancel();
    if (this.editor) {
      this.editor.feedback = null;
      this.editor.alignmentGuides = null;
    }
    this.overlay();
  }

  /** Tool switch or Enter: a dimension being placed is kept where it is; a half-picked one is dropped. */
  commit() {
    if (this.pick?.phase === 'place') this.#finish();
    else this.cancel();
  }

  openOptions() {
    this.app.commands.run('dimension.toolOptions');
  }

  drawOverlay(ctx, editor) {
    const view = editor.view;
    const pk = this.pick;
    const color = layerColor(editor, editor.targetLayer()?.id);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const mark = (p, filled) => {
      const s = view.toScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
      if (filled) ctx.fill();
      ctx.stroke();
    };
    if (pk?.phase === 'points') {
      const pts = [...pk.pts, ...(pk.hover ? [pk.hover] : [])];
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (pk.kind === 'linear') {
        pts.forEach((p, i) => {
          const s = view.toScreen(p.x, p.y);
          if (i) ctx.lineTo(s.x, s.y);
          else ctx.moveTo(s.x, s.y);
        });
      } else {
        // Angular arms and the radius run from the first point.
        const o = view.toScreen(pts[0].x, pts[0].y);
        for (const p of pts.slice(1)) {
          const s = view.toScreen(p.x, p.y);
          ctx.moveTo(o.x, o.y);
          ctx.lineTo(s.x, s.y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of pts) mark(p, Boolean(p.ref));
    } else if (!pk && this.hoverPoint && editor.view) {
      mark(this.hoverPoint, Boolean(this.hoverPoint.ref));
    }
    ctx.restore();
  }
}
