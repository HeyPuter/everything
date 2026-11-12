/**
 * Artboard tool (Shift+O): shows every artboard, click one to make it
 * active, drag inside to move it (with its artwork when "Move/Copy Artwork
 * with Artboard" is on), drag a handle to resize, drag on the pasteboard to
 * draw a new artboard, Alt-drag to duplicate. Delete removes the active
 * artboard, Enter or a double-click opens Artboard Options, arrow keys nudge
 * it and Esc returns to the Selection tool.
 */
import { Tool, fmt } from '../../tools/tool.js';
import { resizeCursorFor } from '../../tools/selection.js';
import { SnapIndex, snapBox, snapPoint } from '../../tools/snap.js';
import { collectOriginals, transformFromOriginals, nodeBounds } from '../../model/geometry.js';
import { translate } from '../../lib/matrix.js';
import { artworkOnArtboard, addArtboard, updateArtboard, duplicateArtboard, boardHandles, resizeRect, moveArtboard, deleteArtboard } from './artboard-ops.js';

/** Outline a document rect on the overlay: four screen corners, so it stays true in a rotated view. */
function strokeDocRect(ctx, view, r) {
  const pts = [
    view.toScreen(r.x, r.y),
    view.toScreen(r.x + r.w, r.y),
    view.toScreen(r.x + r.w, r.y + r.h),
    view.toScreen(r.x, r.y + r.h),
  ];
  ctx.beginPath();
  for (const [i, p] of pts.entries()) {
    if (i) ctx.lineTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
    else ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
  }
  ctx.closePath();
  ctx.stroke();
}

/** Whether the Artboard tool moves and copies artwork with the artboard (persisted preference). */
export function moveArtworkEnabled(app) {
  return app.prefs.get('artboardMoveArtwork') !== false;
}

/** Snap targets for artboard drags: the other artboards and visible top-level objects. */
function artboardSnapIndex(editor, skipIndex, skipIds = new Set()) {
  const { doc, view } = editor;
  const points = [];
  const addBox = (b, kind) => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    points.push({ x: b.x, y: b.y, kind }, { x: b.x + b.w, y: b.y, kind }, { x: b.x, y: b.y + b.h, kind }, { x: b.x + b.w, y: b.y + b.h, kind }, { x: cx, y: b.y, kind }, { x: cx, y: b.y + b.h, kind }, { x: b.x, y: cy, kind }, { x: b.x + b.w, y: cy, kind }, { x: cx, y: cy, kind: 'center' });
  };
  doc.artboards.forEach((a, i) => i !== skipIndex && addBox(a, 'artboard'));
  const visible = view.visibleRect(view.width * 0.5);
  for (const lid of doc.root.children) {
    const layer = doc.get(lid);
    if (!layer || layer.hidden) continue;
    for (const id of layer.children) {
      if (skipIds.has(id) || points.length > 4000) continue;
      const n = doc.get(id);
      const b = n && !n.hidden ? nodeBounds(doc, n) : null;
      if (b && b.x < visible.x + visible.w && b.x + b.w > visible.x && b.y < visible.y + visible.h && b.y + b.h > visible.y) addBox(b, 'bounds');
    }
  }
  const guides = editor.viewOptions.guides ? doc.root.guides || [] : [];
  return { index: new SnapIndex(points), guides };
}

export class ArtboardTool extends Tool {
  static id = 'artboard';
  static label = 'Artboard Tool';
  static shortcut = 'Shift+O';
  static icon = 'tool-artboard';
  static hint = 'Drag to create an artboard | Drag an artboard to move it | Option+Drag to duplicate | Enter for options | Esc to exit';

  constructor(app) {
    super(app);
    this.drag = null;
    this.cursor = 'crosshair';
  }

  activate() {
    // Editing artboards deselects artwork.
    this.editor?.clearSelection();
    this.app.root?.classList.add('artboard-mode');
    this.setCursor('crosshair');
    this.status();
    this.app.dock?.update();
  }

  deactivate() {
    this.cancel();
    this.app.root?.classList.remove('artboard-mode');
    this.app.dock?.update();
  }

  /** Handle of the active artboard under a screen point. */
  handleAt(sx, sy) {
    const ed = this.editor;
    const a = ed.artboard();
    if (!a) return null;
    for (const [k, p] of Object.entries(boardHandles(a))) {
      const s = ed.view.toScreen(p.x, p.y);
      if (Math.abs(s.x - sx) <= 6 && Math.abs(s.y - sy) <= 6) return k;
    }
    return null;
  }

  onHover(e) {
    const handle = this.handleAt(e.sx, e.sy);
    // The resize cursor follows the handle's direction on screen (the view may be rotated).
    if (handle) this.setCursor(resizeCursorFor(this.editor, this.editor.artboard(), handle));
    else if (this.editor.artboardAt(e.x, e.y) >= 0) this.setCursor(e.alt ? 'copy' : 'var(--cursor-move)');
    else this.setCursor('crosshair');
  }

  onPointerDown(e) {
    const ed = this.editor;
    const handle = this.handleAt(e.sx, e.sy);
    if (handle) {
      const index = ed.activeArtboard;
      const a = ed.artboard();
      this.drag = { kind: 'resize', index, handle, r0: { x: a.x, y: a.y, w: a.w, h: a.h }, tx: null, snap: artboardSnapIndex(ed, index) };
      return;
    }
    const index = ed.artboardAt(e.x, e.y);
    if (index >= 0) {
      if (index !== ed.activeArtboard) ed.setActiveArtboard(index);
      const a = ed.doc.artboards[index];
      this.drag = { kind: 'move', index, x0: e.x, y0: e.y, r0: { x: a.x, y: a.y, w: a.w, h: a.h }, alt: e.alt, tx: null, moved: false };
      this.overlay();
      return;
    }
    const snap = artboardSnapIndex(ed, -1);
    const p = snapPoint(ed, e.x, e.y, snap);
    this.drag = { kind: 'draw', x0: p.x, y0: p.y, x: p.x, y: p.y, sx0: e.sx, sy0: e.sy, snap, moved: false };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const ed = this.editor;
    const doc = ed.doc;
    if (d.kind === 'draw') {
      if (!d.moved && Math.hypot(e.sx - d.sx0, e.sy - d.sy0) < 3) return;
      d.moved = true;
      const p = snapPoint(ed, e.x, e.y, d.snap);
      let x = p.x;
      let y = p.y;
      if (e.shift) {
        const s = Math.max(Math.abs(x - d.x0), Math.abs(y - d.y0));
        x = d.x0 + Math.sign(x - d.x0 || 1) * s;
        y = d.y0 + Math.sign(y - d.y0 || 1) * s;
      }
      d.x = x;
      d.y = y;
      d.alt = e.alt;
      ed.alignmentGuides = { lines: p.lines, labels: p.labels };
      const r = this.drawRect(d);
      ed.feedback = { sx: e.sx, sy: e.sy, text: `W: ${fmt(ed, r.w)}\nH: ${fmt(ed, r.h)}` };
      this.overlay();
      return;
    }
    if (d.kind === 'resize') {
      if (!d.tx) d.tx = doc.begin('Resize Artboard');
      const p = snapPoint(ed, e.x, e.y, d.snap);
      ed.alignmentGuides = { lines: p.lines, labels: p.labels };
      const r = resizeRect(d.r0, d.handle, p.x, p.y, { shift: e.shift, alt: e.alt });
      updateArtboard(doc, d.index, r);
      ed.feedback = { sx: e.sx, sy: e.sy, text: `W: ${fmt(ed, r.w)}\nH: ${fmt(ed, r.h)}` };
      return;
    }
    if (d.kind === 'move') {
      let dx = e.x - d.x0;
      let dy = e.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) * ed.view.zoom < 3) return;
      if (!d.moved) {
        d.moved = true;
        const withArt = moveArtworkEnabled(this.app);
        d.tx = doc.begin(d.alt ? 'Duplicate Artboard' : 'Move Artboard');
        let ids = withArt ? artworkOnArtboard(doc, d.index) : [];
        if (d.alt) {
          const dup = duplicateArtboard(doc, d.index, 0, 0, { withArtwork: withArt });
          d.index = dup.index;
          ids = dup.ids;
          ed.setActiveArtboard(d.index);
        }
        d.originals = collectOriginals(doc, ids);
        d.snap = artboardSnapIndex(ed, d.index, new Set(ids));
      }
      if (e.shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      } else {
        const s = snapBox(ed, d.r0, dx, dy, d.snap);
        dx = s.dx;
        dy = s.dy;
        ed.alignmentGuides = { lines: s.lines, labels: s.labels };
      }
      updateArtboard(doc, d.index, { x: d.r0.x + dx, y: d.r0.y + dy });
      if (d.originals.size) transformFromOriginals(doc, d.originals, translate(dx, dy));
      ed.feedback = { sx: e.sx, sy: e.sy, text: `dX: ${fmt(ed, dx)}\ndY: ${fmt(ed, dy)}` };
    }
  }

  drawRect(d) {
    if (d.alt) {
      const w = Math.abs(d.x - d.x0) * 2;
      const h = Math.abs(d.y - d.y0) * 2;
      return { x: d.x0 - w / 2, y: d.y0 - h / 2, w, h };
    }
    return { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    const ed = this.editor;
    ed.feedback = null;
    ed.alignmentGuides = null;
    if (!d) return;
    if (d.kind === 'draw') {
      if (d.moved) {
        const r = this.drawRect(d);
        if (r.w * ed.view.zoom >= 2 && r.h * ed.view.zoom >= 2) {
          let index = -1;
          ed.doc.transact('New Artboard', () => {
            index = addArtboard(ed.doc, r);
          });
          ed.setActiveArtboard(index);
        }
      }
      this.overlay();
      return;
    }
    d.tx?.commit();
    this.overlay();
  }

  onDoubleClick(e) {
    const index = this.editor.artboardAt(e.x, e.y);
    if (index < 0) return;
    this.editor.setActiveArtboard(index);
    this.app.commands.run('artboards.options', { index });
  }

  onKeyDown(ev) {
    const ed = this.editor;
    if (!ed) return false;
    if (ev.key === 'Escape') {
      if (this.drag) this.cancel();
      else this.app.setTool(this.app.lastSelectionTool || 'selection');
      return true;
    }
    if (ev.key === 'Enter') {
      this.app.commands.run('artboards.options', { index: ed.activeArtboard });
      return true;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[ev.key] && !ev.metaKey && !ev.ctrlKey) {
      const inc = (this.app.prefs.get('keyboardIncrement') || 1) * (ev.shiftKey ? 10 : 1);
      const [dx, dy] = arrows[ev.key];
      ed.doc.transact('Move Artboard', () => moveArtboard(ed.doc, ed.activeArtboard, dx * inc, dy * inc, { withArtwork: moveArtworkEnabled(this.app) }), { coalesce: 'nudge-artboard' });
      return true;
    }
    return false;
  }

  /** Delete the active artboard (the Delete key while this tool is active). */
  deleteActive() {
    const ed = this.editor;
    if (!ed) return false;
    if (ed.doc.artboards.length <= 1) {
      this.app.notify('A document needs at least one artboard.');
      return false;
    }
    const i = ed.activeArtboard;
    ed.doc.transact('Delete Artboard', () => deleteArtboard(ed.doc, i));
    ed.setActiveArtboard(Math.min(i, ed.doc.artboards.length - 1));
    return true;
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

  openOptions() {
    if (this.editor) this.app.commands.run('artboards.options', { index: this.editor.activeArtboard });
  }

  drawOverlay(ctx, editor, colors) {
    const { view, doc } = editor;
    ctx.save();
    ctx.lineWidth = 1;
    const accent = colors.selection;
    doc.artboards.forEach((a, i) => {
      if (i === editor.activeArtboard) return;
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([]);
      strokeDocRect(ctx, view, a);
    });
    ctx.globalAlpha = 1;
    const a = editor.artboard();
    if (a) {
      ctx.strokeStyle = accent;
      ctx.setLineDash([4, 3]);
      strokeDocRect(ctx, view, a);
      ctx.setLineDash([]);
      for (const h of Object.values(boardHandles(a))) {
        const s = view.toScreen(h.x, h.y);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(s.x - 3.5) + 0.5, Math.round(s.y - 3.5) + 0.5, 7, 7);
        ctx.strokeRect(Math.round(s.x - 3.5) + 0.5, Math.round(s.y - 3.5) + 0.5, 7, 7);
      }
    }
    const d = this.drag;
    if (d?.kind === 'draw' && d.moved) {
      ctx.strokeStyle = accent;
      ctx.setLineDash([4, 3]);
      strokeDocRect(ctx, view, this.drawRect(d));
    }
    ctx.restore();
  }
}
