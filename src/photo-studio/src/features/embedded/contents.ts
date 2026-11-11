// Building and updating embedded object content: nested documents become a
// .photo project asset plus a rendered composite; placed files keep their
// original bytes. Every change produces new immutable assets and a new
// contents entry, applied to all instances in one history step.
import type { Editor } from '../../editor';
import { containerOf, layer, newDocument, type Layer, type PhotoDocument, type Transform } from '../../model/document';
import { Assets } from '../../model/assets';
import { deserialize, serialize } from '../../model/serialization';
import { instancesOf, projectMimeType, sourceMimeType, type EmbeddedContents, type StackMode } from '../../model/embedded';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { readRgbProfile } from '../../color/profile';
import { sniffImageFormat } from '../../imaging/codecs/sniff';
import { convertToSrgb, documentProfile, floatTo16 } from '../files/color';
import { decodeBrowserImage, decodeFile, inMemoryFile } from '../files/open';
import { addRGBA, addSamples, documentSamples, layerSamples, type Samples } from './render';
import { computeStack } from './stack-client';
import { rescaleFrame, rescaleTransform } from './frame-math';

const browserImages: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };
const profileKey = (d: PhotoDocument) => (d.iccUntaggedProfile ? '' : (d.iccProfile ?? ''));
export const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || 'Embedded Object';

/** Composite (or stack statistic) of a nested document. */
export async function compositeSamples(e: Editor, doc: PhotoDocument, assets: Assets, stack?: StackMode): Promise<Samples> {
  if (!stack || stack === 'none') return documentSamples(e, doc, assets);
  const layers = await layerSamples(e, doc, assets);
  const pixels = doc.width * doc.height;
  const data = layers.length ? await computeStack(layers, pixels, stack) : new Uint8ClampedArray(pixels * 4);
  return { width: doc.width, height: doc.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** Store a nested document's samples where the parent can draw them: in the
 * parent's color space when both match, otherwise converted to sRGB. */
async function storeComposite(parent: PhotoDocument, into: Assets, child: PhotoDocument, s: Samples): Promise<Pick<EmbeddedContents, 'composite' | 'colorSpace'>> {
  const depth = child.bitsPerChannel ?? 8;
  const parentDepth = parent.bitsPerChannel ?? 8;
  if (profileKey(child) === profileKey(parent) && (depth === 32) === (parentDepth === 32))
    return { composite: await addSamples(into, s, depth), colorSpace: 'document' };
  const profile = documentProfile(child);
  if (!profile) return { composite: await addSamples(into, s, depth === 32 ? 16 : depth), colorSpace: 'srgb' };
  if (s.data instanceof Float32Array) {
    const deep = convertToSrgb(floatTo16(s.data), profile);
    return { composite: await into.addRaster({ width: s.width, height: s.height, data: deep as Uint16Array<ArrayBuffer> }), colorSpace: 'srgb' };
  }
  const bytes = convertToSrgb(new Uint8ClampedArray(s.data), profile);
  return { composite: await addRGBA(into, { width: s.width, height: s.height, data: bytes }), colorSpace: 'srgb' };
}

export type FromDocument = { name: string; stack?: StackMode; samples?: Samples; project?: Blob; projectId?: string; id?: string };
/** Contents for `doc` (whose tiles and assets are in `assets`), stored in `into`. */
export async function contentsFromDocument(e: Editor, parent: PhotoDocument, into: Assets, doc: PhotoDocument, assets: Assets, o: FromDocument): Promise<EmbeddedContents> {
  const projectId = o.projectId ?? (await into.add(new Blob([o.project ?? (await serialize(doc, assets))], { type: projectMimeType })));
  const samples = o.samples ?? (await compositeSamples(e, doc, assets, o.stack));
  const stored = await storeComposite(parent, into, doc, samples);
  return {
    id: o.id ?? crypto.randomUUID(),
    name: o.name,
    width: doc.width,
    height: doc.height,
    project: projectId,
    ...stored,
    ...(o.stack && o.stack !== 'none' ? { stack: o.stack } : {}),
  };
}

/** Contents from a file: projects and PSD files keep their layers, browser
 * images are drawn directly and other formats are decoded once. */
export async function contentsFromFile(e: Editor, parent: PhotoDocument, into: Assets, file: Blob, name: string): Promise<EmbeddedContents> {
  // The contents keep the file's bytes: a file picked from disk is copied,
  // so they stay readable when it changes there (as linked files do).
  file = await inMemoryFile(file);
  const lower = name.toLowerCase();
  const title = baseName(name);
  if (lower.endsWith('.photo')) {
    const loaded = await deserialize(file);
    try {
      return { ...(await contentsFromDocument(e, parent, into, loaded.document, loaded.assets, { name: title, project: file })), sourceName: name };
    } finally {
      loaded.assets.clear();
    }
  }
  if (/\.ps[db]$/.test(lower)) {
    const { openPsd } = await import('../../model/psd');
    const loaded = await openPsd(file, name, e.engine);
    try {
      const c = await contentsFromDocument(e, parent, into, loaded.document, loaded.assets, { name: title });
      return { ...c, source: await into.add(new Blob([file], { type: sourceMimeType })), sourceName: name };
    } finally {
      loaded.assets.clear();
    }
  }
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const mime = browserImages[sniffImageFormat(head)];
  if (mime) {
    const id = await into.add(new Blob([file], { type: mime }));
    const { width, height } = into.dimensions(id);
    return { id: crypto.randomUUID(), name: title, width, height, composite: id, source: id, sourceName: name, colorSpace: 'srgb' };
  }
  const decoded = await decodeFile(file, name, { pages: 'first' });
  const img = decoded.image;
  if (decoded.icc)
    try {
      convertToSrgb(img.data, readRgbProfile(decoded.icc));
    } catch {
      /* Unsupported profiles are shown as sRGB, as when opening the file. */
    }
  return {
    id: crypto.randomUUID(),
    name: title,
    width: img.width,
    height: img.height,
    composite: await addRGBA(into, img),
    source: await into.add(new Blob([file], { type: sourceMimeType })),
    sourceName: name,
    colorSpace: 'srgb',
  };
}

/** Contents describing a plain placed image layer (no nested document yet). */
export function plainContents(l: Layer, assets: Assets): EmbeddedContents {
  const isFile = !assets.raster(l.asset!) && l.assetColorSpace === 'srgb';
  return {
    id: crypto.randomUUID(),
    name: l.name,
    width: Math.round(l.sourceWidth),
    height: Math.round(l.sourceHeight),
    composite: l.asset!,
    ...(isFile ? { source: l.asset } : {}),
    colorSpace: l.assetColorSpace ?? 'document',
  };
}
/** Give a plain image layer (in a draft) its own contents entry. */
export function ensureEmbed(d: PhotoDocument, l: Layer, assets: Assets) {
  if (l.kind !== 'image' || l.embed || !l.asset) return;
  const c = plainContents(l, assets);
  d.embeds = { ...d.embeds, [c.id]: c };
  l.embed = { contents: c.id };
}

/** The nested document to edit: the saved project, or a new document holding
 * the placed image as its only layer. Returns a separate asset store. */
export async function openContents(parent: PhotoDocument, parentAssets: Assets, c: EmbeddedContents): Promise<{ document: PhotoDocument; assets: Assets }> {
  if (c.project) return deserialize(parentAssets.blob(c.project));
  const assets = new Assets();
  const doc = newDocument(c.width, c.height, c.name);
  if (c.colorSpace === 'document') {
    if (parent.iccProfile) doc.iccProfile = parent.iccProfile;
    if (parent.iccUntaggedProfile) doc.iccUntaggedProfile = true;
  }
  if (parent.resolution) doc.resolution = structuredClone(parent.resolution);
  const raster = parentAssets.raster(c.composite);
  if (!raster) {
    const img = await decodeBrowserImage(parentAssets.blob(c.composite), c.colorSpace === 'document');
    doc.layers.push(newPixelLayer(c.name, doc, gridFromImage(assets.tiles, img)));
  } else {
    // High-depth content stays an image layer at its own depth.
    doc.bitsPerChannel = raster.data instanceof Float32Array ? 32 : 16;
    await assets.add(parentAssets.blob(c.composite), c.composite);
    const l = layer('image', c.name, c.width, c.height);
    l.asset = c.composite;
    l.assetColorSpace = c.colorSpace;
    doc.layers.push(l);
  }
  return { document: doc, assets };
}

/** Put `next` into a draft and point every instance at it. Unframed
 * instances keep their scale when the content size changes; framed ones keep
 * their frame and are re-rendered from the new composite. */
export function setContents(d: PhotoDocument, next: EmbeddedContents) {
  const prev = d.embeds?.[next.id];
  d.embeds = { ...d.embeds, [next.id]: next };
  for (const l of instancesOf(d, next.id)) {
    // Framed instances re-render from the new content (their cache is stale).
    if (l.embed!.frame) {
      if (prev) l.embed!.frame = rescaleFrame(l.embed!.frame, prev, next);
      continue;
    }
    const from = { width: l.sourceWidth, height: l.sourceHeight };
    l.asset = next.composite;
    l.assetColorSpace = next.colorSpace;
    l.sourceWidth = next.width;
    l.sourceHeight = next.height;
    if (Math.abs(from.width - next.width) > 1e-9 || Math.abs(from.height - next.height) > 1e-9) l.transform = rescaleTransform(l.transform, from, next);
  }
}
/** A new instance layer drawing `c` at `transform`. */
export function instanceLayer(c: EmbeddedContents, name: string, transform: Transform): Layer {
  const l = layer('image', name, c.width, c.height);
  l.asset = c.composite;
  l.assetColorSpace = c.colorSpace;
  l.transform = transform;
  l.embed = { contents: c.id };
  return l;
}
/** Add an instance (and its contents) above the selected layer, one step. */
export function insertInstance(e: Editor, l: Layer, c: EmbeddedContents, label: string) {
  const anchor = e.selected;
  e.command(label, (d) => {
    d.embeds = { ...d.embeds, [c.id]: c };
    const list = (anchor && containerOf(d.layers, anchor)) || d.layers;
    const i = list.findIndex((x) => x.id === anchor);
    list.splice(i < 0 ? list.length : i + 1, 0, l);
  });
  e.selected = l.id;
  e.update();
}
/** Centered on the canvas, scaled down to fit (as placed files are). */
export function fittedTransform(doc: PhotoDocument, w: number, h: number): Transform {
  const scale = Math.min(1, doc.width / w, doc.height / h);
  return { x: (doc.width - w * scale) / 2, y: (doc.height - h * scale) / 2, width: w * scale, height: h * scale, rotation: 0 };
}
