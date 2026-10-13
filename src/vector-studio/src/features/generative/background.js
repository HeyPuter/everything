/**
 * Object > Remove Background for placed images, computed locally (no
 * upload): the background colors are estimated from the image border, a
 * flood fill from the border takes every connected pixel close to them
 * (optionally also enclosed areas of the same colors), specks are cleaned
 * up, and the result is either
 *   - transparent pixels: a new image asset whose background has alpha 0
 *     (with softened edges), or
 *   - a clipping path: the foreground traced into an editable compound
 *     path that clips the unchanged image.
 */
import { uid } from '../../lib/ids.js';
import { UserError } from '../../lib/errors.js';
import { multiply, scale as scaleM } from '../../lib/matrix.js';
import { createGroup, createCompound, createPath } from '../../model/nodes.js';
import { transformAnchors } from '../../model/bezier.js';
import { rgbToOklab, kmeans, rng, toHex } from '../trace/color.js';
import { parsePathData } from '../trace/trace-core.js';
import { assetPixels, resample } from '../trace/trace-runner.js';
import { encodePixels } from '../trace/image-ops.js';
import { selectedImages, withTraceProgress } from '../trace/trace-commands.js';
import { tracePixels } from './vectorize.js';

/** Longest side the mask is computed at. */
export const MASK_MAX = 1024;

/** Background color centers (OKLab) sampled from the opaque border pixels. */
export function borderColors(px, k = 3) {
  const { width: w, height: h, data } = px;
  const idx = [];
  for (let x = 0; x < w; x++) idx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) idx.push(y * w, y * w + w - 1);
  const opaque = idx.filter((i) => data[i * 4 + 3] >= 128);
  if (!opaque.length) return [];
  const pts = new Float64Array(opaque.length * 3);
  const lab = [0, 0, 0];
  opaque.forEach((i, n) => {
    rgbToOklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab);
    pts.set(lab, n * 3);
  });
  const km = kmeans(pts, 3, Math.min(k, opaque.length), { random: rng(7) });
  const out = [];
  for (let c = 0; c < km.k; c++) {
    // Clusters that cover little of the border are objects touching the edge, not background.
    if (km.counts[c] < opaque.length * 0.12) continue;
    out.push([km.centers[c * 3], km.centers[c * 3 + 1], km.centers[c * 3 + 2]]);
  }
  return out;
}

/**
 * Foreground mask of RGBA pixels: { mask (Uint8Array, 1 = keep), colors }.
 * tolerance 1..100 widens what counts as background color; `enclosed` also
 * removes background-colored areas the border flood cannot reach (holes).
 */
export function backgroundMask(px, { tolerance = 30, enclosed = true } = {}) {
  const { width: w, height: h, data } = px;
  const n = w * h;
  const centers = borderColors(px);
  const mask = new Uint8Array(n).fill(1);
  const t = 0.02 + (Math.max(1, Math.min(100, tolerance)) / 100) * 0.3;
  const t2 = t * t;
  // Background-like pixels: transparent, or close to a border color.
  const like = new Uint8Array(n);
  const lab = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 16) {
      like[i] = 1;
      continue;
    }
    rgbToOklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab);
    for (const c of centers) {
      const d = (lab[0] - c[0]) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2;
      if (d <= t2) {
        like[i] = 1;
        break;
      }
    }
  }
  // Flood fill from the border through background-like pixels.
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (i) => {
    if (like[i] && mask[i]) {
      mask[i] = 0;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  if (enclosed) {
    // Enclosed areas of background color big enough not to be detail.
    const minHole = Math.max(24, n * 0.002);
    eachComponent(w, h, (i) => like[i] && mask[i], (pixels) => {
      if (pixels.length >= minHole) for (const i of pixels) mask[i] = 0;
    });
  }
  // Specks: tiny foreground islands go.
  const minSpeck = Math.max(6, n * 0.0005);
  eachComponent(w, h, (i) => mask[i] === 1, (pixels) => {
    if (pixels.length < minSpeck) for (const i of pixels) mask[i] = 0;
  });
  return { mask, colors: centers.map((c) => labHex(c)) };
}

/** Visit 4-connected components of pixels where test(i) holds. */
function eachComponent(w, h, test, fn) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !test(s)) continue;
    const pixels = [];
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && !seen[j] && test(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    fn(pixels);
  }
}

function labHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return toHex({ r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s) });
}

/** Alpha (0..255) from a mask, softened over one pixel at the edges when `smooth`. */
export function maskAlpha(mask, w, h, { smooth = true } = {}) {
  const a = new Uint8ClampedArray(w * h);
  for (let i = 0; i < a.length; i++) a[i] = mask[i] ? 255 : 0;
  if (!smooth) return a;
  const out = new Uint8ClampedArray(a);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = 0;
      let cnt = 0;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = a[yy * w + xx];
          if (v !== a[i]) edge = true;
          sum += v;
          cnt++;
        }
      }
      if (edge) out[i] = sum / cnt;
    }
  }
  return out;
}

/** Scale alpha (w x h) to W x H with bilinear sampling. */
function scaleAlpha(alpha, w, h, W, H) {
  if (w === W && h === H) return alpha;
  const src = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) src.data[i * 4 + 3] = alpha[i];
  const big = resample(src, W, H);
  const out = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) out[i] = big.data[i * 4 + 3];
  return out;
}

/** Working-resolution pixels for the mask. */
function workingPixels(full) {
  const k = Math.min(1, MASK_MAX / Math.max(full.width, full.height));
  if (k >= 1) return full;
  return resample(full, Math.max(1, Math.round(full.width * k)), Math.max(1, Math.round(full.height * k)));
}

/**
 * Remove the background of one image object. mode: 'alpha' | 'clip'.
 * Resolves to the id of the changed image (alpha) or the new clipping
 * group (clip); the document change is one undo step.
 */
export async function removeBackground(doc, imageId, { mode = 'alpha', tolerance = 30, enclosed = true, smooth = true, signal = null, onProgress = null } = {}) {
  const img0 = doc.get(imageId);
  if (!img0 || img0.type !== 'image') throw new UserError('Select a placed image.');
  const full = await assetPixels(doc, img0.asset, null);
  onProgress?.(0.15);
  const work = workingPixels(full);
  const { mask } = backgroundMask(work, { tolerance, enclosed });
  onProgress?.(0.4);
  let kept = 0;
  for (let i = 0; i < mask.length; i++) kept += mask[i];
  if (!kept) throw new UserError('No foreground was found. Lower the tolerance and try again.');
  if (kept === mask.length) throw new UserError('No background was found. Raise the tolerance and try again.');
  if (signal?.aborted) return null;
  if (mode === 'clip') return clipToMask(doc, imageId, img0, mask, work, { signal, onProgress });
  const alpha = scaleAlpha(maskAlpha(mask, work.width, work.height, { smooth }), work.width, work.height, full.width, full.height);
  const out = new Uint8ClampedArray(full.data);
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = Math.round((out[i * 4 + 3] * alpha[i]) / 255);
  const data = await encodePixels({ width: full.width, height: full.height, data: out }, 'image/png');
  onProgress?.(0.95);
  if (signal?.aborted) return null;
  const img = doc.get(imageId);
  if (!img || img.asset !== img0.asset) return null; // changed meanwhile
  const old = doc.assets.get(img0.asset);
  const id = uid('img');
  doc.assets.set(id, { mime: 'image/png', data, name: old?.name || '' });
  doc.transact('Remove Background', () => doc.update(imageId, { asset: id }));
  return imageId;
}

async function clipToMask(doc, imageId, img0, mask, work, { signal, onProgress }) {
  const { width: w, height: h } = work;
  const bw = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] ? 0 : 255;
    bw[i * 4] = bw[i * 4 + 1] = bw[i * 4 + 2] = v;
    bw[i * 4 + 3] = 255;
  }
  const result = await tracePixels({ width: w, height: h, data: bw }, { mode: 'bw', threshold: 128, ignoreWhite: true, paths: 82, corners: 55, noise: 6, detail: 1 }, { signal, onProgress: (v) => onProgress?.(0.4 + 0.5 * v) });
  const img = doc.get(imageId);
  if (!img || img.asset !== img0.asset || signal?.aborted) return null;
  const m = multiply(img.transform || [1, 0, 0, 1, 0, 0], scaleM(img.width / result.w, img.height / result.h));
  const subs = [];
  for (const s of result.shapes) if (s.f) for (const p of parsePathData(s.d)) if (p.anchors.length > 1) subs.push(p);
  if (!subs.length) throw new UserError('No foreground outline was found. Lower the tolerance and try again.');
  let gid = null;
  doc.transact('Remove Background', () => {
    const parent = doc.get(img.parent);
    const index = parent.children.indexOf(img.id);
    const g = createGroup([], { clip: true, name: 'Background Removed' });
    doc.insert(g, parent.id, index);
    gid = g.id;
    doc.move(img.id, g.id);
    const c = createCompound([], { fill: null, stroke: null }, { fillRule: 'evenodd', name: 'Foreground' });
    const kids = subs.map((p) => createPath(transformAnchors(p.anchors, m), true, {}, { parent: c.id }));
    c.children = kids.map((k) => k.id);
    doc.insert(c, g.id, Infinity, kids);
  });
  return gid;
}

/** Object > Remove Background: options, then each selected image. */
export async function removeBackgroundCommand(app) {
  const ed = app.editor;
  const images = selectedImages(ed);
  if (!images.length) throw new UserError('Select a placed image.');
  const prev = app.prefs.get('removeBackground') || {};
  const v = await app.dialogs.form({
    title: 'Remove Background',
    description: 'The background is found from the colors along the image edges, on this device.',
    okLabel: 'Remove',
    fields: [
      { key: 'mode', type: 'radio', label: 'Result', value: prev.mode || 'alpha', options: [{ value: 'alpha', label: 'Transparent pixels' }, { value: 'clip', label: 'Clipping path (editable)' }] },
      { key: 'tolerance', type: 'range', label: 'Tolerance', min: 1, max: 100, value: prev.tolerance ?? 30 },
      { key: 'enclosed', type: 'checkbox', label: 'Remove enclosed background areas', value: prev.enclosed ?? true },
      { key: 'smooth', type: 'checkbox', label: 'Smooth edges', value: prev.smooth ?? true },
    ],
  });
  if (!v) return [];
  app.prefs.set('removeBackground', { mode: v.mode, tolerance: v.tolerance, enclosed: v.enclosed, smooth: v.smooth });
  const doc = ed.doc;
  const ids = await withTraceProgress(app, 'Removing background', async (onProgress, signal) => {
    const out = [];
    for (let i = 0; i < images.length; i++) {
      out.push(await removeBackground(doc, images[i].id, { ...v, signal, onProgress: (p) => onProgress((i + p) / images.length) }));
      if (signal.aborted) return null;
    }
    return out;
  }, { delay: 0 });
  if (!ids) return [];
  const done = ids.filter(Boolean);
  if (app.editors.includes(ed)) ed.select(done);
  return done;
}
