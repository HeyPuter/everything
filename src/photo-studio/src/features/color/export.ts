// Mode-aware export: recompute the real channel data (CMYK planes, gray,
// Lab, palette indices, 1-bit) from the document's composite and write it
// with an embedded profile. The Export dialog (files feature) can call
// `exportModeTiff` / `exportModePng`; File > Export lists the commands.
import type { Editor } from '../../editor';
import type { PhotoDocument } from '../../model/document';
import type { RGBA8 } from '../../imaging/types';
import {
  cachedTransform,
  bakeLut3D,
  rgbToLab,
  serializeIcc,
  transformToCMYK,
  transformToGray,
  type Profile,
} from '../../color/color-management';
import { compositeRGBA } from '../pixels';
import { colorSettings, docCmykProfile, docCmykRef, docGrayProfile, docProfile, ensureProfile } from './profiles';
import { duotoneMap, flattenOn } from './convert';
import { bitmapPng, encodeCmykTiff, encodeGrayTiff, encodeLabTiff, grayPng, palettePng, rgbaPng } from './encode';
import { encodeTiff } from '../../imaging/codecs/tiff';

export type ModeFile = { bytes: Uint8Array; mime: string; extension: string; description: string };

const dpiOf = (doc: PhotoDocument) => {
  const r = doc.resolution;
  if (!r) return undefined;
  return r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution;
};
function profileBytes(p: Profile): Uint8Array {
  return serializeIcc(p);
}

/** Encode a composite as TIFF in the document's mode (or `force` mode). */
export function encodeModeTiff(doc: PhotoDocument, img: RGBA8, force?: 'cmyk'): ModeFile {
  const mode = force ?? doc.mode ?? 'rgb';
  const dp = docProfile(doc);
  const dpi = dpiOf(doc);
  const s = colorSettings();
  if (mode === 'cmyk') {
    const cmyk = docCmykProfile(doc);
    // A CMYK document's pixels are already the printable colors of its inks
    // (converted back relative colorimetric): separate them the same way so
    // a perceptual or saturation conversion is not applied a second time.
    const intent = doc.mode === 'cmyk' ? 'relative' : s.intent;
    // CMYK TIFF carries no transparency here: composite over paper white.
    const planes = transformToCMYK(flattenOn(img), bakeLut3D(cachedTransform(dp, cmyk, intent, { bpc: s.bpc }), 33));
    return { bytes: encodeCmykTiff(planes, { icc: profileBytes(cmyk), dpi }), mime: 'image/tiff', extension: 'tif', description: `CMYK TIFF (${cmyk.name})` };
  }
  if (mode === 'grayscale' || mode === 'bitmap') {
    const gray = docGrayProfile(doc);
    const g = transformToGray(img, bakeLut3D(cachedTransform(dp, gray, s.intent, { bpc: s.bpc }), 33));
    const opaque = g.alpha.every((a) => a === 255);
    return { bytes: encodeGrayTiff(g.gray, opaque ? null : g.alpha, img.width, img.height, { icc: profileBytes(gray), dpi }), mime: 'image/tiff', extension: 'tif', description: `Grayscale TIFF (${gray.name})` };
  }
  if (mode === 'lab') {
    const lab = rgbToLab(flattenOn(img), dp);
    return { bytes: encodeLabTiff(lab, { dpi }), mime: 'image/tiff', extension: 'tif', description: 'CIELab TIFF' };
  }
  // RGB, Indexed and Duotone (inks rendered) as RGB with the document profile.
  const rgb = mode === 'duotone' && doc.modeData?.inks?.length
    ? duotoneMap(dp, docGrayProfile(doc), doc.modeData.inks.map((i) => ({ name: i.name, color: [1, 3, 5].map((k) => parseInt(i.color.slice(k, k + 2), 16)) as [number, number, number], curve: i.curve })))(img)
    : img;
  const opaque = !rgb.data.some((_, i) => i % 4 === 3 && rgb.data[i] !== 255);
  let data: Uint8Array = new Uint8Array(rgb.data.buffer, rgb.data.byteOffset, rgb.data.length);
  if (opaque) {
    data = new Uint8Array(img.width * img.height * 3);
    for (let p = 0; p < img.width * img.height; p++) data.set(rgb.data.subarray(p * 4, p * 4 + 3), p * 3);
  }
  const bytes = encodeTiff({ width: img.width, height: img.height, data, channels: opaque ? 3 : 4 }, { compression: 'lzw', predictor: true, icc: profileBytes(dp), dpi });
  return { bytes, mime: 'image/tiff', extension: 'tif', description: `RGB TIFF (${dp.name})` };
}

/** PNG that keeps the mode where PNG can: 8-bit gray, 1-bit, palette. */
export function encodeModePng(doc: PhotoDocument, img: RGBA8): ModeFile {
  const mode = doc.mode ?? 'rgb';
  const dp = docProfile(doc);
  const dpi = dpiOf(doc);
  const s = colorSettings();
  if (mode === 'grayscale') {
    const gray = docGrayProfile(doc);
    const g = transformToGray(img, bakeLut3D(cachedTransform(dp, gray, s.intent, { bpc: s.bpc }), 33));
    const opaque = g.alpha.every((a) => a === 255);
    return { bytes: grayPng(g.gray, opaque ? null : g.alpha, img.width, img.height, { name: gray.name, bytes: profileBytes(gray) }, dpi), mime: 'image/png', extension: 'png', description: 'Grayscale PNG' };
  }
  if (mode === 'bitmap') {
    const bits = new Uint8Array(img.width * img.height);
    const flat = flattenOn(img);
    for (let p = 0; p < bits.length; p++) bits[p] = flat.data[p * 4] < 128 ? 1 : 0;
    return { bytes: bitmapPng(bits, img.width, img.height, dpi), mime: 'image/png', extension: 'png', description: '1-bit PNG' };
  }
  if (mode === 'indexed' && doc.modeData?.palette?.length) {
    const pal = doc.modeData.palette;
    const t = doc.modeData.transparentIndex ?? -1;
    const palette = new Uint8Array(pal.length * 3);
    const lookup = new Map<number, number>();
    pal.forEach((c, i) => {
      const v = parseInt(c.slice(1), 16);
      palette.set([v >> 16, (v >> 8) & 255, v & 255], i * 3);
      if (i !== t && !lookup.has(v)) lookup.set(v, i);
    });
    const indices = new Uint8Array(img.width * img.height);
    let misses = 0;
    for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
      if (t >= 0 && img.data[i + 3] < 128) {
        indices[p] = t;
        continue;
      }
      const v = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      let k = lookup.get(v);
      if (k === undefined) {
        // Edited after conversion: nearest palette entry.
        misses++;
        let best = 0,
          dist = Infinity;
        for (let j = 0; j < pal.length; j++) {
          if (j === t) continue;
          const d = (palette[j * 3] - img.data[i]) ** 2 + (palette[j * 3 + 1] - img.data[i + 1]) ** 2 + (palette[j * 3 + 2] - img.data[i + 2]) ** 2;
          if (d < dist) {
            dist = d;
            best = j;
          }
        }
        k = best;
        lookup.set(v, k);
      }
      indices[p] = k;
    }
    return { bytes: palettePng(indices, palette, t, img.width, img.height, dpi), mime: 'image/png', extension: 'png', description: `Indexed PNG (${pal.length} colors${misses ? `, ${misses} edited pixels mapped to the nearest entry` : ''})` };
  }
  return { bytes: rgbaPng(img, { name: dp.name, bytes: profileBytes(dp) }, dpi), mime: 'image/png', extension: 'png', description: 'RGBA PNG' };
}

async function save(e: Editor, f: ModeFile) {
  const { download } = await import('../../persistence/puter');
  const name = `${e.doc.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled'}.${f.extension}`;
  download(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.mime }), name);
  e.message(`Exported ${name}: ${f.description}.`);
}

/** Export the document as a TIFF in its image mode (CMYK, Gray, Lab, RGB). */
export async function exportModeTiff(e: Editor, force?: 'cmyk'): Promise<ModeFile> {
  const img = await compositeRGBA(e);
  if (force === 'cmyk' || e.doc.mode === 'cmyk') {
    e.message('Preparing the CMYK separation…');
    await ensureProfile(docCmykRef(e.doc));
  }
  const f = encodeModeTiff(e.doc, img, force);
  await save(e, f);
  return f;
}
export async function exportModePng(e: Editor): Promise<ModeFile> {
  const f = encodeModePng(e.doc, await compositeRGBA(e));
  await save(e, f);
  return f;
}
