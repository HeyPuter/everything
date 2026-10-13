/**
 * Pen (P), Add Anchor Point (+), Delete Anchor Point (-), Anchor Point
 * (Shift+C) and Curvature (Shift+`) tools.
 *
 * Pen: click for a corner, drag for a smooth anchor (Alt while dragging
 * breaks the handles), click the first anchor to close, click the last
 * anchor to retract its outgoing handle (drag from it for a new one). Over a
 * selected path the Pen adds or deletes anchors (not while Shift is held);
 * over an open endpoint it continues that path, and while drawing it
 * connects to another open path's endpoint; with Alt it converts anchors
 * like the Anchor Point tool. Enter,
 * Escape, deselecting or a click with Command/Ctrl ends the path; undo
 * removes the last anchor and drawing goes on.
 */
import { Tool, tol, constrain45, constrainAngle } from './tool.js';
import { createPath, pickStyle } from '../model/nodes.js';
import { anchor, hasIn, hasOut, insertAnchor, nearestOnPath, reverseAnchors, autoSmooth } from '../model/bezier.js';
import { buildSnapIndex, snapPoint } from './snap.js';
import { hitTest } from '../render/hit.js';
import { drawAnchor, layerColor } from '../render/overlay.js';
import { findAnchorOrHandle, isSmooth } from './direct-selection.js';
import { removeEmptyContainers } from '../ops/object-ops.js';

/**
 * Style for new paths drawn with the current paint settings. With
 * `editor.basicNewArt` (New Art Has Basic Appearance) they leave out the
 * current effects.
 */
export function newPathStyle(editor) {
  const style = pickStyle(editor.style);
  if (editor.basicNewArt && style.effects?.length) style.effects = [];
  return style;
}

/** Selected, unlocked paths (for auto add/delete). */
function selectedPaths(editor) {
  return [...editor.selection].map((id) => editor.doc.get(id)).filter((n) => n && n.type === 'path' && !editor.doc.isLocked(n.id));
}

/** An open path endpoint under the pointer: { path, end: 'start'|'end' }. */
function endpointAt(editor, sx, sy, exclude) {
  const { doc, view } = editor;
  let found = null;
  doc.walk((n) => {
    if (found || n.hidden || n.locked) return false;
    if (n.type === 'path' && !n.closed && n.anchors.length && n.id !== exclude) {
      const a = n.anchors[0];
      const b = n.anchors[n.anchors.length - 1];
      const sa = view.toScreen(a.x, a.y);
      const sb = view.toScreen(b.x, b.y);
      if (Math.hypot(sa.x - sx, sa.y - sy) < 6) found = { path: n, end: 'start' };
      else if (Math.hypot(sb.x - sx, sb.y - sy) < 6) found = { path: n, end: 'end' };
    }
    return true;
  });
  return found;
}

export class PenTool extends Tool {
  static id = 'pen';
  static label = 'Pen Tool';
  static shortcut = 'P';
  static icon = 'tool-pen';
  static hint = 'Click to add a corner point | Drag to add a smooth point | Click the first point to close | Enter or Esc to finish';

  constructor(app) {
    super(app);
    this.selectionMode = 'direct';
    this.pathId = null;
    this.drag = null;
    this.cursorPt = null;
  }

  activate() {
    this.setCursor('var(--cursor-pen)');
    this.status();
  }

  deactivate() {
    this.finish();
  }

  /**
   * The path being drawn: it stays active only while it is open and
   * selected, so deselecting (Cmd-click away, Deselect) ends it and undo
   * that removes it starts a fresh path.
   */
  get path() {
    const p = this.pathId ? this.doc?.get(this.pathId) : null;
    return p && !p.closed && this.editor.selection.has(p.id) ? p : null;
  }

  finish() {
    if (this.drag?.tx) this.drag.tx.commit();
    this.drag = null;
    const p = this.pathId ? this.doc?.get(this.pathId) : null;
    // A lone anchor is not a path: remove it.
    if (p && p.anchors.length < 2) this.doc.transact('Delete', () => this.doc.remove(p.id));
    this.pathId = null;
    this.cursorPt = null;
    this.overlay();
  }

  commit() {
    this.finish();
  }

  /**
   * Abandon the gesture in progress (undo, pointer cancel) but keep drawing:
   * undo then removes the last anchor and the next click continues the path.
   */
  cancel() {
    if (this.delegate) {
      this.delegate.drag?.tx.cancel();
      this.delegate.drag = null;
      this.delegate = null;
    }
    if (this.drag?.tx) this.drag.tx.cancel();
    this.drag = null;
    this.overlay();
  }

  onHover(e) {
    const editor = this.editor;
    const p = this.path;
    this.cursorPt = { x: e.x, y: e.y };
    // The rubber band previews where a Shift-click puts the next anchor.
    if (p && e.shift) {
      const last = p.anchors[p.anchors.length - 1];
      this.cursorPt = constrain45(last.x, last.y, e.x, e.y, constrainAngle(this.app));
    }
    let cursor = 'var(--cursor-pen)';
    if (p) {
      const first = p.anchors[0];
      const s = editor.view.toScreen(first.x, first.y);
      if (p.anchors.length > 1 && Math.hypot(s.x - e.sx, s.y - e.sy) < 6) cursor = 'var(--cursor-pen-close)';
      else if (endpointAt(editor, e.sx, e.sy, p.id)) cursor = 'var(--cursor-pen-continue)';
      const last = p.anchors[p.anchors.length - 1];
      const sl = editor.view.toScreen(last.x, last.y);
      if (Math.hypot(sl.x - e.sx, sl.y - e.sy) < 6) cursor = 'var(--cursor-pen-convert)';
    } else {
      const sel = selectedPaths(editor);
      const ah = findAnchorOrHandle(editor, e.sx, e.sy, sel, { handles: false });
      const ep = endpointAt(editor, e.sx, e.sy);
      if (ep) cursor = 'var(--cursor-pen-continue)';
      else if (ah && this.app.prefs.get('autoAddDelete') && !e.shift) cursor = 'var(--cursor-pen-minus)';
      else if (sel.length && this.app.prefs.get('autoAddDelete') && !e.shift) {
        for (const sp of sel) {
          const near = nearestOnPath(sp.anchors, sp.closed, e.x, e.y);
          if (near && near.d < tol(editor, 4)) cursor = 'var(--cursor-pen-plus)';
        }
      }
    }
    if (e.alt && findAnchorOrHandle(editor, e.sx, e.sy, selectedPaths(editor), { handles: true })) cursor = 'var(--cursor-convert)';
    this.setCursor(cursor);
    this.overlay();
  }

  onPointerDown(e) {
    const editor = this.editor;
    const doc = editor.doc;
    if (e.mod) {
      this.finish();
      return;
    }
    let { x, y } = e;
    const p = this.path;
    if (e.alt) {
      // Alt over an anchor or handle of a selected path works as the Anchor Point tool
      // (convert smooth/corner, pull or split handles); the last anchor of the path being drawn keeps its own handling.
      const ah = findAnchorOrHandle(editor, e.sx, e.sy, selectedPaths(editor), { handles: true });
      const own = ah && p && ah.path.id === p.id && ah.index === p.anchors.length - 1 && ah.part !== 'in';
      if (ah && !own) {
        this.delegate = this.app.getTool('anchor-point');
        this.delegate.onPointerDown(e);
        return;
      }
    }
    if (!p && this.pathId) this.finish();
    if (!p) {
      // Continue an open path from an endpoint (this wins over auto delete on a selected path's end).
      const ep = endpointAt(editor, e.sx, e.sy);
      if (ep) {
        doc.transact('Pen', () => {
          if (ep.end === 'start') doc.update(ep.path.id, { anchors: reverseAnchors(ep.path.anchors) });
        });
        this.pathId = ep.path.id;
        editor.selectAnchors(ep.path.id, [doc.get(ep.path.id).anchors.length - 1]);
        this.drag = { tx: doc.begin('Pen'), index: doc.get(ep.path.id).anchors.length - 1, x0: x, y0: y, existing: true };
        return;
      }
      const sel = selectedPaths(editor);
      // Shift turns automatic add and delete off for the click.
      if (this.app.prefs.get('autoAddDelete') && !e.shift) {
        // Delete anchor on a selected path.
        const ah = findAnchorOrHandle(editor, e.sx, e.sy, sel, { handles: false });
        if (ah) {
          deleteAnchor(editor, ah.path, ah.index);
          return;
        }
        for (const sp of sel) {
          const near = nearestOnPath(sp.anchors, sp.closed, x, y);
          if (near && near.d < tol(editor, 4)) {
            doc.transact('Add Anchor Point', () => doc.update(sp.id, { anchors: insertAnchor(sp.anchors, sp.closed, near.index, near.t), shape: undefined }));
            return;
          }
        }
      }
      if (!editor.canDrawInTarget()) {
        this.app.notify('The target layer is locked or hidden.');
        return;
      }
      const snap = snapPoint(editor, x, y, buildSnapIndex(editor));
      x = snap.x;
      y = snap.y;
      const tx = doc.begin('Pen');
      const node = createPath([anchor(x, y)], false, newPathStyle(editor));
      doc.insert(node, editor.targetLayer().id);
      this.pathId = node.id;
      editor.selectAnchors(node.id, [0]);
      this.drag = { tx, index: 0, x0: x, y0: y };
      return;
    }
    const first = p.anchors[0];
    const last = p.anchors[p.anchors.length - 1];
    const sFirst = editor.view.toScreen(first.x, first.y);
    const sLast = editor.view.toScreen(last.x, last.y);
    const tx = doc.begin('Pen');
    if (p.anchors.length > 1 && Math.hypot(sFirst.x - e.sx, sFirst.y - e.sy) < 6) {
      // Close the path; dragging adjusts the closing anchor's handles.
      doc.update(p.id, { closed: true });
      this.drag = { tx, index: 0, x0: first.x, y0: first.y, closing: true };
      return;
    }
    if (Math.hypot(sLast.x - e.sx, sLast.y - e.sy) < 6) {
      // Click the last anchor to retract its outgoing handle; drag from it to pull out a new one.
      if (hasOut(last)) {
        const anchors = p.anchors.slice();
        anchors[anchors.length - 1] = { ...last, ox: last.x, oy: last.y };
        doc.update(p.id, { anchors });
      }
      this.drag = { tx, index: p.anchors.length - 1, x0: last.x, y0: last.y, convert: true };
      return;
    }
    const other = endpointAt(editor, e.sx, e.sy, p.id);
    if (other) {
      // Connect to another open path's endpoint: the two become one path and drawing ends.
      const rest = other.end === 'start' ? other.path.anchors : reverseAnchors(other.path.anchors);
      doc.update(p.id, { anchors: [...p.anchors, ...rest] });
      doc.remove(other.path.id);
      editor.selectAnchors(p.id, [p.anchors.length]);
      this.drag = { tx, index: p.anchors.length, x0: rest[0].x, y0: rest[0].y, closing: true };
      return;
    }
    if (e.shift) ({ x, y } = constrain45(last.x, last.y, x, y, constrainAngle(this.app)));
    else {
      const s = snapPoint(editor, x, y, buildSnapIndex(editor, new Set([p.id])));
      x = s.x;
      y = s.y;
    }
    const anchors = [...p.anchors, anchor(x, y)];
    doc.update(p.id, { anchors });
    editor.selectAnchors(p.id, [anchors.length - 1]);
    this.drag = { tx, index: anchors.length - 1, x0: x, y0: y };
  }

  onPointerMove(e) {
    this.cursorPt = { x: e.x, y: e.y };
    if (this.delegate) {
      this.delegate.onPointerMove(e);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const editor = this.editor;
    const p = this.pathId ? this.doc.get(this.pathId) : null;
    if (!p) return;
    const last = d.last || { x: e.x, y: e.y };
    d.last = { x: e.x, y: e.y };
    if (this.app.input?.spaceDown && !d.closing && !d.existing) {
      // Holding Space moves the anchor being placed (with its handles).
      const dx = e.x - last.x;
      const dy = e.y - last.y;
      const anchors = p.anchors.slice();
      const a = anchors[d.index];
      anchors[d.index] = { x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy };
      d.x0 += dx;
      d.y0 += dy;
      this.doc.update(p.id, { anchors });
      return;
    }
    let hx = e.x;
    let hy = e.y;
    if (Math.hypot(hx - d.x0, hy - d.y0) * editor.view.zoom < 2 && !d.dragging) return;
    d.dragging = true;
    if (e.shift) ({ x: hx, y: hy } = constrain45(d.x0, d.y0, hx, hy, constrainAngle(this.app)));
    const anchors = p.anchors.slice();
    const a = { ...anchors[d.index] };
    if (d.closing) {
      // Dragging on the closing point shapes the incoming segment; Alt keeps the outgoing handle.
      a.ix = 2 * a.x - hx;
      a.iy = 2 * a.y - hy;
      if (!e.alt) {
        a.ox = hx;
        a.oy = hy;
      }
    } else {
      a.ox = hx;
      a.oy = hy;
      if (!d.convert && !e.alt) {
        a.ix = 2 * a.x - hx;
        a.iy = 2 * a.y - hy;
      }
    }
    anchors[d.index] = a;
    this.doc.update(p.id, { anchors });
    this.overlay();
  }

  onPointerUp(e) {
    if (this.delegate) {
      const t = this.delegate;
      this.delegate = null;
      t.onPointerUp(e);
      // Converting keeps the path being drawn selected and going.
      if (this.pathId && this.doc.has(this.pathId) && !this.editor.selection.has(this.pathId)) this.editor.selectAnchors(this.pathId, [this.doc.get(this.pathId).anchors.length - 1]);
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    d.tx.commit();
    const p = this.pathId ? this.doc.get(this.pathId) : null;
    if (d.closing && p) {
      this.pathId = null;
      this.editor.select([p.id]);
    }
    this.overlay();
  }

  onKeyDown(ev) {
    if ((ev.key === 'Enter' || ev.key === 'Escape') && this.pathId) {
      this.finish();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, editor) {
    const p = this.path;
    if (!p || this.drag || !this.cursorPt || !p.anchors.length) return;
    // Rubber band: preview the next segment.
    const last = p.anchors[p.anchors.length - 1];
    const c = editor.view.toScreen(this.cursorPt.x, this.cursorPt.y);
    const a = editor.view.toScreen(last.x, last.y);
    const o = editor.view.toScreen(last.ox, last.oy);
    ctx.save();
    ctx.strokeStyle = layerColor(editor, p.id);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(o.x, o.y, c.x, c.y, c.x, c.y);
    ctx.stroke();
    ctx.restore();
  }
}

/** Remove an anchor; deleting below two anchors removes the path. */
export function deleteAnchor(editor, path, index) {
  const doc = editor.doc;
  doc.transact('Delete Anchor Point', () => {
    const anchors = path.anchors.filter((_, i) => i !== index);
    if (anchors.length < 2) {
      doc.remove(path.id);
      removeEmptyContainers(doc, [path.parent], editor.isolation);
    }
    else doc.update(path.id, { anchors, shape: undefined });
  });
}

export class AddAnchorTool extends Tool {
  static id = 'add-anchor';
  static label = 'Add Anchor Point Tool';
  static shortcut = '=';
  static icon = 'tool-add-anchor';
  static hint = 'Click a path segment to add an anchor point';

  activate() {
    this.setCursor('var(--cursor-pen-plus)');
    this.status();
  }

  onPointerDown(e) {
    const editor = this.editor;
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 4), { outline: true, intoCompound: true });
    if (!hit || hit.type !== 'path') return;
    const near = nearestOnPath(hit.anchors, hit.closed, e.x, e.y);
    if (!near || near.d > tol(editor, 5)) return;
    editor.doc.transact('Add Anchor Point', () => editor.doc.update(hit.id, { anchors: insertAnchor(hit.anchors, hit.closed, near.index, near.t), shape: undefined }));
    editor.selectAnchors(hit.id, [near.index + 1]);
  }
}

export class DeleteAnchorTool extends Tool {
  static id = 'delete-anchor';
  static label = 'Delete Anchor Point Tool';
  static shortcut = '-';
  static icon = 'tool-delete-anchor';
  static hint = 'Click an anchor point to delete it';

  activate() {
    this.selectionMode = 'direct';
    this.setCursor('var(--cursor-pen-minus)');
    this.status();
  }

  onPointerDown(e) {
    const editor = this.editor;
    const paths = [];
    editor.doc.walk((n) => {
      if (n.hidden || n.locked) return false;
      if (n.type === 'path') paths.push(n);
      return true;
    });
    const ah = findAnchorOrHandle(editor, e.sx, e.sy, paths, { handles: false });
    if (ah) deleteAnchor(editor, ah.path, ah.index);
  }
}

export class AnchorPointTool extends Tool {
  static id = 'anchor-point';
  static label = 'Anchor Point Tool';
  static shortcut = 'Shift+C';
  static icon = 'tool-anchor-point';
  static hint = 'Click a smooth point to make it a corner | Drag a corner point to pull out handles | Drag a handle to split it';

  constructor(app) {
    super(app);
    this.selectionMode = 'direct';
    this.drag = null;
  }

  activate() {
    this.setCursor('var(--cursor-convert)');
    this.status();
  }

  onPointerDown(e) {
    const editor = this.editor;
    const paths = [];
    editor.doc.walk((n) => {
      if (n.hidden || n.locked) return false;
      if (n.type === 'path') paths.push(n);
      return true;
    });
    const ah = findAnchorOrHandle(editor, e.sx, e.sy, paths, { handles: true });
    if (!ah) return;
    this.drag = { ah, tx: editor.doc.begin('Convert Anchor Point'), moved: false, x0: e.x, y0: e.y };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const { path, index, part } = d.ah;
    if (!d.moved && Math.hypot(e.x - d.x0, e.y - d.y0) * this.editor.view.zoom < 2) return;
    d.moved = true;
    const anchors = path.anchors.slice();
    const a = { ...anchors[index] };
    if (part === 'anchor') {
      a.ox = e.x;
      a.oy = e.y;
      a.ix = 2 * a.x - e.x;
      a.iy = 2 * a.y - e.y;
    } else if (part === 'in') {
      a.ix = e.x;
      a.iy = e.y;
    } else {
      a.ox = e.x;
      a.oy = e.y;
    }
    anchors[index] = a;
    this.doc.update(path.id, { anchors, shape: undefined });
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved && d.ah.part === 'anchor') {
      const { path, index } = d.ah;
      const anchors = path.anchors.slice();
      const a = anchors[index];
      anchors[index] = isSmooth(a) || hasOut(a) || a.ix !== a.x || a.iy !== a.y ? { ...a, ix: a.x, iy: a.y, ox: a.x, oy: a.y } : autoSmooth(anchors, index, path.closed);
      this.doc.update(path.id, { anchors, shape: undefined });
      this.editor.selectAnchors(path.id, [index]);
    }
    d.tx.commit();
  }
}

/**
 * Curvature tool: each click adds a point and the curve flows smoothly
 * through all points; Alt-click or double-click makes a corner. Drag a
 * point of the path being drawn to move it (a new point follows the drag
 * too). Clicking the first point closes the path; Esc or Enter ends it.
 */
export class CurvatureTool extends Tool {
  static id = 'curvature';
  static label = 'Curvature Tool';
  static shortcut = 'Shift+`';
  static icon = 'tool-curvature';
  static hint = 'Click to add points along a smooth curve | Option+Click for a corner | Drag a point to move it | Esc to finish';

  constructor(app) {
    super(app);
    this.selectionMode = 'direct';
    this.pathId = null;
    this.corners = [];
    this.cursorPt = null;
    this.drag = null;
  }

  activate() {
    this.setCursor('var(--cursor-pen)');
    this.status();
  }

  deactivate() {
    this.finish();
  }

  /** The path being drawn, while it is open and selected (undo and deselecting are respected). */
  get path() {
    const p = this.pathId ? this.doc?.get(this.pathId) : null;
    if (!p || p.closed || !this.editor.selection.has(p.id)) return null;
    // Undo can drop points: corner flags follow the anchors (corners have no handles).
    if (this.corners.length !== p.anchors.length) this.corners = p.anchors.map((a, i) => (i < this.corners.length ? this.corners[i] : p.anchors.length > 1 && !hasIn(a) && !hasOut(a)));
    return p;
  }

  finish() {
    if (this.drag?.tx) this.drag.tx.commit();
    this.drag = null;
    const p = this.pathId && this.doc?.get(this.pathId);
    if (p && p.anchors.length < 2) this.doc.transact('Delete', () => this.doc.remove(p.id));
    this.pathId = null;
    this.corners = [];
    this.overlay();
  }

  cancel() {
    if (this.drag?.tx) this.drag.tx.cancel();
    this.drag = null;
    this.overlay();
  }

  commit() {
    this.finish();
  }

  rebuild(points, closed) {
    const anchors = points.map((pt) => anchor(pt.x, pt.y));
    return anchors.map((a, i) => (this.corners[i] ? a : autoSmooth(anchors, i, closed)));
  }

  onHover(e) {
    this.cursorPt = { x: e.x, y: e.y };
    this.overlay();
  }

  onPointerDown(e) {
    const editor = this.editor;
    const doc = editor.doc;
    const p = this.path;
    if (!p && this.pathId) this.finish();
    if (!p) {
      if (!editor.canDrawInTarget()) return;
      const tx = doc.begin('Curvature');
      const node = createPath([anchor(e.x, e.y)], false, newPathStyle(editor));
      doc.insert(node, editor.targetLayer().id);
      this.pathId = node.id;
      this.corners = [e.alt];
      editor.selectAnchors(this.pathId, [0]);
      this.drag = { tx, index: 0 };
      return;
    }
    const near = (a) => {
      const s = editor.view.toScreen(a.x, a.y);
      return Math.hypot(s.x - e.sx, s.y - e.sy) < 6;
    };
    if (p.anchors.length > 2 && near(p.anchors[0])) {
      doc.transact('Curvature', () => doc.update(p.id, { anchors: this.rebuild(p.anchors, true), closed: true }));
      editor.select([p.id]);
      this.pathId = null;
      this.corners = [];
      return;
    }
    const tx = doc.begin('Curvature');
    const hit = p.anchors.findIndex(near);
    if (hit >= 0) {
      // Grab an existing point to move it.
      this.drag = { tx, index: hit, moved: false };
      editor.selectAnchors(p.id, [hit]);
      return;
    }
    const pts = [...p.anchors.map((a) => ({ x: a.x, y: a.y })), { x: e.x, y: e.y }];
    this.corners.push(e.alt);
    doc.update(p.id, { anchors: this.rebuild(pts, false) });
    editor.selectAnchors(p.id, [pts.length - 1]);
    this.drag = { tx, index: pts.length - 1 };
  }

  onPointerMove(e) {
    this.cursorPt = { x: e.x, y: e.y };
    const d = this.drag;
    const p = this.pathId && this.doc.get(this.pathId);
    if (!d || !p) return;
    d.moved = true;
    const pts = p.anchors.map((a) => ({ x: a.x, y: a.y }));
    pts[d.index] = { x: e.x, y: e.y };
    this.doc.update(p.id, { anchors: this.rebuild(pts, p.closed) });
    this.overlay();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    d?.tx.commit();
    this.overlay();
  }

  onDoubleClick() {
    // Double-click toggles the last point between smooth and corner.
    const p = this.path;
    if (!p) return;
    const i = p.anchors.length - 1;
    this.corners[i] = !this.corners[i];
    this.doc.transact('Curvature', () => this.doc.update(p.id, { anchors: this.rebuild(p.anchors, false) }));
  }

  onKeyDown(ev) {
    if ((ev.key === 'Escape' || ev.key === 'Enter') && this.pathId) {
      this.finish();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, editor) {
    const p = this.path;
    if (!p || !this.cursorPt || this.drag) return;
    // Preview the curve with the pointer as the next point.
    const pts = [...p.anchors.map((a) => ({ x: a.x, y: a.y })), this.cursorPt];
    const prevCorners = this.corners;
    this.corners = [...prevCorners, false];
    const preview = this.rebuild(pts, false);
    this.corners = prevCorners;
    ctx.save();
    ctx.strokeStyle = layerColor(editor, p.id);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const s0 = editor.view.toScreen(preview[0].x, preview[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < preview.length; i++) {
      const a = preview[i - 1];
      const b = preview[i];
      const c1 = editor.view.toScreen(a.ox, a.oy);
      const c2 = editor.view.toScreen(b.ix, b.iy);
      const e2 = editor.view.toScreen(b.x, b.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e2.x, e2.y);
    }
    ctx.stroke();
    const s = editor.view.toScreen(this.cursorPt.x, this.cursorPt.y);
    drawAnchor(ctx, s.x, s.y, layerColor(editor, p.id), false);
    ctx.restore();
  }
}
