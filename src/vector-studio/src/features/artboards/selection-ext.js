/**
 * Selection tool additions: ruler guides can be clicked (when guides are
 * shown and unlocked), dragged, nudged with the arrow keys, deleted with
 * Delete, or dragged back onto their ruler to delete them; clicking an
 * already-selected object (in a multiple selection) makes it the key object
 * for alignment. Also the overlays for the key object, the selected guide
 * and artboard center marks / cross hairs.
 *
 * The Selection tool is extended by wrapping its prototype methods so other
 * feature modules can extend it the same way.
 */
import { SelectionTool } from '../../tools/selection.js';
import { overlayHooks, leafNodes, layerColor } from '../../render/overlay.js';
import { shapePathOf } from '../../render/draw.js';
import { nodeBounds } from '../../model/geometry.js';
import { multiply } from '../../lib/matrix.js';
import { setKeyObject } from './align-panel.js';

/** Index of the guide within `px` screen pixels of a screen point, or -1. */
export function guideAt(editor, sx, sy, px = 3) {
  if (!editor.viewOptions.guides || editor.viewOptions.lockGuides) return -1;
  const guides = editor.doc.root.guides || [];
  const p = editor.view.toDoc(sx, sy);
  const t = px / editor.view.zoom;
  let best = -1;
  let bestD = t;
  guides.forEach((g, i) => {
    const d = Math.abs((g.axis === 'x' ? p.x : p.y) - g.pos);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Replace guide `index` (null removes it) inside a transaction. */
export function setGuide(doc, index, guide) {
  const guides = (doc.root.guides || []).slice();
  if (guide) guides[index] = guide;
  else guides.splice(index, 1);
  doc.updateRoot({ guides });
}

/** Wrap a prototype method: wrapper(original) returns the replacement. */
function wrap(proto, name, wrapper) {
  const orig = proto[name];
  proto[name] = wrapper(orig);
}

export function installSelectionExtensions(app) {
  const proto = SelectionTool.prototype;

  wrap(proto, 'onHover', (orig) =>
    function onHover(e) {
      const ed = this.editor;
      // Guides are checked first (cheap) so ordinary hovering hit-tests once.
      const gi = guideAt(ed, e.sx, e.sy);
      if (gi >= 0 && !this.boxPartAt(e.sx, e.sy) && !this.hitAt(e)) {
        this.setCursor(ed.doc.root.guides[gi].axis === 'x' ? 'ew-resize' : 'ns-resize');
        if (ed.hover) {
          ed.hover = null;
          this.overlay();
        }
        return;
      }
      orig.call(this, e);
    },
  );

  wrap(proto, 'onPointerDown', (orig) =>
    function onPointerDown(e) {
      const ed = this.editor;
      this.keyCandidate = null;
      if (!this.boxPartAt(e.sx, e.sy)) {
        const hit = this.hitAt(e);
        if (!hit) {
          const gi = guideAt(ed, e.sx, e.sy);
          if (gi >= 0) {
            ed.clearSelection();
            ed.selectedGuide = gi;
            const g = ed.doc.root.guides[gi];
            this.guideDrag = { index: gi, g0: g, x0: e.x, y0: e.y, tx: null };
            this.overlay();
            return;
          }
        } else {
          const target = ed.selectionTarget(hit.id);
          if (!e.shift && !e.alt && ed.selection.has(target.id) && ed.topSelection().length > 1 && !ed.anchors.size) this.keyCandidate = target.id;
        }
      }
      if (ed.selectedGuide != null) {
        ed.selectedGuide = null;
        this.overlay();
      }
      orig.call(this, e);
    },
  );

  wrap(proto, 'onPointerMove', (orig) =>
    function onPointerMove(e) {
      const gd = this.guideDrag;
      if (!gd) return orig.call(this, e);
      const ed = this.editor;
      const pos = gd.g0.axis === 'x' ? gd.g0.pos + (e.x - gd.x0) : gd.g0.pos + (e.y - gd.y0);
      if (!gd.tx) {
        if (Math.abs(pos - gd.g0.pos) * ed.view.zoom < 2) return;
        gd.tx = ed.doc.begin('Move Guide');
      }
      setGuide(ed.doc, gd.index, { ...gd.g0, pos });
      ed.feedback = { sx: e.sx, sy: e.sy, text: gd.g0.axis === 'x' ? `X: ${formatPos(ed, pos, 'x')}` : `Y: ${formatPos(ed, pos, 'y')}` };
      this.overlay();
    },
  );

  wrap(proto, 'onPointerUp', (orig) =>
    function onPointerUp(e) {
      const ed = this.editor;
      const gd = this.guideDrag;
      if (gd) {
        this.guideDrag = null;
        ed.feedback = null;
        if (gd.tx) {
          // Dropping a guide back onto its ruler deletes it.
          const onRuler = ed.viewOptions.rulers && (gd.g0.axis === 'x' ? e.sx < 0 : e.sy < 0);
          if (onRuler) {
            setGuide(ed.doc, gd.index, null);
            ed.selectedGuide = null;
          }
          gd.tx.commit();
        }
        this.overlay();
        return;
      }
      const d = this.drag;
      const key = this.keyCandidate;
      this.keyCandidate = null;
      const clicked = key && d?.kind === 'move' && !d.moved;
      orig.call(this, e);
      if (clicked && ed.selection.has(key)) setKeyObject(app, app.alignKey === key ? null : key);
    },
  );

  wrap(proto, 'onKeyDown', (orig) =>
    function onKeyDown(ev) {
      const ed = this.editor;
      const gi = ed?.selectedGuide;
      const guides = ed?.doc.root.guides || [];
      if (gi != null && guides[gi] && !ed.selection.size) {
        const arrows = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
        const g = guides[gi];
        const horizontalKey = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
        if (ev.key in arrows && !ev.metaKey && !ev.ctrlKey && (g.axis === 'x') === horizontalKey) {
          const inc = (app.prefs.get('keyboardIncrement') || 1) * (ev.shiftKey ? 10 : 1);
          ed.doc.transact('Move Guide', () => setGuide(ed.doc, gi, { ...g, pos: g.pos + arrows[ev.key] * inc }), { coalesce: 'nudge-guide' });
          this.overlay();
          return true;
        }
        if (ev.key === 'Escape') {
          ed.selectedGuide = null;
          this.overlay();
          return true;
        }
      }
      return orig.call(this, ev);
    },
  );

  wrap(proto, 'cancel', (orig) =>
    function cancel() {
      const gd = this.guideDrag;
      this.guideDrag = null;
      gd?.tx?.cancel();
      return orig.call(this);
    },
  );

  // Selecting objects deselects the guide; a selection without the key object drops it.
  const watch = (ed) => {
    if (!ed || ed.selectionExtWatched) return;
    ed.selectionExtWatched = true;
    ed.on('selection', () => {
      if (ed.selection.size && ed.selectedGuide != null) ed.selectedGuide = null;
      if (app.editor === ed && app.alignKey && (!ed.selection.has(app.alignKey) || ed.topSelection().length < 2)) setKeyObject(app, null);
    });
    ed.on('doc-change', () => {
      if (ed.selectedGuide != null && !(ed.doc.root.guides || [])[ed.selectedGuide]) ed.selectedGuide = null;
    });
  };
  app.on('active-editor', (ed) => {
    watch(ed);
    if (app.alignKey) setKeyObject(app, null);
  });

  overlayHooks.add((ctx, editor, colors) => drawExtras(app, ctx, editor, colors));
}

function formatPos(editor, pos, axis) {
  const o = editor.artboard() || { x: 0, y: 0 };
  const v = pos - (axis === 'x' ? o.x : o.y);
  return `${Number(v.toFixed(2))} ${editor.doc.root.units || 'pt'}`;
}

function drawExtras(app, ctx, editor, colors) {
  const { view, doc } = editor;
  // Artboard center marks and cross hairs.
  if (editor.viewOptions.artboards && !view.rotation) {
    ctx.save();
    ctx.strokeStyle = colors.selection;
    ctx.lineWidth = 1;
    for (const a of doc.artboards) {
      if (!a.showCenter && !a.showCross) continue;
      const c = view.toScreen(a.x + a.w / 2, a.y + a.h / 2);
      ctx.beginPath();
      if (a.showCenter) {
        ctx.moveTo(Math.round(c.x) + 0.5, c.y - 6);
        ctx.lineTo(Math.round(c.x) + 0.5, c.y + 6);
        ctx.moveTo(c.x - 6, Math.round(c.y) + 0.5);
        ctx.lineTo(c.x + 6, Math.round(c.y) + 0.5);
      }
      if (a.showCross) {
        const l = view.toScreen(a.x, a.y + a.h / 2);
        const r = view.toScreen(a.x + a.w, a.y + a.h / 2);
        const t = view.toScreen(a.x + a.w / 2, a.y);
        const b = view.toScreen(a.x + a.w / 2, a.y + a.h);
        ctx.moveTo(l.x, Math.round(l.y) + 0.5);
        ctx.lineTo(r.x, Math.round(r.y) + 0.5);
        ctx.moveTo(Math.round(t.x) + 0.5, t.y);
        ctx.lineTo(Math.round(b.x) + 0.5, b.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  // Selected guide.
  const gi = editor.selectedGuide;
  const g = gi != null ? (doc.root.guides || [])[gi] : null;
  if (g && editor.viewOptions.guides) {
    ctx.save();
    ctx.strokeStyle = colors.selection;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const a = g.axis === 'x' ? view.toScreen(g.pos, -1e6) : view.toScreen(-1e6, g.pos);
    const b = g.axis === 'x' ? view.toScreen(g.pos, 1e6) : view.toScreen(1e6, g.pos);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
  // Key object: a thick outline.
  const key = app.alignKey;
  if (key && app.editor === editor && editor.selection.has(key) && doc.has(key) && editor.viewOptions.edges) {
    const node = doc.get(key);
    const color = layerColor(editor, key);
    ctx.save();
    for (const leaf of leafNodes(doc, node)) {
      const p = leaf.type === 'path' || leaf.type === 'compound' ? shapePathOf(doc, leaf) : null;
      if (p) {
        const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
        ctx.save();
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3 / view.zoom;
        ctx.stroke(p);
        ctx.restore();
      } else {
        const b = nodeBounds(doc, leaf);
        if (!b) continue;
        const s = view.toScreen(b.x, b.y);
        const e = view.toScreen(b.x + b.w, b.y + b.h);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y);
      }
    }
    ctx.restore();
  }
}
