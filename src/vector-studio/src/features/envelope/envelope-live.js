/**
 * Envelopes as live artwork: the contents are collected as outlines (paths
 * and compound paths with their effects, type as its glyph outlines, the
 * generated artwork of nested live objects), images and gradient meshes,
 * measured in the envelope's frame, and mapped through the envelope's point
 * function. Rendering, hit testing, bounds, export and Expand all read the
 * result through the live framework.
 *
 * Paint follows the options: Distort Appearance bends the contents' effects
 * and scales their strokes with the local stretch (otherwise effects apply
 * after the distortion); linear gradient fills either keep a linear
 * gradient between their mapped end points or, with Distort Linear
 * Gradients, become bands of color bent with the shape; images draw as a
 * mesh-warped raster (see warped-image.js).
 *
 * While the envelope is edited normally its result names the envelope as
 * its source (a click picks the envelope) and its contents are hidden from
 * outlines and snapping; while its contents are edited each piece names the
 * content object it came from, so Direct Selection reaches their anchors.
 */
import { registerLive, virtualId, isVirtualId, liveDef, liveArtwork } from '../../model/live.js';
import { effectiveSubpaths, baseSubpaths, paintParts, isGeomEffectType, geomEffectsToken } from '../../model/geom-effects.js';
import { nodeBounds, gradientEnds, framePatch, transformPatches } from '../../model/geometry.js';
import { pathBounds, transformAnchors } from '../../model/bezier.js';
import { mapSubpaths } from '../../model/point-map.js';
import { sampleStops } from '../../model/gradients.js';
import { layoutText } from '../../model/text-layout.js';
import { multiply, invert, apply } from '../../lib/matrix.js';
import { meshBoundary, meshBounds } from '../mesh/mesh-model.js';
import { textShapes } from '../effects/text-effects.js';
import { findPattern, copiesIn, artBounds, patternView } from '../patterns/model.js';
import { KIND, isEnvelope, editingContents, normalizeOptions, frameOf, isIdentityFrame, envelopeMapping, toleranceFor, transformLive } from './envelope-model.js';
import { bakeWarpedImage, WARPED_IMAGE } from './warped-image.js';

const rasterOnly = (fx) => (fx || []).filter((e) => !isGeomEffectType(e.type));

/** Effects that apply after the distortion: geometry effects lose their original frame. */
const rideAlong = (fx) =>
  (fx || []).map((e) => {
    if (!isGeomEffectType(e.type) || !e.frame) return e;
    const { frame, ...rest } = e;
    return rest;
  });

/** Numeric Jacobian of f at (x, y): [dx/dx, dy/dx, dx/dy, dy/dy]. */
export function jacobian(f, x, y, h = 1e-3) {
  const a = f(x + h, y);
  const b = f(x - h, y);
  const c = f(x, y + h);
  const d = f(x, y - h);
  return [(a.x - b.x) / (2 * h), (a.y - b.y) / (2 * h), (c.x - d.x) / (2 * h), (c.y - d.y) / (2 * h)];
}

/** The affine map that matches f near (x, y). */
export function localAffine(f, x, y, h) {
  const J = jacobian(f, x, y, h);
  const p = f(x, y);
  return [J[0], J[1], J[2], J[3], p.x - (J[0] * x + J[2] * y), p.y - (J[1] * x + J[3] * y)];
}

const localScale = (f, x, y, h) => {
  const J = jacobian(f, x, y, h);
  return Math.sqrt(Math.abs(J[0] * J[3] - J[1] * J[2]));
};

const centerOf = (b) => (b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: 0, y: 0 });

function subsBounds(subs) {
  let b = null;
  for (const s of subs) {
    if (!s.anchors.length) continue;
    const r = pathBounds(s.anchors, s.closed);
    b = b ? union(b, r) : { ...r };
  }
  return b;
}

function union(a, b) {
  if (!a) return b && { ...b };
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const rectAnchors = (w, h, m) =>
  [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => {
    const p = apply(m, x, y);
    return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y };
  });

// ---- collecting the contents ----

/** Plain group settings a wrapper keeps from an object (its paint and geometry are generated). */
function wrapperOf(n) {
  return {
    type: 'group',
    name: n.name || '',
    clip: false,
    opacity: n.opacity ?? 1,
    blendMode: n.blendMode || 'normal',
    effects: rasterOnly(n.effects),
    ...(n.isolate ? { isolate: true } : {}),
    ...(n.knockout ? { knockout: true } : {}),
    hidden: false,
    locked: false,
  };
}

/**
 * The contents as a tree of items: { kind: 'group' | 'shape' | 'image' |
 * 'affine' | 'mesh', node, subs?, children?, src }. `src` is the id the
 * generated piece names as its source.
 */
function collect(view, n, ctx, src = null) {
  if (!n || n.hidden) return null;
  const s = ctx.contents ? src || n.id : ctx.envId;
  if (n.type === 'image') return { kind: 'image', node: n, src: s };
  if (n.type === 'mesh') return { kind: 'mesh', node: n, src: s };
  if (liveDef(n)) {
    // Symbol instances, blends, brush strokes, nested envelopes: their generated artwork.
    const art = liveArtwork(view, n);
    const children = art.items.map((it) => collect(art.vdoc, it, ctx, isVirtualId(it.id) ? s : null)).filter(Boolean);
    return children.length ? { kind: 'group', node: wrapperOf(n), children, src: s } : null;
  }
  switch (n.type) {
    case 'path':
    case 'compound': {
      const subs = (ctx.opts.distortAppearance ? effectiveSubpaths(view, n) : baseSubpaths(view, n)).filter((p) => p.anchors.length);
      if (!subs.length) return null;
      const parts = ctx.opts.distortAppearance ? paintParts(n, subs) : null;
      if (parts) {
        // Outlines that paint differently (Scribble hatching) become pieces of their own.
        const children = parts.map((p) => ({ kind: 'shape', node: { ...n, ...p.style, opacity: 1, blendMode: 'normal', effects: [] }, subs: p.subpaths.map(({ paint, ...rest }) => rest), src: s }));
        return { kind: 'group', node: wrapperOf(n), children, src: s };
      }
      return { kind: 'shape', node: n, subs, src: s };
    }
    case 'group': {
      const children = n.children.map((c) => collect(view, view.get(c), ctx)).filter(Boolean);
      if (!children.length) return null;
      // A clipping group whose mask produced nothing just groups.
      const clip = Boolean(n.clip) && Boolean(view.get(n.children[n.children.length - 1])) && !view.get(n.children[n.children.length - 1]).hidden;
      return { kind: 'group', node: { ...n, clip }, children, src: s };
    }
    case 'text': {
      layoutText(n);
      const runs = textShapes(n);
      if (!runs) return { kind: 'affine', node: n, src: s };
      const children = runs.map((run) => ({ kind: 'shape', node: { ...run.style, type: 'compound', name: '', fillRule: run.fillRule || 'nonzero' }, subs: run.subpaths, src: s }));
      return { kind: 'group', node: wrapperOf(n), children, src: s };
    }
    default:
      return null;
  }
}

/** Bounds of an item in frame space (inv maps document to frame, or null). */
function itemBounds(view, it, inv) {
  const tf = (anchors) => (inv ? transformAnchors(anchors, inv) : anchors);
  switch (it.kind) {
    case 'shape':
      return subsBounds(it.subs.map((p) => ({ anchors: tf(p.anchors), closed: p.closed })));
    case 'image':
      return pathBounds(tf(rectAnchors(it.node.width, it.node.height, it.node.transform)), true);
    case 'mesh':
      return pathBounds(tf(meshBoundary(it.node)), true);
    case 'affine': {
      const b = layoutText(it.node).bounds;
      const m = multiply(it.node.transform, [1, 0, 0, 1, b.x, b.y]);
      return pathBounds(tf(rectAnchors(b.w, b.h, m)), true);
    }
    case 'group': {
      if (it.node.clip) return itemBounds(view, it.children[it.children.length - 1], inv);
      let b = null;
      for (const c of it.children) b = union(b, itemBounds(view, c, inv));
      return b;
    }
    default:
      return null;
  }
}

// ---- mapping ----

function mapPoint(f, p, h) {
  const q = f(p.x, p.y);
  const J = jacobian(f, p.x, p.y, h);
  const out = { ...p, x: q.x, y: q.y };
  for (const d of ['l', 'r', 'u', 'd']) {
    const dx = p[`${d}x`] - p.x;
    const dy = p[`${d}y`] - p.y;
    out[`${d}x`] = q.x + J[0] * dx + J[2] * dy;
    out[`${d}y`] = q.y + J[1] * dx + J[3] * dy;
  }
  return out;
}

/**
 * A gradient paint carried through the mapping: its end points follow it.
 * Other paints (solid colors, patterns that are not distorted) stay as
 * they are.
 */
function mapPaint(paint, box, ctx) {
  if (!paint || (paint.type !== 'linear' && paint.type !== 'radial')) return paint;
  const p = paint.x1 === undefined ? (box ? gradientEnds(paint, box) : null) : paint;
  if (!p) return paint;
  const a = ctx.f(p.x1, p.y1);
  const b = ctx.f(p.x2, p.y2);
  return { ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function reg(ctx, v, src) {
  v.id = virtualId(ctx.envId);
  v.source = src;
  if (v.hidden === undefined) v.hidden = false;
  if (v.locked === undefined) v.locked = false;
  ctx.extra.set(v.id, v);
  return v.id;
}

/** A path for one outline or a compound for several, styled like `base`. */
function shapeNode(ctx, base, subs, src, type) {
  if (type === 'path' && subs.length === 1) {
    return reg(ctx, { ...base, type: 'path', anchors: subs[0].anchors, closed: subs[0].closed, children: undefined, fillRule: undefined }, src);
  }
  const children = subs.map((p) => reg(ctx, { type: 'path', name: '', anchors: p.anchors, closed: p.closed, fill: null, stroke: null }, src));
  return reg(ctx, { ...base, type: 'compound', children, fillRule: base.fillRule || 'nonzero', anchors: undefined, closed: undefined }, src);
}

function emitShape(it, ctx) {
  const n = it.node;
  const mapped = mapSubpaths(it.subs, ctx.f, { tolerance: ctx.tol, step: ctx.h });
  const box = subsBounds(it.subs);
  const c = centerOf(box);
  const k = ctx.opts.distortAppearance ? localScale(ctx.f, c.x, c.y, ctx.h) : 1;
  const style = {
    fill: mapPaint(n.fill, box, ctx),
    stroke: mapPaint(n.stroke, box, ctx),
    effects: ctx.opts.distortAppearance ? rasterOnly(n.effects) : rideAlong(n.effects),
  };
  if (k > 0 && Math.abs(k - 1) > 1e-9) {
    if (n.strokeWidth) style.strokeWidth = n.strokeWidth * k;
    if (n.dash?.length) style.dash = n.dash.map((v) => v * k);
    if (n.dashOffset) style.dashOffset = n.dashOffset * k;
  }
  const base = { ...n, ...style, shape: undefined, live: undefined, frameAngle: undefined };
  if (ctx.opts.distortGradients && n.fill?.type === 'linear' && n.fill.stops?.length) {
    const g = gradientBands(it, mapped, base, box, ctx);
    if (g) return g;
  }
  if (ctx.opts.distortPatterns && n.fill?.type === 'pattern') {
    const g = patternPieces(it, mapped, base, box, ctx);
    if (g) return g;
  }
  return shapeNode(ctx, base, mapped, it.src, n.type === 'path' ? 'path' : 'compound');
}

/**
 * A linear gradient fill bent with the shape: bands of color across the
 * gradient, mapped like the artwork and clipped by the mapped outline,
 * under the object's stroke.
 */
function gradientBands(it, mapped, base, box, ctx) {
  const n = it.node;
  const p = n.fill.x1 === undefined ? gradientEnds(n.fill, box) : n.fill;
  const ax = p.x2 - p.x1;
  const ay = p.y2 - p.y1;
  const len = Math.hypot(ax, ay);
  if (len < 1e-9) return null;
  const dx = ax / len;
  const dy = ay / len;
  const nx = -dy;
  const ny = dx;
  // Extent of the outline (its control polygon) along and across the gradient.
  let t0 = Infinity;
  let t1 = -Infinity;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (const sp of it.subs) {
    for (const a of sp.anchors) {
      for (const [x, y] of [[a.x, a.y], [a.ix, a.iy], [a.ox, a.oy]]) {
        const t = ((x - p.x1) * dx + (y - p.y1) * dy) / len;
        const s = (x - p.x1) * nx + (y - p.y1) * ny;
        t0 = Math.min(t0, t);
        t1 = Math.max(t1, t);
        s0 = Math.min(s0, s);
        s1 = Math.max(s1, s);
      }
    }
  }
  const pad = len * 0.001 + 0.5;
  s0 -= pad;
  s1 += pad;
  const perUnit = 16 + ctx.opts.fidelity * 0.8;
  const count = Math.max(2, Math.min(256, Math.ceil((t1 - t0) * perUnit)));
  const step = (t1 - t0) / count;
  const at = (t, s) => ({ x: p.x1 + dx * len * t + nx * s, y: p.y1 + dy * len * t + ny * s });
  const opacity = n.fill.opacity ?? 1;
  const bands = [];
  for (let k = 0; k < count; k++) {
    const ta = t0 + step * k;
    let tb = ta + step;
    const col = sampleStops(p.stops, Math.max(0, Math.min(1, (ta + tb) / 2)));
    const next = k < count - 1 ? sampleStops(p.stops, Math.max(0, Math.min(1, tb + step / 2))) : null;
    // Opaque neighbors overlap a little so no seam shows between bands.
    if (next && (next.opacity ?? 1) * opacity >= 0.999) tb += step * 0.5;
    const quad = [at(ta, s0), at(tb, s0), at(tb, s1), at(ta, s1)].map((q) => ({ x: q.x, y: q.y, ix: q.x, iy: q.y, ox: q.x, oy: q.y }));
    const band = mapSubpaths([{ anchors: quad, closed: true }], ctx.f, { tolerance: ctx.tol, step: ctx.h })[0];
    const a = (col.opacity ?? 1) * opacity;
    const fill = { type: 'solid', color: col.color, ...(a < 0.999 ? { opacity: a } : {}) };
    bands.push(reg(ctx, { type: 'path', name: '', anchors: band.anchors, closed: true, fill, stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [] }, it.src));
  }
  return clippedFill(it, mapped, base, bands, ctx);
}

/** A fill made of generated pieces: clipped by the mapped outline, under the object's stroke. */
function clippedFill(it, mapped, base, pieces, ctx) {
  const n = it.node;
  const mask = shapeNode(ctx, { name: '', fill: null, stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [], fillRule: n.fillRule || 'nonzero' }, mapped, it.src, 'compound');
  const clipGroup = reg(ctx, { type: 'group', name: '', clip: true, children: [...pieces, mask], opacity: 1, blendMode: 'normal', effects: [] }, it.src);
  const kids = [clipGroup];
  if (base.stroke && base.strokeWidth > 0) kids.push(shapeNode(ctx, { ...base, fill: null, effects: [], opacity: 1, blendMode: 'normal' }, mapped, it.src, n.type === 'path' ? 'path' : 'compound'));
  return reg(ctx, { ...wrapperOf(n), effects: base.effects.filter((e) => !isGeomEffectType(e.type)), children: kids }, it.src);
}

const MAX_PATTERN_COPIES = 400;

/**
 * A pattern fill bent with the shape: the tile copies covering the object
 * become artwork of their own, mapped like everything else and clipped by
 * the mapped outline. Returns null when the pattern is unknown or would
 * need too many copies (the pattern then stays as it is).
 */
function patternPieces(it, mapped, base, box, ctx) {
  const n = it.node;
  const def = findPattern(ctx.view, n.fill.id);
  // Pattern art may itself use patterns: a couple of levels is plenty.
  if (!def || !box || (ctx.patternDepth || 0) > 2) return null;
  const T = n.fill.transform || [1, 0, 0, 1, 0, 0];
  const inv = invert(T);
  const r = pathBounds(rectAnchors(box.w, box.h, multiply(inv, [1, 0, 0, 1, box.x, box.y])), true);
  const copies = copiesIn(def, r, artBounds(def, ctx.view), MAX_PATTERN_COPIES);
  if (!copies.length || copies.length > MAX_PATTERN_COPIES) return null;
  const pv = patternView(ctx.view, def);
  const pieces = [];
  for (const { dx, dy } of copies) {
    const m = multiply(T, [1, 0, 0, 1, dx, dy]);
    for (const rootId of pv.roots) {
      const patches = transformPatches(pv, pv.get(rootId), m);
      const placed = new Map();
      for (const [id, patch] of patches) placed.set(id, { ...pv.get(id), ...patch });
      const tv = { get: (id) => placed.get(id) || pv.get(id), has: (id) => placed.has(id) || pv.has(id), assets: pv.assets, root: pv.root, artboards: [] };
      const item = collect(tv, tv.get(rootId), { ...ctx, contents: false, envId: ctx.envId }, it.src);
      ctx.patternDepth = (ctx.patternDepth || 0) + 1;
      const id = item && emit({ ...item, src: it.src }, ctx);
      ctx.patternDepth -= 1;
      if (id) pieces.push(id);
    }
  }
  return pieces.length ? clippedFill(it, mapped, base, pieces, ctx) : null;
}

/** Every outline under an item, mapped (for a clipping mask made of several pieces). */
function maskOutlines(it, ctx, out = []) {
  if (it.kind === 'shape') out.push(...mapSubpaths(it.subs, ctx.f, { tolerance: ctx.tol, step: ctx.h }));
  else if (it.kind === 'group') for (const c of it.children) maskOutlines(c, ctx, out);
  return out;
}

function emit(it, ctx) {
  switch (it.kind) {
    case 'shape':
      return emitShape(it, ctx);
    case 'group': {
      const n = it.node;
      let kids;
      if (n.clip && it.children.length > 1) {
        kids = it.children.slice(0, -1).map((c) => emit(c, ctx)).filter(Boolean);
        const last = it.children[it.children.length - 1];
        const mask = last.kind === 'shape' ? emitShape(last, ctx) : shapeNode(ctx, { name: '', fill: null, stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [] }, maskOutlines(last, ctx), last.src, 'compound');
        kids.push(mask);
      } else kids = it.children.map((c) => emit(c, ctx)).filter(Boolean);
      if (!kids.length) return null;
      const { live, blend, symbol, transform, frameAngle, ...plain } = n;
      return reg(ctx, { ...plain, type: 'group', clip: Boolean(n.clip && it.children.length > 1), children: kids }, it.src);
    }
    case 'image': {
      const n = it.node;
      const density = Math.round(6 + (ctx.opts.fidelity / 100) * 26);
      const big = Math.max(n.width, n.height) || 1;
      const nu = Math.max(2, Math.round((density * n.width) / big));
      const nv = Math.max(2, Math.round((density * n.height) / big));
      const grid = [];
      for (let b = 0; b <= nv; b++) {
        for (let a = 0; a <= nu; a++) {
          const d = apply(n.transform, (a / nu) * n.width, (b / nv) * n.height);
          const q = ctx.f(d.x, d.y);
          grid.push(q.x, q.y);
        }
      }
      const outline = mapSubpaths([{ anchors: rectAnchors(n.width, n.height, n.transform), closed: true }], ctx.f, { tolerance: ctx.tol, step: ctx.h })[0].anchors;
      return reg(
        ctx,
        {
          type: WARPED_IMAGE,
          live: { kind: WARPED_IMAGE },
          name: n.name || '',
          asset: n.asset,
          width: n.width,
          height: n.height,
          nu,
          nv,
          grid,
          outline,
          preserve: ctx.opts.preserve,
          antialias: ctx.opts.antialias !== false,
          opacity: n.opacity ?? 1,
          blendMode: n.blendMode || 'normal',
          effects: rasterOnly(n.effects),
        },
        it.src,
      );
    }
    case 'affine': {
      // Type whose outline fonts are still loading: the closest straight copy until they arrive.
      const n = it.node;
      const c = centerOf(nodeBounds(null, n));
      const A = localAffine(ctx.f, c.x, c.y, ctx.h);
      return reg(ctx, { ...n, transform: multiply(A, n.transform), fill: mapPaint(n.fill, null, ctx), stroke: mapPaint(n.stroke, null, ctx), effects: rasterOnly(n.effects) }, it.src);
    }
    case 'mesh': {
      const n = it.node;
      return reg(ctx, { ...n, points: n.points.map((p) => mapPoint(ctx.f, p, ctx.h)), effects: rasterOnly(n.effects) }, it.src);
    }
    default:
      return null;
  }
}

// ---- the live kinds ----

/** The contents as items and their source rectangle in the envelope's frame. */
function collectContents(doc, env, ctx) {
  const frame = frameOf(env);
  const inv = isIdentityFrame(frame) ? null : invert(frame);
  const items = env.children.map((c) => collect(doc, doc.get(c), ctx)).filter(Boolean);
  let r = null;
  for (const it of items) r = union(r, itemBounds(doc, it, inv));
  // A flat source (a single horizontal line) still spans the envelope.
  if (r && (r.w < 1e-6 || r.h < 1e-6)) {
    const pad = Math.max(r.w, r.h, 1) * 0.005;
    r = { x: r.x - (r.w < 1e-6 ? pad : 0), y: r.y - (r.h < 1e-6 ? pad : 0), w: Math.max(r.w, 2 * pad), h: Math.max(r.h, 2 * pad) };
  }
  return { items, r };
}

/** The source rectangle of an envelope's contents, measured directly (no artwork generated). */
export function contentRect(doc, env) {
  const ctx = { envId: env.id, contents: false, opts: normalizeOptions(env.live.options), extra: new Map() };
  return collectContents(doc, env, ctx).r;
}

const sourceRects = new WeakMap();

/** Generate an envelope's distorted artwork. */
export function generateEnvelope(doc, env) {
  const live = env.live;
  const opts = normalizeOptions(live.options);
  const ctx = { envId: env.id, contents: live.editing === 'contents', opts, extra: new Map() };
  const { items, r } = collectContents(doc, env, ctx);
  const f = envelopeMapping(live, r);
  if (!f) return { items: [], extra: ctx.extra };
  const out = live.mode === 'mesh' && live.mesh ? meshBounds(live.mesh) : r;
  const diag = Math.max(Math.hypot(r.w, r.h), out ? Math.hypot(out.w, out.h) : 0);
  ctx.f = f;
  ctx.view = doc;
  ctx.tol = live.mode === 'mesh' ? toleranceFor(opts.fidelity, diag) : toleranceFor(opts.fidelity, Math.hypot(r.w, r.h));
  ctx.h = Math.max(1e-4, diag * 1e-6);
  const ids = items.map((it) => emit(it, ctx)).filter(Boolean);
  sourceRects.set(ctx.extra, r);
  return { items: ids, extra: ctx.extra };
}

/** The source rectangle (frame space) of an envelope's contents, or null. */
export function sourceRect(doc, env) {
  const art = liveArtwork(doc, env);
  return sourceRects.get(art.extra) || null;
}

/** Generated artwork for Object > Expand: warped images become images of their own. */
function expandArtwork(doc, env) {
  const g = generateEnvelope(doc, env);
  for (const [id, v] of [...g.extra]) {
    if (v.type !== WARPED_IMAGE) continue;
    const baked = bakeWarpedImage(doc, v);
    for (const n of baked.nodes) g.extra.set(n.id, n);
    g.extra.set(id, { ...baked.root, id });
  }
  return g;
}

const COMMON = {
  label: '<Envelope>',
  // Type outlines (and engine-computed effects) arrive later: regenerate then.
  // Distorted pattern fills follow edits of their pattern definitions too.
  deps: (doc, node) => [geomEffectsToken(), node.live?.options?.distortPatterns ? doc.root : null],
  generate: generateEnvelope,
  expandArtwork,
};

registerLive(KIND, {
  ...COMMON,
  test: (n) => isEnvelope(n) && !editingContents(n),
  // The contents do not draw where they are stored: outlines, snapping and
  // marquee selection treat the envelope as a whole.
  ownSpace: true,
  transform: (doc, node, m) => ({ patch: { live: transformLive(node.live, m), ...framePatch(node, m) }, matrix: m }),
});

registerLive('envelopeContents', {
  ...COMMON,
  test: editingContents,
  selectContents: true,
  transformParams: (node, m) => ({ live: transformLive(node.live, m) }),
});
