/**
 * Mockup Lighting: a raster effect that carries a photo's shading onto
 * artwork placed over it.
 *
 *   { type: 'mockupLighting', strength 0..1, displace (points) }
 *
 * The photo is the image painted below the object in the same group (the
 * mockup's photo). For every pixel of the art the photo's luminance there
 * is compared with its average under the art: darker spots darken the art
 * by that ratio (multiply), brighter spots lighten it (the inverse), scaled
 * by `strength`, so the art keeps its colors on average and picks up the
 * folds, shadows and highlights of the surface. `displace` shifts the art
 * by up to that distance with the luminance (a displacement map), so
 * printed lines wobble along creases. The art's alpha is kept.
 *
 * The effect works in device pixels (sharp at every zoom). SVG export
 * writes lit objects as images (svgExportHook); PDF export already
 * rasterizes objects with raster effects.
 */
import { registerContentEffect } from '../../render/effects.js';
import { imageFor, drawNode } from '../../render/draw.js';
import { effectOutsets, visualBounds } from '../../model/geometry.js';
import { multiply, invert, translate, scale as scaleM } from '../../lib/matrix.js';
import { registerEffectType } from '../paint/effects-model.js';
import { svgExportHooks } from '../io/hooks.js';
import { LIGHTING, LIGHTING_DEFAULTS } from './mockup-model.js';

/** Test and embedding hooks: pixels(doc, assetId) -> { width, height, data } (natural size) or null. */
export const lightingHooks = { pixels: null };

const LUM_MAX = 512;
const IDENT = [1, 0, 0, 1, 0, 0];

/** The visible image painted below `node` in its parent (the mockup's photo), or null. */
export function photoBelow(doc, node) {
  const parent = node?.parent ? doc.get(node.parent) : null;
  if (!parent?.children) return null;
  const i = parent.children.indexOf(node.id);
  for (let j = i - 1; j >= 0; j--) {
    const k = doc.get(parent.children[j]);
    if (k?.type === 'image' && !k.hidden) return k;
  }
  return null;
}

/**
 * A luminance grid of RGBA pixels: { w, h, lum: Float32Array } at most
 * `max` on the long side (area averaged), lightly smoothed so sensor noise
 * and JPEG blocks do not show on the art. Transparent pixels count as white.
 */
export function luminanceGrid(px, max = LUM_MAX) {
  const k = Math.min(1, max / Math.max(px.width, px.height));
  const w = Math.max(1, Math.round(px.width * k));
  const h = Math.max(1, Math.round(px.height * k));
  const sum = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  const d = px.data;
  for (let y = 0; y < px.height; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / px.height));
    for (let x = 0; x < px.width; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / px.width));
      const o = (y * px.width + x) * 4;
      const a = d[o + 3] / 255;
      const l = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
      sum[gy * w + gx] += l * a + (1 - a);
      cnt[gy * w + gx] += 1;
    }
  }
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = cnt[i] ? sum[i] / cnt[i] : 1;
  return { w, h, lum: smooth(lum, w, h) };
}

/** 3x3 box blur (edges clamp). */
function smooth(src, w, h) {
  if (w < 3 || h < 3) return src;
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) s += src[yy * w + Math.max(0, Math.min(w - 1, x + dx))];
      }
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

/** Bilinear luminance at grid coordinates (pixel centers at +0.5), NaN outside the grid. */
export function sampleGrid(g, gx, gy) {
  if (!(gx >= 0 && gy >= 0 && gx <= g.w && gy <= g.h)) return NaN;
  const fx = Math.max(0, Math.min(g.w - 1, gx - 0.5));
  const fy = Math.max(0, Math.min(g.h - 1, gy - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const L = g.lum;
  const a = L[y0 * g.w + x0] * (1 - tx) + L[y0 * g.w + x1] * tx;
  const b = L[y1 * g.w + x0] * (1 - tx) + L[y1 * g.w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

const gridCache = new WeakMap();

/** The luminance grid of an image asset, or null while it is not decoded. */
export function photoLuminance(doc, assetId) {
  if (lightingHooks.pixels) {
    const px = lightingHooks.pixels(doc, assetId);
    if (!px) return null;
    let g = gridCache.get(px);
    if (!g) gridCache.set(px, (g = luminanceGrid(px)));
    return g;
  }
  const img = imageFor(doc, assetId);
  if (!img) return null;
  let g = gridCache.get(img);
  if (g !== undefined) return g;
  g = null;
  try {
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    const k = Math.min(1, LUM_MAX / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * k));
    const h = Math.max(1, Math.round(nh * k));
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h)?.data;
    if (data && data.length === w * h * 4) g = luminanceGrid({ width: w, height: h, data });
  } catch {
    // Linked images that do not allow reading their pixels light nothing.
    g = null;
  }
  gridCache.set(img, g);
  return g;
}

/**
 * Light RGBA pixels (straight alpha, W x H). lumAt(x, y) is the photo's
 * luminance at a pixel center (NaN off the photo). `displace` is in
 * pixels. Returns new pixels, or null when the art is not over the photo.
 */
export function applyLighting(src, W, H, lumAt, { strength = LIGHTING_DEFAULTS.strength, displace = 0 } = {}) {
  const n = W * H;
  const L = new Float32Array(n).fill(NaN);
  let sum = 0;
  let wsum = 0;
  const all = displace > 0;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const a = src[i * 4 + 3];
      if (!a && !all) continue;
      const l = lumAt(x + 0.5, y + 0.5);
      L[i] = l;
      if (a && Number.isFinite(l)) {
        sum += l * a;
        wsum += a;
      }
    }
  }
  if (!wsum) return null;
  const mean = Math.max(1e-3, sum / wsum);
  const out = new Uint8ClampedArray(src.length);
  const px = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const l = L[i];
      const lit = Number.isFinite(l);
      if (all && lit) sampleRGBA(src, W, H, x + 0.5 + (l - mean) * displace, y + 0.5 + (l - mean) * displace, px);
      else {
        const o = i * 4;
        px[0] = src[o];
        px[1] = src[o + 1];
        px[2] = src[o + 2];
        px[3] = src[o + 3];
      }
      const o = i * 4;
      if (!px[3]) continue;
      let f = lit ? 1 + strength * (l / mean - 1) : 1;
      f = Math.max(0, Math.min(3, f));
      for (let c = 0; c < 3; c++) {
        const v = px[c] / 255;
        out[o + c] = Math.round(255 * (f <= 1 ? v * f : 1 - (1 - v) / f));
      }
      out[o + 3] = px[3];
    }
  }
  return out;
}

/** Bilinear RGBA sample with premultiplied interpolation (no dark fringes); transparent outside. */
function sampleRGBA(src, W, H, x, y, out) {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const [xx, yy, wt] of [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x0 + 1, y0, tx * (1 - ty)],
    [x0, y0 + 1, (1 - tx) * ty],
    [x0 + 1, y0 + 1, tx * ty],
  ]) {
    if (xx < 0 || yy < 0 || xx >= W || yy >= H || wt <= 0) continue;
    const o = (yy * W + xx) * 4;
    const al = src[o + 3] * wt;
    r += src[o] * al;
    g += src[o + 1] * al;
    b += src[o + 2] * al;
    a += al;
  }
  out[3] = Math.round(a);
  if (a > 0) {
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
  } else out[0] = out[1] = out[2] = 0;
  return out;
}

/** The content effect (see registerContentEffect). */
export function lightingEffect(layer, e, scale, pool, info) {
  if (!info?.doc || !info.node || !(e.strength > 0 || e.displace > 0)) return null;
  const photo = photoBelow(info.doc, info.node);
  if (!photo || !(photo.width > 0) || !(photo.height > 0)) return null;
  const grid = photoLuminance(info.doc, photo.asset);
  if (!grid) return null;
  const W = layer.canvas.width;
  const H = layer.canvas.height;
  let img;
  try {
    img = layer.ctx.getImageData(0, 0, W, H);
  } catch {
    return null;
  }
  if (!img?.data || img.data.length !== W * H * 4) return null;
  const t = info.transform;
  const M = t ? [t.a, t.b, t.c, t.d, t.e, t.f] : [scale, 0, 0, scale, 0, 0];
  const toLayer = multiply(translate(-(info.x || 0), -(info.y || 0)), M);
  const A = multiply(scaleM(grid.w / photo.width, grid.h / photo.height), multiply(invert(photo.transform || IDENT), invert(toLayer)));
  const lumAt = (x, y) => sampleGrid(grid, A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]);
  const devPerUnit = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || scale || 1;
  const out = applyLighting(img.data, W, H, lumAt, { strength: e.strength ?? 0, displace: (e.displace || 0) * devPerUnit });
  if (!out) return null;
  const o = pool.acquire(W, H);
  const id = o.ctx.createImageData(W, H);
  if (!id?.data || id.data.length !== out.length) return null;
  id.data.set(out);
  o.ctx.putImageData(id, 0, 0);
  return o;
}

registerContentEffect(LIGHTING, lightingEffect, { margin: (e) => e.displace || 0 });
effectOutsets.set(LIGHTING, (e) => e.displace || 0);

registerEffectType(LIGHTING, {
  label: 'Mockup Lighting',
  command: 'panel.mockup',
  defaults: { ...LIGHTING_DEFAULTS },
  ranges: { strength: [0, 1], displace: [0, 50] },
  describe: (e) => `Mockup Lighting: ${Math.round((e.strength ?? 0) * 100)}%`,
  // The Mockup panel edits it.
  openDialog: (app) => {
    app.commands.run('panel.mockup');
    return null;
  },
});

// ---- SVG export ----

const lit = (node) => (node.effects || []).some((e) => e && !e.hidden && e.type === LIGHTING && (e.strength > 0 || e.displace > 0));

/** Renders a node for embedding: (doc, node, rect, k) -> PNG data URL or null. Replaceable in tests. */
export const lightingRaster = {
  render(doc, node, rect, k) {
    if (typeof document === 'undefined') return null;
    const W = Math.max(1, Math.ceil(rect.w * k));
    const H = Math.max(1, Math.ceil(rect.h * k));
    const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(k, 0, 0, k, -rect.x * k, -rect.y * k);
    drawNode(ctx, doc, node, { viewRect: rect, outline: false, hairline: 1 / k, scale: k });
    let url = null;
    try {
      url = canvas.toDataURL('image/png');
    } catch {
      url = null;
    }
    return typeof url === 'string' && url.startsWith('data:image/png') ? url : null;
  },
};

/** Lit art exports to SVG as an image of itself at about the photo's resolution (2-4 px per point). */
function svgExportHook(node, w, depth) {
  if (!lit(node)) return undefined;
  const doc = w.doc;
  const vb = visualBounds(doc, node);
  if (!vb || !(vb.w > 0) || !(vb.h > 0)) return '';
  const k = Math.max(1, Math.min(4, 4096 / vb.w, 4096 / vb.h));
  const url = lightingRaster.render(doc, { ...node, opacity: 1, blendMode: 'normal' }, vb, k);
  if (!url) return undefined;
  w.needsXlink = true;
  const p = w.map(vb.x, vb.y);
  return `${w.nl(depth)}<image${w.nameId(node.name)} x="${w.n(p.x)}" y="${w.n(p.y)}" width="${w.n(vb.w)}" height="${w.n(vb.h)}" preserveAspectRatio="none" xlink:href="${url}"${w.commonAttrs({ ...node, effects: [], isolate: false })}/>`;
}

export function installLightingExport() {
  if (!svgExportHooks.element.includes(svgExportHook)) svgExportHooks.element.push(svgExportHook);
}
