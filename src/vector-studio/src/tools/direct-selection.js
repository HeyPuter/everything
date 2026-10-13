/**
 * Direct Selection (A), Group Selection and Lasso (Q) tools.
 *
 * Direct Selection selects and drags individual anchors, direction handles
 * and segments. Dragging a curved segment reshapes it so the curve follows
 * the pointer; dragging a handle of a smooth anchor keeps the opposite
 * handle collinear (Alt breaks it into a corner).
 */
import { Tool, tol, fmt } from './tool.js';
import { hitTest, marqueeHits, pointInPolygon, nodeTouchesRect } from '../render/hit.js';
import { TransformSession } from './transform-session.js';
import { anchor, hasIn, hasOut, nearestOnPath, segmentPoints, segmentCount, pointAt } from '../model/bezier.js';
import { buildSnapIndex, snapPoint } from './snap.js';
import { rectFrom } from './selection.js';
import { leafNodes } from '../render/overlay.js';
import { selectedSegmentHits } from '../ops/object-ops.js';

const ANCHOR_HIT = 5;

/**
 * Feature hooks: instance(tool, node, e) handles a Direct Selection click
 * on a leaf live object (e.g. picking one part of a symbol instance) and
 * returns true when it did.
 */
export const directSelectHooks = { instance: null };

/**
 * Feature hooks for objects with their own points (gradient meshes):
 *   pointerDown(tool, e) -> null | { move(e), up(e), cancel(), drawOverlay?(ctx, editor) }
 *     claims the press (dragging a mesh point, selecting a patch)
 *   marquee(tool, rect, add)  refines a marquee selection
 *   hover(tool, e) -> cursor | null   claims the pointer while hovering
 *   doubleClick(tool, e) -> bool      handles a double-click
 *   acceptsAlt: true                  also gets presses with Option held
 */
export const directSelectionHooks = [];

/** Is an anchor smooth (handles on opposite sides of the anchor, collinear)? */
export function isSmooth(a) {
  if (!hasIn(a) || !hasOut(a)) return false;
  const v1x = a.x - a.ix;
  const v1y = a.y - a.iy;
  const v2x = a.ox - a.x;
  const v2y = a.oy - a.y;
  const cross = v1x * v2y - v1y * v2x;
  const l = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  return l > 0 && Math.abs(cross) / l < 0.02 && v1x * v2x + v1y * v2y > 0;
}

/** Paths whose anchors are editable: plain paths and compound children, visible and unlocked. */
export function editablePaths(editor) {
  const out = [];
  const { doc } = editor;
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type === 'path') out.push(n);
    return true;
  });
  return out;
}

/** Find an anchor or handle under a screen point among the given paths. */
export function findAnchorOrHandle(editor, sx, sy, paths, { handles = true } = {}) {
  const { view } = editor;
  let best = null;
  let bestD = ANCHOR_HIT;
  for (const p of paths) {
    const sel = editor.selectedAnchors(p.id);
    const n = p.anchors.length;
    const partial = editor.anchors.has(p.id);
    p.anchors.forEach((a, i) => {
      const s = view.toScreen(a.x, a.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d <= bestD) {
        bestD = d;
        best = { path: p, index: i, part: 'anchor' };
      }
      if (!handles) return;
      const prevSel = sel.has(i) || (partial && sel.has(i - 1 >= 0 ? i - 1 : n - 1));
      const nextSel = sel.has(i) || (partial && sel.has((i + 1) % n));
      if (prevSel && hasIn(a) && (p.closed || i > 0)) {
        const h = view.toScreen(a.ix, a.iy);
        const dh = Math.hypot(h.x - sx, h.y - sy);
        if (dh <= bestD) {
          bestD = dh;
          best = { path: p, index: i, part: 'in' };
        }
      }
      if (nextSel && hasOut(a) && (p.closed || i < n - 1)) {
        const h = view.toScreen(a.ox, a.oy);
        const dh = Math.hypot(h.x - sx, h.y - sy);
        if (dh <= bestD) {
          bestD = dh;
          best = { path: p, index: i, part: 'out' };
        }
      }
    });
  }
  return best;
}

/** Paths currently showing anchors (selected or hovered). */
function activePaths(editor) {
  const out = new Map();
  for (const id of editor.selection) {
    for (const leaf of leafNodes(editor.doc, editor.doc.get(id))) {
      if (leaf.type === 'path') out.set(leaf.id, leaf);
      if (leaf.type === 'compound') for (const c of leaf.children) out.set(c, editor.doc.get(c));
    }
  }
  for (const id of editor.anchors.keys()) out.set(id, editor.doc.get(id));
  if (editor.hover) {
    const h = editor.doc.get(editor.hover);
    if (h?.type === 'path') out.set(h.id, h);
  }
  return [...out.values()].filter((p) => p && !editor.doc.isLocked(p.id));
}

/** New anchors with the given indices moved by (dx, dy), handles included. */
export function moveAnchorSet(anchors, indices, dx, dy) {
  return anchors.map((a, i) => (indices.has(i) ? { x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy } : a));
}

export class DirectSelectionTool extends Tool {
  static id = 'direct-selection';
  static label = 'Direct Selection Tool';
  static shortcut = 'A';
  static icon = 'tool-direct-selection';
  static hint = 'Click an anchor point or path segment to select | Drag to move | Shift+Click to add to the selection';

  constructor(app) {
    super(app);
    this.selectionMode = 'direct';
    this.drag = null;
  }

  activate() {
    this.setCursor('var(--cursor-direct)');
    this.status();
  }

  deactivate() {
    this.cancel();
  }

  onDoubleClick(e) {
    for (const hook of directSelectionHooks) if (hook.doubleClick?.(this, e)) return;
  }

  onHover(e) {
    const editor = this.editor;
    for (const hook of directSelectionHooks) {
      const cursor = hook.hover?.(this, e);
      if (cursor) {
        this.hookCursor = true;
        this.setCursor(cursor);
        return;
      }
    }
    if (this.hookCursor) {
      this.hookCursor = false;
      this.setCursor('var(--cursor-direct)');
    }
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 3), { outline: editor.viewOptions.mode === 'outline' || Boolean(editor.prefs?.get('objectSelectionByPath')), intoCompound: true });
    const id = hit?.id || null;
    if (editor.hover !== id) {
      editor.hover = id;
      this.overlay();
    }
  }

  onPointerDown(e) {
    const editor = this.editor;
    const doc = editor.doc;
    for (const hook of directSelectionHooks) {
      if (e.alt && !hook.acceptsAlt) continue;
      const handler = hook.pointerDown?.(this, e);
      if (handler) {
        this.drag = { kind: 'hook', handler };
        return;
      }
    }
    const paths = activePaths(editor);
    const ah = findAnchorOrHandle(editor, e.sx, e.sy, paths);
    // Alt works like the Group Selection tool (whole path, then its groups; Alt-drag copies),
    // except on a direction handle, where Alt breaks a smooth point.
    if (e.alt && !(ah && ah.part !== 'anchor') && this.constructor === DirectSelectionTool) {
      this.delegate = this.app.getTool('group-selection');
      this.delegate.onPointerDown(e);
      return;
    }
    if (ah) {
      if (ah.part === 'anchor') {
        const sel = editor.selectedAnchors(ah.path.id);
        if (e.shift) {
          // A wholly selected path first becomes an explicit anchor set so the toggle removes just this anchor.
          if (!editor.anchors.has(ah.path.id) && sel.size) editor.selectAnchors(ah.path.id, [...sel], { add: true });
          // Shift adds the anchor and drags the selection; a selected anchor is deselected only on a plain click.
          const wasSelected = sel.has(ah.index);
          if (!wasSelected) editor.selectAnchors(ah.path.id, [ah.index], { add: true });
          this.startAnchorDrag(e, ah);
          if (wasSelected) this.drag.toggle = { id: ah.path.id, index: ah.index };
          return;
        }
        // On an already selected anchor the whole selection drags; a click without a drag narrows it to this anchor.
        const narrow = sel.has(ah.index) && (sel.size > 1 || editor.selection.size > 1);
        if (!sel.has(ah.index)) editor.selectAnchors(ah.path.id, [ah.index]);
        this.startAnchorDrag(e, ah);
        if (narrow) this.drag.narrow = { id: ah.path.id, index: ah.index };
        return;
      }
      this.startHandleDrag(e, ah);
      return;
    }
    const hit = hitTest(doc, e.x, e.y, tol(editor, 3), { outline: editor.viewOptions.mode === 'outline' || Boolean(editor.prefs?.get('objectSelectionByPath')), intoCompound: true });
    if (hit && !hit.children && !hit.anchors && directSelectHooks.instance?.(this, hit, e)) return;
    if (hit) {
      if (hit.type === 'path') {
        // Clicking right on an anchor of an unselected path grabs that anchor.
        const onAnchor = findAnchorOrHandle(editor, e.sx, e.sy, [hit], { handles: false });
        if (onAnchor) {
          if (e.shift) editor.selectAnchors(hit.id, [onAnchor.index], { add: true });
          else editor.selectAnchors(hit.id, [onAnchor.index]);
          this.startAnchorDrag(e, onAnchor);
          return;
        }
        const near = nearestOnPath(hit.anchors, hit.closed, e.x, e.y);
        if (near && near.d <= tol(editor, 4) && !e.shift && selectedSegmentHits(editor).get(hit.id)?.includes(near.index)) {
          // A segment the marquee selected: dragging moves every selected segment (and anchor) with it.
          this.drag = { kind: 'anchors', x0: e.x, y0: e.y, px: e.x, py: e.y, targets: null, moved: false, segments: { path: hit, index: near.index } };
          return;
        }
        if (near && near.d <= tol(editor, 4)) {
          // Segment click: select its two anchors; dragging reshapes the segment.
          const i0 = near.index;
          const i1 = (near.index + 1) % hit.anchors.length;
          if (e.shift) editor.selectAnchors(hit.id, [i0, i1], { add: true });
          else {
            editor.selectAnchors(hit.id, [i0, i1]);
            // Remember the clicked segment so Delete removes just it (see deleteSelection).
            editor.segment = { id: hit.id, index: i0, node: hit, set: editor.anchors.get(hit.id) };
          }
          this.startSegmentDrag(e, hit, near);
          return;
        }
        // Fill click: the whole path.
        if (e.shift) editor.select([hit.id], { toggle: true });
        else if (!editor.selection.has(hit.id) || editor.anchors.has(hit.id)) editor.select([hit.id]);
      } else if (e.shift) editor.select([hit.id], { toggle: true });
      else if (!editor.selection.has(hit.id)) editor.select([hit.id]);
      this.startObjectDrag(e);
      return;
    }
    if (!e.shift) editor.clearSelection();
    this.drag = { kind: 'marquee', x0: e.x, y0: e.y, x: e.x, y: e.y, add: e.shift };
  }

  /** Originals of every partially/fully selected path for an anchor move. */
  #anchorTargets() {
    const editor = this.editor;
    const targets = [];
    const seen = new Set();
    const addPath = (p) => {
      if (!p || seen.has(p.id) || p.type !== 'path' || editor.doc.isLocked(p.id)) return;
      seen.add(p.id);
      const sel = editor.selectedAnchors(p.id);
      if (sel.size) targets.push({ id: p.id, orig: p, indices: new Set(sel) });
    };
    for (const id of editor.anchors.keys()) addPath(editor.doc.get(id));
    for (const id of editor.selection) for (const leaf of leafNodes(editor.doc, editor.doc.get(id))) {
      if (leaf.type === 'compound') for (const c of leaf.children) addPath(editor.doc.get(c));
      else addPath(leaf);
    }
    // Segments a marquee selected move with their end points.
    for (const [id, indices] of selectedSegmentHits(editor)) {
      const p = editor.doc.get(id);
      if (!p || editor.doc.isLocked(id)) continue;
      let t = targets.find((x) => x.id === id);
      if (!t) targets.push((t = { id, orig: p, indices: new Set() }));
      for (const i of indices) t.indices.add(i).add((i + 1) % p.anchors.length);
    }
    return targets;
  }

  startAnchorDrag(e, ah) {
    const a = ah.path.anchors[ah.index];
    this.drag = { kind: 'anchors', x0: a.x, y0: a.y, px: e.x, py: e.y, targets: null, moved: false };
  }

  startObjectDrag(e) {
    this.drag = { kind: 'anchors', x0: e.x, y0: e.y, px: e.x, py: e.y, targets: null, moved: false, object: true };
  }

  startHandleDrag(e, ah) {
    const a = ah.path.anchors[ah.index];
    this.drag = { kind: 'handle', path: ah.path, index: ah.index, part: ah.part, smooth: isSmooth(a), tx: null };
  }

  startSegmentDrag(e, path, near) {
    const c = segmentPoints(path.anchors, near.index);
    const straight = Math.abs(c[2] - c[0]) < 1e-9 && Math.abs(c[3] - c[1]) < 1e-9 && Math.abs(c[4] - c[6]) < 1e-9 && Math.abs(c[5] - c[7]) < 1e-9;
    if (straight) {
      this.drag = { kind: 'anchors', x0: e.x, y0: e.y, px: e.x, py: e.y, targets: null, moved: false };
      return;
    }
    this.drag = { kind: 'segment', path, index: near.index, t: near.t, x0: e.x, y0: e.y, c, tx: null };
  }

  onPointerMove(e) {
    if (this.delegate) {
      this.delegate.onPointerMove(e);
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'hook') {
      d.handler.move?.(e);
      return;
    }
    const editor = this.editor;
    const doc = editor.doc;
    if (d.kind === 'marquee' || d.kind === 'lasso') {
      d.x = e.x;
      d.y = e.y;
      if (d.points) d.points.push({ x: e.x, y: e.y });
      this.overlay();
      return;
    }
    if (d.kind === 'anchors') {
      if (!d.moved && Math.hypot(e.x - d.px, e.y - d.py) * editor.view.zoom < 3) return;
      if (!d.moved) {
        d.moved = true;
        d.targets = this.#anchorTargets();
        d.tx = doc.begin('Move');
        d.snap = buildSnapIndex(editor, new Set(d.targets.map((t) => t.id)));
      }
      let tx = d.x0 + (e.x - d.px);
      let ty = d.y0 + (e.y - d.py);
      if (e.shift) {
        const dx = tx - d.x0;
        const dy = ty - d.y0;
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = dx * Math.cos(a) + dy * Math.sin(a);
        tx = d.x0 + Math.cos(a) * len;
        ty = d.y0 + Math.sin(a) * len;
      } else {
        const s = snapPoint(editor, tx, ty, d.snap);
        tx = s.x;
        ty = s.y;
        editor.alignmentGuides = { lines: s.lines, labels: s.labels };
      }
      const dx = tx - d.x0;
      const dy = ty - d.y0;
      for (const t of d.targets) doc.update(t.id, { anchors: moveAnchorSet(t.orig.anchors, t.indices, dx, dy), shape: undefined });
      editor.feedback = { sx: e.sx, sy: e.sy, text: `dX: ${fmt(editor, dx)}\ndY: ${fmt(editor, dy)}` };
      return;
    }
    if (d.kind === 'handle') {
      if (!d.tx) d.tx = doc.begin('Move Handle');
      const p = doc.get(d.path.id);
      const anchors = d.path.anchors.map((a) => ({ ...a }));
      const a = anchors[d.index];
      let hx = e.x;
      let hy = e.y;
      if (e.shift) {
        const c = constrainHandle(a.x, a.y, hx, hy);
        hx = c.x;
        hy = c.y;
      }
      const keepSmooth = d.smooth && !e.alt;
      if (d.part === 'in') {
        a.ix = hx;
        a.iy = hy;
        if (keepSmooth) mirrorAngle(a, 'in');
      } else {
        a.ox = hx;
        a.oy = hy;
        if (keepSmooth) mirrorAngle(a, 'out');
      }
      if (p) doc.update(p.id, { anchors, shape: undefined });
      return;
    }
    if (d.kind === 'segment') {
      if (!d.tx) d.tx = doc.begin('Reshape');
      const { c, t } = d;
      const p0 = pointAt(c, t);
      const dx = e.x - p0.x - (d.x0 - p0.x);
      const dy = e.y - p0.y - (d.y0 - p0.y);
      // Distribute the drag to both handles so B(t) moves by (dx, dy).
      const w1 = 3 * (1 - t) * (1 - t) * t;
      const w2 = 3 * (1 - t) * t * t;
      const denom = w1 * w1 + w2 * w2 || 1;
      const k1 = w1 / denom;
      const k2 = w2 / denom;
      const anchors = d.path.anchors.map((a) => ({ ...a }));
      const i0 = d.index;
      const i1 = (d.index + 1) % anchors.length;
      anchors[i0].ox = c[2] + dx * k1;
      anchors[i0].oy = c[3] + dy * k1;
      anchors[i1].ix = c[4] + dx * k2;
      anchors[i1].iy = c[5] + dy * k2;
      // Keep smooth neighbors smooth.
      if (isSmooth(d.path.anchors[i0])) mirrorAngle(anchors[i0], 'out');
      if (isSmooth(d.path.anchors[i1])) mirrorAngle(anchors[i1], 'in');
      doc.update(d.path.id, { anchors, shape: undefined });
    }
  }

  onPointerUp(e) {
    if (this.delegate) {
      const t = this.delegate;
      this.delegate = null;
      t.onPointerUp(e);
      return;
    }
    const d = this.drag;
    this.drag = null;
    const editor = this.editor;
    editor.feedback = null;
    editor.alignmentGuides = null;
    if (!d) return;
    if (d.kind === 'hook') {
      d.handler.up?.(e);
      this.overlay();
      return;
    }
    if (d.kind === 'marquee') {
      const r = rectFrom(d);
      if (r.w * editor.view.zoom > 2 || r.h * editor.view.zoom > 2) {
        this.selectInRegion((a) => a.x >= r.x && a.x <= r.x + r.w && a.y >= r.y && a.y <= r.y + r.h, r, d.add, true, d.add);
        for (const hook of directSelectionHooks) hook.marquee?.(this, r, d.add);
      }
      this.overlay();
      return;
    }
    if (d.tx) d.tx.commit();
    // The moved segments stay selected (their records follow the changed paths).
    if (d.segments && d.moved) for (const [id, h] of editor.segmentHits || []) if (d.targets?.some((t) => t.id === id)) h.node = editor.doc.get(id);
    if (d.segments && !d.moved) {
      // A click without a drag selects just that segment, like clicking an unselected one.
      const { path, index } = d.segments;
      editor.selectAnchors(path.id, [index, (index + 1) % path.anchors.length]);
      editor.segment = { id: path.id, index, node: path, set: editor.anchors.get(path.id) };
    }
    if (d.narrow && !d.moved) editor.selectAnchors(d.narrow.id, [d.narrow.index]);
    if (d.toggle && !d.moved) editor.selectAnchors(d.toggle.id, [d.toggle.index], { toggle: true, add: true });
    this.overlay();
  }

  /**
   * Select anchors matching `inside` across all editable paths touched by the
   * rect. With `segments`, a path the rect crosses without enclosing an anchor
   * records the crossed segments (Delete removes just those). With `toggle`
   * (Shift-marquee), enclosed anchors and objects flip in or out of the selection.
   */
  selectInRegion(inside, r, add, segments = false, toggle = false) {
    const editor = this.editor;
    if (!add) {
      editor.clearSelection();
      editor.segmentHits = new Map();
    }
    if (!editor.segmentHits) editor.segmentHits = new Map();
    const hits = marqueeHits(editor.doc, r, { intoCompound: true });
    let any = false;
    for (const n of hits) {
      if (n.type === 'path') {
        const idx = n.anchors.map((a, i) => (inside(a) ? i : -1)).filter((i) => i >= 0);
        if (toggle) {
          if (idx.length) this.#toggleAnchors(n, idx);
          else if (!editor.selection.has(n.id)) editor.selectAnchors(n.id, [], { add: true });
          any = true;
          continue;
        }
        if (idx.length === n.anchors.length) editor.select([n.id], { add: true });
        else if (idx.length) editor.selectAnchors(n.id, idx, { add: true });
        else {
          editor.selectAnchors(n.id, [], { add: true });
          if (segments) {
            const crossed = [];
            for (let i = 0; i < segmentCount(n.anchors, n.closed); i++) {
              const c = segmentPoints(n.anchors, i);
              const seg = [anchor(c[0], c[1], c[0], c[1], c[2], c[3]), anchor(c[6], c[7], c[4], c[5], c[6], c[7])];
              if (nodeTouchesRect(editor.doc, { type: 'path', anchors: seg, closed: false }, r)) crossed.push(i);
            }
            editor.segmentHits.set(n.id, { node: n, set: editor.anchors.get(n.id), indices: crossed });
          }
        }
        any = true;
      } else {
        editor.select([n.id], toggle ? { toggle: true } : { add: true });
        any = true;
      }
    }
    if (!any) this.overlay();
  }

  /** Flip anchors of a path in or out of the selection (the path goes whole, partial or unselected). */
  #toggleAnchors(n, idx) {
    const editor = this.editor;
    const next = new Set(editor.selectedAnchors(n.id));
    for (const i of idx) {
      if (next.has(i)) next.delete(i);
      else next.add(i);
    }
    if (next.size === n.anchors.length) editor.select([n.id], { add: true });
    else if (!next.size) {
      if (editor.selection.has(n.id)) editor.select([n.id], { toggle: true });
    } else {
      editor.anchors.delete(n.id);
      editor.selectAnchors(n.id, [...next], { add: true });
    }
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel() {
    if (this.delegate) {
      const t = this.delegate;
      this.delegate = null;
      t.drag?.session?.cancel();
      t.drag = null;
    }
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'hook') d.handler.cancel?.();
    if (d?.tx) d.tx.cancel();
    if (this.editor) {
      this.editor.feedback = null;
      this.editor.alignmentGuides = null;
    }
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    if (this.delegate) {
      this.delegate.drawOverlay(ctx, editor);
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'hook') d.handler.drawOverlay?.(ctx, editor);
    if (d.kind === 'marquee') {
      const a = editor.view.toScreen(d.x0, d.y0);
      const b = editor.view.toScreen(d.x, d.y);
      ctx.save();
      ctx.strokeStyle = '#7a7a7a';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
    }
    if (d.kind === 'lasso' && d.points.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#7a7a7a';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      d.points.forEach((p, i) => {
        const s = editor.view.toScreen(p.x, p.y);
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** Constrain a handle to 45-degree angles around its anchor. */
function constrainHandle(ax, ay, hx, hy) {
  const dx = hx - ax;
  const dy = hy - ay;
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: ax + Math.cos(a) * len, y: ay + Math.sin(a) * len };
}

/** Rotate the opposite handle to stay collinear, keeping its length. */
export function mirrorAngle(a, moved) {
  const [mx, my] = moved === 'in' ? [a.ix, a.iy] : [a.ox, a.oy];
  const [ox, oy] = moved === 'in' ? [a.ox, a.oy] : [a.ix, a.iy];
  const len = Math.hypot(ox - a.x, oy - a.y);
  const dx = a.x - mx;
  const dy = a.y - my;
  const l = Math.hypot(dx, dy);
  if (!l || !len) return;
  const nx = a.x + (dx / l) * len;
  const ny = a.y + (dy / l) * len;
  if (moved === 'in') {
    a.ox = nx;
    a.oy = ny;
  } else {
    a.ix = nx;
    a.iy = ny;
  }
}

export class GroupSelectionTool extends Tool {
  static id = 'group-selection';
  static label = 'Group Selection Tool';
  static shortcut = '';
  static icon = 'tool-group-selection';
  static hint = 'Click to select an object inside a group | Click again to add the next group up';

  constructor(app) {
    super(app);
    this.selectionMode = 'object';
    this.drag = null;
    this.last = null;
  }

  activate() {
    this.setCursor('var(--cursor-direct)');
    this.status();
  }

  onHover(e) {
    const editor = this.editor;
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 3));
    const id = hit?.id || null;
    if (editor.hover !== id) {
      editor.hover = id;
      this.overlay();
    }
  }

  onPointerDown(e) {
    const editor = this.editor;
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 3));
    if (!hit) {
      if (!e.shift) editor.clearSelection();
      this.drag = { kind: 'marquee', x0: e.x, y0: e.y, x: e.x, y: e.y, add: e.shift };
      return;
    }
    // Repeated clicks on the same leaf walk up one group at a time.
    let target = hit;
    if (this.last && this.last.leaf === hit.id && editor.selection.has(this.last.current)) {
      const cur = editor.doc.get(this.last.current);
      const parent = cur && editor.doc.get(cur.parent);
      if (parent && parent.type === 'group') target = parent;
      else target = cur;
    }
    this.last = { leaf: hit.id, current: target.id };
    editor.select([target.id], { add: e.shift || target !== hit });
    this.drag = { kind: 'move', x0: e.x, y0: e.y, session: null };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'marquee') {
      d.x = e.x;
      d.y = e.y;
      this.overlay();
      return;
    }
    const editor = this.editor;
    const dx = e.x - d.x0;
    const dy = e.y - d.y0;
    if (!d.session) {
      if (Math.hypot(dx, dy) * editor.view.zoom < 3) return;
      d.session = new TransformSession(editor, 'Move', { duplicate: e.alt });
    }
    d.session.apply([1, 0, 0, 1, dx, dy]);
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const editor = this.editor;
    if (d.kind === 'marquee') {
      const r = rectFrom(d);
      const hits = marqueeHits(editor.doc, r);
      editor.select(hits.map((n) => n.id), d.add ? { toggle: true } : {});
    } else if (d.session) d.session.commit();
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    DirectSelectionTool.prototype.drawOverlay.call(this, ctx, editor);
  }
}

export class LassoTool extends DirectSelectionTool {
  static id = 'lasso';
  static label = 'Lasso Tool';
  static shortcut = 'Q';
  static icon = 'tool-lasso';
  static hint = 'Drag around anchor points to select them | Shift to add | Option to subtract';

  activate() {
    this.setCursor('var(--cursor-lasso)');
    this.status();
  }

  onPointerDown(e) {
    this.drag = { kind: 'lasso', points: [{ x: e.x, y: e.y }], add: e.shift, subtract: e.alt };
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d || d.kind !== 'lasso') return super.onPointerUp();
    const editor = this.editor;
    const poly = d.points;
    if (poly.length < 3) {
      if (!d.add) editor.clearSelection();
      return;
    }
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    if (d.subtract) {
      for (const n of marqueeHits(editor.doc, r, { intoCompound: true })) {
        if (n.type !== 'path') continue;
        const idx = n.anchors.map((a, i) => (pointInPolygon(a.x, a.y, poly) ? i : -1)).filter((i) => i >= 0);
        if (idx.length) {
          const cur = editor.selectedAnchors(n.id);
          const keep = [...cur].filter((i) => !idx.includes(i));
          editor.anchors.set(n.id, new Set(keep));
          if (!keep.length) {
            editor.anchors.delete(n.id);
            editor.selection.delete(n.id);
          }
        }
      }
      editor.emit('selection');
    } else this.selectInRegion((a) => pointInPolygon(a.x, a.y, poly), r, d.add);
    this.overlay();
  }
}
