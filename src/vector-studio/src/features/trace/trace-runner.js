/**
 * Running traces off the main thread.
 *
 * imagePixels() decodes an image asset into RGBA pixels at the working
 * resolution (cached). runTrace() traces them in a Web Worker, reporting
 * progress, and can be cancelled with an AbortSignal (the worker is
 * terminated). Without Worker support (tests, old browsers) the trace
 * runs on the main thread after yielding once.
 */
import { traceImage } from './trace-core.js';
import { gridSize } from './presets.js';

let pixelSource = null;

/**
 * Replace how asset pixels are read: fn(doc, assetId) -> { width, height,
 * data } at natural size, or null. For tests and headless use.
 */
export function setPixelSource(fn) {
  pixelSource = fn;
  cache.clear();
  sizes = new WeakMap();
  lastDecoded = null;
}

const cache = new Map();
const CACHE_LIMIT = 6;
/** Natural sizes of assets (asset record -> { width, height }). */
let sizes = new WeakMap();
/** The image decoded to learn an asset's size, kept for the pixel read that follows. */
let lastDecoded = null;

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

/** Decode an asset to an HTMLImageElement (or ImageBitmap). */
async function decodeAsset(asset) {
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  if (asset.external) img.crossOrigin = 'anonymous';
  img.src = asset.data;
  await img.decode();
  return img;
}

/** Bilinear resample of RGBA pixels (used when pixels come from a pixel source). */
export function resample(src, w, h) {
  if (src.width === w && src.height === h) return src;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  const d = src.data;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(src.height - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(src.width - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = d[(y0 * src.width + x0) * 4 + c] * (1 - tx) + d[(y0 * src.width + x1) * 4 + c] * tx;
        const b = d[(y1 * src.width + x0) * 4 + c] * (1 - tx) + d[(y1 * src.width + x1) * 4 + c] * tx;
        out[(y * w + x) * 4 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return { width: w, height: h, data: out };
}

function decodeError(asset) {
  return new Error(asset.external ? 'The linked image could not be loaded. Embed it and try again.' : 'The image could not be decoded.');
}

/**
 * Natural pixel size of an asset: { width, height }. Learning it does not
 * read the pixels, so tracing a large photo keeps only the pixels it traces.
 */
export async function assetSize(doc, assetId) {
  const asset = doc.assets.get(assetId);
  if (!asset) throw new Error('The image data is missing.');
  const known = sizes.get(asset);
  if (known) return known;
  let size;
  if (pixelSource) {
    const src = await pixelSource(doc, assetId);
    if (!src) throw new Error('The image could not be read.');
    size = { width: src.width, height: src.height };
  } else {
    let img;
    try {
      img = await decodeAsset(asset);
    } catch {
      throw decodeError(asset);
    }
    if (!img) throw new Error('Images cannot be read here.');
    size = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
    lastDecoded = { asset, img };
  }
  sizes.set(asset, size);
  return size;
}

/**
 * Pixels of an asset. size: null for natural size, else { w, h }.
 * Resolves to { width, height, data, naturalWidth, naturalHeight }.
 * Throws a readable error when the image cannot be read.
 */
export async function assetPixels(doc, assetId, size) {
  const asset = doc.assets.get(assetId);
  if (!asset) throw new Error('The image data is missing.');
  const decoded = lastDecoded?.asset === asset ? lastDecoded.img : null;
  lastDecoded = null;
  const key = `${assetId}:${size ? `${size.w}x${size.h}` : 'full'}`;
  if (cache.has(key)) return remember(key, cache.get(key));
  if (pixelSource) {
    const src = await pixelSource(doc, assetId);
    if (!src) throw new Error('The image could not be read.');
    const px = size ? resample(src, size.w, size.h) : src;
    return remember(key, { ...px, naturalWidth: src.width, naturalHeight: src.height });
  }
  let img = decoded;
  if (!img) {
    try {
      img = await decodeAsset(asset);
    } catch {
      throw decodeError(asset);
    }
  }
  if (!img) throw new Error('Images cannot be read here.');
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  sizes.set(asset, { width: nw, height: nh });
  const w = size ? size.w : nw;
  const h = size ? size.h : nh;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    throw new Error('This linked image does not allow reading its pixels. Embed it and try again.');
  }
  return remember(key, { width: w, height: h, data: data.data, naturalWidth: nw, naturalHeight: nh });
}

/** Pixels at the working resolution for `detail`, plus the scale from natural pixels. */
export async function tracePixels(doc, assetId, detail) {
  const full = await assetSize(doc, assetId);
  const g = gridSize(full.width, full.height, detail);
  const px = await assetPixels(doc, assetId, g.w === full.width && g.h === full.height ? null : { w: g.w, h: g.h });
  return { image: { width: px.width, height: px.height, data: px.data }, scale: g.w / full.width, natural: { width: full.width, height: full.height } };
}

function abortError() {
  const e = new Error('Tracing was cancelled.');
  e.name = 'AbortError';
  return e;
}

let workerFailed = false;

/**
 * Trace pixels. extra: { scale, swatches }. opts: { onProgress, signal, worker }.
 * Resolves to the trace result; rejects with an AbortError when cancelled.
 */
export function runTrace(image, options, extra = {}, { onProgress = null, signal = null, worker: useWorker = true } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (useWorker && !workerFailed && typeof Worker !== 'undefined') {
    let w;
    try {
      w = new Worker(new URL('./trace.worker.js', import.meta.url), { type: 'module' });
    } catch {
      workerFailed = true;
    }
    if (w) {
      return new Promise((resolve, reject) => {
        const done = () => {
          w.terminate();
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          done();
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort);
        w.onmessage = (e) => {
          const m = e.data;
          if (m.progress !== undefined) onProgress?.(m.progress);
          else if (m.error) {
            done();
            reject(new Error(m.error));
          } else if (m.result) {
            done();
            resolve(m.result);
          }
        };
        w.onerror = (e) => {
          // A worker that cannot start (blocked, unsupported) falls back to the main thread.
          e.preventDefault?.();
          done();
          workerFailed = true;
          runTrace(image, options, extra, { onProgress, signal, worker: false }).then(resolve, reject);
        };
        // Copy the pixels: cached buffers must stay usable here.
        const data = new Uint8ClampedArray(image.data);
        w.postMessage({ image: { width: image.width, height: image.height, data }, options, extra }, [data.buffer]);
      });
    }
  }
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (signal?.aborted) return reject(abortError());
      try {
        resolve(traceImage(image, options, { ...extra, onProgress }));
      } catch (err) {
        reject(err);
      }
    }, 0);
  });
}
