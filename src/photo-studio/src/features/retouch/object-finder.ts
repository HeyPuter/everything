// Highlight Objects for the Object Selection tool: the objects of the image are
// found in the background (see imaging/segment/objects) while the tool is
// active; the one under the pointer is highlighted and a click selects it.
// Results are kept per source image, so moving the selection or switching
// tools does not search again.
import type { Editor } from '../../editor';
import type { DetectedObject } from '../../imaging/segment/objects';
import type { Mask8 } from '../../imaging/types';
import { runJob } from '../assist/client';
import { sourceImage, sourceKey } from './source';

/** The smallest object containing the point (the most specific one), or -1. */
export function objectAt(
  objects: Pick<DetectedObject, 'rect' | 'mask' | 'area'>[],
  x: number,
  y: number,
): number {
  let best = -1;
  objects.forEach((o, i) => {
    const lx = Math.floor(x) - o.rect.x,
      ly = Math.floor(y) - o.rect.y;
    if (lx < 0 || ly < 0 || lx >= o.rect.width || ly >= o.rect.height) return;
    if (o.mask.data[ly * o.mask.width + lx] < 128) return;
    if (best < 0 || o.area < objects[best].area) best = i;
  });
  return best;
}

/** Tinted pixels for a highlight: a light fill inside the object and a solid edge. */
export function highlightRGBA(
  m: Mask8,
  rgb: [number, number, number],
  fill = 0.3,
): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, data } = m;
  const out = new Uint8ClampedArray(w * h * 4);
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 128;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      const edge =
        inside(x, y) &&
        (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1));
      out.set([rgb[0], rgb[1], rgb[2], edge ? 255 : Math.round(data[i] * fill)], i * 4);
    }
  return out;
}

type Found = {
  key: string;
  objects?: DetectedObject[];
  pending?: Promise<void>;
  urls: Map<number, string>;
};
let found: Found | undefined;
let hovered = -1;

export const finderOn = (e: Editor) => e.settings.objectFinder !== false;
const sampleAll = (e: Editor) => e.settings.objectSampleAll !== false;
// The source key serializes the layer stack; documents are immutable, so it
// is computed once per layer list (not on every pointer move).
let memo: { layers: unknown; layer: string; all: boolean; size: string; key: string } | undefined;
function keyOf(e: Editor) {
  const all = sampleAll(e),
    layer = e.selected,
    size = `${e.doc.width}x${e.doc.height}`;
  if (
    !memo ||
    memo.layers !== e.doc.layers ||
    memo.layer !== layer ||
    memo.all !== all ||
    memo.size !== size
  )
    memo = { layers: e.doc.layers, layer, all, size, key: sourceKey(e, all) };
  return memo.key;
}

/** Start finding the objects of the current source, unless already found. */
export function findObjects(e: Editor, force = false) {
  if (!e.hasDocument || !finderOn(e)) return;
  const key = keyOf(e);
  if (!force && found?.key === key) return;
  const entry: Found = { key, urls: new Map() };
  found = entry;
  hovered = -1;
  e.message('Finding objects…');
  entry.pending = (async () => {
    const img = await sourceImage(e, sampleAll(e));
    const objects = await runJob<DetectedObject[]>(undefined, 'objects', {
      img: { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) },
      opts: { minSize: 0.002, maxObjects: 32 },
    });
    if (found !== entry) return;
    entry.objects = objects;
    e.message(
      objects.length
        ? `${objects.length} ${objects.length === 1 ? 'object' : 'objects'} found. Point at one and click to select it.`
        : 'No distinct objects found. Drag around an object instead.',
    );
    e.overlay();
  })().catch(() => {
    if (found === entry) found = undefined;
  });
}
/** Objects found for the image as it is now. */
function current(e: Editor) {
  return found && found.key === keyOf(e) ? found : undefined;
}
export function finderHover(e: Editor, x: number, y: number) {
  const f = current(e);
  if (!f?.objects) {
    findObjects(e);
    return;
  }
  const next = finderOn(e) ? objectAt(f.objects, x, y) : -1;
  if (next === hovered) return;
  hovered = next;
  e.overlay();
}
export function finderClear(e?: Editor) {
  if (hovered < 0) return;
  hovered = -1;
  e?.overlay();
}
/** The object under a point, for a click. */
export function finderObject(e: Editor, x: number, y: number): DetectedObject | undefined {
  const f = current(e);
  if (!f?.objects || !finderOn(e)) return undefined;
  return f.objects[objectAt(f.objects, x, y)];
}
function highlightUrl(f: Found, i: number, rgb: [number, number, number]) {
  let url = f.urls.get(i);
  if (url) return url;
  const o = f.objects![i];
  const c = document.createElement('canvas');
  c.width = o.rect.width;
  c.height = o.rect.height;
  c.getContext('2d')!.putImageData(
    new ImageData(highlightRGBA(o.mask, rgb), o.rect.width, o.rect.height),
    0,
    0,
  );
  url = c.toDataURL();
  f.urls.set(i, url);
  return url;
}
/** Highlights over the canvas: the hovered object, or every object with Show All Objects. */
export function finderOverlay(e: Editor) {
  const f = current(e);
  if (!f?.objects || !finderOn(e)) return '';
  const all = !!e.settings.objectShowAll;
  const list = all ? f.objects.map((_, i) => i) : hovered >= 0 ? [hovered] : [];
  return list
    .map((i) => {
      const o = f.objects![i];
      const href = highlightUrl(f, i, [80, 150, 255]);
      return `<image class="object-finder" href="${href}" x="${o.rect.x}" y="${o.rect.y}" width="${o.rect.width}" height="${o.rect.height}" preserveAspectRatio="none" opacity="${all && i !== hovered ? 0.6 : 1}"/>`;
    })
    .join('');
}
