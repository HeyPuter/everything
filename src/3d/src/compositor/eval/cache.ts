// GPU textures kept between evaluations (render passes, decoded images, generated sources), and
// asynchronous decoding of image data-blocks.
import type { ImageData as Img } from '../../data/types';
import { imageCanvas } from '../../render/images';
import type { Gpu, Texture } from '../gpu/gpu';

interface Entry {
  tex: Texture;
  used: number;
}

const entries = new Map<string, Entry>();
let generation = 0;

/** Texture for `key`, created by `make` on a miss (kept while used by recent evaluations). */
export function cachedTexture(key: string, make: () => Texture): Texture {
  const e = entries.get(key);
  if (e) {
    e.used = generation;
    return e.tex;
  }
  const tex = make();
  entries.set(key, { tex, used: generation });
  return tex;
}

/** Start an evaluation generation. */
export function beginGeneration() {
  generation++;
}

/** Free cached textures not used during the last `keep` generations. */
export function sweepCache(gpu: Gpu, keep = 2) {
  for (const [k, e] of entries)
    if (generation - e.used >= keep) {
      gpu.free(e.tex);
      entries.delete(k);
    }
}

export function clearCache(gpu: Gpu) {
  for (const e of entries.values()) gpu.free(e.tex);
  entries.clear();
}

// ---------------------------------------------------------------------------
// image decoding

interface Decoded {
  key: string;
  bmp: ImageBitmap | null;
  failed?: boolean;
}

const decoded = new Map<string, Decoded>();
let onDecoded: (() => void) | null = null;
/** Called whenever an image finished decoding (the compositor re-runs). */
export function setImageDecodedCallback(fn: () => void) {
  onDecoded = fn;
}
/** Tell the compositor that pixels it waited for (images, movie frames) became available. */
export function notifyDecoded() {
  onDecoded?.();
}

export function imageKey(img: Img): string {
  return `${img.id}|${img.revision ?? 0}|${img.bytes?.length ?? 0}|${img.width}x${img.height}|${img.source}|${img.generated_type}|${img.generated_color?.join(',')}|${img.colorspace}|${img.alpha_mode ?? ''}`;
}

/**
 * Pixel source of an image (rows top-down, straight alpha), or null while it is decoding.
 * File images are decoded from their bytes; generated and painted images use their canvas.
 */
export function imageSource(img: Img): { src: TexImageSource; w: number; h: number } | null {
  if (img.bytes && img.bytes.length && !img.revision) {
    const key = imageKey(img);
    const d = decoded.get(img.id);
    if (d && d.key === key) {
      if (d.bmp) return { src: d.bmp, w: d.bmp.width, h: d.bmp.height };
      if (d.failed) return null;
      return null;
    }
    const entry: Decoded = { key, bmp: null };
    decoded.set(img.id, entry);
    const blob = new Blob([img.bytes as Uint8Array<ArrayBuffer>], {
      type: img.mime,
    });
    createImageBitmap(blob, {
      imageOrientation: 'none',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
      .then((bmp) => {
        if (decoded.get(img.id) !== entry) return bmp.close();
        entry.bmp = bmp;
        onDecoded?.();
      })
      .catch(() => {
        entry.failed = true;
      });
    return null;
  }
  const c = imageCanvas(img);
  return { src: c, w: c.width, h: c.height };
}
