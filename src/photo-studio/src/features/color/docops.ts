// Document-wide color operations: apply a pixel mapping to every pixel layer,
// embedded image and flat layer color, flatten for palette modes, and bring
// high-depth documents down to 8 bits per channel.
import type { Editor } from '../../editor';
import { allLayers, findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { clearToPixelLayer, newPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { gridFromImage, type TileGrid } from '../../model/tiles';
import type { Mat3 } from '../../imaging/filters/warp';
import { hexRgb, rgbHexString, syncLegacyFields } from '../../model/text-layer';
import { isVectorGradient } from '../../model/vector-gradient';
import { isVectorPattern } from '../../model/vector-pattern';
import type { RGBA8 } from '../../imaging/types';
import { builtinProfile, cachedTransform, type Profile } from '../../color/color-management';
import { compositeRGBA, toRGBA8 } from '../pixels';
import { mapGrid, mapHex, type PixelMap } from './convert';
import { rgbaPng } from './encode';
import { docProfile } from './profiles';

/**
 * 'convert': values change because the profile changes (Convert to Profile);
 * colors defined in sRGB (solid, text, sRGB images and fills) keep their
 * appearance through the renderer and are left alone.
 * 'constrain': every color is pushed into the mode's gamut, including colors
 * defined in sRGB (converted to document values, mapped and back).
 */
export type MapScope = 'convert' | 'constrain';
export type MapReport = { layers: number; skipped: string[] };

export function requireEightBit(e: Editor): boolean {
  if ((e.doc.bitsPerChannel ?? 8) > 8) {
    e.message('Convert the document to 8 Bits/Channel first (Image > Mode > 8 Bits/Channel).');
    return false;
  }
  return true;
}

function srgbHexMapper(map: PixelMap, prof: Profile): (hex: string) => string {
  if (prof.key === builtinProfile('srgb').key) return (hex) => mapHex(map, hex);
  const toDoc = cachedTransform(builtinProfile('srgb'), prof, 'relative');
  const toSrgb = cachedTransform(prof, builtinProfile('srgb'), 'relative');
  return (hex) => {
    const v = parseInt(hex.slice(1), 16);
    const d = toDoc.one([(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    const m = mapHex(map, '#' + d.map((x) => x.toString(16).padStart(2, '0')).join(''));
    const mv = parseInt(m.slice(1), 16);
    const s = toSrgb.one([(mv >> 16) / 255, ((mv >> 8) & 255) / 255, (mv & 255) / 255]);
    return '#' + s.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
  };
}

/** Stop an operation whose document is no longer the one shown (the user
 * switched documents or it changed while the operation waited). */
export function assertSameDocument(e: Editor, doc: PhotoDocument) {
  if (e.doc !== doc) throw new Error('The document changed while the conversion was prepared; nothing was converted. Try again.');
}

/** Apply `map` to the document's colors as one undo step; `mutate` adds the
 * document-level changes (mode, profile) to the same step. */
export async function mapDocument(e: Editor, label: string, map: PixelMap, scope: MapScope, mutate: (d: PhotoDocument) => void): Promise<MapReport> {
  const doc = e.doc;
  const prof = docProfile(doc);
  const skipped: string[] = [];
  // Embedded images: re-encode converted pixels as new immutable assets.
  const images = new Map<string, string>();
  for (const l of allLayers(doc.layers)) {
    if (l.kind !== 'image' || !l.asset) continue;
    if (scope === 'convert' && l.assetColorSpace === 'srgb') continue;
    if (e.assets.raster(l.asset)) {
      skipped.push(`${l.name} (high-depth source)`);
      continue;
    }
    const src = await e.renderer.sourcePixels({ ...l, strokes: [] }, e.assets);
    const img: RGBA8 = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.buffer, src.data.byteOffset, src.data.length) };
    const png = rgbaPng(map(img));
    images.set(l.id, await e.assets.add(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' })));
  }
  // Video layers: every frame converts alike. Footage frames are decoded and
  // kept as converted (altered) frames in their own placement.
  const videos = new Map<string, { altered: Record<string, TileGrid>; alteredMatrix: Record<string, Mat3> }>();
  for (const l of allLayers(doc.layers)) {
    const v = l.kind === 'pixel' ? l.video : undefined;
    if (!v) continue;
    const { footageGrid } = await import('../animation/video-frames');
    const { footageFrame } = await import('../../model/video-layer');
    const altered: Record<string, TileGrid> = {};
    const alteredMatrix: Record<string, Mat3> = { ...v.alteredMatrix };
    const converted = new Map<number, TileGrid>();
    for (let k = 0; k < v.frames; k++) {
      if (k % 10 === 0) e.message(`Converting ${l.name}: frame ${k + 1} of ${v.frames}…`);
      const a = v.altered?.[k];
      if (a) {
        altered[k] = mapGrid(e.assets.tiles, a, map);
        continue;
      }
      const j = footageFrame(v, k);
      if (j < 0) continue;
      let grid = converted.get(j);
      if (!grid) converted.set(j, (grid = mapGrid(e.assets.tiles, await footageGrid(e.session, v, j), map)));
      altered[k] = grid;
      if (v.matrix) alteredMatrix[k] = v.matrix;
    }
    videos.set(l.id, { altered, alteredMatrix });
  }
  const srgbHex = srgbHexMapper(map, prof);
  const srgbRgb = (c: readonly number[]) => hexRgb(srgbHex(rgbHexString(c)));
  // Decoding above can take a while; the step must land in the document it
  // was computed for, not one the user switched to meanwhile.
  assertSameDocument(e, doc);
  let layers = 0;
  e.command(label, (d) => {
    for (const l of allLayers(d.layers)) {
      let touched = false;
      if (l.kind === 'pixel' && l.pixels) {
        l.pixels = mapGrid(e.assets.tiles, l.pixels, map);
        // Live Filters re-render from their source: it changes alike.
        if (l.liveSource) l.liveSource = mapGrid(e.assets.tiles, l.liveSource, map);
        const video = videos.get(l.id);
        if (video && l.video) {
          l.video = { ...l.video, altered: video.altered };
          if (Object.keys(video.alteredMatrix).length) l.video.alteredMatrix = video.alteredMatrix;
          else delete l.video.alteredMatrix;
          if (!Object.keys(video.altered).length) delete l.video.altered;
        }
        touched = true;
      }
      const asset = images.get(l.id);
      if (asset) {
        l.asset = asset;
        l.assetColorSpace = 'document';
        touched = true;
      }
      if (l.kind === 'vector' && l.vector) {
        const fill = l.vector.fill;
        if (isVectorGradient(fill) || isVectorPattern(fill)) skipped.push(`${l.name} (gradient or pattern fill)`);
        else if ('rgb' in fill && fill.rgb) {
          if (fill.space === 'document') {
            const hex = mapHex(map, '#' + fill.rgb.map((v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join(''));
            l.vector.fill = { rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number], space: 'document' };
            touched = true;
          } else if (scope === 'constrain') {
            const hex = srgbHex('#' + fill.rgb.map((v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join(''));
            l.vector.fill = { rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number], space: 'srgb' };
            l.color = hex;
            touched = true;
          }
        }
      }
      if (scope === 'constrain' && (l.kind === 'solid' || l.kind === 'text') && /^#[0-9a-f]{6}$/i.test(l.color)) {
        l.color = srgbHex(l.color);
        touched = true;
      }
      // Type draws the colors of its runs (sRGB).
      if (scope === 'constrain' && l.textData) {
        for (const p of l.textData.content.paragraphs) for (const r of p.runs) r.style.color = srgbRgb(r.style.color);
        syncLegacyFields(l);
        touched = true;
      }
      if (l.kind === 'solid' && l.fill) skipped.push(`${l.name} (gradient or pattern fill)`);
      if (scope === 'constrain' && l.artboard?.color) {
        l.artboard.color = srgbHex(l.artboard.color);
        touched = true;
      }
      if (l.style && Object.keys(l.style).length) skipped.push(`${l.name} (layer style)`);
      if (l.kind === 'adjustment') skipped.push(`${l.name} (adjustment)`);
      if (touched) layers++;
    }
    // Character and paragraph styles keep matching the text that uses them.
    if (scope === 'constrain')
      for (const def of [...(d.textStyles?.character.map((c) => c.style) ?? []), ...(d.textStyles?.paragraph.map((p) => p.char) ?? [])])
        if (def.color) def.color = srgbRgb(def.color);
    d.patterns = d.patterns?.map((p) => ({ ...p, grid: mapGrid(e.assets.tiles, p.grid, map) }));
    mutate(d);
  });
  return { layers, skipped: [...new Set(skipped)] };
}

export function reportText(r: MapReport) {
  if (!r.skipped.length) return '';
  const list = r.skipped.slice(0, 4).join(', ') + (r.skipped.length > 4 ? ` and ${r.skipped.length - 4} more` : '');
  return ` Not converted: ${list}.`;
}

/** Replace all layers with one pixel layer holding `image` (document size). */
export function flattenTo(e: Editor, label: string, name: string, image: RGBA8, mutate: (d: PhotoDocument) => void) {
  const grid = gridFromImage(e.assets.tiles, image);
  const l = newPixelLayer(name, image, grid);
  e.command(label, (d) => {
    d.layers = [l];
    d.selection = null;
    d.selectionMask = null;
    mutate(d);
  });
  e.selected = l.id;
  e.update();
}

export async function flatComposite(e: Editor): Promise<RGBA8> {
  return compositeRGBA(e);
}

// ----- Bit depth -----

const srgbEncode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
/** Convert float/16-bit samples into 8-bit document values. Untagged 32-bit
 * documents hold linear sRGB, so they are encoded to sRGB on the way down. */
export function eightBit(samples: Uint8Array | Float32Array, width: number, height: number, linear: boolean): RGBA8 {
  if (samples instanceof Uint8Array || !linear) return toRGBA8(samples, width, height);
  const lut = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) lut[i] = Math.round(srgbEncode(i / 4096) * 255);
  const data = new Uint8ClampedArray(samples.length);
  for (let i = 0; i < samples.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = samples[i + c];
      data[i + c] = lut[v <= 0 ? 0 : v >= 1 ? 4096 : Math.round(v * 4096)];
    }
    data[i + 3] = Math.round(Math.max(0, Math.min(1, samples[i + 3])) * 255);
  }
  return { width, height, data };
}

/** Image > Mode > 8 Bits/Channel for 16/32-bit documents: layers whose
 * samples depend on depth (pixel, image, legacy paint) become 8-bit pixel
 * layers; text, shapes, fills, adjustments and groups stay editable. */
export async function convertTo8Bit(e: Editor) {
  const doc = e.doc;
  const depth = doc.bitsPerChannel ?? 8;
  if (depth === 8) return;
  const linear = depth === 32 && (doc.iccUntaggedProfile || !doc.iccProfile);
  const results = new Map<string, RGBA8>();
  let clipped = false;
  for (const l of allLayers(doc.layers)) {
    if (l.kind !== 'pixel' && l.kind !== 'image' && l.kind !== 'paint') continue;
    const plain: Layer = {
      ...l, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskInverted: false, maskDisabled: false,
      opacity: 1, blend: 'normal', fillOpacity: 1, clipped: false, style: undefined,
    };
    const samples = await e.renderer.layerPixels(plain, doc, e.assets);
    if (samples instanceof Float32Array && !clipped) for (let i = 0; i < samples.length; i++) if (samples[i] > 1) { clipped = true; break; }
    results.set(l.id, eightBit(samples, doc.width, doc.height, linear));
  }
  const grids = new Map([...results].map(([id, img]) => [id, gridFromImage(e.assets.tiles, img)]));
  e.command('Convert to 8 Bits/Channel', (d) => {
    for (const [id, grid] of grids) {
      const l = findLayer(d.layers, id);
      if (!l) continue;
      clearToPixelLayer(l);
      setLayerPixels(l, grid, d);
    }
    delete d.bitsPerChannel;
    // Linear float values were encoded to sRGB above.
    if (linear) {
      delete d.iccProfile;
      delete d.iccUntaggedProfile;
    }
  });
  e.message(`Converted to 8 bits/channel${clipped ? '; HDR values above white were clipped' : ''}.`);
}
