/**
 * Corner widgets: a small handle inside every corner of the selected paths
 * (Selection tool) or of the selected anchors (Direct Selection). Drag it
 * into the shape to round the corners, Option-click to switch between
 * round, inverted round and chamfer, double-click for the Corners dialog
 * (type, radius, absolute or relative rounding). Live rectangles change
 * their corner radii and types; other paths keep their sharp
 * anchors and carry the corner on the anchor (model/corners.js), so the
 * rounding stays editable. View > Hide Corner Widget turns them off.
 */
import { canvasWidgets } from '../../tools/widgets.js';
import { directSelectionHooks } from '../../tools/direct-selection.js';
import { overlayHooks } from '../../render/overlay.js';
import { cornerGeometry, cornerLimits, trimFor, radiusFor } from '../../model/corners.js';
import { shapeAnchors } from '../../model/shapes.js';
import { apply, rotate } from '../../lib/matrix.js';
import { formatLength } from '../../lib/units.js';

export const CORNER_TYPES = ['round', 'inverted', 'chamfer'];
export const TYPE_LABELS = { round: 'Round', inverted: 'Inverted Round', chamfer: 'Chamfer' };
export const ROUNDING_LABELS = { relative: 'Relative', absolute: 'Absolute' };
const REST = 14; // px from the corner when not rounded
const R = 4.5; // widget radius, px
const MAX_WIDGETS = 64;

/** Distance from the corner along the bisector to the middle of a rounded corner's arc. */
function arcMid(r, theta) {
  return r / Math.sin(theta / 2) - r;
}

/** Widget distance from the corner: a fixed gap plus the rounding, so it moves smoothly from 0. */
function widgetDist(r, theta, zoom) {
  return REST / zoom + arcMid(r, theta);
}

/** The four corners of a live rectangle: { k (radius index), x, y, theta, bisector }. */
function rectCorners(shape) {
  const m = rotate(shape.angle || 0, shape.cx, shape.cy);
  const pts = [
    [shape.cx - shape.w / 2, shape.cy - shape.h / 2],
    [shape.cx + shape.w / 2, shape.cy - shape.h / 2],
    [shape.cx + shape.w / 2, shape.cy + shape.h / 2],
    [shape.cx - shape.w / 2, shape.cy + shape.h / 2],
  ].map(([x, y]) => apply(m, x, y));
  const c = { x: shape.cx, y: shape.cy };
  return pts.map((p, k) => {
    const bx = c.x - p.x;
    const by = c.y - p.y;
    const l = Math.hypot(bx, by) || 1;
    return { k, x: p.x, y: p.y, theta: Math.PI / 2, bisector: { x: bx / l, y: by / l } };
  });
}

/**
 * Corners showing widgets for the current tool and selection:
 * [{ node, index | k, x, y, theta, bisector, r, type, limited }].
 */
export function cornerTargets(app) {
  const editor = app.editor;
  if (!editor || editor.viewOptions?.cornerWidget === false) return [];
  const tool = app.toolId;
  if (tool !== 'selection' && tool !== 'direct-selection') return [];
  const doc = editor.doc;
  const zoom = editor.view.zoom;
  const out = [];
  const ids = tool === 'selection' ? editor.topSelection() : [...editor.selection];
  for (const id of ids) {
    const n = doc.get(id);
    if (!n || n.type !== 'path' || !n.anchors?.length || doc.isLocked(id) || doc.isHidden(id)) continue;
    if (n.shape?.kind === 'rect') {
      // Small rectangles on screen have no room for widgets.
      if (Math.min(n.shape.w, n.shape.h) * zoom < 24) continue;
      for (const c of rectCorners(n.shape)) {
        const r = n.shape.radii?.[c.k] || 0;
        out.push({ node: n, rect: true, ...c, r, arcR: r, type: n.shape.cornerTypes?.[c.k] || 'round', rounding: n.shape.rounding || 'absolute', limited: r >= Math.min(n.shape.w, n.shape.h) / 2 - 1e-6 });
      }
      continue;
    }
    const sel = tool === 'direct-selection' ? editor.selectedAnchors?.(id) : null;
    const lim = cornerLimits(n.anchors, n.closed);
    for (let i = 0; i < n.anchors.length; i++) {
      if (sel && sel.size && !sel.has(i)) continue;
      const g = cornerGeometry(n.anchors, n.closed, i);
      if (!g) continue;
      const a = n.anchors[i];
      const r = a.corner?.r || 0;
      const rounding = a.corner?.rounding || 'absolute';
      // The widget sits on the arc: a relative corner's r is a distance along the segments.
      const arcR = rounding === 'relative' ? radiusFor(r, g.theta) : r;
      out.push({ node: n, index: i, x: g.x, y: g.y, theta: g.theta, bisector: g.bisector, r, arcR, type: a.corner?.type || 'round', rounding, limited: lim[i].limited });
    }
  }
  return out.length > MAX_WIDGETS ? [] : out;
}

function widgetPos(editor, c) {
  const d = widgetDist(c.arcR ?? c.r, c.theta, editor.view.zoom);
  return { x: c.x + c.bisector.x * d, y: c.y + c.bisector.y * d };
}

function hitCorner(app, e) {
  const editor = app.editor;
  for (const c of cornerTargets(app)) {
    const p = widgetPos(editor, c);
    const s = editor.view.toScreen(p.x, p.y);
    if (Math.hypot(e.sx - s.x, e.sy - s.y) <= R + 3) return c;
  }
  return null;
}

/** The corners an edit applies to: every widget shown (the selection), or just one. */
function group(app, picked) {
  const all = cornerTargets(app);
  return all.length ? all : [picked];
}

/** Write radii/types to the targets (inside a transaction). */
function setCorners(doc, targets, patch) {
  const byNode = new Map();
  for (const t of targets) {
    const list = byNode.get(t.node.id) || [];
    list.push(t);
    byNode.set(t.node.id, list);
  }
  for (const [id, list] of byNode) {
    const n = doc.get(id);
    if (!n) continue;
    if (n.shape?.kind === 'rect') {
      const radii = [...(n.shape.radii || [0, 0, 0, 0])];
      const types = [...(n.shape.cornerTypes || ['round', 'round', 'round', 'round'])];
      const max = Math.min(n.shape.w, n.shape.h) / 2;
      for (const t of list) {
        radii[t.k] = Math.max(0, Math.min(max, patch.r ?? radii[t.k]));
        if (patch.type) types[t.k] = patch.type;
      }
      const shape = { ...n.shape, radii };
      if (types.some((t) => t !== 'round')) shape.cornerTypes = types;
      else delete shape.cornerTypes;
      if (patch.rounding === 'relative') shape.rounding = 'relative';
      else if (patch.rounding) delete shape.rounding;
      doc.update(id, { shape, anchors: shapeAnchors(shape) });
      continue;
    }
    const idx = new Set(list.map((t) => t.index));
    const anchors = n.anchors.map((a, i) => {
      if (!idx.has(i)) return a;
      const r = Math.max(0, patch.r ?? a.corner?.r ?? 0);
      const type = patch.type ?? a.corner?.type ?? 'round';
      const rounding = patch.rounding ?? a.corner?.rounding ?? 'absolute';
      const { corner, ...rest } = a;
      // A corner type chosen before any rounding is kept for the next drag.
      return r > 0 || type !== 'round' ? { ...rest, corner: { r, type, ...(rounding === 'relative' ? { rounding } : {}) } } : rest;
    });
    doc.update(id, { anchors });
  }
}

/** Drag handler for a corner widget (shared by both selection tools). */
function beginDrag(app, picked, e) {
  const editor = app.editor;
  const doc = editor.doc;
  const targets = group(app, picked);
  const start = { x: e.x, y: e.y };
  const zoom = editor.view.zoom;
  // Where the pointer grabbed the widget, measured along the corner's bisector.
  const along0 = (e.x - picked.x) * picked.bisector.x + (e.y - picked.y) * picked.bisector.y;
  const s0 = widgetDist(picked.arcR ?? picked.r, picked.theta, zoom);
  let tx = null;
  let moved = false;
  const units = doc.root.units || 'pt';
  return {
    move(ev) {
      const along = (ev.x - picked.x) * picked.bisector.x + (ev.y - picked.y) * picked.bisector.y;
      if (!moved && Math.hypot(ev.x - start.x, ev.y - start.y) * editor.view.zoom < 3) return;
      moved = true;
      // Keep the widget under the pointer: its distance from the corner maps back to a radius.
      const mid = Math.max(0, s0 + (along - along0) - REST / zoom);
      const arcR = mid / (1 / Math.sin(picked.theta / 2) - 1);
      const r = picked.rounding === 'relative' ? trimFor(arcR, picked.theta) : arcR;
      tx ||= doc.begin('Round Corners');
      setCorners(doc, targets, { r });
      editor.feedback = { sx: ev.sx, sy: ev.sy, text: `Radius: ${formatLength(r, units)}` };
      editor.emit('overlay');
    },
    end(ev) {
      editor.feedback = null;
      if (tx) {
        tx.commit();
        return;
      }
      // A click with Option switches the corner type.
      if (ev?.alt) {
        const next = CORNER_TYPES[(CORNER_TYPES.indexOf(picked.type) + 1) % CORNER_TYPES.length];
        doc.transact('Corner Type', () => setCorners(doc, targets, { type: next, r: picked.r || undefined }));
        app.notify?.(`Corners: ${TYPE_LABELS[next]}`, { polite: true });
      }
      editor.emit('overlay');
    },
    cancel() {
      editor.feedback = null;
      tx?.cancel();
      tx = null;
    },
    up(ev) {
      this.end(ev);
    },
  };
}

/** The Corners dialog for the widget's corners. */
export async function cornersDialog(app, picked) {
  const editor = app.editor;
  const doc = editor.doc;
  const targets = group(app, picked);
  const fields = [
    { key: 'type', label: 'Corner', type: 'radio', value: picked.type, options: CORNER_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })) },
    { key: 'r', label: 'Radius', type: 'length', value: picked.r, min: 0, max: 100000 },
    { key: 'rounding', label: 'Rounding', type: 'radio', value: picked.rounding || 'absolute', options: Object.entries(ROUNDING_LABELS).map(([value, label]) => ({ value, label })) },
  ];
  let tx = null;
  const patch = (v) => ({ r: v.r, type: v.type, rounding: v.rounding });
  const preview = (v) => {
    tx ||= doc.begin('Corners');
    setCorners(doc, targets, patch(v));
  };
  const v = await app.dialogs.form({ title: 'Corners', fields, onChange: preview });
  if (!v) {
    tx?.cancel();
    return;
  }
  if (!tx) tx = doc.begin('Corners');
  setCorners(doc, targets, patch(v));
  tx.commit();
}

function drawWidgets(ctx, editor) {
  const app = drawWidgets.app;
  if (!app || app.editor !== editor) return;
  const list = cornerTargets(app);
  if (!list.length) return;
  ctx.save();
  for (const c of list) {
    const p = widgetPos(editor, c);
    const s = editor.view.toScreen(p.x, p.y);
    const hover = editor.widgetHover === `corner:${c.node.id}:${c.index ?? c.k}`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = hover ? 2 : 1;
    ctx.strokeStyle = c.limited ? '#e5484d' : '#4f80ff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = c.limited ? '#e5484d' : '#4f80ff';
    ctx.fill();
  }
  ctx.restore();
}

let current = null;
let installed = false;

export function install(app) {
  // The registries are module-wide: register once and act on the latest app.
  current = app;
  drawWidgets.app = app;
  if (installed) return;
  installed = true;
  overlayHooks.add(drawWidgets);
  canvasWidgets.add({
    hit(editor, e) {
      const a = current;
      if (!a || a.editor !== editor || a.toolId !== 'selection') return null;
      const c = hitCorner(a, e);
      if (!c) return null;
      return {
        id: `corner:${c.node.id}:${c.index ?? c.k}`,
        cursor: 'pointer',
        tip: 'Drag to round the corners | Option+click changes the corner type | Double-click for options',
        begin: (ev) => beginDrag(a, c, ev),
        doubleClick: () => cornersDialog(a, c),
      };
    },
  });
  directSelectionHooks.push({
    acceptsAlt: true,
    hover(tool, e) {
      if (tool.app !== current) return null;
      const c = hitCorner(current, e);
      const id = c ? `corner:${c.node.id}:${c.index ?? c.k}` : null;
      if (tool.editor.widgetHover !== id) {
        tool.editor.widgetHover = id;
        tool.overlay();
      }
      return c ? 'pointer' : null;
    },
    pointerDown(tool, e) {
      if (tool.app !== current) return null;
      const c = hitCorner(current, e);
      return c ? beginDrag(current, c, e) : null;
    },
    doubleClick(tool, e) {
      if (tool.app !== current) return false;
      const c = hitCorner(current, e);
      if (!c) return false;
      cornersDialog(current, c);
      return true;
    },
  });
}
