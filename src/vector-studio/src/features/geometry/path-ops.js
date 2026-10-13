/**
 * Object > Path commands: Outline Stroke, Offset Path, Simplify, Add and
 * Remove Anchor Points, Divide Objects Below, Split Into Grid and Clean Up;
 * plus Object > Expand and Object > Shape > Expand / Convert to Shapes.
 */
import { UserError } from '../../lib/errors.js';
import { h } from '../../lib/dom.js';
import { OP, runGeom } from './engine/index.js';
import { withBusy } from './busy.js';
import {
  geometryLeaves,
  shapeOf,
  subpathsOf,
  styleOf,
  nodeFromSubpaths,
  groupOf,
  replaceWith,
  snapshot,
  unchangedSince,
} from './nodes-io.js';
import { addMidpoints, removeAnchorsKeepingShape, fitPolygon } from './anchors.js';
import { flattenPath, simplifyPolyline, anchor as mkAnchor } from '../../model/bezier.js';
import { createPath } from '../../model/nodes.js';
import { rectangle, KAPPA } from '../../model/shapes.js';
import { nodeBounds, rectsIntersect } from '../../model/geometry.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { isGradient } from '../../model/gradients.js';
import { expandGradientItems } from './expand-gradient.js';
import { convertToMesh } from '../mesh/mesh-ops.js';
import { overlayHooks } from '../../render/overlay.js';
import { tracePath } from '../../render/draw.js';
import { formatLength } from '../../lib/units.js';
import { hasAppearanceStack } from '../../model/appearance.js';
import { expandNodeAppearance } from '../../ops/expand-appearance.js';

const JOIN = { miter: 0, round: 1, bevel: 2 };
const CAP = { butt: 0, round: 1, square: 2 };
const ALIGN = { center: 0, inside: 1, outside: 2 };

/**
 * Engine params for a node's stroke. `pattern` ({ dash, offset }) is the
 * dash actually drawn (corner-aligned dashes adjust the node's own).
 */
export function strokeParams(node, pattern = null) {
  const dash = pattern ? pattern.dash || [] : node.dash && node.dash.length ? node.dash : [];
  const offset = pattern ? pattern.offset || 0 : node.dashOffset || 0;
  return [node.strokeWidth || 0, JOIN[node.strokeJoin] ?? 0, CAP[node.strokeCap] ?? 0, node.miterLimit || 10, ALIGN[node.strokeAlign] ?? 0, offset, ...dash];
}

/**
 * The stroke as drawn: the engine shape (open paths with arrowheads are
 * trimmed where the arrowheads attach), the dash pattern and the arrowhead
 * contours, from the paint module's hooks when installed.
 */
function drawnStroke(app, doc, node) {
  const shape = shapeOf(doc, node);
  let arrows = [];
  if (node.type === 'path' && !node.closed && (node.arrowStart || node.arrowEnd)) {
    const trimmed = app.strokeAnchors?.(node);
    if (trimmed && trimmed.length > 1) shape.subpaths = [{ anchors: trimmed, closed: false }];
    arrows = app.arrowheadPaths?.(node) || [];
  }
  return { shape, pattern: app.dashPattern?.(node) || null, arrows };
}

function targets(editor) {
  return geometryLeaves(editor.doc, editor.topSelection());
}

/** Position just above (or at) a node within its parent. */
function at(doc, node, above = true) {
  const parent = doc.get(node.parent);
  return { parentId: parent.id, index: parent.children.indexOf(node.id) + (above ? 1 : 0) };
}

/**
 * Preview session for dialogs: changes go into an open transaction that is
 * rolled back before each refresh and committed on OK.
 */
export class PreviewSession {
  constructor(doc, label) {
    this.doc = doc;
    this.label = label;
    this.tx = null;
    this.disposed = false;
  }

  show(fn) {
    if (this.disposed) return undefined;
    this.clear();
    this.tx = this.doc.begin(this.label);
    try {
      return fn();
    } catch (err) {
      this.clear();
      throw err;
    }
  }

  clear() {
    if (this.tx) {
      const tx = this.tx;
      this.tx = null;
      tx.cancel();
    }
  }

  /** Roll back and ignore any preview that arrives later (the dialog closed). */
  dispose() {
    this.clear();
    this.disposed = true;
  }

  commit() {
    if (!this.tx) return false;
    const tx = this.tx;
    this.tx = null;
    tx.commit();
    return true;
  }
}

// ---- Outline Stroke / Expand ----

/** Items replacing a node when its stroke is expanded: [fill copy?, stroke outline, arrowheads?]. */
function expandedStrokeItems(doc, node, rec, arrows = []) {
  const style = styleOf(node);
  const strokeStyle = { ...style, fill: node.stroke, stroke: null, dash: [], dashOffset: 0, arrowStart: null, arrowEnd: null, strokeAlign: 'center' };
  const outline = rec && nodeFromSubpaths(rec.subpaths, strokeStyle);
  const heads = arrows.length ? nodeFromSubpaths(arrows, strokeStyle) : null;
  const parts = [outline, heads].filter(Boolean);
  if (!parts.length) return null;
  const fillCopy = node.fill ? nodeFromSubpaths(subpathsOf(doc, node), { ...style, stroke: null, arrowStart: null, arrowEnd: null }, node.type === 'compound' ? { fillRule: node.fillRule } : {}) : null;
  const items = [fillCopy, ...parts].filter(Boolean);
  return items.length === 1 ? items[0] : groupOf(items);
}

/** Outline Stroke (and Expand with Stroke): stroke becomes a filled shape. */
export async function outlineStroke(app, { label = 'Outline Stroke', expandFill = true } = {}) {
  const editor = app.editor;
  const doc = editor.doc;
  expandStacks(editor, label);
  const nodes = targets(editor).filter((n) => n.stroke && n.strokeWidth > 0);
  if (!nodes.length) {
    app.notify('Select a path with a stroke.');
    return false;
  }
  const snap = snapshot(doc, nodes);
  const strokes = nodes.map((n) => drawnStroke(app, doc, n));
  const results = await withBusy(app, label, () =>
    Promise.all(nodes.map((n, i) => runGeom(OP.STROKE, [strokes[i].shape], strokeParams(n, strokes[i].pattern), { tol: 0.01 }))),
  );
  if (!unchangedSince(doc, snap)) return false;
  const ids = [];
  doc.transact(label, () => {
    nodes.forEach((n, i) => {
      const src = expandFill ? n : { ...n, fill: null };
      const item = expandedStrokeItems(doc, src, results[i][0], strokes[i].arrows);
      if (!item) return;
      ids.push(...replaceWith(doc, [n], [item], at(doc, n)));
    });
  });
  editor.select(ids);
  return true;
}

/**
 * Objects with several fills and strokes (appearance stacks) expand into
 * one path per fill and stroke first, so that every stroke gets outlined.
 */
function expandStacks(editor, label) {
  const doc = editor.doc;
  const top = editor.topSelection();
  const stacked = [...new Set([...top.map((id) => doc.get(id)), ...targets(editor)])].filter((n) => n && hasAppearanceStack(n));
  if (!stacked.length) return;
  const keep = top.filter((id) => !stacked.some((n) => n.id === id));
  const out = [];
  doc.transact(label, () => {
    for (const n of stacked) if (doc.get(n.id)) out.push(expandNodeAppearance(doc, n.id));
  });
  editor.select([...keep, ...out].filter((id) => doc.get(id)));
}

/**
 * Object > Expand dialog: Object (live shapes, type), Fill, Stroke, and
 * what gradient fills expand to (a gradient mesh or a number of steps).
 */
export async function expandDialog(app) {
  const editor = app.editor;
  const sel = editor.selectedNodes();
  const hasStroke = targets(editor).some((n) => n.stroke && n.strokeWidth > 0);
  const hasText = sel.some((n) => n.type === 'text');
  const hasGradient = targets(editor).some((n) => isGradient(n.fill));
  const last = app.prefs?.get('expandGradient') || { to: 'steps', steps: 255 };
  const v = await app.dialogs.form({
    title: 'Expand',
    fields: [
      { type: 'heading', label: 'Expand' },
      { key: 'object', label: 'Object', type: 'checkbox', value: true },
      { key: 'fill', label: 'Fill', type: 'checkbox', value: true, inline: true },
      { key: 'stroke', label: 'Stroke', type: 'checkbox', value: hasStroke, inline: true },
      { type: 'heading', label: 'Expand Gradient To' },
      {
        key: 'gradientTo',
        label: 'Gradients become',
        type: 'radio',
        value: last.to,
        options: [
          { value: 'mesh', label: 'Gradient Mesh' },
          { value: 'steps', label: 'Solid steps' },
        ],
        disabled: (x) => !hasGradient || !x.fill,
      },
      { key: 'steps', label: 'Number of steps', type: 'number', value: last.steps, min: 1, max: 1000, step: 1, disabled: (x) => !hasGradient || !x.fill || x.gradientTo !== 'steps' },
    ],
  });
  if (!v) return false;
  if (hasGradient) app.prefs?.set('expandGradient', { to: v.gradientTo, steps: Math.round(v.steps) });
  if (v.object) {
    expandShapes(editor, 'Expand');
    if (hasText && app.commands.get('type.createOutlines')) await app.commands.run('type.createOutlines');
  }
  if (v.stroke && hasStroke) await outlineStroke(app, { label: 'Expand', expandFill: v.fill });
  if (v.fill && hasGradient) expandGradients(app, v.gradientTo, Math.round(v.steps));
  return true;
}

/** Expand the gradient fills of the selected paths (Object > Expand). */
export function expandGradients(app, to = 'steps', steps = 255) {
  const editor = app.editor;
  const doc = editor.doc;
  const nodes = targets(editor).filter((n) => isGradient(n.fill));
  if (!nodes.length) return false;
  const keep = new Set(editor.topSelection().filter((id) => !nodes.some((n) => n.id === id)));
  const ids = [];
  doc.transact('Expand', () => {
    for (const n of nodes) {
      if (to === 'mesh' && n.type === 'path' && n.closed) {
        const stops = n.fill.stops?.length || 2;
        const cells = Math.max(2, Math.min(12, stops * 2 - 1));
        const mesh = convertToMesh(doc, n.id, n.fill.type === 'radial' ? { rows: cells, cols: cells } : { rows: 1, cols: cells });
        if (mesh) ids.push(mesh.id);
        continue;
      }
      const item = expandGradientItems(doc, n, steps);
      if (item) ids.push(...replaceWith(doc, [n], [item], at(doc, n)));
    }
  });
  editor.select([...keep, ...ids].filter((id) => doc.has(id)));
  return true;
}

/** Shape > Expand Shape: drop live-shape parameters. */
export function expandShapes(editor, label = 'Expand Shape') {
  const doc = editor.doc;
  const nodes = targets(editor).filter((n) => n.type === 'path' && n.shape);
  if (!nodes.length) return false;
  doc.transact(label, () => nodes.forEach((n) => doc.update(n.id, { shape: undefined })));
  editor.emit('selection');
  return true;
}

/** Recognize a live shape from anchors: rect (any rotation), ellipse (axis aligned), regular polygon. */
export function recognizeShape(anchors, closed) {
  if (!closed) {
    if (anchors.length === 2 && !hasHandles(anchors)) return { kind: 'line', x1: anchors[0].x, y1: anchors[0].y, x2: anchors[1].x, y2: anchors[1].y };
    return null;
  }
  const n = anchors.length;
  const e = 1e-3;
  const cx = anchors.reduce((s, a) => s + a.x, 0) / n;
  const cy = anchors.reduce((s, a) => s + a.y, 0) / n;
  if (n === 4 && !hasHandles(anchors)) {
    const [a, b, c, d] = anchors;
    const dot = (p, q, r) => (p.x - q.x) * (r.x - q.x) + (p.y - q.y) * (r.y - q.y);
    if ([dot(d, a, b), dot(a, b, c), dot(b, c, d), dot(c, d, a)].every((v) => Math.abs(v) < e * (1 + Math.hypot(b.x - a.x, b.y - a.y) ** 2))) {
      const w = Math.hypot(b.x - a.x, b.y - a.y);
      const hh = Math.hypot(d.x - a.x, d.y - a.y);
      let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      angle = ((angle % 360) + 360) % 360;
      return { kind: 'rect', cx, cy, w, h: hh, radii: [0, 0, 0, 0], angle: Math.abs(angle) < 1e-6 || Math.abs(angle - 360) < 1e-6 ? 0 : angle };
    }
  }
  if (n === 4 && anchors.every((a) => Math.hypot(a.ox - a.x, a.oy - a.y) > e)) {
    const xs = anchors.map((a) => a.x);
    const ys = anchors.map((a) => a.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const hgt = Math.max(...ys) - Math.min(...ys);
    const rx = w / 2;
    const ry = hgt / 2;
    const ok = anchors.every((a) => {
      const onX = Math.abs(Math.abs(a.x - cx) - rx) < e && Math.abs(a.y - cy) < e;
      const onY = Math.abs(Math.abs(a.y - cy) - ry) < e && Math.abs(a.x - cx) < e;
      const k = onX ? Math.abs(a.oy - a.y) / (ry || 1) : Math.abs(a.ox - a.x) / (rx || 1);
      return (onX || onY) && Math.abs(k - KAPPA) < 0.01;
    });
    if (ok) return { kind: 'ellipse', cx, cy, w, h: hgt, angle: 0 };
  }
  if (n >= 3 && !hasHandles(anchors)) {
    const r = Math.hypot(anchors[0].x - cx, anchors[0].y - cy);
    const sideLen = Math.hypot(anchors[1].x - anchors[0].x, anchors[1].y - anchors[0].y);
    const regular = anchors.every((a, i) => {
      const nx = anchors[(i + 1) % n];
      return Math.abs(Math.hypot(a.x - cx, a.y - cy) - r) < e * (1 + r) && Math.abs(Math.hypot(nx.x - a.x, nx.y - a.y) - sideLen) < e * (1 + sideLen);
    });
    if (regular && r > 0) {
      const first = (Math.atan2(anchors[0].y - cy, anchors[0].x - cx) * 180) / Math.PI;
      const angle = (((first + 90) % 360) + 360) % 360;
      return { kind: 'polygon', cx, cy, r, sides: n, angle: Math.abs(angle) < 1e-6 ? 0 : angle };
    }
  }
  return null;
}

function hasHandles(anchors) {
  return anchors.some((a) => Math.abs(a.ix - a.x) > 1e-9 || Math.abs(a.iy - a.y) > 1e-9 || Math.abs(a.ox - a.x) > 1e-9 || Math.abs(a.oy - a.y) > 1e-9);
}

/** Shape > Convert to Shapes. */
export function convertToShapes(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const nodes = targets(editor).filter((n) => n.type === 'path' && !n.shape);
  const found = nodes.map((n) => [n, recognizeShape(n.anchors, n.closed)]).filter(([, s]) => s);
  if (!found.length) {
    app.notify('The selection has no paths that can become live shapes.');
    return false;
  }
  doc.transact('Convert to Shapes', () => found.forEach(([n, shape]) => doc.update(n.id, { shape })));
  editor.emit('selection');
  return true;
}

// ---- Offset Path ----

export async function offsetPathDialog(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const nodes = targets(editor);
  if (!nodes.length) {
    app.notify('Select one or more paths.');
    return false;
  }
  const last = app.prefs.get('offsetPath') || { offset: 10, joins: 'miter', miter: 4 };
  const preview = new PreviewSession(doc, 'Offset Path');
  let seq = 0;
  const compute = async (v) => {
    const join = JOIN[v.joins] ?? 0;
    const records = await runGeom(OP.OFFSET, nodes.map((n) => shapeOf(doc, n)), [v.offset, join, v.miter], { tol: 0.01 });
    return records;
  };
  const apply = (v, records) => {
    const ids = [];
    nodes.forEach((n, i) => {
      const rec = records.find((r) => r.owner === i);
      const built = rec && nodeFromSubpaths(rec.subpaths, styleOf(n));
      if (!built) return;
      const pos = at(doc, n, v.offset < 0);
      doc.insert(built.node, pos.parentId, pos.index, built.descendants);
      ids.push(built.node.id);
    });
    return ids;
  };
  const refresh = async (v) => {
    const my = ++seq;
    if (!v.preview) {
      preview.clear();
      return;
    }
    const records = await compute(v);
    if (my !== seq) return;
    preview.show(() => apply(v, records));
  };
  const v = await app.dialogs.form({
    title: 'Offset Path',
    fields: [
      { key: 'offset', label: 'Offset', type: 'length', value: last.offset },
      {
        key: 'joins',
        label: 'Joins',
        type: 'select',
        value: last.joins,
        options: [
          { value: 'miter', label: 'Miter' },
          { value: 'round', label: 'Round' },
          { value: 'bevel', label: 'Bevel' },
        ],
      },
      { key: 'miter', label: 'Miter limit', type: 'number', value: last.miter, min: 1, max: 500 },
      { key: 'preview', label: 'Preview', type: 'checkbox', value: false },
    ],
    onChange: (vals) => refresh(vals).catch((err) => app.notify(err.message, { error: true })),
  });
  seq++;
  preview.dispose();
  if (!v) return false;
  app.prefs.set('offsetPath', { offset: v.offset, joins: v.joins, miter: v.miter });
  let ids = [];
  const records = await withBusy(app, 'Offset Path', () => compute(v));
  doc.transact('Offset Path', () => {
    ids = apply(v, records);
  });
  editor.select(ids);
  return true;
}

// ---- Simplify ----

function anchorCount(doc, nodes) {
  let n = 0;
  for (const node of nodes) for (const sp of subpathsOf(doc, node)) n += sp.anchors.length;
  return n;
}

/** Accuracy in document units for a 0..100 "more points" slider value and a path size. */
export function simplifyAccuracy(value, diag) {
  return Math.max(1e-4, diag * 10 ** (-1 - (3.5 * value) / 100));
}

/** Straight-line version of anchors (handles retracted, collinear points removed). */
function straighten(anchors, closed, tolerance) {
  const pts = flattenPath(anchors, closed, tolerance / 4);
  const simp = simplifyPolyline(closed ? [...pts, pts[0]] : pts, tolerance);
  if (closed && simp.length > 1) simp.pop();
  return simp.map((p) => mkAnchor(p.x, p.y));
}

/**
 * Simplify subpaths: polygonal runs are first fitted with Beziers (split at
 * corners turning more than `cornerDeg`), then the engine refits smooth
 * stretches (kurbo) within `accuracy`. `straight` converts to lines.
 */
export async function simplifySubpaths(subpaths, accuracy, cornerDeg = 30, straight = false) {
  const prepared = subpaths.map((sp) => {
    const polygonal = sp.anchors.length > 3 && !sp.anchors.some((a) => Math.abs(a.ix - a.x) + Math.abs(a.iy - a.y) + Math.abs(a.ox - a.x) + Math.abs(a.oy - a.y) > 1e-9);
    return polygonal && !straight ? { closed: sp.closed, anchors: fitPolygon(sp.anchors, sp.closed, accuracy, cornerDeg) } : sp;
  });
  const thresh = cornerDeg >= 89.9 ? 1e9 : Math.max(1e-3, Math.tan((cornerDeg * Math.PI) / 180));
  const recs = await runGeom(OP.SIMPLIFY, [{ subpaths: prepared, filled: true }], [accuracy, thresh]);
  let sps = recs[0]?.subpaths || prepared;
  if (sps.length !== subpaths.length) sps = prepared;
  if (straight) sps = sps.map((sp) => ({ closed: sp.closed, anchors: straighten(sp.anchors, sp.closed, accuracy) }));
  return sps;
}

export async function simplifyDialog(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const nodes = targets(editor);
  if (!nodes.length) {
    app.notify('Select one or more paths.');
    return false;
  }
  const originals = nodes.map((n) => ({ node: n, subpaths: subpathsOf(doc, n), kids: n.type === 'compound' ? n.children.slice() : null }));
  const before = anchorCount(doc, nodes);
  const diag = (n) => {
    const b = nodeBounds(doc, n) || { w: 1, h: 1 };
    return Math.hypot(b.w, b.h) || 1;
  };
  const prefs = app.prefs.get('simplify') || { precision: 50, angle: 30, straight: false };
  const state = { precision: prefs.precision, angle: prefs.angle ?? 30, straight: prefs.straight, showOriginal: false, preview: true };
  const preview = new PreviewSession(doc, 'Simplify');
  let seq = 0;
  let lastCount = before;

  const compute = async () => {
    const out = [];
    for (const o of originals) {
      out.push(await simplifySubpaths(o.subpaths, simplifyAccuracy(state.precision, diag(o.node)), state.angle, state.straight));
    }
    return out;
  };
  const apply = (results) => {
    originals.forEach((o, i) => {
      const sps = results[i];
      if (o.node.type === 'path') doc.update(o.node.id, { anchors: sps[0].anchors, shape: undefined });
      else o.kids.forEach((kid, k) => sps[k] && doc.update(kid, { anchors: sps[k].anchors }));
    });
  };
  const count = h('p.simplify-counts', { 'aria-live': 'polite' });
  const setCount = (cur) => {
    lastCount = cur;
    count.textContent = `Original: ${before} pts    Current: ${cur} pts`;
  };
  setCount(before);
  const refresh = async () => {
    const my = ++seq;
    const results = await compute();
    if (my !== seq) return results;
    setCount(results.reduce((s, sps) => s + sps.reduce((a, sp) => a + sp.anchors.length, 0), 0));
    if (state.preview) preview.show(() => apply(results));
    else preview.clear();
    editor.emit('overlay');
    return results;
  };
  const hook = (ctx, ed) => {
    if (!state.showOriginal || ed !== editor) return;
    ctx.save();
    const v = ed.view;
    ctx.strokeStyle = '#ff3f3f';
    ctx.lineWidth = 1;
    for (const o of originals) {
      for (const sp of o.subpaths) {
        ctx.beginPath();
        const scr = sp.anchors.map((a) => {
          const p = v.toScreen(a.x, a.y);
          const i = v.toScreen(a.ix, a.iy);
          const q = v.toScreen(a.ox, a.oy);
          return { x: p.x, y: p.y, ix: i.x, iy: i.y, ox: q.x, oy: q.y };
        });
        tracePath(ctx, scr, sp.closed);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  overlayHooks.add(hook);

  const id = `simp-${Date.now().toString(36)}`;
  const slider = h('input', { type: 'range', id: `${id}-p`, min: 0, max: 100, step: 1, value: state.precision });
  const sliderOut = h('output.range-out', { for: `${id}-p` }, `${state.precision}%`);
  const angle = h('input', { type: 'range', id: `${id}-a`, min: 0, max: 180, step: 1, value: state.angle });
  const angleOut = h('output.range-out', { for: `${id}-a` }, `${state.angle}°`);
  const check = (key, label) => {
    const input = h('input', { type: 'checkbox', id: `${id}-${key}`, checked: state[key] });
    input.addEventListener('change', () => {
      state[key] = input.checked;
      if (key === 'showOriginal') editor.emit('overlay');
      else refresh().catch(() => {});
    });
    return h('div.form-row.check', input, h('label', { for: `${id}-${key}` }, label));
  };
  slider.addEventListener('input', () => {
    state.precision = Number(slider.value);
    sliderOut.textContent = `${state.precision}%`;
    refresh().catch(() => {});
  });
  angle.addEventListener('input', () => {
    state.angle = Number(angle.value);
    angleOut.textContent = `${state.angle}°`;
    refresh().catch(() => {});
  });
  const body = h(
    'div.form.simplify-form',
    h('div.form-row', h('label', { for: `${id}-p` }, 'Simplify Curve'), h('div.range-wrap', slider, sliderOut)),
    h('div.form-row', h('label', { for: `${id}-a` }, 'Corner Point Angle Threshold'), h('div.range-wrap', angle, angleOut)),
    check('straight', 'Convert to Straight Lines'),
    check('showOriginal', 'Show Original Path'),
    check('preview', 'Preview'),
    count,
  );
  refresh().catch(() => {});
  const ok = await openDialog({
    title: 'Simplify',
    body,
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'OK', primary: true, value: true },
    ],
  });
  overlayHooks.delete(hook);
  seq++;
  preview.dispose();
  editor.emit('overlay');
  if (!ok) return false;
  app.prefs.set('simplify', { precision: state.precision, angle: state.angle, straight: state.straight });
  const results = await withBusy(app, 'Simplify', compute);
  doc.transact('Simplify', () => apply(results));
  app.notify(`Simplified from ${before} to ${lastCount} anchor points.`, { polite: true });
  return true;
}

// ---- Add / Remove Anchor Points ----

export function addAnchorPoints(editor) {
  const doc = editor.doc;
  const nodes = targets(editor);
  if (!nodes.length) return false;
  doc.transact('Add Anchor Points', () => {
    for (const n of nodes) {
      if (n.type === 'path') doc.update(n.id, { anchors: addMidpoints(n.anchors, n.closed), shape: undefined });
      else for (const c of n.children) {
        const cn = doc.get(c);
        if (cn?.type === 'path') doc.update(c, { anchors: addMidpoints(cn.anchors, cn.closed), shape: undefined });
      }
    }
  });
  return true;
}

export function removeAnchorPoints(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const work = [];
  for (const [id, set] of editor.anchors) {
    const n = doc.get(id);
    if (n?.type === 'path' && set.size) work.push([n, set]);
  }
  if (!work.length) {
    app.notify('Select anchor points with the Direct Selection tool.');
    return false;
  }
  let removed = 0;
  doc.transact('Remove Anchor Points', () => {
    for (const [n, set] of work) {
      const next = removeAnchorsKeepingShape(n.anchors, n.closed, set);
      if (!next) {
        // Nothing meaningful remains: remove the path like deleting it.
        doc.remove(n.id);
        removed += n.anchors.length;
        continue;
      }
      if (next === n.anchors) continue;
      removed += n.anchors.length - next.length;
      doc.update(n.id, { anchors: next, shape: undefined });
    }
  });
  editor.select(work.map(([n]) => n.id).filter((id) => doc.has(id)));
  return removed > 0;
}

// ---- Divide Objects Below ----

export async function divideBelow(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const sel = targets(editor);
  if (sel.length !== 1) {
    app.notify('Select exactly one path to divide the objects below it.');
    return false;
  }
  const cutter = sel[0];
  const cb = nodeBounds(doc, cutter);
  const order = doc.paintOrder();
  const below = doc
    .leaves()
    .filter((n) => (n.type === 'path' || n.type === 'compound') && order.get(n.id) < order.get(cutter.id))
    .filter((n) => !doc.isLocked(n.id) && !doc.isHidden(n.id))
    .filter((n) => {
      const b = nodeBounds(doc, n);
      return b && cb && rectsIntersect(b, cb);
    });
  if (!below.length) {
    app.notify('There are no objects below the selected path.');
    return false;
  }
  const open = cutter.type === 'path' && !cutter.closed;
  const shapes = [...below.map((n) => shapeOf(doc, n, { string: n.type === 'path' && !n.closed && !n.fill })), shapeOf(doc, cutter, { string: open })];
  const snap = snapshot(doc, [...below, cutter]);
  const records = await withBusy(app, 'Divide Objects Below', () => runGeom(open ? OP.SLICE_EACH : OP.DIVIDE_BELOW, shapes, []));
  if (!unchangedSince(doc, snap)) return false;
  const ids = [];
  doc.transact('Divide Objects Below', () => {
    below.forEach((n, i) => {
      const recs = records.filter((r) => r.owner === i);
      if (!recs.length || recs.some((r) => r.unchanged)) return;
      const items = recs.map((r) => nodeFromSubpaths(r.subpaths, styleOf(n))).filter(Boolean);
      ids.push(...replaceWith(doc, [n], items, at(doc, n)));
    });
    doc.remove(cutter.id);
  });
  editor.select(ids);
  return true;
}

// ---- Split Into Grid ----

/** Rectangles for a grid inside bounds b. */
export function gridCells(b, { rows, cols, rowGutter, colGutter }) {
  const ch = (b.h - rowGutter * (rows - 1)) / rows;
  const cw = (b.w - colGutter * (cols - 1)) / cols;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push({ x: b.x + c * (cw + colGutter), y: b.y + r * (ch + rowGutter), w: cw, h: ch });
  }
  return { cells, cw, ch };
}

/**
 * Split Into Grid: rows and columns, each with Number, cell size, Gutter and
 * Total linked (Total = Number x size + gutters). While the size and total
 * are untouched every object is split to fill its own bounds; once they are
 * edited, cells take the size entered.
 */
export async function splitGridDialog(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const nodes = targets(editor);
  if (!nodes.length) {
    app.notify('Select one or more objects to split.');
    return false;
  }
  const b0 = nodeBounds(doc, nodes[0]);
  const last = app.prefs?.get('splitGrid') || { rows: 2, cols: 2, rowGutter: 12, colGutter: 12, guides: false };
  const fit = { rows: true, cols: true };
  const size = (total, n, gutter) => (total - (n - 1) * gutter) / n;
  const linked = (axis) => {
    const [nKey, sKey, gKey, tKey] = axis === 'rows' ? ['rows', 'height', 'rowGutter', 'rowTotal'] : ['cols', 'width', 'colGutter', 'colTotal'];
    const n = (form) => Math.max(1, Math.round(form.get(nKey)));
    return {
      // Number and Gutter keep the total and resize the cells; size and Total move each other.
      count: (_, form) => form.set(sKey, round4(size(form.get(tKey), n(form), form.get(gKey)))),
      gutter: (_, form) => form.set(sKey, round4(size(form.get(tKey), n(form), form.get(gKey)))),
      size: (v, form) => {
        fit[axis] = false;
        form.set(tKey, round4(n(form) * v + (n(form) - 1) * form.get(gKey)));
      },
      total: (v, form) => {
        fit[axis] = false;
        form.set(sKey, round4(size(v, n(form), form.get(gKey))));
      },
    };
  };
  const R = linked('rows');
  const C = linked('cols');
  const H = b0?.h || 100;
  const W = b0?.w || 100;
  const optsFor = (v, b) => {
    const rows = Math.max(1, Math.round(v.rows));
    const cols = Math.max(1, Math.round(v.cols));
    const h = fit.rows ? size(b.h, rows, v.rowGutter) : v.height;
    const w = fit.cols ? size(b.w, cols, v.colGutter) : v.width;
    return { rows, cols, rowGutter: v.rowGutter, colGutter: v.colGutter, h, w };
  };
  const apply = (v) => {
    const ids = [];
    const guides = [...(doc.root.guides || [])];
    for (const n of nodes) {
      const b = nodeBounds(doc, n);
      if (!b) continue;
      const o = optsFor(v, b);
      if (!(o.w > 0) || !(o.h > 0)) throw new UserError('The gutters are too wide for the selected object.');
      const box = { x: b.x, y: b.y, w: o.cols * o.w + (o.cols - 1) * o.colGutter, h: o.rows * o.h + (o.rows - 1) * o.rowGutter };
      const { cells } = gridCells(box, o);
      const style = styleOf(n);
      const items = cells.map((c) => ({
        node: createPath(rectangle(c.x, c.y, c.w, c.h), true, style, { shape: { kind: 'rect', cx: c.x + c.w / 2, cy: c.y + c.h / 2, w: c.w, h: c.h, radii: [0, 0, 0, 0], angle: 0 } }),
        descendants: [],
      }));
      ids.push(...replaceWith(doc, [n], items, at(doc, n)));
      if (v.guides) {
        for (const c of cells) guides.push({ axis: 'x', pos: c.x }, { axis: 'x', pos: c.x + c.w }, { axis: 'y', pos: c.y }, { axis: 'y', pos: c.y + c.h });
      }
    }
    if (v.guides) {
      const seen = new Set();
      doc.updateRoot({ guides: guides.filter((g) => !seen.has(`${g.axis}${g.pos.toFixed(4)}`) && seen.add(`${g.axis}${g.pos.toFixed(4)}`)) });
    }
    return ids;
  };
  let tx = null;
  const rollback = () => {
    if (tx) {
      tx.cancel();
      tx = null;
    }
  };
  const preview = (v) => {
    rollback();
    if (!v.preview) return;
    tx = doc.begin('Split Into Grid');
    try {
      apply(v);
    } catch {
      rollback();
    }
  };
  const rows = Math.max(1, last.rows);
  const cols = Math.max(1, last.cols);
  let v;
  try {
    v = await app.dialogs.form({
      title: 'Split Into Grid',
      className: 'split-grid-dialog',
      fields: [
        { type: 'heading', label: 'Rows' },
        { key: 'rows', label: 'Number', type: 'number', value: rows, min: 1, max: 500, onInput: R.count },
        { key: 'height', label: 'Height', type: 'length', value: round4(size(H, rows, last.rowGutter)), min: 0.001, onInput: R.size },
        { key: 'rowGutter', label: 'Gutter', type: 'length', value: last.rowGutter, min: 0, onInput: R.gutter },
        { key: 'rowTotal', label: 'Total', type: 'length', value: round4(H), min: 0.001, onInput: R.total },
        { type: 'heading', label: 'Columns' },
        { key: 'cols', label: 'Number', type: 'number', value: cols, min: 1, max: 500, onInput: C.count },
        { key: 'width', label: 'Width', type: 'length', value: round4(size(W, cols, last.colGutter)), min: 0.001, onInput: C.size },
        { key: 'colGutter', label: 'Gutter', type: 'length', value: last.colGutter, min: 0, onInput: C.gutter },
        { key: 'colTotal', label: 'Total', type: 'length', value: round4(W), min: 0.001, onInput: C.total },
        { key: 'guides', label: 'Add Guides', type: 'checkbox', value: last.guides },
        { key: 'preview', label: 'Preview', type: 'checkbox', value: false },
      ],
      onChange: preview,
    });
  } finally {
    rollback();
  }
  if (!v) return false;
  app.prefs?.set('splitGrid', { rows: Math.round(v.rows), cols: Math.round(v.cols), rowGutter: v.rowGutter, colGutter: v.colGutter, guides: v.guides });
  let ids = [];
  doc.transact('Split Into Grid', () => {
    ids = apply(v);
  });
  editor.select(ids);
  return true;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

// ---- Clean Up ----

/** Ids Clean Up would delete. */
export function cleanUpTargets(doc, { stray = true, unpainted = true, emptyText = true } = {}) {
  const out = [];
  doc.walk((n) => {
    if (n.type === 'layer') return !n.locked;
    if (n.locked) return false;
    const parent = doc.get(n.parent);
    const isMask = parent?.type === 'group' && parent.clip && parent.children[parent.children.length - 1] === n.id;
    const inCompound = parent?.type === 'compound';
    if (n.type === 'path' && !inCompound) {
      if (stray && n.anchors.length === 1) out.push(n.id);
      else if (unpainted && !n.fill && !(n.stroke && n.strokeWidth > 0) && !isMask) out.push(n.id);
    } else if (n.type === 'path' && inCompound && stray && n.anchors.length === 1) out.push(n.id);
    else if (n.type === 'compound' && unpainted && !n.fill && !(n.stroke && n.strokeWidth > 0) && !isMask) out.push(n.id);
    else if (n.type === 'text' && emptyText && !(n.text || '').trim()) out.push(n.id);
    return n.type !== 'compound';
  });
  return out;
}

export async function cleanUpDialog(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const v = await app.dialogs.form({
    title: 'Clean Up',
    fields: [
      { type: 'heading', label: 'Delete' },
      { key: 'stray', label: 'Stray Points', type: 'checkbox', value: true },
      { key: 'unpainted', label: 'Unpainted Objects', type: 'checkbox', value: true },
      { key: 'emptyText', label: 'Empty Text Paths', type: 'checkbox', value: true },
    ],
  });
  if (!v) return false;
  const ids = cleanUpTargets(doc, v);
  if (!ids.length) {
    app.notify('There was nothing to clean up.');
    return false;
  }
  doc.transact('Clean Up', () => {
    for (const id of ids) if (doc.has(id)) doc.remove(id);
    // Groups and compounds left empty go too.
    let again = true;
    while (again) {
      again = false;
      doc.walk((n) => {
        if ((n.type === 'group' || n.type === 'compound') && !n.children.length) {
          doc.remove(n.id);
          again = true;
          return false;
        }
        return true;
      });
    }
  });
  editor.clearSelection();
  app.notify(`Deleted ${ids.length} object${ids.length === 1 ? '' : 's'}.`);
  return true;
}

