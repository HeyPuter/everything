/**
 * Geometry from other feature modules, normalized to subpaths
 * [{ anchors, closed }] in document space:
 *
 * - Text outlines from `app.textOutlines(node, { doc })` when the type
 *   module provides it. Accepted results (sync or async): an array of
 *   { anchors, closed } or path nodes, a compound/group-like object with
 *   `children` nodes, { paths }, { subpaths }, { nodes }, or SVG path data.
 * - Arrowheads from `drawHooks.arrowheadOutlines(node)` when present, else by
 *   recording the Path2D calls `drawHooks.arrowheads(node)` makes.
 */
import { drawHooks, paintStyle } from '../../render/draw.js';
import { parsePathData, arcToCubics } from './svg-path.js';
import { apply, multiply } from '../../lib/matrix.js';
import { paintHooks } from './hooks.js';

export function normalizeSubpaths(r, depth = 0) {
  if (!r || depth > 6) return [];
  if (typeof r === 'string') return parsePathData(r);
  if (r instanceof RecordingPath2D) return r.subpaths();
  if (Array.isArray(r)) return r.flatMap((x) => normalizeSubpaths(x, depth + 1));
  if (typeof r !== 'object') return [];
  if (Array.isArray(r.anchors)) return r.anchors.length ? [{ anchors: r.anchors, closed: r.closed !== false }] : [];
  if (r.d && typeof r.d === 'string') return parsePathData(r.d);
  for (const key of ['subpaths', 'paths', 'outlines', 'nodes', 'descendants']) if (Array.isArray(r[key])) return normalizeSubpaths(r[key], depth + 1);
  if (Array.isArray(r.children) && r.children.length && typeof r.children[0] === 'object') return normalizeSubpaths(r.children, depth + 1);
  if (r.node) return normalizeSubpaths([r.node, ...(r.descendants || [])], depth + 1);
  return [];
}

/**
 * Text outlines normalized to paint runs [{ fill, stroke, strokeWidth, subpaths }]
 * in document space. The type module returns one entry per glyph
 * ({ index, fill, stroke, strokeWidth, contours }); consecutive glyphs with
 * the same paint are merged so the output stays compact. Older or simpler
 * results (plain contours or path data) use the node's own paint.
 */
export function normalizeTextOutlines(r, node, { fallback = false } = {}) {
  if (Array.isArray(r) && r.some((g) => g && Array.isArray(g.contours))) {
    const runs = [];
    const stand = [];
    let key = null;
    for (const g of r) {
      // A character the font has no glyph for: its outline is the font's empty-glyph box.
      if (fallback && g?.fallback) {
        if (!g.fallback.merged) stand.push({ ...g.fallback, fill: g.fill ?? null, stroke: g.stroke ?? null, strokeWidth: g.strokeWidth ?? 0 });
        continue;
      }
      if (!g || !Array.isArray(g.contours) || !g.contours.length) continue;
      const k = JSON.stringify([g.fill ?? null, g.stroke ?? null, g.strokeWidth ?? 0]);
      if (k !== key) {
        runs.push({ fill: g.fill ?? null, stroke: g.stroke ?? null, strokeWidth: g.strokeWidth ?? 0, subpaths: [] });
        key = k;
      }
      runs[runs.length - 1].subpaths.push(...g.contours.filter((c) => c?.anchors?.length > 1).map((c) => ({ anchors: c.anchors, closed: c.closed !== false })));
    }
    const out = runs.filter((x) => x.subpaths.length);
    if (stand.length) out.fallback = stand;
    return out;
  }
  const subs = normalizeSubpaths(r);
  if (!subs.length) return [];
  const m = node.transform || [1, 0, 0, 1, 0, 0];
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  return [{ fill: node.fill ?? null, stroke: node.stroke ?? null, strokeWidth: (node.strokeWidth || 0) * s, subpaths: subs }];
}

/** All contours of normalized text outline runs (for clipping paths). */
export function outlineSubpaths(runs) {
  return (runs || []).flatMap((r) => r.subpaths);
}

/**
 * Outline runs of a text node, or null when the type module cannot provide
 * them. With `images`, characters the font has no glyphs for are left out of
 * the outlines and drawn as the canvas draws them (in the system font that
 * stands in) into `runs.images`: [{ m, width, height, data, url }], where m
 * maps the image's unit square (y down) to document space.
 */
export async function textOutlines(app, doc, node, { images = false } = {}) {
  if (!app?.textOutlines) return null;
  try {
    const r = await app.textOutlines(node, { doc });
    const runs = normalizeTextOutlines(r, node, { fallback: images });
    if (runs.fallback) {
      runs.images = [];
      for (const g of runs.fallback) {
        const img = await glyphImage(doc, node, g, Math.max(300, doc.root?.rasterResolution || 0));
        if (img) runs.images.push(img);
      }
    }
    return runs.length || runs.fallback ? runs : null;
  } catch {
    return null;
  }
}

/** Largest side of a stand-in glyph image, in pixels. */
const GLYPH_IMAGE_MAX = 2048;

/** A character drawn with the canvas's font fallback at `ppi`: { m, width, height, data, url } or null. */
async function glyphImage(doc, node, g, ppi) {
  const m = g.m;
  const k = (ppi / 72) * (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1);
  let canvas;
  try {
    canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
  } catch {
    return null;
  }
  let ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const spacing = g.letterSpacing && 'letterSpacing' in ctx ? `${g.letterSpacing}px` : null;
  ctx.font = g.font;
  if (spacing) ctx.letterSpacing = spacing;
  const tm = ctx.measureText(g.ch);
  // The ink box in glyph space (baseline at y 0), with a little room for anti-aliasing and strokes.
  const pad = g.size * 0.05 + (g.strokeWidth || 0) + 2 / k;
  const has = Number.isFinite(tm.actualBoundingBoxAscent) && tm.actualBoundingBoxAscent + tm.actualBoundingBoxDescent > 0;
  const x0 = (has ? -tm.actualBoundingBoxLeft : 0) - pad;
  const x1 = (has ? tm.actualBoundingBoxRight : tm.width || g.size) + pad;
  const y0 = (has ? -tm.actualBoundingBoxAscent : -g.size) - pad;
  const y1 = (has ? tm.actualBoundingBoxDescent : g.size * 0.3) + pad;
  if (!(x1 > x0 && y1 > y0)) return null;
  const s = Math.min(k, GLYPH_IMAGE_MAX / Math.max(x1 - x0, y1 - y0));
  const width = Math.max(1, Math.ceil((x1 - x0) * s));
  const height = Math.max(1, Math.ceil((y1 - y0) * s));
  canvas.width = width;
  canvas.height = height;
  ctx = canvas.getContext('2d');
  ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
  ctx.font = g.font;
  if (spacing) ctx.letterSpacing = spacing;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const fill = paintStyle(ctx, doc, node, g.fill, g.seg);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillText(g.ch, 0, 0);
  }
  const stroke = g.strokeWidth > 0 ? paintStyle(ctx, doc, node, g.stroke, g.seg) : null;
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = g.strokeWidth;
    ctx.lineJoin = node.strokeJoin || 'miter';
    ctx.strokeText(g.ch, 0, 0);
  }
  if (!fill && !stroke) return null;
  const data = ctx.getImageData(0, 0, width, height)?.data;
  if (!data || data.length !== width * height * 4) return null;
  let url = null;
  try {
    url = canvas.toDataURL ? canvas.toDataURL('image/png') : await blobURL(await canvas.convertToBlob({ type: 'image/png' }));
  } catch {
    url = null;
  }
  return { m: multiply(m, [(x1 - x0), 0, 0, (y1 - y0), x0, y0]), width, height, data, url };
}

function blobURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function graphemes(str) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str), (x) => x.segment);
  return Array.from(str);
}

/**
 * Precompute outlines for every visible text node under the given roots:
 * Map id -> runs. With `images` (exports that convert text to outlines),
 * characters the fonts lack are placed as images (see textOutlines) and the
 * user is told which ones.
 */
export async function collectTextOutlines(app, doc, rootIds, { images = false } = {}) {
  const out = new Map();
  if (!app?.textOutlines) return out;
  const missing = new Set();
  const visit = async (id) => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    if (n.type === 'text') {
      const s = await textOutlines(app, doc, n, { images });
      if (s) out.set(n.id, s);
      for (const g of s?.fallback || []) for (const c of graphemes(g.ch)) if (c.trim()) missing.add(c);
    }
    for (const c of n.children || []) await visit(c);
  };
  for (const id of rootIds) await visit(id);
  if (missing.size) {
    const chars = [...missing];
    const list = chars.slice(0, 8).join(' ') + (chars.length > 8 ? ' …' : '');
    app.notify?.(`Some characters have no outlines in their font and were placed as images: ${list}. Choose a font that includes them to keep them as vector shapes.`, { timeout: 8000 });
  }
  return out;
}

/**
 * A Path2D stand-in that records geometry. Used while calling the
 * arrowheads hook so its paths can be written to SVG and PDF.
 */
export class RecordingPath2D {
  constructor(src) {
    this.subs = [];
    this.cur = null;
    if (typeof src === 'string') for (const sp of parsePathData(src)) this.subs.push({ anchors: sp.anchors.map((a) => ({ ...a })), closed: sp.closed });
    else if (src instanceof RecordingPath2D) this.addPath(src);
  }

  #pt(x, y) {
    return { x, y, ix: x, iy: y, ox: x, oy: y };
  }

  moveTo(x, y) {
    this.pending = null;
    this.cur = { anchors: [this.#pt(x, y)], closed: false };
    this.subs.push(this.cur);
  }

  #last() {
    if (!this.cur) this.moveTo(this.pending?.x ?? 0, this.pending?.y ?? 0);
    return this.cur.anchors[this.cur.anchors.length - 1];
  }

  lineTo(x, y) {
    if (!this.cur && !this.pending) return this.moveTo(x, y);
    this.#last();
    this.cur.anchors.push(this.#pt(x, y));
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    const last = this.#last();
    last.ox = c1x;
    last.oy = c1y;
    this.cur.anchors.push({ x, y, ix: c2x, iy: c2y, ox: x, oy: y });
  }

  quadraticCurveTo(qx, qy, x, y) {
    const l = this.#last();
    this.bezierCurveTo(l.x + (2 / 3) * (qx - l.x), l.y + (2 / 3) * (qy - l.y), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
  }

  closePath() {
    if (!this.cur) return;
    const a = this.cur.anchors;
    if (a.length > 1) {
      const f = a[0];
      const l = a[a.length - 1];
      if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) {
        f.ix = l.ix;
        f.iy = l.iy;
        a.pop();
      }
    }
    this.cur.closed = true;
    this.pending = a[0] ? { x: a[0].x, y: a[0].y } : null;
    this.cur = null;
  }

  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  roundRect(x, y, w, h) {
    this.rect(x, y, w, h);
  }

  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw = false) {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep = (sweep % (2 * Math.PI)) + 2 * Math.PI;
    if (ccw && sweep > 0) sweep = (sweep % (2 * Math.PI)) - 2 * Math.PI;
    if (Math.abs(a1 - a0) >= 2 * Math.PI - 1e-9) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const pt = (a) => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
    const p0 = pt(a0);
    if (this.cur) this.lineTo(p0[0], p0[1]);
    else this.moveTo(p0[0], p0[1]);
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    let a = a0;
    for (let i = 0; i < steps; i++) {
      const b = a + sweep / steps;
      const s = pt(a);
      const e = pt(b);
      for (const seg of arcToCubics(s[0], s[1], rx, ry, (rot * 180) / Math.PI, 0, sweep > 0 ? 1 : 0, e[0], e[1])) this.bezierCurveTo(...seg);
      a = b;
    }
  }

  arc(cx, cy, r, a0, a1, ccw) {
    this.ellipse(cx, cy, r, r, 0, a0, a1, ccw);
  }

  arcTo(x1, y1) {
    this.lineTo(x1, y1);
  }

  addPath(p, m) {
    if (!(p instanceof RecordingPath2D)) return;
    const t = m ? [m.a ?? m[0], m.b ?? m[1], m.c ?? m[2], m.d ?? m[3], m.e ?? m[4], m.f ?? m[5]] : null;
    for (const sp of p.subs) {
      const anchors = sp.anchors.map((a) => {
        if (!t) return { ...a };
        const q = apply(t, a.x, a.y);
        const i = apply(t, a.ix, a.iy);
        const o = apply(t, a.ox, a.oy);
        return { x: q.x, y: q.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
      });
      this.subs.push({ anchors, closed: sp.closed });
    }
    this.cur = null;
  }

  subpaths() {
    return this.subs.filter((s) => s.anchors.length > 1);
  }
}

/** Arrowhead outlines for a path node (filled with the stroke paint), or []. */
export function arrowheadOutlines(node) {
  if (!node.arrowStart && !node.arrowEnd) return [];
  try {
    if (drawHooks.arrowheadOutlines) return normalizeSubpaths(drawHooks.arrowheadOutlines(node));
    if (!drawHooks.arrowheads) return [];
    const Real = globalThis.Path2D;
    let result;
    globalThis.Path2D = RecordingPath2D;
    try {
      result = drawHooks.arrowheads(node);
    } finally {
      globalThis.Path2D = Real;
    }
    if (!result) return [];
    return (Array.isArray(result) ? result : [result]).flatMap((p) => (p instanceof RecordingPath2D ? p.subpaths() : []));
  } catch {
    return [];
  }
}


/**
 * Stroke geometry from the paint module, read through the app at call time
 * (the paint module installs after this one):
 *   app.arrowheadPaths(node)  arrowhead contours in document space
 *   app.strokeAnchors(node)   the stroked path after arrowhead trimming
 *   app.dashPattern(node)     { dash, offset } actually used (corner-aligned dashes)
 */
export { paintHooks };

/** Arrowhead contours for a path node (filled with the stroke paint), or []. */
export function nodeArrowOutlines(node) {
  if (node.type !== 'path' || (!node.arrowStart && !node.arrowEnd)) return [];
  const app = paintHooks.app;
  if (app?.arrowheadPaths) {
    try {
      return normalizeSubpaths(app.arrowheadPaths(node));
    } catch {
      return [];
    }
  }
  return arrowheadOutlines(node);
}

/** The anchors the stroke follows (trimmed for arrowheads), or null when it is the node's own geometry. */
export function strokedAnchors(node) {
  if (node.type !== 'path' || node.closed || (!node.arrowStart && !node.arrowEnd)) return null;
  const app = paintHooks.app;
  try {
    const a = app?.strokeAnchors?.(node);
    return a && a !== node.anchors && a.length > 1 ? a : null;
  } catch {
    return null;
  }
}

/** Effective dash { dash, offset } for a node, or null for a solid stroke. */
export function effectiveDash(node) {
  const app = paintHooks.app;
  let d = null;
  try {
    d = app?.dashPattern ? app.dashPattern(node) : null;
  } catch {
    d = null;
  }
  if (!d && node.dash?.length) d = { dash: node.dash, offset: node.dashOffset || 0 };
  if (!d || !d.dash?.length || !d.dash.some((v) => v > 0)) return null;
  return d;
}
