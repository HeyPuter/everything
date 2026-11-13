// Rendered frames for the Timeline: small thumbnails for the frame strip and
// larger images for onion skins. Each frame is composited by the renderer
// (one at a time, between edits) and cached by the content it shows, so
// selecting another frame or editing one layer only re-renders what changed.
import type { Editor } from '../../editor';
import type { PhotoDocument } from '../../model/document';
import { frameContent, frameDocument, sharedContent } from '../../model/animation';

export type FrameImage = { thumb: string; onion: string; width: number; height: number };
const cache = new Map<string, FrameImage>();
const maxEntries = 600;
const thumbBox = { width: 112, height: 72 };
const onionMax = 1280;
// Build frame documents only when their job runs. Queued thumbnails share
// the source snapshot instead of retaining a full document copy per frame.
let queue: { key: string; doc: () => PhotoDocument | Promise<PhotoDocument>; e: Editor; assets: Editor['assets'] }[] = [];
let running = false;
const listeners = new Set<() => void>();

/** Called whenever a requested frame finished rendering. */
export function onFrameRendered(fn: () => void) {
  listeners.add(fn);
}

// 53-bit string hash (cyrb53), enough to key renders of document states.
function hash(s: string) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const keys = new WeakMap<PhotoDocument, { base: string; frames: Map<number, string> }>();
/** Cache key of what frame `index` shows (memoized per document state). It is
 * built from the shared content and the frame's records, so selecting another
 * frame keeps every key and no frame document is built. */
export function frameKey(e: Editor, doc: PhotoDocument, index: number) {
  let entry = keys.get(doc);
  if (!entry) keys.set(doc, (entry = { base: `${e.session.id}:${doc.width}x${doc.height}:${doc.bitsPerChannel ?? 8}:${hash(sharedContent(doc))}:${hash(JSON.stringify([doc.globalLight, doc.patterns]))}`, frames: new Map() }));
  let key = entry.frames.get(index);
  if (key === undefined) entry.frames.set(index, (key = `${entry.base}:${hash(frameContent(doc, index))}`));
  return key;
}

/** The cached render of frame `index`, queueing it when missing. */
export function frameImage(e: Editor, doc: PhotoDocument, index: number, key = frameKey(e, doc, index)): FrameImage | undefined {
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (!queue.some((q) => q.key === key)) queue.push({ key, doc: () => frameDocument(doc, index), e, assets: e.assets });
  void pump();
}

/** The cached render for `key`, queueing `build` when missing. */
export function docImage(e: Editor, key: string, build: () => Promise<PhotoDocument>): FrameImage | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (!queue.some((q) => q.key === key)) queue.push({ key, doc: build, e, assets: e.assets });
  void pump();
}

/** Drop queued renders (for example when the document changes again). */
export function clearQueue() {
  queue = [];
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue[0];
      const { e } = job;
      // Wait for gestures and commands to finish; the compositor is shared.
      if (e.busy || e.toolBusy || !e.renderer) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      queue.shift();
      if (cache.has(job.key)) continue;
      try {
        cache.set(job.key, await render(e, await job.doc(), job.assets));
        while (cache.size > maxEntries) {
          const [oldest, img] = cache.entries().next().value!;
          URL.revokeObjectURL(img.thumb);
          URL.revokeObjectURL(img.onion);
          cache.delete(oldest);
        }
        for (const fn of listeners) fn();
      } catch {
        /* A failed thumbnail leaves its placeholder. */
      }
    }
  } finally {
    running = false;
  }
}

/** Composite a document and return straight 8-bit RGBA. */
export async function compositeFrame(e: Editor, doc: PhotoDocument, assets = e.assets): Promise<ImageData> {
  const samples = await e.renderer.documentPixels({ ...doc, selection: null }, assets);
  const n = doc.width * doc.height * 4;
  const data = new Uint8ClampedArray(n);
  if (samples instanceof Float32Array) for (let i = 0; i < n; i++) data[i] = samples[i] * 255 + 0.5;
  else data.set(samples.subarray(0, n));
  return new ImageData(data, doc.width, doc.height);
}

async function render(e: Editor, doc: PhotoDocument, assets: Editor['assets']): Promise<FrameImage> {
  const img = await compositeFrame(e, doc, assets);
  const full = new OffscreenCanvas(img.width, img.height);
  full.getContext('2d')!.putImageData(img, 0, 0);
  const scaled = async (k: number) => {
    const w = Math.max(1, Math.round(img.width * k)),
      h = Math.max(1, Math.round(img.height * k));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(full, 0, 0, w, h);
    return URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
  };
  const thumb = await scaled(Math.min(1, thumbBox.width / img.width, thumbBox.height / img.height));
  const onion = await scaled(Math.min(1, onionMax / Math.max(img.width, img.height)));
  return { thumb, onion, width: img.width, height: img.height };
}
