// Recording AI results in Generation History. The dialogs that generate call
// `recordGeneration` with every image that arrived; recording never blocks or
// fails the edit itself (storage errors are ignored).
import type { Editor } from '../../editor';
import type { RGBA8 } from '../../imaging/types';
import { GenerationStore, type GenerationEntry, type GenerationKind } from '../../persistence/generations';

// Stored images keep at most this many pixels on the longer side (providers
// return about one megapixel; the AI layer of Upscale up to about 4K).
const STORE_MAX_SIDE = 4096;
const THUMB_SIDE = 160;

let store: GenerationStore | undefined;
export const generationStore = () => (store ??= new GenerationStore());
/** Replace the store (tests). */
export function setGenerationStore(s: GenerationStore) {
  store = s;
}
const listeners = new Set<() => void>();
export function onGenerationsChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function generationsChanged() {
  for (const fn of listeners) fn();
}

/** Encode RGBA pixels as PNG, scaled down to fit `max` on the longer side. */
export async function encodePng(img: RGBA8, max = Infinity): Promise<Blob> {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)),
    h = Math.max(1, Math.round(img.height * s));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  if (s === 1) return src.convertToBlob({ type: 'image/png' });
  const out = new OffscreenCanvas(w, h);
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return out.convertToBlob({ type: 'image/png' });
}

export type GenerationRecord = {
  kind: GenerationKind;
  prompt: string;
  settings?: Record<string, unknown>;
  model?: string;
  placement?: { x: number; y: number; width?: number; height?: number };
};

/** Store one or more results of a generation (each image is its own entry). */
export async function recordGeneration(e: Editor, r: GenerationRecord, images: RGBA8 | RGBA8[]): Promise<GenerationEntry[]> {
  const list = Array.isArray(images) ? images : [images];
  const doc = e.hasDocument ? e.doc : undefined;
  const out: GenerationEntry[] = [];
  try {
    for (const [i, img] of list.entries()) {
      const [image, thumb] = await Promise.all([encodePng(img, STORE_MAX_SIDE), encodePng(img, THUMB_SIDE)]);
      const s = Math.min(1, STORE_MAX_SIDE / Math.max(img.width, img.height));
      out.push(
        await generationStore().add(
          {
            kind: r.kind,
            prompt: r.prompt.slice(0, 4000),
            settings: { ...(r.settings ?? {}), ...(list.length > 1 ? { variation: i + 1 } : {}) },
            model: r.model || undefined,
            placement: r.placement,
            docId: doc?.id,
            docName: doc?.name ?? 'Untitled',
            width: Math.max(1, Math.round(img.width * s)),
            height: Math.max(1, Math.round(img.height * s)),
            thumb,
          },
          image,
        ),
      );
    }
  } catch {
    // Storage is optional (private browsing, quota): the edit itself stands.
  }
  if (out.length) generationsChanged();
  return out;
}
