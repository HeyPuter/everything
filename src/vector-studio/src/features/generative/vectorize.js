/**
 * Generated pictures to vector art: decode what the image model returns,
 * trace it with the Trace Image engine (in a worker), and turn the traced
 * shapes into document nodes or SVG previews.
 *
 * A traced result is { w, h, shapes, stats } in the traced pixel grid (see
 * features/trace/trace-core.js); it is plain JSON, so the generation
 * history keeps it and can place it again later.
 */
import { createGroup, createPath, createCompound } from '../../model/nodes.js';
import { transformAnchors } from '../../model/bezier.js';
import { scaleFactor } from '../../lib/matrix.js';
import { parsePathData } from '../trace/trace-core.js';
import { normalizeOptions, gridSize } from '../trace/presets.js';
import { runTrace, resample } from '../trace/trace-runner.js';
import { vectorPrompt, COLOR_MODES } from './prompts.js';
import { abortable, isAbort, AIError, aiErrorMessage, abortError } from './ai.js';

/** Longest side pictures are decoded at (larger ones are scaled down). */
export const DECODE_MAX = 1024;

const RATIOS = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
];

/** The supported picture shape closest to w:h, as { w, h }. */
export function ratioFor(w, h) {
  const r = w > 0 && h > 0 ? w / h : 1;
  let best = RATIOS[0];
  for (const q of RATIOS) if (Math.abs(Math.log(q[0] / q[1] / r)) < Math.abs(Math.log(best[0] / best[1] / r))) best = q;
  return { w: best[0], h: best[1] };
}

/** Trace options for a content type, detail level (1..3) and color treatment. */
export function traceOptionsFor({ contentType = 'subject', detail = 2, color = 'full' } = {}) {
  const d = Math.max(1, Math.min(3, Math.round(detail))) - 1;
  const table = {
    icon: { colors: [3, 5, 7], noise: [64, 36, 20], paths: 72, corners: 82, ignoreWhite: true, detail: 1 },
    subject: { colors: [6, 10, 16], noise: [44, 22, 10], paths: 74, corners: 70, ignoreWhite: true, detail: d >= 2 ? 2 : 1 },
    scene: { colors: [8, 14, 24], noise: [48, 24, 12], paths: 70, corners: 66, ignoreWhite: false, detail: d >= 1 ? 2 : 1 },
    pattern: { colors: [5, 8, 12], noise: [40, 24, 14], paths: 72, corners: 72, ignoreWhite: false, detail: 1 },
  };
  const t = table[contentType] || table.subject;
  const cm = COLOR_MODES.find((c) => c.id === color);
  if (color === 'mono') {
    return normalizeOptions({ mode: 'bw', threshold: 140, paths: t.paths + 6, corners: t.corners, noise: t.noise[d], ignoreWhite: t.ignoreWhite, detail: t.detail });
  }
  const colors = cm?.colors ? Math.min(cm.colors, t.colors[d] + 1) : t.colors[d];
  return normalizeOptions({ mode: 'color', palette: 'limited', colors, paths: t.paths, corners: t.corners, noise: t.noise[d], ignoreWhite: t.ignoreWhite, method: 'abutting', detail: t.detail });
}

/** Decode a data URL into a Blob, or null when src is not one. */
export function dataUrlToBlob(src) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(src || ''));
  if (!m) return null;
  const type = m[1] || 'application/octet-stream';
  let bytes;
  if (m[2]) {
    const bin = atob(m[3].replace(/\s/g, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type });
}

/** The picture source of what txt2img returned (an <img>, a URL or a data URL). */
export function imageSource(result) {
  if (typeof result === 'string') return result;
  return result?.currentSrc || result?.src || result?.getAttribute?.('src') || result?.url || '';
}

/**
 * Pixels of a generated picture: { width, height, data }, at most
 * DECODE_MAX on the long side. Browser only (tests inject a decoder).
 */
export async function decodeImage(result, { fetchFn = globalThis.fetch } = {}) {
  const src = imageSource(result);
  if (!src) throw new AIError('No picture came back. Try again.');
  let blob = dataUrlToBlob(src);
  if (!blob) {
    let res;
    try {
      res = await fetchFn(src, { mode: 'cors', credentials: 'omit' });
    } catch {
      throw new AIError('The generated picture could not be downloaded.');
    }
    if (!res?.ok) throw new AIError('The generated picture could not be downloaded.');
    blob = await res.blob();
  }
  if (!blob.size) throw new AIError('The answer was not a picture.');
  if (typeof createImageBitmap !== 'function') throw new AIError('Pictures cannot be read in this browser.');
  const bmp = await createImageBitmap(blob);
  try {
    const k = Math.min(1, DECODE_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  } finally {
    bmp.close?.();
  }
}

/** Trace pixels with options: resolves to { w, h, shapes, stats }. */
export async function tracePixels(pixels, options, { signal = null, onProgress = null } = {}) {
  const o = normalizeOptions(options);
  const g = gridSize(pixels.width, pixels.height, o.detail);
  const image = g.w === pixels.width && g.h === pixels.height ? pixels : resample(pixels, g.w, g.h);
  const result = await runTrace({ width: image.width, height: image.height, data: image.data }, o, { scale: g.w / pixels.width }, { signal, onProgress });
  return { w: result.w, h: result.h, shapes: result.shapes, stats: result.stats };
}

// ---- results to artwork ----

/** Matrix mapping a w x h grid into rect: 'contain' fits inside, 'cover' fills it. */
export function fitMatrix(w, h, rect, mode = 'contain') {
  const sx = rect.w / (w || 1);
  const sy = rect.h / (h || 1);
  const s = mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  return [s, 0, 0, s, rect.x + (rect.w - w * s) / 2, rect.y + (rect.h - h * s) / 2];
}

function shapeStyle(s, k) {
  return s.f
    ? { fill: { type: 'solid', color: s.f }, stroke: null, strokeWidth: 0 }
    : { fill: null, stroke: { type: 'solid', color: s.s }, strokeWidth: Math.max(0.1, (s.sw || 1) * k), strokeCap: 'round', strokeJoin: 'round' };
}

/**
 * Document nodes for a traced result mapped through m: { node, descendants }
 * ready for doc.insert(node, parentId, index, descendants). The root is a
 * group named `name`.
 */
export function resultToNodes(result, m, { name = '' } = {}) {
  const k = scaleFactor(m);
  const descendants = [];
  const group = createGroup([], { name });
  for (const s of result.shapes || []) {
    const subs = parsePathData(s.d).filter((p) => p.anchors.length > 1);
    if (!subs.length) continue;
    const style = shapeStyle(s, k);
    if (subs.length === 1) {
      const p = createPath(transformAnchors(subs[0].anchors, m), subs[0].closed, style, { parent: group.id });
      descendants.push(p);
      group.children.push(p.id);
      continue;
    }
    const c = createCompound([], style, { fillRule: 'evenodd', parent: group.id });
    for (const sub of subs) {
      const p = createPath(transformAnchors(sub.anchors, m), sub.closed, {}, { parent: c.id });
      descendants.push(p);
      c.children.push(p.id);
    }
    descendants.push(c);
    group.children.push(c.id);
  }
  return { node: group, descendants };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** SVG markup of a traced result (previews and the history). */
export function resultSvg(result, { background = null } = {}) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.w} ${result.h}">`];
  if (background) parts.push(`<rect width="${result.w}" height="${result.h}" fill="${esc(background)}"/>`);
  for (const s of result.shapes || []) {
    if (s.f) parts.push(`<path fill="${esc(s.f)}" fill-rule="evenodd" d="${esc(s.d)}"/>`);
    else parts.push(`<path fill="none" stroke="${esc(s.s)}" stroke-width="${Number(s.sw) || 1}" stroke-linecap="round" stroke-linejoin="round" d="${esc(s.d)}"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

export function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---- the generation pipeline ----

/**
 * Generate `count` variations: picture -> pixels -> traced result.
 * settings: { prompt, contentType, style, color, detail, reference, ratio }.
 * Resolves to { variations: [{ id, result }], failed, imagePrompt }.
 * Rejects with an AbortError when cancelled, or an AIError when every
 * variation failed.
 */
export async function generateVariations(app, client, settings, { count = 3, signal = null, onProgress = null, decode = null } = {}) {
  const imagePrompt = vectorPrompt(settings);
  const options = traceOptionsFor(settings);
  const ratio = settings.ratio || { w: 1, h: 1 };
  const decodeFn = decode || app.generativeDecode || decodeImage;
  const n = Math.max(1, Math.min(4, Math.round(count)));
  const stage = new Array(n).fill(0);
  const t0 = Date.now();
  const report = () => onProgress?.(stage.reduce((a, b) => a + b, 0) / n);
  // Picture generation reports no progress: ease toward the halfway mark meanwhile.
  const ticker = setInterval(() => {
    const ease = 0.45 * (1 - Math.exp(-(Date.now() - t0) / 9000));
    for (let i = 0; i < n; i++) if (stage[i] < 0.5) stage[i] = Math.max(stage[i], ease);
    report();
  }, 250);
  const one = async (i) => {
    let picture;
    try {
      picture = await abortable(Promise.resolve().then(() => client.txt2img(imagePrompt, { ratio })), signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new AIError(aiErrorMessage(err, 'The picture could not be generated. Try again.'));
    }
    stage[i] = 0.5;
    report();
    const pixels = await abortable(Promise.resolve(decodeFn(picture)), signal);
    if (signal?.aborted) throw abortError();
    const result = await tracePixels(pixels, options, {
      signal,
      onProgress: (v) => {
        stage[i] = 0.5 + 0.5 * v;
        report();
      },
    });
    stage[i] = 1;
    report();
    if (!result.shapes.length) throw new AIError('The generated picture had nothing to trace. Try another description.');
    return { id: `v${i + 1}-${Date.now().toString(36)}`, result };
  };
  try {
    const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => one(i)));
    if (signal?.aborted) throw abortError();
    const variations = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    const errors = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
    if (errors.some(isAbort)) throw abortError();
    if (!variations.length) throw errors[0] instanceof AIError ? errors[0] : new AIError(aiErrorMessage(errors[0], 'Nothing could be generated. Try again.'));
    return { variations, failed: errors.length, imagePrompt };
  } finally {
    clearInterval(ticker);
  }
}
