/**
 * Perspective Grid tool (Shift+P): shows the grid and edits it through its
 * on-canvas controls. Perspective Selection tool (Shift+V): selects
 * objects, moves them within their plane (hold 5 to move them toward or
 * away from it), scales them through a box drawn in perspective, Alt-drag
 * duplicates, arrow keys nudge along the plane, and dragging ordinary
 * artwork brings it onto the active plane. In both tools 1, 2, 3 and 4
 * pick the left, horizontal, right or no plane.
 */
import { Tool, tol, fmt } from '../../tools/tool.js';
import { hitTest, marqueeHits } from '../../render/hit.js';
import { translate, scale as scaleMatrix } from '../../lib/matrix.js';
import { collectOriginals, transformFromOriginals, transformNodes, unionRect } from '../../model/geometry.js';
import { duplicateInPlace } from '../../tools/transform-session.js';
import { marqueeRegion } from '../../tools/selection.js';
import { announce } from '../../lib/dom.js';
import { toFlat, toDoc, localScale, depthOf, settingsOf, PLANE_LABELS } from './grid-math.js';
import { gridOf, setGrid, isPerspective, perspectiveOwner, frameFor, flatBounds } from './model.js';
import { dragHandle, planeOfHandle, HANDLE_LABELS } from './handles.js';
import { drawHandles, handleAt } from './render.js';
import { pstate, setPState, activePlane } from './state.js';
import { attachToPlane, perspectiveTexts } from './ops.js';

const PLANE_BY_KEY = { 1: 'left', 2: 'floor', 3: 'right', 4: 'none' };

/** 1-4 pick the active plane. Returns true when handled. */
export function planeKey(app, ev) {
  const plane = PLANE_BY_KEY[ev.key];
  if (!plane || ev.metaKey || ev.ctrlKey || ev.altKey || !app.editor) return false;
  setPState(app.editor, { plane });
  announce(`${PLANE_LABELS[plane]} active`);
  return true;
}

function feedbackFor(editor, id, g) {
  const len = (v) => fmt(editor, v);
  switch (id) {
    case 'vl':
    case 'vr':
    case 'station': {
      const s = settingsOf(g);
      return `Viewing angle: ${Number(s.angle.toFixed(1))}°\nDistance: ${len(s.distance)}`;
    }
    case 'vx':
      return `Vanishing point X: ${len(g.vx)}`;
    case 'v3':
      return `Third point: ${len(g.v3.x - g.ox)}, ${len(g.v3.y - g.oy)}`;
    case 'horizon-l':
    case 'horizon-r':
      return `Horizon height: ${len(g.oy - g.horizon)}`;
    case 'extent-left':
      return `Left extent: ${len(g.extent.left)}`;
    case 'extent-right':
      return `Right extent: ${len(g.extent.right)}`;
    case 'extent-height':
      return `Height: ${len(g.extent.height)}`;
    case 'cell':
      return `Grid cell: ${len(g.cell)}`;
    case 'plane-left':
    case 'plane-right':
    case 'plane-floor':
      return `${PLANE_LABELS[planeOfHandle(id)]}: ${len(g.planes[planeOfHandle(id)])}`;
    default:
      return '';
  }
}

/** Objects in perspective on a plane at a position. */
export function objectsOnPlane(doc, plane, offset) {
  const out = [];
  doc.walk((n) => {
    if (isPerspective(n)) {
      if (n.live.plane === plane && Math.abs((n.live.offset || 0) - offset) < 1e-6) out.push(n.id);
      return false;
    }
    return true;
  });
  return out;
}

export class PerspectiveGridTool extends Tool {
  static id = 'perspective-grid';
  static label = 'Perspective Grid Tool';
  static shortcut = 'Shift+P';
  static icon = 'tool-perspective-grid';
  static hint = 'Drag the grid controls to change the grid | Shift-drag a plane control to move its objects | 1-4 pick the plane | Esc hides the grid';

  constructor(app) {
    super(app);
    this.drag = null;
    this.hoverId = null;
  }

  activate() {
    const ed = this.editor;
    if (ed && !pstate(ed).visible) setPState(ed, { visible: true });
    this.setCursor('default');
    this.status();
  }

  deactivate() {
    this.cancel();
    this.hoverId = null;
  }

  onHover(e) {
    const ed = this.editor;
    const h = pstate(ed).visible ? handleAt(ed, e.sx, e.sy) : null;
    const id = h?.id || null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.overlay();
      this.status(id ? `${HANDLE_LABELS[id]}: drag to change${pstate(ed).lock ? ' (the grid is locked)' : ''}` : undefined);
    }
    this.setCursor(!h ? 'default' : pstate(ed).lock ? 'not-allowed' : h.kind === 'horizon' ? 'ns-resize' : h.kind === 'origin' || h.id === 'v3' ? 'move' : 'grab');
  }

  onPointerDown(e) {
    const ed = this.editor;
    const st = pstate(ed);
    if (!st.visible) {
      setPState(ed, { visible: true });
      return;
    }
    const h = handleAt(ed, e.sx, e.sy);
    if (!h) return;
    if (st.lock) {
      this.app.notify('The perspective grid is locked. Unlock it in View > Perspective Grid.');
      return;
    }
    const doc = ed.doc;
    const start = gridOf(doc);
    const plane = planeOfHandle(h.id);
    const tx = doc.begin(plane && e.shift ? 'Move Plane and Objects' : 'Edit Perspective Grid');
    let objects = [];
    if (plane && e.shift) {
      objects = objectsOnPlane(doc, plane, start.planes[plane] || 0);
      // Alt+Shift leaves copies of the objects behind.
      if (e.alt) {
        for (const id of objects) {
          const n = doc.get(id);
          const parent = doc.get(n.parent);
          const { node, descendants } = doc.cloneSubtree(id);
          doc.insert(node, parent.id, parent.children.indexOf(id), descendants);
        }
      }
    }
    this.drag = { id: h.id, plane, start, x0: e.x, y0: e.y, tx, objects };
    this.setCursor(h.kind === 'horizon' ? 'ns-resize' : 'grabbing');
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const ed = this.editor;
    const st = pstate(ed);
    const g = dragHandle(d.start, d.id, { x: e.x, y: e.y }, { lockStation: st.lockStation, snap: st.snap, shift: e.shift, delta: { dx: e.x - d.x0, dy: e.y - d.y0 } });
    setGrid(ed.doc, g);
    for (const id of d.objects) {
      const n = ed.doc.get(id);
      if (n) ed.doc.update(id, { live: { ...n.live, offset: g.planes[d.plane] } });
    }
    const text = feedbackFor(ed, d.id, g);
    ed.feedback = text ? { sx: e.sx, sy: e.sy, text } : null;
    this.overlay();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.editor.feedback = null;
    d.tx.commit();
    this.setCursor('grab');
    this.overlay();
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    d?.tx.cancel();
    if (this.editor) this.editor.feedback = null;
    this.overlay();
  }

  onDoubleClick(e) {
    const h = pstate(this.editor).visible ? handleAt(this.editor, e.sx, e.sy) : null;
    if (!h) return;
    const plane = planeOfHandle(h.id);
    if (plane) this.app.commands.run('perspective.planePosition', { plane });
    else this.app.commands.run('perspective.define');
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape') {
      if (this.drag) this.cancel();
      else if (this.editor && pstate(this.editor).visible) setPState(this.editor, { visible: false });
      else return false;
      return true;
    }
    return planeKey(this.app, ev);
  }

  openOptions() {
    this.app.commands.run('perspective.define');
  }

  drawOverlay(ctx, editor) {
    drawHandles(ctx, editor, { hover: this.hoverId, active: this.drag?.id, locked: pstate(editor).lock });
  }
}

const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e', nw: 'se', se: 'nw', ne: 'sw', sw: 'ne' };

export class PerspectiveSelectionTool extends Tool {
  static id = 'perspective-select';
  static label = 'Perspective Selection Tool';
  static shortcut = 'Shift+V';
  static icon = 'tool-perspective-select';
  static hint = 'Drag objects within their plane | Hold 5 to move toward or away from the plane | Option-drag to duplicate | Drag artwork onto the grid to attach it | 1-4 pick the plane';

  constructor(app) {
    super(app);
    this.drag = null;
    this.perpendicular = false;
    this.onKeyUpDoc = (ev) => {
      if (ev.key === '5' && this.perpendicular) {
        this.perpendicular = false;
        if (this.drag?.kind === 'move') this.drag.modeChanged = true;
      }
    };
  }

  // The ordinary box shows only for selections without perspective objects; those get a box in perspective.
  get showsBoundingBox() {
    const ed = this.app?.editor;
    return Boolean(ed) && !ed.topSelection().some((id) => isPerspective(ed.doc.get(id)));
  }

  set showsBoundingBox(_v) {}

  activate() {
    const ed = this.editor;
    if (ed && !pstate(ed).visible) setPState(ed, { visible: true });
    document.addEventListener('keyup', this.onKeyUpDoc);
    this.setCursor('default');
    this.status();
  }

  deactivate() {
    document.removeEventListener('keyup', this.onKeyUpDoc);
    this.cancel();
  }

  hitAt(e) {
    const ed = this.editor;
    const iso = ed.isolation;
    const filter = iso ? (n) => ed.doc.isAncestor(iso, n.id) : null;
    return hitTest(ed.doc, e.x, e.y, tol(ed, 3), { outline: ed.viewOptions.mode === 'outline', filter });
  }

  /** The perspective box of the selection: { frame, flat bounds, ids } when its objects share one plane. */
  box() {
    const ed = this.editor;
    const doc = ed.doc;
    const ids = ed.topSelection().filter((id) => isPerspective(doc.get(id)));
    if (!ids.length) return null;
    const first = doc.get(ids[0]).live;
    let b = null;
    for (const id of ids) {
      const n = doc.get(id);
      // One box needs one flat space: the same plane, position and reference.
      if (n.live.plane !== first.plane || Math.abs((n.live.offset || 0) - (first.offset || 0)) > 1e-6 || n.live.ox !== first.ox || n.live.oy !== first.oy) return null;
      b = unionRect(b, flatBounds(doc, n));
    }
    if (!b) return null;
    return { frame: frameFor(gridOf(doc), first.plane, first.offset || 0, first), b, ids };
  }

  boxPoints(box) {
    const { b } = box;
    const pts = { nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y], e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h], s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2] };
    const out = {};
    for (const [k, [x, y]] of Object.entries(pts)) {
      const p = toDoc(box.frame, x, y);
      out[k] = { fx: x, fy: y, ...this.editor.view.toScreen(p.x, p.y) };
    }
    return out;
  }

  boxHandleAt(sx, sy) {
    const box = this.box();
    if (!box) return null;
    const pts = this.boxPoints(box);
    for (const [k, p] of Object.entries(pts)) if (Math.hypot(p.x - sx, p.y - sy) <= 6) return { box, handle: k, pts };
    return null;
  }

  onHover(e) {
    const ed = this.editor;
    if (this.boxHandleAt(e.sx, e.sy)) {
      this.setCursor('crosshair');
      if (ed.hover) {
        ed.hover = null;
        this.overlay();
      }
      return;
    }
    const hit = this.hitAt(e);
    const id = hit ? ed.selectionTarget(hit.id)?.id || null : null;
    this.setCursor(id && ed.selection.has(id) ? 'var(--cursor-move)' : 'default');
    if (ed.hover !== id) {
      ed.hover = id;
      this.overlay();
    }
  }

  onPointerDown(e) {
    const ed = this.editor;
    ed.hover = null;
    const bh = this.boxHandleAt(e.sx, e.sy);
    if (bh) {
      this.startScale(e, bh);
      return;
    }
    const hit = this.hitAt(e);
    if (hit) {
      const target = ed.selectionTarget(hit.id);
      let toggle = null;
      if (e.shift) {
        if (!ed.selection.has(target.id)) ed.select([target.id], { add: true });
        else toggle = target.id;
      } else if (!ed.selection.has(target.id) || ed.anchors.size) ed.select([target.id]);
      this.drag = { kind: 'move', x0: e.x, y0: e.y, sx0: e.sx, sy0: e.sy, alt: e.alt, started: false, toggle };
      return;
    }
    if (!e.shift) ed.clearSelection();
    this.drag = { kind: 'marquee', x0: e.x, y0: e.y, x: e.x, y: e.y, add: e.shift };
  }

  startScale(e, { box, handle, pts }) {
    const ed = this.editor;
    const opp = pts[OPPOSITE[handle]];
    const b = box.b;
    this.drag = {
      kind: 'scale',
      handle,
      frame: box.frame,
      origin: { x: opp.fx, y: opp.fy },
      center: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
      start: { x: pts[handle].fx, y: pts[handle].fy },
      b,
      tx: ed.doc.begin('Scale'),
      originals: collectOriginals(ed.doc, box.ids.flatMap((id) => ed.doc.get(id).children)),
    };
  }

  beginMove(e) {
    const ed = this.editor;
    const doc = ed.doc;
    const d = this.drag;
    const copy = d.alt || e.alt;
    d.tx = doc.begin(copy ? 'Duplicate' : 'Move');
    let ids = ed.topSelection();
    if (copy) ids = duplicateInPlace(ed, ids);
    const plane = activePlane(ed);
    const flat = ids.filter((id) => !isPerspective(doc.get(id)));
    if (flat.length && plane) {
      // Ordinary artwork dragged with the Perspective Selection tool goes onto the active plane.
      const made = attachToPlane(doc, flat, plane);
      ids = [...ids.filter((id) => isPerspective(doc.get(id))), ...made];
      ed.select(ids);
    }
    d.started = true;
    d.mode = this.perpendicular ? 'perp' : 'plane';
    // Measure from the press so the object stays under the pointer.
    d.ax = d.x0;
    d.ay = d.y0;
    const g = gridOf(doc);
    d.persp = ids
      .filter((id) => isPerspective(doc.get(id)))
      .map((id) => {
        const n = doc.get(id);
        const fb = flatBounds(doc, n);
        return { id, node: n, plane: n.live.plane, off: n.live.offset || 0, baseOff: n.live.offset || 0, dx: 0, dy: 0, bdx: 0, bdy: 0, fb, c: fb ? { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 } : null, originals: collectOriginals(doc, n.children) };
      });
    d.grid = g;
    d.plain = ids.filter((id) => !isPerspective(doc.get(id)));
    d.plainOriginals = collectOriginals(doc, d.plain);
  }

  /** Plane position that puts the object's center under the pointer moved by (mx, my) on the page. */
  solveOffset(o, mx, my) {
    const g = this.drag.grid;
    if (!o.c) return o.baseOff;
    const at = (s) => toDoc(frameFor(g, o.plane, s, o.node.live), o.c.x + o.dx, o.c.y + o.dy);
    const p0 = at(o.baseOff);
    const target = { x: p0.x + mx, y: p0.y + my };
    let s = o.baseOff;
    const h = Math.max(0.5, g.cell / 10);
    for (let i = 0; i < 8; i++) {
      const p = at(s);
      const q = at(s + h);
      const jx = (q.x - p.x) / h;
      const jy = (q.y - p.y) / h;
      const jj = jx * jx + jy * jy;
      if (jj < 1e-12) break;
      const step = ((target.x - p.x) * jx + (target.y - p.y) * jy) / jj;
      let next = s + step;
      // Never past the viewer.
      for (let k = 0; k < 20 && depthOf(frameFor(g, o.plane, next, o.node.live), o.c.x + o.dx, o.c.y + o.dy) < 0.05; k++) next = (next + s) / 2;
      s = next;
      if (Math.abs(step) < 1e-4) break;
    }
    if (pstate(this.editor).snap && g.cell > 0) {
      const snapped = Math.round(s / g.cell) * g.cell;
      if (Math.abs(snapped - s) * this.editor.view.zoom < 6) s = snapped;
    }
    return s;
  }

  updateMove(e) {
    const ed = this.editor;
    const doc = ed.doc;
    const d = this.drag;
    const st = pstate(ed);
    const mode = this.perpendicular ? 'perp' : 'plane';
    if (mode !== d.mode || d.modeChanged) {
      // Switching between moving along and across the plane continues from where the object is.
      for (const o of d.persp) {
        o.bdx = o.dx;
        o.bdy = o.dy;
        o.baseOff = o.off;
      }
      d.ax = e.x;
      d.ay = e.y;
      d.mode = mode;
      d.modeChanged = false;
    }
    const g = d.grid;
    let fb = null;
    for (const o of d.persp) {
      if (mode === 'perp') {
        o.off = this.solveOffset(o, e.x - d.ax, e.y - d.ay);
        doc.update(o.id, { live: { ...doc.get(o.id).live, offset: o.off } });
      } else {
        const frame = frameFor(g, o.plane, o.off, o.node.live);
        const a = toFlat(frame, d.ax, d.ay);
        const p = toFlat(frame, e.x, e.y);
        if (!a || !p) continue;
        let dx = p.x - a.x;
        let dy = p.y - a.y;
        if (e.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        dx += o.bdx;
        dy += o.bdy;
        if (st.snap && o.fb && g.cell > 0) {
          // Snap the object's corner to the grid lines when it comes within a few pixels.
          const t = 6 / ed.view.zoom / Math.max(1e-6, localScale(frame, o.c.x + dx, o.c.y + dy));
          const sx = Math.round((o.fb.x + dx - frame.ox) / g.cell) * g.cell + frame.ox - o.fb.x;
          const sy = Math.round((o.fb.y + dy - frame.oy) / g.cell) * g.cell + frame.oy - o.fb.y;
          if (Math.abs(sx - dx) < t) dx = sx;
          if (Math.abs(sy - dy) < t) dy = sy;
        }
        // Keep artwork in front of the viewer.
        if (o.c && depthOf(frame, o.c.x + dx, o.c.y + dy) < 0.05) continue;
        o.dx = dx;
        o.dy = dy;
        transformFromOriginals(doc, o.originals, translate(dx, dy));
      }
      if (!fb && o.fb) fb = o;
    }
    if (d.plain.length) {
      let dx = e.x - d.x0;
      let dy = e.y - d.y0;
      if (e.shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      transformFromOriginals(doc, d.plainOriginals, translate(dx, dy));
    }
    if (fb) ed.feedback = { sx: e.sx, sy: e.sy, text: mode === 'perp' ? `Plane position: ${fmt(ed, fb.off)}` : `dX: ${fmt(ed, fb.dx)}\ndY: ${fmt(ed, fb.dy)}` };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const ed = this.editor;
    if (d.kind === 'marquee') {
      d.x = e.x;
      d.y = e.y;
      this.overlay();
      return;
    }
    if (d.kind === 'scale') {
      const p = toFlat(d.frame, e.x, e.y);
      if (!p) return;
      const origin = e.alt ? d.center : d.origin;
      const fx = d.handle.includes('e') || d.handle.includes('w');
      const fy = d.handle.includes('n') || d.handle.includes('s');
      let sx = 1;
      let sy = 1;
      const w0 = d.start.x - origin.x;
      const h0 = d.start.y - origin.y;
      if (fx && Math.abs(w0) > 1e-9) sx = (p.x - origin.x) / w0;
      if (fy && Math.abs(h0) > 1e-9) sy = (p.y - origin.y) / h0;
      if (e.shift) {
        if (fx && fy) {
          const s = Math.abs(sx) > Math.abs(sy) ? sx : sy;
          sx = Math.sign(sx || 1) * Math.abs(s);
          sy = Math.sign(sy || 1) * Math.abs(s);
        } else if (fx) sy = Math.abs(sx);
        else sx = Math.abs(sy);
      }
      if (Math.abs(sx) < 1e-3) sx = sx < 0 ? -1e-3 : 1e-3;
      if (Math.abs(sy) < 1e-3) sy = sy < 0 ? -1e-3 : 1e-3;
      transformFromOriginals(ed.doc, d.originals, scaleMatrix(sx, sy, origin.x, origin.y));
      ed.feedback = { sx: e.sx, sy: e.sy, text: `W: ${fmt(ed, Math.abs(d.b.w * sx))}\nH: ${fmt(ed, Math.abs(d.b.h * sy))}` };
      return;
    }
    if (!d.started) {
      if (Math.hypot(e.sx - d.sx0, e.sy - d.sy0) < 3) return;
      this.beginMove(e);
    }
    this.updateMove(e);
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    const ed = this.editor;
    ed.feedback = null;
    if (!d) return;
    if (d.kind === 'marquee') {
      // The marquee is drawn upright on screen: in a rotated view it covers a turned square of the document.
      const { r, screen, opts } = marqueeRegion(ed, d);
      if (screen.w > 2 || screen.h > 2) {
        const iso = ed.isolation;
        const hits = marqueeHits(ed.doc, r, opts).filter((n) => !iso || ed.doc.isAncestor(iso, n.id));
        const targets = [...new Set(hits.map((n) => ed.selectionTarget(n.id).id))];
        ed.select(targets, d.add ? { toggle: true } : {});
      }
      this.overlay();
      return;
    }
    if (d.tx) d.tx.commit();
    else if (d.toggle) ed.select([d.toggle], { toggle: true });
    this.overlay();
    if (e) this.onHover(e);
  }

  onDoubleClick(e) {
    const ed = this.editor;
    const hit = this.hitAt(e);
    const owner = hit ? perspectiveOwner(ed.doc, hit.id) : null;
    if (owner && perspectiveTexts(ed.doc, owner.id).length) {
      ed.select([owner.id]);
      this.app.commands.run('perspective.editText');
    }
  }

  onKeyDown(ev) {
    const ed = this.editor;
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    if (ev.key === '5' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (!this.perpendicular) {
        this.perpendicular = true;
        if (this.drag?.kind === 'move') this.drag.modeChanged = true;
      }
      return true;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[ev.key] && ed?.selection.size && !ev.metaKey && !ev.ctrlKey && !this.drag) {
      const inc = (this.app.prefs.get('keyboardIncrement') || 1) * (ev.shiftKey ? 10 : 1);
      const [dx, dy] = arrows[ev.key];
      nudgeInPerspective(ed, dx * inc, dy * inc, { copy: ev.altKey });
      return true;
    }
    return planeKey(this.app, ev);
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    d?.tx?.cancel();
    if (this.editor) this.editor.feedback = null;
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    const d = this.drag;
    if (d?.kind === 'marquee') {
      const a = editor.view.toScreen(d.x0, d.y0);
      const b = editor.view.toScreen(d.x, d.y);
      ctx.save();
      ctx.strokeStyle = '#7a7a7a';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
      return;
    }
    if (!editor.viewOptions.boundingBox || editor.textEdit) return;
    const box = this.box();
    if (!box) return;
    const pts = this.boxPoints(box);
    const color = editor.doc.layerOf(box.ids[0])?.color || '#4f80ff';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ['nw', 'ne', 'se', 'sw'].forEach((k, i) => (i ? ctx.lineTo(pts[k].x, pts[k].y) : ctx.moveTo(pts[k].x, pts[k].y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (const p of Object.values(pts)) {
      ctx.fillRect(Math.round(p.x - 3) + 0.5, Math.round(p.y - 3) + 0.5, 6, 6);
      ctx.strokeRect(Math.round(p.x - 3) + 0.5, Math.round(p.y - 3) + 0.5, 6, 6);
    }
    ctx.restore();
  }
}

/**
 * Arrow-key nudge with the Perspective Selection tool: objects in
 * perspective move along their plane (right and down follow the plane's
 * axes), other objects move on the page. Alt nudges a copy.
 */
export function nudgeInPerspective(editor, dx, dy, { copy = false } = {}) {
  const doc = editor.doc;
  doc.transact(
    copy ? 'Duplicate' : 'Move',
    () => {
      let ids = editor.topSelection();
      if (copy) ids = duplicateInPlace(editor, ids);
      for (const id of ids) {
        const n = doc.get(id);
        if (isPerspective(n)) transformNodes(doc, n.children, translate(dx, dy));
        else transformNodes(doc, [id], translate(dx, dy));
      }
    },
    { coalesce: copy ? null : 'perspective-nudge' },
  );
}
