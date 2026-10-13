/**
 * Live shape widgets for the Selection tool: the pie handles of a live
 * ellipse (drag to cut a wedge, Shift snaps to 15 degrees, Option drags
 * both ends together, double-click to enter the angles) and the side-count
 * handle of a live polygon (drag up for more sides, down for fewer).
 */
import { canvasWidgets } from '../../tools/widgets.js';
import { overlayHooks } from '../../render/overlay.js';
import { regenerateShape, isPie } from '../../model/shapes.js';
import { apply, rotate } from '../../lib/matrix.js';

const R = 4.5; // handle radius, px
const OUT = 12; // px outside the rim
const MIN_SIDES = 3;
const MAX_SIDES = 20;

const norm = (deg) => Math.round((((deg % 360) + 360) % 360) * 1e6) / 1e6;

/** Document point on a live ellipse's rim at `deg` (counterclockwise from 3 o'clock in its frame). */
export function rimPoint(shape, deg) {
  const t = (deg * Math.PI) / 180;
  return apply(rotate(shape.angle || 0, shape.cx, shape.cy), shape.cx + (shape.w / 2) * Math.cos(t), shape.cy - (shape.h / 2) * Math.sin(t));
}

/** Angle (degrees, in the ellipse's frame) of the rim point nearest the direction of document point p. */
export function rimAngle(shape, p) {
  const q = apply(rotate(-(shape.angle || 0), shape.cx, shape.cy), p.x, p.y);
  return norm((Math.atan2(-(q.y - shape.cy) / (shape.h / 2 || 1), (q.x - shape.cx) / (shape.w / 2 || 1)) * 180) / Math.PI);
}

/** Set a live shape's params and regenerate its anchors (inside a transaction). */
export function setShape(doc, id, patch) {
  const n = doc.get(id);
  if (!n?.shape) return;
  const shape = { ...n.shape, ...patch };
  const anchors = regenerateShape(shape, n.anchors);
  if (anchors) doc.update(id, { shape, anchors });
}

/** The single selected, unlocked live shape of `kind` (Selection tool only). */
function target(app, kind) {
  const editor = app.editor;
  if (!editor || app.toolId !== 'selection' || editor.viewOptions?.shapeWidgets === false) return null;
  const top = editor.topSelection();
  if (top.length !== 1) return null;
  const n = editor.doc.get(top[0]);
  if (!n || n.type !== 'path' || n.shape?.kind !== kind || editor.doc.isLocked(n.id)) return null;
  return n;
}

/** Screen positions of the pie handles: [{ which: 'start'|'end', x, y }]. */
function pieHandles(editor, n) {
  const s = n.shape;
  // Small ellipses on screen have no room for the handles.
  if (Math.min(s.w, s.h) * editor.view.zoom < 16) return [];
  const c = editor.view.toScreen(s.cx, s.cy);
  const at = (deg) => {
    const p = editor.view.toScreen(rimPoint(s, deg).x, rimPoint(s, deg).y);
    const l = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    return { x: p.x + ((p.x - c.x) / l) * OUT, y: p.y + ((p.y - c.y) / l) * OUT };
  };
  if (!isPie(s)) return [{ which: 'start', ...at(0) }];
  return [
    { which: 'start', ...at(s.pieStart) },
    { which: 'end', ...at(s.pieEnd) },
  ];
}

/** Screen position of a polygon's side-count handle: outside the middle of its first side. */
function sidesHandle(editor, n) {
  const s = n.shape;
  if (s.r * editor.view.zoom < 12 || n.anchors.length < 3) return null;
  const a = editor.view.toScreen(n.anchors[0].x, n.anchors[0].y);
  const b = editor.view.toScreen(n.anchors[1].x, n.anchors[1].y);
  const c = editor.view.toScreen(s.cx, s.cy);
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const l = Math.hypot(m.x - c.x, m.y - c.y) || 1;
  return { x: m.x + ((m.x - c.x) / l) * OUT, y: m.y + ((m.y - c.y) / l) * OUT };
}

function beginPie(app, n, which, e) {
  const editor = app.editor;
  const doc = editor.doc;
  const s0 = n.shape;
  const start0 = isPie(s0) ? s0.pieStart : 0;
  const end0 = isPie(s0) ? s0.pieEnd : 0;
  const grab = rimAngle(s0, e);
  let tx = null;
  return {
    move(ev) {
      let a = rimAngle(s0, ev);
      if (ev.shift) a = norm(Math.round(a / 15) * 15);
      let start = start0;
      let end = end0;
      if (ev.alt) {
        // Option turns the whole pie, keeping its sweep.
        const d = a - grab;
        start = norm(start0 + d);
        end = norm(end0 + d);
      } else if (which === 'start') start = a;
      else end = a;
      tx ||= doc.begin('Pie Angle');
      setShape(doc, n.id, { pieStart: start, pieEnd: end });
      const sweep = norm(end - start) || 360;
      editor.feedback = { sx: ev.sx, sy: ev.sy, text: `Start: ${Number(start.toFixed(1))}°\nEnd: ${Number(end.toFixed(1))}°\nSweep: ${Number(sweep.toFixed(1))}°` };
      editor.emit('overlay');
    },
    end() {
      editor.feedback = null;
      tx?.commit();
      tx = null;
      editor.emit('overlay');
    },
    cancel() {
      editor.feedback = null;
      tx?.cancel();
      tx = null;
    },
  };
}

function beginSides(app, n, e) {
  const editor = app.editor;
  const doc = editor.doc;
  const sides0 = Math.round(n.shape.sides);
  const sy0 = e.sy;
  let tx = null;
  return {
    move(ev) {
      const sides = Math.max(MIN_SIDES, Math.min(Math.max(MAX_SIDES, sides0), sides0 + Math.round((sy0 - ev.sy) / 10)));
      if (!tx && sides === sides0) return;
      tx ||= doc.begin('Polygon Sides');
      setShape(doc, n.id, { sides });
      editor.feedback = { sx: ev.sx, sy: ev.sy, text: `Sides: ${sides}` };
      editor.emit('overlay');
    },
    end() {
      editor.feedback = null;
      tx?.commit();
      tx = null;
      editor.emit('overlay');
    },
    cancel() {
      editor.feedback = null;
      tx?.cancel();
      tx = null;
    },
  };
}

/** Exact pie angles for a live ellipse. */
export async function pieDialog(app, id) {
  const doc = app.editor.doc;
  const n = doc.get(id);
  if (!n?.shape) return;
  const pie = isPie(n.shape);
  let tx = null;
  const preview = (v) => {
    tx ||= doc.begin('Pie Angle');
    setShape(doc, id, { pieStart: norm(v.start), pieEnd: norm(v.end) });
  };
  const v = await app.dialogs.form({
    title: 'Pie Angles',
    fields: [
      { key: 'start', label: 'Pie Start Angle', type: 'angle', value: pie ? n.shape.pieStart : 0 },
      { key: 'end', label: 'Pie End Angle', type: 'angle', value: pie ? n.shape.pieEnd : 0 },
    ],
    onChange: preview,
  });
  if (!v) {
    tx?.cancel();
    return;
  }
  tx ||= doc.begin('Pie Angle');
  setShape(doc, id, { pieStart: norm(v.start), pieEnd: norm(v.end) });
  tx.commit();
}

function hit(app, e) {
  const editor = app.editor;
  const near = (p) => p && Math.hypot(e.sx - p.x, e.sy - p.y) <= R + 3;
  const el = target(app, 'ellipse');
  if (el) {
    // The end handle is drawn last (on top), so it wins when the two overlap.
    const handles = pieHandles(editor, el).reverse();
    const h = handles.find(near);
    if (h) {
      return {
        id: `pie:${el.id}:${h.which}`,
        cursor: 'pointer',
        tip: 'Drag to make a pie | Shift snaps to 15° | Option turns the pie | Double-click for exact angles',
        begin: (ev) => beginPie(app, el, h.which, ev),
        doubleClick: () => pieDialog(app, el.id),
      };
    }
  }
  const poly = target(app, 'polygon');
  if (poly && near(sidesHandle(editor, poly))) {
    return {
      id: `sides:${poly.id}`,
      cursor: 'ns-resize',
      tip: 'Drag up for more sides, down for fewer',
      begin: (ev) => beginSides(app, poly, ev),
    };
  }
  return null;
}

function drawHandle(ctx, p, hover, diamond) {
  ctx.beginPath();
  if (diamond) {
    const r = R + 1;
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x + r, p.y);
    ctx.lineTo(p.x, p.y + r);
    ctx.lineTo(p.x - r, p.y);
    ctx.closePath();
  } else ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = hover ? 2 : 1;
  ctx.strokeStyle = '#4f80ff';
  ctx.stroke();
}

function draw(ctx, editor) {
  const app = draw.app;
  const drag = editor.tool?.drag;
  if (!app || app.editor !== editor || (drag && drag.kind !== 'widget')) return;
  ctx.save();
  const el = target(app, 'ellipse');
  if (el) {
    const c = editor.view.toScreen(el.shape.cx, el.shape.cy);
    for (const h of pieHandles(editor, el)) {
      const hover = editor.widgetHover === `pie:${el.id}:${h.which}`;
      if (hover && isPie(el.shape)) {
        // Hovering a pie handle shows the radius it moves.
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(h.x, h.y);
        ctx.strokeStyle = '#4f80ff';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawHandle(ctx, h, hover, false);
      // A tick toward the center tells the pie handle from a corner widget.
      ctx.beginPath();
      const l = Math.hypot(h.x - c.x, h.y - c.y) || 1;
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(h.x - ((h.x - c.x) / l) * (OUT - R), h.y - ((h.y - c.y) / l) * (OUT - R));
      ctx.strokeStyle = '#4f80ff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  const poly = target(app, 'polygon');
  const p = poly && sidesHandle(editor, poly);
  if (p) drawHandle(ctx, p, editor.widgetHover === `sides:${poly.id}`, true);
  ctx.restore();
}

let current = null;
let installed = false;

export function install(app) {
  // The registries are module-wide: register once and act on the latest app.
  current = app;
  draw.app = app;
  if (installed) return;
  installed = true;
  overlayHooks.add(draw);
  canvasWidgets.add({
    hit(editor, e) {
      const a = current;
      if (!a || a.editor !== editor) return null;
      return hit(a, e);
    },
  });
}
