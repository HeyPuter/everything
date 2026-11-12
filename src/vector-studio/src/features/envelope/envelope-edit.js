/**
 * Editing envelope shapes on the canvas.
 *
 * Selected envelopes show their shape: the mesh lines and points of a mesh
 * envelope, or the outline and the grid a warp envelope would become. With
 * Direct Selection, mesh points and their handles drag (Shift keeps the
 * move or the handle at 45-degree steps), Shift-click adds points, a
 * marquee selects the points inside it and a click inside a patch selects
 * its four corners. Dragging a point of a warp envelope turns it into a
 * mesh envelope first, in the same undo step.
 *
 * Point selections are kept per editor while the object selection they
 * were made with is unchanged.
 */
import { fmt, tol } from '../../tools/tool.js';
import { buildSnapIndex, snapPoint } from '../../tools/snap.js';
import { hitTest } from '../../render/hit.js';
import { layerColor } from '../../render/overlay.js';
import { tracePath } from '../../render/draw.js';
import { movePoint, nearestPoint, nearestHandle, nearestEdge, locate, patchCorners, liveHandles, meshBoundary, rowCol } from '../mesh/mesh-model.js';
import { meshLinesPath } from '../mesh/mesh-raster.js';
import { isEnvelope, editingContents, displayMesh, envelopeOf, envelopeOutline, addColumn, addRow, dropColumn, dropRow } from './envelope-model.js';
import { sourceRect } from './envelope-live.js';
import { resetWithMesh } from './envelope-ops.js';

const POINT_HIT = 5;
const store = new WeakMap();

/** Selected envelope points: Map envelopeId -> Set of point indices. */
export function envelopePointSelection(editor) {
  const rec = store.get(editor);
  if (!rec || rec.set !== editor.selection || rec.version !== editor.selection.version) return new Map();
  const out = new Map();
  for (const [id, pts] of rec.points) {
    const n = editor.doc.get(id);
    if (!isEnvelope(n) || !editor.selection.has(id)) continue;
    const mesh = shownMesh(editor.doc, n);
    const valid = new Set([...pts].filter((k) => mesh && k < mesh.points.length));
    if (valid.size) out.set(id, valid);
  }
  return out;
}

export function selectedEnvelopePoints(editor, id) {
  return envelopePointSelection(editor).get(id) || new Set();
}

/** Select points of an envelope (with `add` other selected objects and points stay; `toggle` flips). */
export function selectEnvelopePoints(editor, id, points, { add = false, toggle = false } = {}) {
  const prev = add || toggle ? envelopePointSelection(editor) : new Map();
  const set = new Set(prev.get(id) || []);
  for (const k of points) {
    if (toggle && set.has(k)) set.delete(k);
    else set.add(k);
  }
  const keep = add || toggle ? [...editor.selection] : [];
  editor.select([...new Set([...keep, id])]);
  prev.set(id, set);
  if (!set.size) prev.delete(id);
  store.set(editor, { set: editor.selection, version: editor.selection.version, points: prev });
  editor.emit('selection');
}

/** The mesh shown for an envelope (its own, or its warp as a mesh), or null. */
export function shownMesh(doc, env) {
  return displayMesh(env.live, sourceRect(doc, env));
}

/** Envelopes being edited as envelopes (not their contents) among the selection, plus `hover`. */
export function activeEnvelopes(editor, hover = null) {
  const out = [];
  for (const id of editor.selection) {
    const n = editor.doc.get(id);
    if (isEnvelope(n) && !editingContents(n) && !editor.doc.isLocked(id) && !editor.doc.isHidden(id)) out.push(n);
  }
  if (hover && isEnvelope(hover) && !editingContents(hover) && !out.includes(hover)) out.push(hover);
  return out;
}

/** The envelope under a document point (edited as an envelope), or null. */
export function envelopeAt(editor, x, y) {
  const filter = editor.isolation ? (n) => editor.inIsolation(n.id) : null;
  const outline = editor.viewOptions.mode === 'outline';
  const hit = hitTest(editor.doc, x, y, tol(editor, 2), { outline, filter });
  return isEnvelope(hit) && !editingContents(hit) && editor.inIsolation(hit.id) ? hit : null;
}

/** Make sure an envelope has its own mesh (a warp becomes the mesh it shows). Returns the node. */
function ensureMesh(doc, env) {
  if (env.live.mode === 'mesh' && env.live.mesh) return env;
  const m = shownMesh(doc, env);
  if (!m) return env;
  resetWithMesh(doc, env.id, m.rows, m.cols, { maintain: true });
  return doc.get(env.id);
}

const constrain = (dx, dy) => {
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [Math.cos(a) * len, Math.sin(a) * len];
};

/** Drag handler moving the selected points of envelopes (the grabbed one leads). */
export function pointDrag(editor, env, k, e, { tx: open = null } = {}) {
  const doc = editor.doc;
  const mesh0 = shownMesh(doc, env);
  const start = { x: mesh0.points[k].x, y: mesh0.points[k].y, px: e.x, py: e.y };
  let tx = open;
  let originals = null;
  let snap = null;
  return {
    move(ev) {
      if (!originals) {
        if (Math.hypot(ev.x - start.px, ev.y - start.py) * editor.view.zoom < 2) return;
        const sel = envelopePointSelection(editor);
        if (!sel.has(env.id)) sel.set(env.id, new Set([k]));
        if (!tx) tx = doc.begin('Move Envelope Point');
        originals = new Map();
        for (const [id, pts] of sel) {
          const n = doc.get(id);
          if (!isEnvelope(n) || doc.isLocked(id)) continue;
          originals.set(id, { node: ensureMesh(doc, n), pts });
        }
        snap = buildSnapIndex(editor, new Set(originals.keys()));
      }
      let x = start.x + (ev.x - start.px);
      let y = start.y + (ev.y - start.py);
      if (ev.shift) {
        const [cx, cy] = constrain(x - start.x, y - start.y);
        x = start.x + cx;
        y = start.y + cy;
        editor.alignmentGuides = null;
      } else {
        const s = snapPoint(editor, x, y, snap);
        x = s.x;
        y = s.y;
        editor.alignmentGuides = { lines: s.lines, labels: s.labels };
      }
      const ddx = x - start.x;
      const ddy = y - start.y;
      for (const [id, { node, pts }] of originals) {
        const m = node.live.mesh;
        doc.update(id, { live: { ...node.live, mesh: { ...m, points: m.points.map((p, i) => (pts.has(i) ? movePoint(p, ddx, ddy) : p)) } } });
      }
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

/** Drag handler for one handle of a mesh point (Shift: 45-degree steps). */
export function handleDrag(editor, env, k, dir) {
  const doc = editor.doc;
  let tx = null;
  let node = null;
  return {
    move(ev) {
      if (!tx) {
        tx = doc.begin('Move Envelope Handle');
        node = ensureMesh(doc, doc.get(env.id));
      }
      const m = node.live.mesh;
      const p = m.points[k];
      let hx = ev.x;
      let hy = ev.y;
      if (ev.shift) {
        const [cx, cy] = constrain(hx - p.x, hy - p.y);
        hx = p.x + cx;
        hy = p.y + cy;
      }
      const points = m.points.slice();
      points[k] = { ...p, [`${dir}x`]: hx, [`${dir}y`]: hy };
      doc.update(env.id, { live: { ...node.live, mesh: { ...m, points } } });
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

/** A point or handle of the active envelopes under the pointer: { env, k, dir? } or null. */
function pick(editor, e, envs) {
  const toScreen = (x, y) => editor.view.toScreen(x, y);
  for (const env of envs) {
    const sel = selectedEnvelopePoints(editor, env.id);
    const m = shownMesh(editor.doc, env);
    const hd = sel.size && m ? nearestHandle(m, sel, e.sx, e.sy, POINT_HIT, toScreen) : null;
    if (hd) return { env, k: hd.k, dir: hd.dir };
  }
  for (const env of envs) {
    const m = shownMesh(editor.doc, env);
    const k = m ? nearestPoint(m, e.sx, e.sy, POINT_HIT, toScreen) : -1;
    if (k >= 0) return { env, k };
  }
  return null;
}

/** Direct Selection press on envelopes: returns a drag handler, or null to let the tool go on. */
export function directPointerDown(tool, e) {
  const editor = tool.editor;
  const under = envelopeAt(editor, e.x, e.y);
  const envs = activeEnvelopes(editor, under);
  if (!envs.length) return null;
  const hit = pick(editor, e, envs);
  if (hit?.dir) return handleDrag(editor, hit.env, hit.k, hit.dir);
  if (hit) {
    const sel = selectedEnvelopePoints(editor, hit.env.id);
    if (e.shift) {
      selectEnvelopePoints(editor, hit.env.id, [hit.k], { toggle: true });
      if (!selectedEnvelopePoints(editor, hit.env.id).has(hit.k)) return { up() {} };
    } else if (!sel.has(hit.k)) selectEnvelopePoints(editor, hit.env.id, [hit.k]);
    // On an already selected point the whole selection drags; a click without a drag narrows it.
    const narrow = !e.shift && sel.has(hit.k) && sel.size > 1;
    const d = pointDrag(editor, hit.env, hit.k, e);
    if (!narrow) return d;
    return {
      move: d.move,
      cancel: d.cancel,
      up(ev) {
        const moved = d.moved;
        d.up(ev);
        if (!moved) selectEnvelopePoints(editor, hit.env.id, [hit.k]);
      },
    };
  }
  if (!under) return null;
  const m = shownMesh(editor.doc, under);
  const loc = m ? locate(m, e.x, e.y) : null;
  if (!loc) {
    if (!editor.selection.has(under.id) || e.shift) editor.select([under.id], { add: e.shift });
    return { up() {} };
  }
  const corners = patchCorners(m, loc.i, loc.j);
  const sel = selectedEnvelopePoints(editor, under.id);
  if (!corners.every((k) => sel.has(k))) selectEnvelopePoints(editor, under.id, corners, { add: e.shift });
  return pointDrag(editor, under, corners[0], e);
}

/** Direct Selection marquee: envelope points inside it (`inside`, else the rectangle `r`). */
export function directMarquee(tool, r, add, inside = null) {
  const within = inside || ((x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  const editor = tool.editor;
  const candidates = new Set([...editor.selection]);
  // The marquee may have selected an envelope as a whole: refine it to its points.
  for (const id of candidates) {
    const n = editor.doc.get(id);
    if (!isEnvelope(n) || editingContents(n)) continue;
    const m = shownMesh(editor.doc, n);
    if (!m) continue;
    const picked = [];
    m.points.forEach((p, k) => {
      if (within(p.x, p.y)) picked.push(k);
    });
    if (picked.length && picked.length < m.points.length) {
      selectEnvelopePoints(editor, id, picked, { add: true, toggle: add });
    }
  }
}

// ---- the Mesh tool on envelopes ----

function setMesh(doc, env, mesh) {
  doc.update(env.id, { live: { ...env.live, mesh } });
  return doc.get(env.id);
}

/**
 * The Mesh tool on envelopes: a click inside a patch adds a row and a
 * column line through it, a click on a mesh line adds one line across it,
 * Option-click on a point or line removes the lines through it; points and
 * handles drag as with Direct Selection. Lines go in exactly where they
 * split their patch, so the artwork does not move.
 */
export function meshToolPointerDown(tool, e) {
  const editor = tool.editor;
  const doc = editor.doc;
  const under = envelopeAt(editor, e.x, e.y);
  const envs = activeEnvelopes(editor, under);
  if (!envs.length) return null;
  const hit = pick(editor, e, envs);
  if (hit?.dir) return handleDrag(editor, hit.env, hit.k, hit.dir);
  if (hit) {
    if (e.alt) {
      doc.transact('Delete Envelope Mesh Point', () => {
        const env = ensureMesh(doc, doc.get(hit.env.id));
        const [i, j] = rowCol(env.live.mesh, hit.k);
        setMesh(doc, env, dropRow(dropColumn(env.live.mesh, j), i));
      });
      editor.select([hit.env.id]);
      return true;
    }
    if (e.shift) selectEnvelopePoints(editor, hit.env.id, [hit.k], { toggle: true });
    else if (!selectedEnvelopePoints(editor, hit.env.id).has(hit.k)) selectEnvelopePoints(editor, hit.env.id, [hit.k]);
    return selectedEnvelopePoints(editor, hit.env.id).has(hit.k) ? pointDrag(editor, hit.env, hit.k, e) : true;
  }
  const t = tol(editor, 3);
  for (const env of envs) {
    const m = shownMesh(doc, env);
    const edge = m ? nearestEdge(m, e.x, e.y, t) : null;
    if (!edge) continue;
    if (e.alt) {
      doc.transact('Delete Envelope Mesh Line', () => {
        const cur = ensureMesh(doc, doc.get(env.id));
        const mm = cur.live.mesh;
        setMesh(doc, cur, edge.kind === 'h' ? dropRow(mm, edge.i) : dropColumn(mm, edge.j));
      });
      editor.select([env.id]);
      return true;
    }
    return addAndDrag(editor, env, e, (mm) => {
      const u = Math.min(0.999, Math.max(0.001, edge.t));
      if (edge.kind === 'h') return { mesh: addColumn(mm, edge.j, u), k: (cols) => edge.i * (cols + 1) + edge.j + 1 };
      return { mesh: addRow(mm, edge.i, u), k: (cols) => (edge.i + 1) * (cols + 1) + edge.j };
    });
  }
  if (e.alt || !under) return e.alt ? true : null;
  const m = shownMesh(doc, under);
  const loc = m ? locate(m, e.x, e.y) : null;
  if (!loc) return null;
  return addAndDrag(editor, under, e, (mm) => {
    const s = Math.min(0.999, Math.max(0.001, loc.s));
    const tt = Math.min(0.999, Math.max(0.001, loc.t));
    const out = addRow(addColumn(mm, loc.j, s), loc.i, tt);
    return { mesh: out, k: (cols) => (loc.i + 1) * (cols + 1) + loc.j + 1 };
  });
}

function addAndDrag(editor, env, e, add) {
  const doc = editor.doc;
  const tx = doc.begin('Add Envelope Mesh Point');
  const cur = ensureMesh(doc, doc.get(env.id));
  const r = add(cur.live.mesh);
  const next = setMesh(doc, cur, r.mesh);
  const k = r.k(r.mesh.cols);
  selectEnvelopePoints(editor, env.id, [k]);
  const d = pointDrag(editor, next, k, e, { tx });
  return d;
}

// ---- overlay ----

const square = (ctx, x, y, r, fill, stroke) => {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.fillRect(Math.round(x - r) + 0.5, Math.round(y - r) + 0.5, 2 * r, 2 * r);
  ctx.strokeRect(Math.round(x - r) + 0.5, Math.round(y - r) + 0.5, 2 * r, 2 * r);
};

function docSpace(ctx, view, fn) {
  ctx.save();
  const m = view.matrix;
  ctx.setTransform(view.dpr * m[0], view.dpr * m[1], view.dpr * m[2], view.dpr * m[3], view.dpr * m[4], view.dpr * m[5]);
  ctx.lineWidth = 1 / view.zoom;
  ctx.setLineDash([]);
  fn();
  ctx.restore();
}

/**
 * Overlay: shapes of selected envelopes (mesh lines and points; handles of
 * selected points with Direct Selection), the hovered envelope's outline,
 * and a dashed outline around envelopes whose contents are being edited.
 */
export function drawEnvelopeOverlay(ctx, editor) {
  if (!editor.viewOptions.edges || editor.dragPreview) return;
  const { doc, view } = editor;
  const direct = editor.tool?.selectionMode === 'direct';
  const sel = envelopePointSelection(editor);
  const seen = new Set();
  const drawEnv = (env, color, { points }) => {
    const m = shownMesh(doc, env);
    if (!m) return;
    docSpace(ctx, view, () => {
      ctx.strokeStyle = color;
      if (env.live.mode !== 'mesh') ctx.globalAlpha = 0.55;
      ctx.stroke(meshLinesPath(m));
      ctx.globalAlpha = 1;
      if (env.live.mode !== 'mesh') ctx.stroke(tracePath(new Path2D(), envelopeOutline(env.live, sourceRect(doc, env)) || meshBoundary(m), true));
    });
    if (!points) return;
    const pts = sel.get(env.id) || new Set();
    if (direct) {
      for (const k of pts) {
        const p = m.points[k];
        const s = view.toScreen(p.x, p.y);
        for (const dir of liveHandles(m, k)) {
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
    m.points.forEach((p, k) => {
      const s = view.toScreen(p.x, p.y);
      const on = pts.has(k);
      if (!direct) square(ctx, s.x, s.y, 2, color, color);
      else square(ctx, s.x, s.y, on ? 3 : 2.5, on ? color : '#ffffff', color);
    });
  };
  for (const id of editor.selection) {
    const n = doc.get(id);
    const env = isEnvelope(n) ? n : null;
    if (!env || doc.isHidden(id) || seen.has(id)) continue;
    seen.add(id);
    if (editingContents(env)) continue;
    drawEnv(env, layerColor(editor, id), { points: true });
  }
  // Envelopes whose contents are being edited: a dashed outline of the shape.
  const editing = new Set();
  for (const id of editor.selection) {
    const env = envelopeOf(doc, id);
    if (env && editingContents(env) && !doc.isHidden(env.id)) editing.add(env);
  }
  for (const env of editing) {
    const m = shownMesh(doc, env);
    if (!m) continue;
    docSpace(ctx, view, () => {
      ctx.strokeStyle = layerColor(editor, env.id);
      ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
      ctx.stroke(tracePath(new Path2D(), meshBoundary(m), true));
    });
  }
  const hover = editor.hover && doc.has(editor.hover) ? doc.get(editor.hover) : null;
  if (isEnvelope(hover) && !seen.has(hover.id) && !editingContents(hover)) {
    const m = shownMesh(doc, hover);
    if (m) {
      docSpace(ctx, view, () => {
        ctx.strokeStyle = layerColor(editor, hover.id);
        ctx.lineWidth = 1.5 / view.zoom;
        ctx.stroke(tracePath(new Path2D(), meshBoundary(m), true));
      });
    }
  }
}
