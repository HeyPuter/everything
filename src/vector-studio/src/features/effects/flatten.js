/**
 * Object > Flatten Transparency: replace transparent artwork (opacity,
 * blending modes, see-through colors, raster effects) by opaque objects
 * that look the same on white paper.
 *
 * The selection's shapes (fills, and strokes outlined into shapes) are
 * divided into faces where they overlap. A face covered only by solid
 * colors gets its exact composited color, worked out through the object
 * tree with the same opacity, isolation and blending-mode math the
 * renderer uses, and faces of one color are merged into one shape. Faces
 * that solid-color math cannot reproduce (gradients, images, type, raster
 * effects, clipping) are filled from a raster image of the artwork clipped
 * to those faces. The Raster/Vector balance trades the two: at 0 the whole
 * selection becomes one image; higher values keep more faces as vectors
 * before falling back to an image for very complex overlaps.
 *
 * Flattener preset options: line art/text and gradient resolutions (the
 * image uses the gradient one when only gradients need it), text converted
 * to outlines first (so solid type stays vector), strokes kept as strokes
 * where nothing is painted over them, and complex regions clipped to their
 * exact outlines or to their bounding boxes.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { OP, runGeom } from '../geometry/engine/index.js';
import { strokeParams } from '../geometry/path-ops.js';
import { liveDef } from '../../model/live.js';
import { geomEffectsOf, effectiveSubpaths, paintParts } from '../../model/geom-effects.js';
import { rasterEffects } from '../../render/effects.js';
import { visualBounds, selectionBounds, inflate } from '../../model/geometry.js';
import { createPath, createCompound, createGroup, createImage } from '../../model/nodes.js';
import { sliderField, checkField, selectRow } from './dialog-kit.js';
import { RESOLUTIONS, renderToImage } from './raster.js';

// ---- color compositing (straight colors in 0..1) ----

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c) {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n || 1));
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l || 1));
  return out;
}
const setLum = (c, l) => clipColor(c.map((v) => v + (l - lum(c))));
const sat = (c) => Math.max(...c) - Math.min(...c);
function setSat(c, s) {
  const max = Math.max(...c);
  const min = Math.min(...c);
  if (max === min) return [0, 0, 0];
  return c.map((v) => ((v - min) * s) / (max - min));
}

const SEPARABLE = {
  normal: (b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => SEPARABLE.hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  colorDodge: (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  colorBurn: (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  hardLight: (b, s) => (s <= 0.5 ? b * 2 * s : SEPARABLE.screen(b, 2 * s - 1)),
  softLight: (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};
const NONSEPARABLE = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

/** The blend function B(Cb, Cs) of a blending mode, on rgb arrays. */
export function blendColors(mode, b, s) {
  if (NONSEPARABLE[mode]) return NONSEPARABLE[mode](b, s);
  const f = SEPARABLE[mode] || SEPARABLE.normal;
  return [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
}

/**
 * Composite a straight color `src` ({ c: rgb, a }) onto `dst` with a
 * blending mode (W3C compositing: the blend applies where the backdrop is
 * opaque). Returns a straight color.
 */
export function compositeOver(dst, src, mode = 'normal') {
  const ab = dst.a;
  const as = src.a;
  if (as <= 0) return dst;
  const mixed = ab > 0 ? blendColors(mode, dst.c, src.c) : src.c;
  const cs = src.c.map((v, i) => (1 - ab) * v + ab * mixed[i]);
  const ao = as + ab * (1 - as);
  if (ao <= 0) return { c: [0, 0, 0], a: 0 };
  return { c: cs.map((v, i) => (as * v + (1 - as) * ab * dst.c[i]) / ao), a: ao };
}

const CLEAR = Object.freeze({ c: [0, 0, 0], a: 0 });
const WHITE = Object.freeze({ c: [1, 1, 1], a: 1 });

// ---- collecting the artwork ----

const isSolid = (p) => !p || p.type === 'solid';
const rectSub = (r) => ({
  closed: true,
  anchors: [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y })),
});

/**
 * The selection as a tree for compositing, plus the engine shapes:
 *   tree: { kind: 'group', opacity, mode, isolated, children } |
 *         { kind: 'shape', index, color, alpha, mode }
 *   shapes: engine shapes in paint order; complex[i] marks a shape that
 *   needs the raster image (its area is its visual bounds or outline).
 */
export function collectArtwork(doc, ids, strokeOutlines, { textOutlines = null, liveStrokes = null } = {}) {
  const shapes = [];
  const complex = [];
  // Why a shape needs the image: 'gradient' (only a gradient) or 'other'.
  const reasons = [];
  let transparent = false;
  const addShape = (subpaths, { evenodd = false, hard = false, reason = 'other' } = {}) => {
    shapes.push({ subpaths, filled: true, evenodd });
    complex.push(hard);
    reasons.push(hard ? reason : null);
    return shapes.length - 1;
  };
  const visit = (n) => {
    if (!n || n.hidden) return null;
    const opacity = n.opacity ?? 1;
    const mode = n.blendMode || 'normal';
    if (opacity < 1 || mode !== 'normal') transparent = true;
    // Artwork solid-color math cannot reproduce goes to the raster image, over its visual bounds.
    const hardBox = () => {
      transparent = transparent || Boolean(rasterEffects(n));
      const vb = visualBounds(doc, n);
      return vb ? { kind: 'shape', index: addShape([rectSub(vb)], { hard: true }), hard: true } : null;
    };
    if (rasterEffects(n) || n.knockout || n.opacityMask) {
      transparent = true;
      return hardBox();
    }
    if (n.type === 'group' && !liveDef(n) && !n.clip) {
      const children = n.children.map((c) => visit(doc.get(c))).filter(Boolean);
      return { kind: 'group', opacity, mode, isolated: opacity < 1 || mode !== 'normal' || Boolean(n.isolate), children };
    }
    if ((n.type === 'path' || n.type === 'compound') && !liveDef(n)) {
      let subs = geomEffectsOf(n) ? effectiveSubpaths(doc, n) : null;
      if (subs && paintParts(n, subs)) return hardBox();
      if (!isSolid(n.fill) || !isSolid(n.stroke)) {
        if ((n.fill?.stops || n.stroke?.stops || []).some((s) => (s.opacity ?? 1) < 1)) transparent = true;
        const vb = visualBounds(doc, n);
        const gradientOnly = [n.fill, n.stroke].every((p) => !p || p.type === 'solid' || p.type === 'linear' || p.type === 'radial');
        return vb ? { kind: 'shape', index: addShape([rectSub(vb)], { hard: true, reason: gradientOnly ? 'gradient' : 'other' }), hard: true } : null;
      }
      subs ||= n.type === 'path' ? [{ anchors: n.anchors, closed: n.closed }] : n.children.map((c) => doc.get(c)).filter((c) => c?.anchors).map((c) => ({ anchors: c.anchors, closed: c.closed }));
      const parts = [];
      if (n.fill && subs.length) {
        const a = (n.fill.opacity ?? 1) * opacity;
        if ((n.fill.opacity ?? 1) < 1) transparent = true;
        parts.push({ kind: 'shape', index: addShape(subs, { evenodd: n.type === 'compound' && n.fillRule === 'evenodd' }), color: hexToRgb(n.fill.color), alpha: a, mode });
      }
      if (n.stroke && n.strokeWidth > 0 && !liveStrokes?.has(n.id)) {
        const outline = strokeOutlines.get(n.id);
        if (outline?.length) {
          if ((n.stroke.opacity ?? 1) < 1) transparent = true;
          parts.push({ kind: 'shape', index: addShape(outline), color: hexToRgb(n.stroke.color), alpha: (n.stroke.opacity ?? 1) * opacity, mode });
        }
      }
      return parts.length ? { kind: 'group', opacity: 1, mode: 'normal', isolated: false, children: parts } : null;
    }
    // Type converted to outlines: solid-colored glyph runs composite like shapes.
    if (n.type === 'text' && textOutlines?.has(n.id)) {
      const runs = textOutlines.get(n.id);
      if (runs.every((r) => !r.stroke && isSolid(r.fill))) {
        const parts = runs.filter((r) => r.fill && r.subpaths.length).map((r) => {
          if ((r.fill.opacity ?? 1) < 1) transparent = true;
          return { kind: 'shape', index: addShape(r.subpaths), color: hexToRgb(r.fill.color), alpha: (r.fill.opacity ?? 1) * opacity, mode };
        });
        return parts.length ? { kind: 'group', opacity: 1, mode: 'normal', isolated: false, children: parts } : null;
      }
    }
    // Type, images, clipping groups and live artwork.
    return hardBox();
  };
  const ordered = doc.sortByPaintOrder(ids);
  const tree = { kind: 'group', opacity: 1, mode: 'normal', isolated: false, children: ordered.map((id) => visit(doc.get(id))).filter(Boolean) };
  return { tree, shapes, complex, reasons, transparent };
}

/** The composited color of a face covered by `cover` (shape indices), over white. */
export function faceColor(tree, cover) {
  const covered = new Set(cover);
  const comp = (node, below) => {
    if (node.kind === 'shape') {
      if (!covered.has(node.index)) return below;
      return compositeOver(below, { c: node.color, a: node.alpha }, node.mode);
    }
    if (!node.isolated) {
      let acc = below;
      for (const c of node.children) acc = comp(c, acc);
      return acc;
    }
    let inner = CLEAR;
    for (const c of node.children) inner = comp(c, inner);
    return compositeOver(below, { c: inner.c, a: inner.a * node.opacity }, node.mode);
  };
  return comp(tree, WHITE);
}

/** Faces a balance keeps as vectors before turning everything into one image. */
export function maxVectorFaces(balance) {
  if (balance >= 100) return Infinity;
  if (balance <= 0) return 0;
  return Math.round(20 * 2 ** (balance / 12.5));
}

const subpathsOfRecords = (recs) => recs.flatMap((r) => r.subpaths).filter((s) => s.anchors.length > 1);

/**
 * Flatten the editor's selection. Options: { balance 0-100, resolution
 * (line art and text ppi), gradientResolution, antialias, textOutlines
 * (Map text id -> outline runs, when type converts to outlines),
 * strokesToOutlines (default true), clipComplex (default true) }. `deps`
 * replaces the engine and the rasterizer in tests.
 * Returns the id of the flattened group, or null.
 */
export async function flattenSelection(editor, opts, deps = {}) {
  const run = deps.run || ((op, shapes, params = []) => runGeom(op, shapes, params, { tol: 0.02 }));
  const render = deps.render || renderToImage;
  const doc = editor.doc;
  const ids = editor.topSelection().filter((id) => doc.get(id) && doc.get(id).type !== 'layer');
  if (!ids.length) return { error: 'Select the artwork to flatten.' };
  const snap = new Map();
  for (const id of ids) for (const d of [id, ...doc.descendants(id).map((n) => n.id)]) snap.set(d, doc.get(d));

  // Strokes become shapes first so they divide and composite like fills.
  const strokeOutlines = new Map();
  const leaves = [];
  for (const id of ids) {
    for (const n of [doc.get(id), ...doc.descendants(id)]) {
      if ((n?.type === 'path' || n?.type === 'compound') && n.stroke?.type === 'solid' && n.strokeWidth > 0 && !n.hidden) leaves.push(n);
    }
  }
  const liveStrokes = opts.strokesToOutlines === false ? keepableStrokes(doc, ids, leaves) : new Set();
  for (const n of leaves) {
    if (liveStrokes.has(n.id)) continue;
    const subs = geomEffectsOf(n) ? effectiveSubpaths(doc, n) : n.type === 'path' ? [{ anchors: n.anchors, closed: n.closed }] : n.children.map((c) => doc.get(c)).filter((c) => c?.anchors).map((c) => ({ anchors: c.anchors, closed: c.closed }));
    const recs = await run(OP.STROKE, [{ subpaths: subs, filled: Boolean(n.fill), evenodd: n.fillRule === 'evenodd' }], strokeParams(n));
    strokeOutlines.set(n.id, subpathsOfRecords(recs));
  }
  const art = collectArtwork(doc, ids, strokeOutlines, { textOutlines: opts.textOutlines || null, liveStrokes });
  if (!art.transparent) return { error: 'The selection has no transparency to flatten.' };
  if (!art.shapes.length) return { error: 'Nothing in the selection can be flattened.' };

  const balance = Math.max(0, Math.min(100, opts.balance ?? 75));
  let records = balance > 0 ? await run(OP.DIVIDE, art.shapes) : [];
  const vectorFaces = [];
  const rasterFaces = [];
  for (const rec of records) {
    if (!rec.subpaths.length) continue;
    if (rec.cover.some((i) => art.complex[i])) rasterFaces.push(rec);
    else vectorFaces.push(rec);
  }
  let allRaster = balance <= 0 || vectorFaces.length > maxVectorFaces(balance);
  if (allRaster) records = [];

  // Vector faces, merged by color.
  const byColor = new Map();
  if (!allRaster) {
    for (const rec of vectorFaces) {
      const c = faceColor(art.tree, rec.cover);
      const hex = toHex(c.c);
      if (!byColor.has(hex)) byColor.set(hex, []);
      byColor.get(hex).push(rec);
    }
  }
  const merged = [];
  for (const [hex, recs] of byColor) {
    const out = recs.length > 1 ? await run(OP.UNITE, recs.map((r) => ({ subpaths: r.subpaths, filled: true }))) : recs;
    merged.push({ hex, subpaths: subpathsOfRecords(out) });
  }

  // Raster faces come from one image of the artwork, clipped to them.
  let image = null;
  let clip = null;
  if (allRaster || rasterFaces.length) {
    const vb = selectionBounds(doc, ids, true);
    if (vb && vb.w > 0 && vb.h > 0) {
      const rect = inflate(vb, 1);
      // Gradients alone can use their own (usually lower) resolution.
      const gradientsOnly = !allRaster && rasterFaces.every((rec) => rec.cover.every((i) => !art.complex[i] || art.reasons[i] === 'gradient'));
      const ppi = (gradientsOnly && opts.gradientResolution) || opts.resolution || 300;
      image = { rect, ...(await render(doc, doc.sortByPaintOrder(ids), rect, { ppi, background: 'white', antialias: opts.antialias !== false })) };
      const clipFaces = allRaster ? null : rasterFaces;
      if (clipFaces && opts.clipComplex === false) clip = clipFaces.map((rec) => rectSub(recordBounds(rec))).filter(Boolean);
      else if (clipFaces) clip = subpathsOfRecords(clipFaces);
      else {
        // Everything is raster: keep the image to the artwork's own outline.
        const all = await run(OP.UNITE, art.shapes.map((s) => ({ ...s, evenodd: s.evenodd })));
        clip = subpathsOfRecords(all);
      }
    }
  }
  for (const [id, n] of snap) {
    if (doc.get(id) !== n) return { error: 'Flatten Transparency was canceled because the artwork changed.' };
  }

  let gid = null;
  doc.transact('Flatten Transparency', () => {
    const ordered = doc.sortByPaintOrder(ids);
    const top = doc.get(ordered[ordered.length - 1]);
    const parent = doc.get(top.parent);
    const index = parent.children.indexOf(top.id) + 1;
    const g = createGroup([], { name: '' });
    gid = doc.insert(g, parent.id, index).id;
    for (const m of merged) {
      if (!m.subpaths.length) continue;
      const style = { fill: { type: 'solid', color: m.hex }, stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [] };
      if (m.subpaths.length === 1) doc.insert(createPath(m.subpaths[0].anchors, true, style), gid);
      else {
        const comp = createCompound([], style, { fillRule: 'nonzero' });
        const kids = m.subpaths.map((s) => ({ ...createPath(s.anchors, s.closed, { fill: null, stroke: null }), parent: comp.id }));
        comp.children = kids.map((k) => k.id);
        doc.insert(comp, gid, Infinity, kids);
      }
    }
    if (image && clip?.length) {
      const assetId = uid('img');
      doc.assets.set(assetId, { mime: 'image/png', data: image.data, name: 'Flattened artwork' });
      const r = image.rect;
      const img = createImage(assetId, image.width, image.height, [r.w / image.width, 0, 0, r.h / image.height, r.x, r.y]);
      const cg = createGroup([], { clip: true });
      doc.insert(cg, gid);
      doc.insert(img, cg.id);
      const comp = createCompound([], { fill: null, stroke: null }, { fillRule: 'nonzero' });
      const kids = clip.map((s) => ({ ...createPath(s.anchors, true, { fill: null, stroke: null }), parent: comp.id }));
      comp.children = kids.map((k) => k.id);
      doc.insert(comp, cg.id, Infinity, kids);
    }
    // Strokes kept as strokes go on top, in their paint order (nothing was painted over them).
    for (const n of leaves) {
      if (!liveStrokes.has(n.id)) continue;
      const style = { fill: null, stroke: { ...n.stroke }, strokeWidth: n.strokeWidth, strokeCap: n.strokeCap, strokeJoin: n.strokeJoin, miterLimit: n.miterLimit, dash: n.dash, dashOffset: n.dashOffset, opacity: 1, blendMode: 'normal', effects: [] };
      doc.insert(createPath(n.anchors.map((a) => ({ ...a })), n.closed, style), gid);
    }
    for (const id of ordered) doc.remove(id);
  });
  editor.select([gid]);
  return { id: gid, vector: merged.length + liveStrokes.size, raster: Boolean(image) };
}

function recordBounds(rec) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of rec.subpaths) {
    for (const a of s.anchors) {
      for (const [x, y] of [[a.x, a.y], [a.ix ?? a.x, a.iy ?? a.y], [a.ox ?? a.x, a.oy ?? a.y]]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Strokes that can stay strokes: plain centered strokes of opaque paths in
 * opaque, normal-blending ancestry, with nothing selected painted over them.
 */
function keepableStrokes(doc, ids, leaves) {
  const keep = new Set();
  const order = doc.paintOrder();
  const items = [];
  for (const id of ids) for (const n of [doc.get(id), ...doc.descendants(id)]) if (n && !n.hidden && n.type !== 'group' && n.type !== 'layer' && !(n.parent && doc.get(n.parent)?.type === 'compound')) items.push(n);
  for (const n of leaves) {
    if (n.type !== 'path' || (n.strokeAlign && n.strokeAlign !== 'center') || n.arrowStart || n.arrowEnd || n.widthProfile || liveDef(n) || geomEffectsOf(n) || rasterEffects(n)) continue;
    if ((n.stroke.opacity ?? 1) < 1 || (n.opacity ?? 1) < 1 || (n.blendMode && n.blendMode !== 'normal')) continue;
    if (doc.ancestors(n.id).some((a) => (a.opacity ?? 1) < 1 || (a.blendMode && a.blendMode !== 'normal') || a.clip || a.knockout || rasterEffects(a))) continue;
    const vb = visualBounds(doc, n);
    const o = order.get(n.id) ?? 0;
    const covered = items.some((m) => m !== n && (order.get(m.id) ?? 0) > o && rectsOverlap(visualBounds(doc, m), vb));
    if (!covered) keep.add(n.id);
  }
  return keep;
}

const rectsOverlap = (a, b) => Boolean(a && b) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Object > Flatten Transparency dialog. */
export async function flattenDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const last = { balance: 75, resolution: 300, antialias: true, ...(app.prefs?.get?.('flattenTransparency') || {}) };
  const balance = sliderField({ label: 'Raster/Vector balance', value: last.balance, min: 0, max: 100, integer: true, ends: ['Rasters', 'Vectors'] });
  const res = selectRow({ label: 'Raster resolution', value: String(last.resolution), options: [...RESOLUTIONS, { value: 600, label: 'Very high (600 ppi)' }].map((r) => ({ value: String(r.value), label: r.label })) });
  const aa = checkField({ label: 'Anti-alias rasters', value: last.antialias });
  const v = await openDialog({
    title: 'Flatten Transparency',
    className: 'fx-dialog',
    body: h('div.fx-body', h('p.fx-note', 'Transparent artwork becomes opaque shapes that look the same on white. Where colors cannot be reproduced as shapes, an image of the artwork fills in.'), balance.el, res.el, aa.el),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => ({ balance: balance.get(), resolution: Number(res.get()), antialias: aa.get() }) }],
    initialFocus: () => balance.field,
  });
  if (!v) return false;
  app.prefs?.set?.('flattenTransparency', v);
  let r;
  try {
    r = await flattenSelection(ed, v);
  } catch (err) {
    app.notify(err?.message || 'The artwork could not be flattened.', { error: true });
    return false;
  }
  if (r.error) {
    app.notify(r.error);
    return false;
  }
  return true;
}
