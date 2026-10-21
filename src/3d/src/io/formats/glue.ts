// Browser/app glue for the interchange formats: registration with File ▸ Import/Export,
// options dialogs, committing IR into the open document and reporting warnings.
import { app } from '../../app/app';
import type { ImageData } from '../../data/types';
import { imageCanvas, imageReady } from '../../render/images';
import { encodePngRgba } from './pngsync';
import { activeCollection, setMode } from '../../ops/object';
import { commitScene, type CommitOptions } from './to-document';
import type { IRScene } from './ir';
import { buildExportScene, type ExportOptions, type ExportScene } from './scene-builder';
import type { FormatOption } from './ui';

export { defineFormat, type FormatDef, type ExportFile, type ExportTarget, type ImportSource } from './formatops';

/** Commit an IR scene into the open document (one undo step is pushed by the caller). */
export function commitToApp(ir: IRScene, opts: CommitOptions = {}) {
  const doc = app.doc;
  if (doc.mode !== 'OBJECT') setMode(doc, 'OBJECT');
  const res = commitScene(doc, ir, { collection: activeCollection(doc), ...opts });
  for (const w of res.warnings) app.report('WARNING', w);
  if (!res.objects.length) app.report('WARNING', 'The file contained no importable objects');
  app.changed('doc', 'select');
  return res;
}

export function exportSceneFromApp(opts: ExportOptions): ExportScene {
  return buildExportScene(app.doc, opts, app.graph);
}

export function reportWarnings(warnings: string[]) {
  for (const w of [...new Set(warnings)]) app.report('WARNING', w);
}

/** Pixels of an image's canvas (null when it is not decoded yet). */
function canvasPixels(img: ImageData): globalThis.ImageData | null {
  if (img.bytes?.length && !imageReady(img)) return null;
  const c = imageCanvas(img);
  return c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
}

/**
 * Encode an image as PNG synchronously (exports run inside script calls). Images whose pixels
 * are not decoded yet pass their stored PNG/JPEG file through unchanged.
 */
export function encodeImagePng(img: ImageData): { bytes: Uint8Array; mime: string } | null {
  if (!img) return null;
  try {
    const px = canvasPixels(img);
    if (px) return { bytes: encodePngRgba(px.width, px.height, px.data, px.width * px.height > 4e6 ? 1 : 6), mime: 'image/png' };
    if (img.bytes?.length && /png|jpe?g/i.test(img.mime)) return { bytes: img.bytes, mime: img.mime };
  } catch {
    // canvas unavailable
  }
  return null;
}

export async function readFileBytes(file: File) {
  return new Uint8Array(await file.arrayBuffer());
}

export const APPLY_MODIFIERS: FormatOption = { id: 'apply_modifiers', label: 'Apply Modifiers', type: 'bool', default: true, description: 'Export the evaluated mesh (viewport modifier settings)' };

/** Pack roughness (→ G) and metallic (→ B) image channels into one PNG (glTF layout). */
export function packMetallicRoughnessPng(rough: { img: ImageData; channel: string } | null, metal: { img: ImageData; channel: string } | null): Uint8Array | null {
  try {
    const r = rough ? canvasPixels(rough.img) : null,
      m = metal ? canvasPixels(metal.img) : null;
    if ((rough && !r) || (metal && !m)) return null;
    const w = Math.max(r?.width ?? 1, m?.width ?? 1),
      h = Math.max(r?.height ?? 1, m?.height ?? 1);
    // nearest sampling when the two images differ in size
    const sample = (px: globalThis.ImageData, x: number, y: number, c: number) => px.data[(Math.min(px.height - 1, Math.floor((y * px.height) / h)) * px.width + Math.min(px.width - 1, Math.floor((x * px.width) / w))) * 4 + c];
    const ch = (c: string) => (c === 'G' ? 1 : c === 'B' ? 2 : c === 'A' ? 3 : 0);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        out[i] = 255;
        out[i + 1] = r ? sample(r, x, y, ch(rough!.channel)) : 255;
        out[i + 2] = m ? sample(m, x, y, ch(metal!.channel)) : 255;
        out[i + 3] = 255;
      }
    return encodePngRgba(w, h, out);
  } catch {
    return null;
  }
}
