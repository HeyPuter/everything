/**
 * On-canvas controls for a selected mockup (Selection tool): the outline
 * of the art's surface, a handle on each corner (drag to fit the art to
 * the photo in perspective; Shift keeps the corner on its original row or
 * column line) and a handle in the middle that slides the whole surface.
 * Every drag is one undo step; Escape cancels it. Mesh-fitted mockups show
 * their mesh through the envelope overlay and are edited with Direct
 * Selection.
 */
import { canvasWidgets } from '../../tools/widgets.js';
import { overlayHooks, layerColor } from '../../render/overlay.js';
import { fmt } from '../../tools/tool.js';
import { isMockup, setMockupCorners, mockupParts } from './mockup-model.js';
import { editableCorners, effectiveFit } from './mockup-ui.js';
import { isConvexQuad } from './perspective.js';

const R = 5;
const NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];

/** The mockup whose handles show: the single selected one (not being edited). */
export function activeMockup(editor) {
  if (!editor || editor.textEdit || editor.dragPreview) return null;
  const top = editor.topSelection();
  if (top.length !== 1) return null;
  const n = editor.doc.get(top[0]);
  if (!isMockup(n) || editor.doc.isLocked(n.id) || editor.doc.isHidden(n.id)) return null;
  return n;
}

/** Screen-space handles: [{ id, k?, x, y }]. */
export function mockupHandles(editor) {
  const m = activeMockup(editor);
  const q = m ? editableCorners(editor.doc, m) : null;
  if (!q) return { m: null, q: null, handles: [] };
  const handles = q.map((p, k) => ({ id: `corner${k}`, k, ...editor.view.toScreen(p.x, p.y) }));
  const c = q.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  handles.push({ id: 'move', ...editor.view.toScreen(c.x, c.y) });
  return { m, q, handles };
}

function beginDrag(app, m, q0, handle, e0) {
  const editor = app.editor;
  const doc = editor.doc;
  const tx = doc.begin(handle.id === 'move' ? 'Move Mockup Art' : 'Move Mockup Corner');
  let last = q0;
  const move = (e) => {
    let q;
    if (handle.id === 'move') {
      const dx = e.x - e0.x;
      const dy = e.y - e0.y;
      q = q0.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      editor.feedback = { sx: e.sx, sy: e.sy, text: `dX: ${fmt(editor, dx)}\ndY: ${fmt(editor, dy)}` };
    } else {
      const k = handle.k;
      let x = e.x;
      let y = e.y;
      if (e.shift) {
        // Keep the corner on the line of one of its sides.
        const a = q0[(k + 1) % 4];
        const b = q0[(k + 3) % 4];
        const along = (o) => {
          const ux = q0[k].x - o.x;
          const uy = q0[k].y - o.y;
          const l2 = ux * ux + uy * uy || 1;
          const t = ((e.x - o.x) * ux + (e.y - o.y) * uy) / l2;
          return { x: o.x + ux * t, y: o.y + uy * t };
        };
        const pa = along(a);
        const pb = along(b);
        const p = Math.hypot(pa.x - e.x, pa.y - e.y) <= Math.hypot(pb.x - e.x, pb.y - e.y) ? pa : pb;
        x = p.x;
        y = p.y;
      }
      q = q0.slice();
      q[k] = { x, y };
      editor.feedback = { sx: e.sx, sy: e.sy, text: `X: ${fmt(editor, x)}\nY: ${fmt(editor, y)}` };
    }
    // A corner cannot cross the others (the surface would fold over).
    if (!isConvexQuad(q)) return;
    if (setMockupCorners(doc, m.id, q)) last = q;
  };
  return {
    move,
    end: () => {
      editor.feedback = null;
      if (last === q0) tx.cancel();
      else tx.commit();
    },
    cancel: () => {
      editor.feedback = null;
      tx.cancel();
    },
  };
}

function drawWidgets(ctx, editor, colors) {
  const { doc, view } = editor;
  // The surface outline of every selected mockup; handles only for the Selection tool.
  for (const id of editor.topSelection()) {
    const m = doc.get(id);
    if (!isMockup(m) || doc.isHidden(id)) continue;
    const { art } = mockupParts(doc, m);
    const mesh = art?.live?.mesh;
    if (!mesh || effectiveFit(doc, m) !== 'perspective') continue;
    const q = editableCorners(doc, m);
    if (!q) continue;
    const s = q.map((p) => view.toScreen(p.x, p.y));
    ctx.save();
    ctx.strokeStyle = layerColor(editor, id) || colors.selection || '#4f80ff';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  if (editor.tool?.id !== 'selection') return;
  const info = mockupHandles(editor);
  if (!info.m) return;
  const accent = layerColor(editor, info.m.id) || colors.selection || '#4f80ff';
  for (const h of info.handles) {
    const hot = editor.widgetHover === `mockup:${h.id}`;
    const r = hot ? R + 1.5 : R;
    ctx.save();
    ctx.translate(Math.round(h.x) + 0.5, Math.round(h.y) + 0.5);
    ctx.fillStyle = hot ? accent : '#ffffff';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (h.id === 'move') {
      ctx.moveTo(0, -r - 1);
      ctx.lineTo(r + 1, 0);
      ctx.lineTo(0, r + 1);
      ctx.lineTo(-r - 1, 0);
      ctx.closePath();
    } else ctx.rect(-r, -r, 2 * r, 2 * r);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function installMockupWidgets(app) {
  canvasWidgets.add({
    hit(editor, e) {
      const info = mockupHandles(editor);
      if (!info.m) return null;
      // Corners win over the middle handle when they are close together.
      for (const h of info.handles) {
        if (Math.hypot(e.sx - h.x, e.sy - h.y) > R + 3) continue;
        const m = info.m;
        const q = info.q;
        const tip = h.id === 'move' ? 'Drag to slide the art across the photo' : `Drag the ${NAMES[h.k]} corner of the art | Shift: along a side`;
        return { id: `mockup:${h.id}`, cursor: h.id === 'move' ? 'move' : 'crosshair', tip, begin: (ev) => beginDrag(app, m, q, h, ev) };
      }
      return null;
    },
  });
  overlayHooks.add(drawWidgets);
}
