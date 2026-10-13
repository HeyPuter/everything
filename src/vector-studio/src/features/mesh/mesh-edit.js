/**
 * Editing gradient meshes: the mesh point selection, point / handle /
 * patch drags shared by the Mesh tool and Direct Selection, coloring
 * selected points from the paint controls, and the on-canvas overlay of
 * mesh lines, points and handles.
 *
 * Mesh points are selected per editor and stay valid while the object
 * selection they were made with is unchanged; any other selection change
 * (clicking another object, undo) falls back to the whole mesh.
 */
import { fmt, tol } from '../../tools/tool.js';
import { buildSnapIndex, snapPoint } from '../../tools/snap.js';
import { hitTest } from '../../render/hit.js';
import { layerColor } from '../../render/overlay.js';
import { meshLinesPath } from './mesh-raster.js';
import { movePoint, nearestPoint, nearestHandle, locate, patchCorners, slideTarget, slidePoint, liveHandles, rgba, patchColor } from './mesh-model.js';
import { isMesh } from './mesh-live.js';
import { rgbToHex } from '../../lib/color.js';

const POINT_HIT = 5;
const store = new WeakMap();

/** Selected mesh points: Map meshId -> Set of point indices (empty when whole meshes are selected). */
export function meshPointSelection(editor) {
  const rec = store.get(editor);
  if (!rec || rec.set !== editor.selection || rec.version !== editor.selection.version) return new Map();
  const out = new Map();
  for (const [id, pts] of rec.points) {
    const n = editor.doc.get(id);
    if (!isMesh(n) || !editor.selection.has(id)) continue;
    const valid = new Set([...pts].filter((k) => k < n.points.length));
    if (valid.size) out.set(id, valid);
  }
  return out;
}

/** Selected point indices of one mesh (empty when the whole mesh or nothing is selected). */
export function selectedPoints(editor, id) {
  return meshPointSelection(editor).get(id) || new Set();
}

/**
 * Select mesh points. With `add`, points (and other selected objects) are
 * kept; with `toggle`, the given points flip.
 */
export function selectMeshPoints(editor, id, points, { add = false, toggle = false } = {}) {
  const prev = add || toggle ? meshPointSelection(editor) : new Map();
  const set = new Set(prev.get(id) || []);
  for (const k of points) {
    if (toggle && set.has(k)) set.delete(k);
    else set.add(k);
  }
  const keepIds = add || toggle ? [...editor.selection] : [];
  editor.select([...new Set([...keepIds, id])]);
  prev.set(id, set);
  if (!set.size) prev.delete(id);
  store.set(editor, { set: editor.selection, version: editor.selection.version, points: prev });
  editor.emit('selection');
}

/** Forget point selections (the meshes stay selected as objects). */
export function clearMeshPoints(editor) {
  store.delete(editor);
}

/** Meshes whose points can be grabbed: selected meshes, plus the one under the pointer. */
export function activeMeshes(editor, hover = null) {
  const out = [];
  for (const id of editor.selection) {
    const n = editor.doc.get(id);
    if (isMesh(n) && !editor.doc.isLocked(id) && !editor.doc.isHidden(id)) out.push(n);
  }
  if (hover && isMesh(hover) && !out.includes(hover)) out.push(hover);
  return out;
}

/** The mesh under a document point (topmost, unlocked), or null. */
export function meshAt(editor, x, y) {
  const hit = hitTest(editor.doc, x, y, tol(editor, 2), { outline: editor.viewOptions.mode === 'outline' });
  return isMesh(hit) ? hit : null;
}

/** A mesh point or handle under the pointer: { mesh, k, dir? } or null. */
export function pickPointOrHandle(editor, e, meshes) {
  const toScreen = (x, y) => editor.view.toScreen(x, y);
  for (const m of meshes) {
    const sel = selectedPoints(editor, m.id);
    const h = sel.size ? nearestHandle(m, sel, e.sx, e.sy, POINT_HIT, toScreen) : null;
    if (h) return { mesh: m, k: h.k, dir: h.dir };
  }
  for (const m of meshes) {
    const k = nearestPoint(m, e.sx, e.sy, POINT_HIT, toScreen);
    if (k >= 0) return { mesh: m, k };
  }
  return null;
}

/**
 * Drag handler moving selected mesh points (Shift slides a single point
 * along its mesh line). `anchor` is the point grabbed.
 */
export function pointDrag(editor, mesh, k, e, { tx: open = null } = {}) {
  const doc = editor.doc;
  const start = { x: mesh.points[k].x, y: mesh.points[k].y, px: e.x, py: e.y };
  let tx = open;
  let originals = null;
  let snap = null;
  return {
    move(ev) {
      if (!originals) {
        if (Math.hypot(ev.x - start.px, ev.y - start.py) * editor.view.zoom < 2) return;
        if (!tx) tx = doc.begin('Move Mesh Point');
        originals = new Map();
        const sel = meshPointSelection(editor);
        if (!sel.has(mesh.id)) sel.set(mesh.id, new Set([k]));
        for (const [id, pts] of sel) originals.set(id, { node: doc.get(id), pts });
        snap = buildSnapIndex(editor, new Set(originals.keys()));
      }
      let x = start.x + (ev.x - start.px);
      let y = start.y + (ev.y - start.py);
      const orig = originals.get(mesh.id).node;
      if (ev.shift && originals.size === 1 && originals.get(mesh.id).pts.size === 1) {
        // Slide along the mesh line through the point, keeping its shape.
        const target = slideTarget(orig, k, x, y);
        if (target) {
          const out = slidePoint(orig, k, target.axis, target.u);
          doc.update(mesh.id, { points: out.points });
          const p = out.points[k];
          editor.feedback = { sx: ev.sx, sy: ev.sy, text: `dX: ${fmt(editor, p.x - start.x)}\ndY: ${fmt(editor, p.y - start.y)}` };
          return;
        }
      }
      if (!ev.shift) {
        const s = snapPoint(editor, x, y, snap);
        x = s.x;
        y = s.y;
        editor.alignmentGuides = { lines: s.lines, labels: s.labels };
      }
      const ddx = x - start.x;
      const ddy = y - start.y;
      for (const [id, { node, pts }] of originals) doc.update(id, { points: node.points.map((p, i) => (pts.has(i) ? movePoint(p, ddx, ddy) : p)) });
      editor.feedback = { sx: ev.sx, sy: ev.sy, text: `dX: ${fmt(editor, ddx)}\ndY: ${fmt(editor, ddy)}` };
    },
    up() {
      editor.feedback = null;
      editor.alignmentGuides = null;
      if (tx) tx.commit();
      tx = null;
    },
    cancel() {
      editor.feedback = null;
      editor.alignmentGuides = null;
      if (tx) tx.cancel();
      tx = null;
    },
    get moved() {
      return Boolean(originals);
    },
  };
}

/** Drag handler for one direction handle of a mesh point (Shift: 45-degree steps). */
export function handleDrag(editor, mesh, k, dir) {
  const doc = editor.doc;
  let tx = null;
  return {
    move(ev) {
      if (!tx) tx = doc.begin('Move Mesh Handle');
      const cur = doc.get(mesh.id);
      if (!cur) return;
      const p = mesh.points[k];
      let hx = ev.x;
      let hy = ev.y;
      if (ev.shift) {
        const len = Math.hypot(hx - p.x, hy - p.y);
        const a = Math.round(Math.atan2(hy - p.y, hx - p.x) / (Math.PI / 4)) * (Math.PI / 4);
        hx = p.x + Math.cos(a) * len;
        hy = p.y + Math.sin(a) * len;
      }
      const points = mesh.points.slice();
      points[k] = { ...p, [`${dir}x`]: hx, [`${dir}y`]: hy };
      doc.update(mesh.id, { points });
    },
    up() {
      if (tx) tx.commit();
      tx = null;
    },
    cancel() {
      if (tx) tx.cancel();
      tx = null;
    },
  };
}

/**
 * Direct Selection on meshes: grab points and handles of selected meshes,
 * click a point of any mesh to select it, click inside a patch to select
 * its four corners. Returns a drag handler or null to let the tool go on.
 */
export function directPointerDown(tool, e) {
  const editor = tool.editor;
  const under = meshAt(editor, e.x, e.y);
  const meshes = activeMeshes(editor, under);
  if (!meshes.length) return null;
  const hit = pickPointOrHandle(editor, e, meshes);
  if (hit?.dir) return handleDrag(editor, hit.mesh, hit.k, hit.dir);
  if (hit) {
    const sel = selectedPoints(editor, hit.mesh.id);
    if (e.shift) selectMeshPoints(editor, hit.mesh.id, [hit.k], { toggle: true });
    else if (!sel.has(hit.k)) selectMeshPoints(editor, hit.mesh.id, [hit.k]);
    if (e.shift && !selectedPoints(editor, hit.mesh.id).has(hit.k)) return { up() {} };
    // On an already selected point the whole selection drags; a click without a drag narrows it.
    const narrow = !e.shift && sel.has(hit.k) && sel.size > 1;
    const d = pointDrag(editor, hit.mesh, hit.k, e);
    return narrow
      ? {
          ...d,
          move: d.move,
          up(ev) {
            const moved = d.moved;
            d.up(ev);
            if (!moved) selectMeshPoints(editor, hit.mesh.id, [hit.k]);
          },
        }
      : d;
  }
  if (!under) return null;
  const loc = locate(under, e.x, e.y);
  if (!loc) return null;
  const corners = patchCorners(under, loc.i, loc.j);
  const sel = selectedPoints(editor, under.id);
  const already = corners.every((k) => sel.has(k));
  if (!already) selectMeshPoints(editor, under.id, corners, { add: e.shift });
  return pointDrag(editor, under, corners[0], e);
}

/** Marquee with Direct Selection: mesh points inside the rectangle. */
export function directMarquee(tool, r, add) {
  const editor = tool.editor;
  for (const id of [...editor.selection]) {
    const n = editor.doc.get(id);
    if (!isMesh(n)) continue;
    const inside = [];
    n.points.forEach((p, k) => {
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) inside.push(k);
    });
    if (inside.length && inside.length < n.points.length) selectMeshPoints(editor, id, inside, { add: true, toggle: add });
  }
}

// ---- paint ----

/** Set the color and/or opacity of selected mesh points (or of whole selected meshes). */
export function paintMeshPoints(editor, { color, opacity }, label = 'Mesh Color', coalesce = null) {
  const doc = editor.doc;
  const sel = meshPointSelection(editor);
  const targets = new Map(sel);
  if (!targets.size && color) {
    for (const id of editor.topSelection()) {
      const n = doc.get(id);
      if (isMesh(n)) targets.set(id, null);
    }
  }
  if (!targets.size) return false;
  doc.transact(
    label,
    () => {
      for (const [id, pts] of targets) {
        const n = doc.get(id);
        doc.update(id, { points: n.points.map((p, k) => (pts && !pts.has(k) ? p : { ...p, ...(color ? { c: color } : {}), ...(opacity != null ? { a: opacity } : {}) })) });
      }
    },
    { coalesce },
  );
  return true;
}

/** Common paint of the selected mesh points: a value, 'mixed', or undefined when no mesh points are selected. */
export function meshCommonStyle(editor, key) {
  const sel = meshPointSelection(editor);
  if (!sel.size) {
    if (key !== 'fill') return undefined;
    const meshes = editor.topSelection().map((id) => editor.doc.get(id)).filter(isMesh);
    if (!meshes.length || meshes.length !== editor.selection.size) return undefined;
    sel.clear();
    for (const m of meshes) sel.set(m.id, new Set(m.points.map((_, k) => k)));
  }
  const values = [];
  for (const [id, pts] of sel) {
    const n = editor.doc.get(id);
    for (const k of pts) values.push(n.points[k]);
  }
  if (!values.length) return undefined;
  if (key === 'fill') {
    const c = values[0].c;
    return values.every((p) => p.c === c) ? { type: 'solid', color: c } : 'mixed';
  }
  if (key === 'opacity') {
    const a = values[0].a ?? 1;
    return values.every((p) => (p.a ?? 1) === a) ? a : 'mixed';
  }
  if (key === 'stroke') return null;
  return undefined;
}

/** The color of a mesh at a document point: { color, opacity } or null outside it. */
export function meshColorAt(mesh, x, y) {
  const loc = isMesh(mesh) ? locate(mesh, x, y) : null;
  if (!loc) return null;
  const [r, g, b, a] = patchColor(mesh, loc.i, loc.j, loc.s, loc.t);
  return { color: rgbToHex({ r, g, b }), opacity: a };
}

/**
 * Eyedropper on meshes: clicking a mesh picks the color under the pointer
 * (not just the object's style), and with mesh points selected the picked
 * fill color goes to those points.
 */
export const meshEyedropperHook = {
  sample(editor, hit, e) {
    const c = isMesh(hit) ? meshColorAt(hit, e.x, e.y) : null;
    return c ? { fill: { type: 'solid', color: c.color } } : null;
  },
  apply(editor, patch) {
    if (!meshPointSelection(editor).size || patch.fill?.type !== 'solid') return false;
    return paintMeshPoints(editor, { color: patch.fill.color }, 'Eyedropper');
  },
};

/** The paint hooks for mesh points, wrapping any hooks already installed. */
export function installMeshPaintHooks(app, paintHooks) {
  const prevApply = paintHooks.applyStyle;
  const prevCommon = paintHooks.commonStyle;
  paintHooks.applyStyle = (editor, patch, label, coalesce) => {
    if (prevApply?.(editor, patch, label, coalesce)) return true;
    const pointSel = meshPointSelection(editor).size > 0;
    const color = patch.fill?.type === 'solid' ? patch.fill.color : null;
    const opacity = pointSel && 'opacity' in patch ? patch.opacity : null;
    if (!pointSel) {
      // Whole meshes take a solid fill on every point; other objects in the selection go on as usual.
      const top = editor.topSelection();
      if (!color || !top.some((id) => isMesh(editor.doc.get(id)))) return false;
      paintMeshPoints(editor, { color }, label, coalesce);
      if (!top.every((id) => isMesh(editor.doc.get(id)))) return false;
      editor.setStyle(patch);
      return true;
    }
    if (!color && opacity == null) return false;
    editor.setStyle(patch);
    paintMeshPoints(editor, { color, opacity }, label === 'Change Appearance' ? 'Mesh Color' : label, coalesce);
    return true;
  };
  paintHooks.commonStyle = (editor, key) => {
    const v = meshCommonStyle(editor, key);
    if (v !== undefined) return v;
    return prevCommon?.(editor, key);
  };
}

// ---- overlay ----

function diamond(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Mesh lines, points and the handles of selected points for selected meshes. */
export function drawMeshOverlay(ctx, editor) {
  if (!editor.viewOptions.edges || editor.dragPreview) return;
  const { doc, view } = editor;
  const mode = editor.tool?.selectionMode || 'object';
  const meshTool = editor.tool?.constructor?.id === 'mesh';
  const sel = meshPointSelection(editor);
  const draw = (n, color, { points = true } = {}) => {
    ctx.save();
    const m = view.matrix;
    ctx.setTransform(view.dpr * m[0], view.dpr * m[1], view.dpr * m[2], view.dpr * m[3], view.dpr * m[4], view.dpr * m[5]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 / view.zoom;
    ctx.setLineDash([]);
    ctx.stroke(meshLinesPath(n));
    ctx.restore();
    if (!points) return;
    const pts = sel.get(n.id) || new Set();
    const showHandles = mode === 'direct' || meshTool;
    if (showHandles) {
      for (const k of pts) {
        const p = n.points[k];
        const s = view.toScreen(p.x, p.y);
        for (const dir of liveHandles(n, k)) {
          const hx = p[`${dir}x`];
          const hy = p[`${dir}y`];
          if (Math.hypot(hx - p.x, hy - p.y) < 1e-9) continue;
          const hs = view.toScreen(hx, hy);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(hs.x, hs.y);
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    n.points.forEach((p, k) => {
      const s = view.toScreen(p.x, p.y);
      const on = pts.has(k);
      if (mode === 'object' && !meshTool) diamond(ctx, s.x, s.y, 2.5, color, color);
      else diamond(ctx, s.x, s.y, on ? 4 : 3.5, on ? color : '#ffffff', color);
    });
  };
  for (const id of editor.selection) {
    const n = doc.get(id);
    if (!isMesh(n) || doc.isHidden(id)) continue;
    draw(n, layerColor(editor, id));
  }
  // The Mesh tool shows the mesh under the pointer.
  if (meshTool && editor.hover && !editor.selection.has(editor.hover)) {
    const h = doc.get(editor.hover);
    if (isMesh(h)) draw(h, layerColor(editor, h.id), { points: false });
  }
}

/** The color under a mesh point as hex (for reporting and tests). */
export function pointColor(n, k) {
  const c = rgba(n.points[k]);
  return rgbToHex({ r: c[0], g: c[1], b: c[2] });
}
