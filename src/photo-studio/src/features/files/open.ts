import type { Editor } from '../../editor';
import { deserialize } from '../../model/serialization';
import { escapeXML } from '../../model/assets';
import { formDialog, information } from '../../ui/dialog';
import { assertSize, layer, type Layer, type PhotoDocument } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { encodeIccProfile } from '../../model/psd-resources';
import { readRgbProfile } from '../../color/profile';
import type { RGBA8 } from '../../imaging/types';
import { decodeImage } from '../../imaging/codecs/decode';
import { decodeIco, pickIcoEntry } from '../../imaging/codecs/ico';
import { sniffImageFormat, type ImageFormat } from '../../imaging/codecs/sniff';
import { applyOrientation } from '../../imaging/codecs/orientation';
import { readPngDpi, readPngIcc } from '../../imaging/codecs/png-chunks';
import { readJpegDensity, readJpegIcc } from '../../imaging/codecs/jpeg-markers';
import { decodePng16, rgba16To8 } from './png';
import { decodeApng, isApng } from '../../imaging/codecs/apng';
import { framesFromLayers } from '../../model/animation';
import { noteRecent, type RecentSource } from './recent';
import { emitAppEvent, openedFiles } from '../../app/app-events';

const browserTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};
const formatMime: Partial<Record<ImageFormat, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml' };

export type DecodedLayer = { name: string; image: RGBA8 };
export type DecodedFile = {
  image: RGBA8;
  notice?: string;
  // Raw ICC profile of the samples (they are not converted to sRGB).
  icc?: Uint8Array;
  dpi?: number;
  // High-depth samples (straight RGBA) when the source has them.
  deep?: { data: Uint16Array | Float32Array; depth: 16 | 32 };
  // Further pages/frames to open as layers above the first.
  layers?: DecodedLayer[];
  // Animated sources opened as a frame animation: one delay per frame
  // (including the first) and the number of plays (0 = forever).
  animation?: { delays: number[]; plays: number };
};
export type PageChoice = 'first' | 'layers' | 'animation' | 'ask';
export type DecodeOptions = { pages?: PageChoice };
// Formats decoded by our own codecs register here (TIFF, BMP variants, TGA...).
// Decoders run in order; the first whose `test` matches decodes the file.
export const extraDecoders: { test: (name: string, bytes: Uint8Array) => boolean; decode: (bytes: Uint8Array, name: string, opts: DecodeOptions) => Promise<DecodedFile> }[] = [];

const codecFormats = new Set<ImageFormat>(['tiff', 'bigtiff', 'bmp', 'gif', 'ico', 'cur', 'tga', 'pnm']);
extraDecoders.push(
  { test: (_n, b) => codecFormats.has(sniffImageFormat(b)), decode: decodeWithCodecs },
  { test: (_n, b) => sniffImageFormat(b) === 'png' || sniffImageFormat(b) === 'jpeg', decode: decodeTagged },
);

async function choosePages(kind: string, count: number, choice: PageChoice | undefined, animated = false): Promise<'first' | 'layers' | 'animation' | null> {
  if (choice === 'animation' && !animated) return 'layers';
  if (choice && choice !== 'ask') return choice;
  const options: [string, string][] = [['first', `First ${kind} only`], ['layers', `All ${kind}s as layers`]];
  if (animated) options.push(['animation', 'All frames as a frame animation']);
  const v = await formDialog(`Open ${kind}s`, [{ name: 'pages', label: `This file has ${count} ${kind}s`, type: 'select', value: animated ? 'animation' : 'first', options }], 'Open');
  return v ? (v.pages as 'first' | 'layers' | 'animation') : null;
}
/** Frames of an animated file as layers (and optionally an animation). */
function animatedFrames(out: DecodedFile, frames: { rgba: RGBA8; delayMs: number }[], pick: 'layers' | 'animation', plays: number) {
  out.layers = frames.slice(1).map((f, i) => ({ name: `Frame ${i + 2}`, image: f.rgba }));
  if (pick === 'animation') out.animation = { delays: frames.map((f) => f.delayMs), plays };
  else out.layers.forEach((l, i) => (l.name += ` (${frames[i + 1].delayMs} ms)`));
}

function orient<T extends Uint16Array | Float32Array>(data: T, w: number, h: number, o: number | undefined): T {
  if (!o || o <= 1 || o > 8) return data;
  // Rotate a high-depth plane with the same mapping as applyOrientation by
  // routing pixel indices through it.
  const idx = new Uint8ClampedArray(w * h * 4);
  const view = new Uint32Array(idx.buffer);
  for (let i = 0; i < view.length; i++) view[i] = i;
  const r = applyOrientation({ width: w, height: h, data: idx }, o);
  const map = new Uint32Array(r.data.buffer);
  const Ctor = data.constructor as { new (n: number): T };
  const out = new Ctor(data.length);
  for (let i = 0; i < map.length; i++) for (let c = 0; c < 4; c++) out[i * 4 + c] = data[map[i] * 4 + c];
  return out;
}

async function decodeWithCodecs(bytes: Uint8Array, _name: string, opts: DecodeOptions): Promise<DecodedFile> {
  const format = sniffImageFormat(bytes);
  if (format === 'ico' || format === 'cur') {
    // PNG entries need the browser decoder; decodeImage only reads BMP ones.
    const res = decodeIco(bytes);
    const best = pickIcoEntry(res);
    const image = best.rgba ?? (await decodeBrowserImage(new Blob([best.png!.slice()], { type: 'image/png' })));
    return { image, notice: res.entries.length > 1 ? `Opened the ${best.width}×${best.height} image of ${res.entries.length}.` : undefined };
  }
  const d = decodeImage(bytes);
  if (!d) throw new Error('Unsupported image format.');
  assertSize(d.width, d.height);
  const notes = d.notes.filter((n) => !/first was opened/.test(n));
  const out: DecodedFile = { image: applyOrientation(d.rgba8, d.orientation), icc: d.icc, dpi: d.dpi?.x };
  if (d.data16) out.deep = { data: orient(d.data16, d.width, d.height, d.orientation), depth: 16 };
  else if (d.dataF32) out.deep = { data: orient(d.dataF32, d.width, d.height, d.orientation), depth: 32 };
  if (d.tiffPages && d.tiffPages.length > 1) {
    const pick = await choosePages('page', d.tiffPages.length, opts.pages);
    if (!pick) throw new CancelOpen();
    if (pick === 'layers')
      out.layers = d.tiffPages.slice(1).map((p, i) => ({ name: `Page ${i + 2}`, image: applyOrientation(p.rgba8, p.orientation) }));
    else notes.push(`The file has ${d.tiffPages.length} pages; the first was opened.`);
  }
  if (d.gifFrames && d.gifFrames.length > 1) {
    const pick = await choosePages('frame', d.gifFrames.length, opts.pages, true);
    if (!pick) throw new CancelOpen();
    // GIF stores extra repeats; no looping extension means one play.
    const plays = d.gifLoopCount === undefined ? 1 : d.gifLoopCount === 0 ? 0 : Math.min(65535, d.gifLoopCount + 1);
    if (pick !== 'first') animatedFrames(out, d.gifFrames, pick, plays);
    else notes.push(`Animated GIF with ${d.gifFrames.length} frames; the first was opened.`);
  }
  if (notes.length) out.notice = notes.join(' ');
  return out;
}

/** True when the renderer's color management can use this RGB profile. */
function usableProfile(icc: Uint8Array | undefined) {
  if (!icc?.length) return false;
  try {
    readRgbProfile(icc);
    return true;
  } catch {
    return false;
  }
}

// PNG and JPEG: keep embedded RGB profiles (decode without conversion and tag
// the document) and read 16-bit PNG samples ourselves.
async function decodeTagged(bytes: Uint8Array, name: string, opts: DecodeOptions = {}): Promise<DecodedFile> {
  const png = sniffImageFormat(bytes) === 'png';
  if (png && isApng(bytes)) {
    let anim: ReturnType<typeof decodeApng> | undefined;
    try {
      anim = decodeApng(bytes);
    } catch {
      anim = undefined; // Unsupported variants open as their default image.
    }
    if (anim && anim.frames.length > 1) {
      assertSize(anim.width, anim.height);
      const pick = await choosePages('frame', anim.frames.length, opts.pages, true);
      if (!pick) throw new CancelOpen();
      const out: DecodedFile = { image: anim.frames[0].rgba };
      if (pick !== 'first') animatedFrames(out, anim.frames, pick, anim.plays);
      else out.notice = `Animated PNG with ${anim.frames.length} frames; the first was opened.`;
      return out;
    }
  }
  let icc: Uint8Array | undefined, dpi: number | undefined;
  try {
    icc = png ? readPngIcc(bytes)?.profile : readJpegIcc(bytes);
    const density = png ? readPngDpi(bytes) : readJpegDensity(bytes);
    if (density && (!('unit' in density) || density.unit !== 'none'))
      dpi = 'unit' in density && density.unit === 'cm' ? density.x * 2.54 : density.x;
  } catch {
    /* Damaged metadata does not prevent opening the pixels. */
  }
  const keep = usableProfile(icc);
  let notice: string | undefined;
  if (icc && !keep) notice = 'The embedded color profile is not an RGB matrix profile; colors were converted to sRGB.';
  if (png) {
    let deep: ReturnType<typeof decodePng16> = null;
    try {
      deep = decodePng16(bytes);
    } catch {
      deep = null; // Let the browser report or recover from damage.
    }
    if (deep)
      // Unconverted samples: tag the document only when the profile is usable.
      return { image: { width: deep.width, height: deep.height, data: rgba16To8(deep.data16) }, deep: { data: deep.data16, depth: 16 }, icc: keep ? icc : undefined, dpi, notice: icc && !keep ? 'The embedded color profile is not an RGB matrix profile and was not applied.' : undefined };
  }
  const blob = new Blob([bytes.slice()], { type: png ? 'image/png' : 'image/jpeg' });
  void name;
  // createImageBitmap applies EXIF orientation itself ('from-image'), so the
  // pixels are already upright; rotating again would double the rotation.
  return { image: await decodeBrowserImage(blob, keep), icc: keep ? icc : undefined, dpi, notice };
}

class CancelOpen extends Error {}

/** Decode a browser-supported image into straight 8-bit RGBA. With `raw`, the
 * samples stay in the file's own color space (for ICC-tagged documents). */
export async function decodeBrowserImage(blob: Blob, raw = false): Promise<RGBA8> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: raw ? 'none' : 'default', imageOrientation: 'from-image' });
  try {
    if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 24_000_000)
      throw new Error('This image exceeds the 24 megapixel or 8192 pixel limit.');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const c = canvas.getContext('2d', { willReadFrequently: true })!;
    c.drawImage(bitmap, 0, 0);
    const data = c.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: data.width, height: data.height, data: data.data };
  } finally {
    bitmap.close();
  }
}

/** Decode any supported raster file (not PSD/.photo) to its pixels and tags. */
export async function decodeFile(blob: Blob, name: string, opts: DecodeOptions = {}): Promise<DecodedFile> {
  const lower = name.toLowerCase();
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  for (const d of extraDecoders) if (d.test(lower, head)) return d.decode(new Uint8Array(await blob.arrayBuffer()), name, opts);
  const sniffed = formatMime[sniffImageFormat(head)];
  const ext = lower.split('.').pop() ?? '';
  if (sniffed && sniffed !== blob.type) blob = new Blob([blob], { type: sniffed });
  else if (!blob.type || blob.type === 'application/octet-stream') {
    const mime = browserTypes[ext];
    if (mime) blob = new Blob([blob], { type: mime });
  }
  if (!Object.values(browserTypes).includes(blob.type) && blob.type !== 'image/heic')
    throw new Error('Open a PNG, JPEG, WebP, AVIF, GIF, BMP, TIFF, ICO, TGA, Netpbm, SVG, PSD, PSB or .photo file.');
  if (blob.type === 'image/svg+xml') return { image: await rasterizeSvg(blob) };
  return { image: await decodeBrowserImage(blob) };
}

const resolution = (dpi: number): PhotoDocument['resolution'] => ({
  horizontalResolution: dpi,
  horizontalResolutionUnit: 'PPI',
  widthUnit: 'Inches',
  verticalResolution: dpi,
  verticalResolutionUnit: 'PPI',
  heightUnit: 'Inches',
});

export type OpenOptions = DecodeOptions & { source?: RecentSource };

/** Open a file as a new document tab, or place it into the current document. */
export async function openFile(e: Editor, blob: Blob, name: string, place = false, opts: OpenOptions = {}) {
  e.transform.apply();
  const lower = name.toLowerCase();
  const isPsd = /\.ps[db]$/.test(lower);
  const source: RecentSource = opts.source ?? { kind: 'local', blob };
  if (place && e.hasDocument) {
    // Placed files become embedded objects: browser images draw directly,
    // other formats keep their original bytes and layered files their layers.
    const { placeEmbedded } = await import('../embedded/place');
    await placeEmbedded(e, blob, name);
    return true;
  }
  if (lower.endsWith('.photo') || isPsd) {
    const loaded = isPsd ? await (await import('../../model/psd')).openPsd(blob, name, e.engine) : await deserialize(blob);
    const s = e.sessionForOpen();
    await e.renderer?.settle();
    s.assets.clear();
    s.assets = loaded.assets;
    s.history.reset(loaded.document);
    s.hasDocument = true;
    s.storage.reset();
    if (source.kind === 'puter' && lower.endsWith('.photo')) s.storage.path = source.path;
    s.saved = s.doc;
    s.fileName = name;
    e.selected = s.doc.layers.at(-1)?.id ?? '';
    if (s.doc.animation) e.dock?.show('timeline');
    e.fit();
    e.update();
    noteRecent(e, name, source);
    e.message(isPsd ? 'PSD opened' : 'Project opened');
    if ('notice' in loaded && loaded.notice) information('PSD import', `<p>${escapeXML(String(loaded.notice))}</p>`);
    openedFiles.set(s, { blob, name });
    void emitAppEvent('open-document', s);
    return true;
  }
  let decoded: DecodedFile;
  try {
    decoded = await decodeFile(blob, name, opts);
  } catch (error) {
    if (error instanceof CancelOpen) return false;
    throw error;
  }
  const { image } = decoded;
  const title = name.replace(/\.[^.]+$/, '');
  const s = e.sessionForOpen();
  const width = Math.max(image.width, ...(decoded.layers ?? []).map((l) => l.image.width));
  const height = Math.max(image.height, ...(decoded.layers ?? []).map((l) => l.image.height));
  assertSize(width, height);
  let base: Layer;
  const doc: PhotoDocument = { ...s.doc, name: title, width, height, layers: [], selection: null };
  if (decoded.deep) {
    // High-depth sources open as an embedded raster in a 16/32-bit document,
    // as layered PSD imports do; painting rasterizes it on first edit.
    base = layer('image', 'Background', image.width, image.height);
    base.asset = await s.assets.addRaster({ width: image.width, height: image.height, data: decoded.deep.data as Uint16Array<ArrayBuffer> });
    base.assetColorSpace = 'document';
    doc.bitsPerChannel = decoded.deep.depth;
  } else base = newPixelLayer('Background', doc, gridFromImage(s.assets.tiles, image));
  doc.layers.push(base);
  for (const extra of decoded.layers ?? []) doc.layers.push(newPixelLayer(extra.name, doc, gridFromImage(s.assets.tiles, extra.image)));
  if (decoded.animation) {
    if (decoded.layers?.length) doc.layers[0].name = 'Frame 1';
    framesFromLayers(doc, decoded.animation.delays.map((ms) => Math.max(0, Math.min(600_000, Math.round(ms)))), decoded.animation.plays);
  }
  if (decoded.icc) doc.iccProfile = encodeIccProfile(decoded.icc);
  if (decoded.dpi && decoded.dpi > 0 && decoded.dpi < 30000) doc.resolution = resolution(Math.round(decoded.dpi * 100) / 100);
  s.history.reset(doc);
  s.hasDocument = true;
  s.storage.reset();
  s.saved = s.doc;
  s.fileName = name;
  e.selected = doc.layers.at(decoded.animation ? 0 : -1)!.id;
  // Animations open with the Timeline showing.
  if (doc.animation) e.dock?.show('timeline');
  e.fit();
  e.update();
  noteRecent(e, name, source);
  e.message(decoded.notice ?? (doc.animation ? `Opened ${name} as a ${doc.animation.frames.length}-frame animation` : `Opened ${name}`));
  openedFiles.set(s, { blob, name });
  void emitAppEvent('open-document', s);
  return true;
}
export { insertAboveSelection } from '../layers/insert';
async function rasterizeSvg(blob: Blob): Promise<RGBA8> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.min(8192, img.naturalWidth || 1024),
      h = Math.min(8192, img.naturalHeight || 1024);
    const canvas = new OffscreenCanvas(w, h);
    const c = canvas.getContext('2d')!;
    c.drawImage(img, 0, 0, w, h);
    const data = c.getImageData(0, 0, w, h);
    return { width: w, height: h, data: data.data };
  } finally {
    URL.revokeObjectURL(url);
  }
}
