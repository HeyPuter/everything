// Applying data sets: visibility and text changes, and pixel replacement
// from a folder of images the user picked (kept for the browser session).

import type { Editor } from '../../editor';
import { findLayer, type Layer, type PhotoDocument, type Rect } from '../../model/document';
import type { Assets } from '../../model/assets';
import { gridFromImage } from '../../model/tiles';
import { setLayerPixels } from '../../model/pixel-layer';
import { fitTextFrame, syncLegacyFields, textLayerName } from '../../model/text-layer';
import { pixelPlacement, setChanges, type DataSet, type PixelVariable } from '../../model/variables';
import { setPlainText } from '../../imaging/text/model';
import { prepareFonts } from '../../imaging/text/fonts';
import type { RGBA8 } from '../../imaging/types';
import { readRgbProfile } from '../../color/profile';
import { convertToSrgb } from '../files/color';
import { decodeFile } from '../files/open';
import { contentsFromFile } from '../embedded/contents';
import { editable, layoutOf, localBounds, ppiOf, replaceLayer } from '../type/text-utils';

// ------------------------------------------------------------ image folder

const images = new Map<string, File>();
let folderLabel = '';
const key = (name: string) => name.trim().replace(/\\/g, '/').toLowerCase();

/** Files that pixel values are matched against: by name, or by path inside the folder. */
export function setImageFiles(files: File[]) {
  images.clear();
  for (const f of files) {
    if (!/^image\/|\.(psd|psb|tiff?|tga|bmp|ico|webp|avif|heic|photo)$/i.test(f.type || f.name)) continue;
    images.set(key(f.name), f);
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    // "folder/sub/a.png" also matches "sub/a.png".
    if (rel) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) images.set(key(parts.slice(i).join('/')), f);
      folderLabel = parts[0];
    }
  }
  if (!files.some((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath)) folderLabel = `${files.length} file${files.length === 1 ? '' : 's'}`;
}
export const imageFolderLabel = () => (images.size ? folderLabel : '');
export const imageNames = () => [...new Set([...images.values()].map((f) => f.name))].sort();
export function findImage(name: string): File | undefined {
  const k = key(name);
  return images.get(k) ?? images.get(k.split('/').pop()!);
}

/** Ask for a folder of images (or several image files where folders cannot be picked). */
export function chooseImageFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // Folders where supported; otherwise any number of image files.
    input.webkitdirectory = true;
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

// ------------------------------------------------------------ applying

export type Applied = { doc: PhotoDocument; missing: string[]; failed: string[] };

/** The document with a data set applied (a new snapshot; nothing is committed).
 * New pixel content goes into `assets`. */
export async function documentWithSet(e: Editor, base: PhotoDocument, set: DataSet, assets: Assets = e.assets): Promise<Applied> {
  const { visible, text, pixel } = setChanges(base, set);
  let doc = base;
  const missing: string[] = [];
  const failed: string[] = [];
  const ppi = ppiOf(base);
  for (const [id, v] of visible) doc = replaceLayer(doc, id, (l) => (l.visible === v ? l : { ...l, visible: v }));
  for (const [id, value] of text) {
    const l = findLayer(doc.layers, id);
    if (!l || l.kind !== 'text') continue;
    const t = editable(l, ppi);
    if (t.text === value && t.textData) continue;
    const data = { ...t.textData, content: setPlainText(t.textData.content, value) };
    await prepareFonts(data);
    const n: Layer = { ...t, textData: data };
    delete n.asset;
    delete n.assetColorSpace;
    fitTextFrame(n, localBounds(data, layoutOf(data, ppi)));
    // Names that follow the text keep following it.
    if (l.name === textLayerName(t.textData.content) || l.name === l.text) n.name = textLayerName(data.content);
    syncLegacyFields(n);
    doc = replaceLayer(doc, id, () => n);
  }
  for (const [id, { file: name, variable }] of pixel) {
    const l = findLayer(doc.layers, id);
    if (!l) continue;
    const file = findImage(name);
    if (!file) {
      missing.push(name);
      continue;
    }
    try {
      if (l.kind === 'image') {
        const c = await contentsFromFile(e, doc, assets, file, file.name);
        const place = pixelPlacement(variable, c.width, c.height);
        doc = { ...doc, embeds: { ...doc.embeds, [c.id]: c } };
        doc = replaceLayer(doc, id, (x) => {
          const n: Layer = { ...x, asset: c.composite, assetColorSpace: c.colorSpace, sourceWidth: c.width, sourceHeight: c.height, embed: { contents: c.id }, transform: { ...place, rotation: 0 } };
          return n;
        });
      } else if (l.kind === 'pixel') {
        const img = await decodeImage(file);
        const placed = placeImage(img, variable);
        const grid = gridFromImage(assets.tiles, placed.image, placed.x, placed.y);
        doc = replaceLayer(doc, id, (x) => {
          const n: Layer = { ...x };
          setLayerPixels(n, grid, doc);
          return n;
        });
      }
    } catch {
      failed.push(name);
    }
  }
  return { doc, missing, failed };
}

async function decodeImage(file: File): Promise<RGBA8> {
  const decoded = await decodeFile(file, file.name, { pages: 'first' });
  if (decoded.icc)
    try {
      convertToSrgb(decoded.image.data, readRgbProfile(decoded.icc));
    } catch {
      /* Shown as sRGB, as when the file is opened. */
    }
  return decoded.image;
}

/** The image resampled into its placement (cropped to the bounds when clipping). */
export function placeImage(img: RGBA8, v: PixelVariable): { image: RGBA8; x: number; y: number } {
  const place = pixelPlacement(v, img.width, img.height);
  let r: Rect = place;
  if (v.clip) {
    const b = v.bounds;
    const x0 = Math.max(place.x, b.x), y0 = Math.max(place.y, b.y);
    r = { x: x0, y: y0, width: Math.min(place.x + place.width, b.x + b.width) - x0, height: Math.min(place.y + place.height, b.y + b.height) - y0 };
  }
  const x = Math.round(r.x), y = Math.round(r.y);
  const w = Math.max(1, Math.min(8192, Math.round(r.x + r.width) - x)), h = Math.max(1, Math.min(8192, Math.round(r.y + r.height) - y));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const out = new OffscreenCanvas(w, h);
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, place.x - x, place.y - y, place.width, place.height);
  return { image: { width: w, height: h, data: g.getImageData(0, 0, w, h).data }, x, y };
}

/** Apply a set to the open document as one undo step. */
export async function applySet(e: Editor, index: number, label = 'Apply Data Set'): Promise<Applied | undefined> {
  // Preparing text and images takes a while; when the document changes
  // meanwhile (another edit, someone else in a shared document), the set is
  // prepared again for the document as it is now.
  for (let tries = 0; tries < 3; tries++) {
    const before = e.doc;
    const set = before.variables?.sets[index];
    if (!set) return;
    const r = await documentWithSet(e, before, set);
    if (e.doc !== before) continue;
    e.command(label, (d) => {
      d.layers = structuredClone(r.doc.layers);
      if (r.doc.embeds) d.embeds = structuredClone(r.doc.embeds);
      if (d.variables) d.variables.current = index;
    });
    reportMissing(e, r);
    return r;
  }
  e.message('The data set was not applied: the document kept changing while it was prepared. Try again.');
}

export function reportMissing(e: Editor, r: Applied) {
  if (r.missing.length) e.message(images.size ? `No image named ${[...new Set(r.missing)].join(', ')} in the chosen folder.` : 'Choose the folder of replacement images (Data Sets…) to apply pixel replacement.');
  else if (r.failed.length) e.message(`Could not read ${[...new Set(r.failed)].join(', ')}.`);
}
