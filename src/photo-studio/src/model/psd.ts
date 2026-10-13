import {
  isVectorGradient,
  supportedGradientDefinition,
  exportGradientDefinition,
  gradientFrame,
} from "./vector-gradient";
import type { PsdSolidGradientFill } from "./psd-gradient-fill";
import { psdLayerBounds } from "./psd-layer-bounds";
import { hasMask } from "./masks";
import { supportedPsdPixelMask, importPsdPixelMask, exportPsdPixelMask } from './psd-pixel-mask';
import { exportProtection } from './locks';
import { activeLayerStyle } from './layer-style';
import {
  getLayerImageData,
  getCompositeImageData,
  type Psd,
  type Layer as PsdLayer,
  type PixelData,
} from "ag-psd";
import { Assets } from "./assets";
import {
  assertSize,
  allLayers,
  blends,
  layer,
  newDocument,
  type Layer,
  type PhotoDocument,
} from "./document";
import { validateDocument } from "./serialization";
import { ImageEngine } from "../engine/engine";
import { readRgbProfile } from "../color/profile";
import {
  readPsdImageResource,
  replacePsdImageResource,
  encodeIccProfile,
  decodeIccProfile,
  readPsdImageResources,
  encodePsdImageResources,
  decodePsdImageResources,
  restorePsdImageResources,
  psdResourcesMimeType,
} from "./psd-resources";
import {
  vectorBounds,
  vectorUnbounded,
  transformedVectorMask,
  transformedVectorPsdBounds,
  validateVectorMask,
  vectorPaintMatrix,
} from "./vector";
import {
  vectorDisplayHex,
  vectorDocumentRgb,
  vectorColorRgb,
} from "../color/vector";
import {
  solidRgb,
  importVectorStroke,
  exportVectorStroke,
} from "./vector-stroke";
import { writeHighDepthPsd } from "./psd-high-depth";
import { writePsdWithPreciseStrokes } from "./psd-stroke-writer";
import {
  readPsdWithPatternResources,
  supportedPsdPattern,
  indexPsdPatterns,
  type PsdPatternResource,
} from "./psd-patterns";
import {
  isVectorPattern,
  nativePatternPlacement,
  patternReferencePoint,
} from "./vector-pattern";
import type { PsdPatternFill } from "./psd-fill-codec";
import type { RasterPixels } from "./raster";
import {
  readPsdMetadata,
  encodePsdMetadata,
  decodePsdMetadata,
  restorePsdMetadata,
  psdMetadataMimeType,
} from "./psd-metadata";
import { validatePsdHeader } from "./psd-header";
import { exportPsdText, importPsdText, type ImportedText } from "./psd-text";
import { documentPpi, syncLegacyFields, textMatrix } from "./text-layer";
import { findBundled, isFontAvailable } from "../imaging/text/fonts";
import {
  psdOriginalMimeType,
  psdPreviewFingerprint,
  saveOriginalPsd,
} from "./psd-original";
export { validatePsdHeader } from "./psd-header";
import { exportGridMask, exportPsdAdjustment, importPsdAdjustment, supportedPsdAdjustment } from "./psd-adjustments";
import { exportPsdArtboard, importPsdArtboard } from "./psd-artboard";
import { blendingFromPsd, blendingToPsd, cleanBlending, type AdvancedBlending } from "./blending";

const memoryLimit = 512 * 1024 * 1024;

function vectorColor(l: PsdLayer): [number, number, number] | undefined {
  if (l.children || (l.vectorStroke && !importVectorStroke(l))) return;
  return solidRgb(l.vectorFill);
}
function requiresComposite(
  l: PsdLayer,
  supportedVector: (l: PsdLayer) => boolean,
  depth = 8,
): boolean {
  // Blend If ranges, channel restrictions and knockout are imported as
  // advanced blending options (see importBlending).
  return !!(
    (l.blendMode && !blends.includes(l.blendMode as Layer["blend"]) && !(l.blendMode === "pass through" && l.children)) ||
    (l.adjustment && !supportedPsdAdjustment(l, depth)) ||
    l.effects ||
    (l.vectorMask && !supportedVector(l)) ||
    (l.vectorFill && !supportedVector(l)) ||
    (l.vectorStroke && !supportedVector(l)) ||
    !supportedPsdPixelMask(l) ||
    (l.artboard && (!l.children || !importPsdArtboard(l.artboard))) ||
    (l.fillOpacity !== undefined && l.fillOpacity !== 1) ||
    l.children?.some((child) => requiresComposite(child, supportedVector, depth))
  );
}

function importBlending(item: PsdLayer): AdvancedBlending | undefined {
  const b: AdvancedBlending = {};
  const ranges = blendingFromPsd(item.blendingRanges);
  if (ranges) b.ranges = ranges;
  const restricted = item.channelBlendingRestrictions ?? [];
  if (restricted.length) b.exclude = { r: restricted.includes(0), g: restricted.includes(1), b: restricted.includes(2) };
  if (item.knockout) b.knockout = 'shallow';
  if (item.blendInteriorElements) b.interiorAsGroup = true;
  if (item.blendClippendElements === false) b.clippedAsGroup = false;
  if (item.layerMaskAsGlobalMask) b.maskHidesEffects = true;
  return cleanBlending(b);
}
function exportBlending(l: Layer): Partial<PsdLayer> {
  const b = l.blending;
  if (!b) return {};
  const out: Partial<PsdLayer> = {};
  const ranges = blendingToPsd(b);
  if (ranges) out.blendingRanges = ranges;
  const restricted = (['r', 'g', 'b'] as const).flatMap((k, i) => (b.exclude?.[k] ? [i] : []));
  // The codec reads entries only while more than four bytes remain, so the
  // last entry is repeated (excluding a channel twice changes nothing).
  if (restricted.length) out.channelBlendingRestrictions = [...restricted, restricted[restricted.length - 1]];
  // The format stores knockout as a flag: deep is written as shallow.
  if (b.knockout) out.knockout = true;
  if (b.interiorAsGroup) out.blendInteriorElements = true;
  if (b.clippedAsGroup === false) out.blendClippendElements = false;
  if (b.maskHidesEffects) out.layerMaskAsGlobalMask = true;
  return out;
}

async function addPixels(
  assets: Assets,
  pixels: PixelData,
  engine: ImageEngine,
) {
  assertSize(pixels.width, pixels.height);
  // A Canvas 2D round trip premultiplies into 8-bit storage, then divides by
  // alpha on export. That irreversibly changes straight RGB, especially at low
  // alpha. Encode the decoded bytes directly with the worker's lossless encoder.
  const blob = await engine.png(
    new Uint8Array(pixels.data),
    pixels.width,
    pixels.height,
  );
  return assets.add(blob);
}

export async function openPsd(blob: Blob, name: string, engine?: ImageEngine) {
  if (blob.size > memoryLimit) throw new Error("PSD exceeds 512 MB.");
  const header = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  validatePsdHeader(header);
  const channelDepth = new DataView(header.buffer).getUint16(22);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const psd = readPsdWithPatternResources(bytes, {
    useImageData: true,
    // High-depth transparency is straight channel data. The codec's eager
    // composite path incorrectly applies its byte-only white-matte removal.
    // Its raw API keeps the channel streams and lets us decode typed planes.
    useRawData: channelDepth > 8,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    totalMemoryLimit: memoryLimit,
  });
  const patterns = new Map<string, PsdPatternResource>();
  const ambiguousPatterns = new Set<string>();
  for (const record of psd.patternResources ?? []) {
    const previous = patterns.get(record.id);
    if (
      previous &&
      (previous.raw.length !== record.raw.length ||
        !previous.raw.every((v, i) => v === record.raw[i]))
    )
      ambiguousPatterns.add(record.id);
    else patterns.set(record.id, record);
  }
  const supportedVector = (item: PsdLayer) => {
    if (vectorColor(item)) return true;
    if (item.children || (item.vectorStroke && !importVectorStroke(item)))
      return false;
    const fill = item.vectorFill;
    if (fill?.type === "solid")
      return supportedGradientDefinition(fill as unknown as PsdSolidGradientFill);
    if (
      fill?.type !== "pattern" ||
      !nativePatternPlacement(fill as PsdPatternFill) ||
      ambiguousPatterns.has(fill.id)
    )
      return false;
    const resource = patterns.get(fill.id);
    return !!resource && supportedPsdPattern(resource);
  };
  const document = newDocument(
    psd.width,
    psd.height,
    name.replace(/\.ps[db]$/i, ""),
  );
  if (channelDepth > 8) document.bitsPerChannel = channelDepth as 16 | 32;
  if (psd.imageResources?.resolutionInfo)
    document.resolution = { ...psd.imageResources.resolutionInfo };
  const aspect = psd.imageResources?.pixelAspectRatio?.aspect;
  if (aspect && Number.isFinite(aspect) && aspect >= 0.1 && aspect <= 10 && Math.abs(aspect - 1) > 1e-6)
    document.pixelAspect = aspect;
  // Resource 1039 is the raw ICC profile in the format's image resource table.
  const profile = readPsdImageResource(bytes, 1039);
  if (profile?.length) document.iccProfile = encodeIccProfile(profile);
  if (psd.imageResources?.iccUntaggedProfile !== undefined)
    document.iccUntaggedProfile = psd.imageResources.iccUntaggedProfile;
  const assets = new Assets();
  let notice = "";
  let textNotice = "";
  let preserveOriginal = false;
  let colorNotice = "";
  if (profile?.length && !document.iccUntaggedProfile) {
    try {
      readRgbProfile(profile);
    } catch (error) {
      colorNotice = `The embedded ICC profile cannot be used for display (${String(error)}). Its bytes are retained; colors are shown as sRGB.`;
    }
  }
  let count = 0;
  const check = (items: PsdLayer[], depth = 0) => {
    if (depth > 12) throw new Error("Too many nested PSD groups.");
    for (const item of items) {
      if (++count > 200) throw new Error("PSD exceeds 200 layers.");
      if (item.imageData)
        assertSize(item.imageData.width, item.imageData.height);
      if (item.children) check(item.children, depth + 1);
    }
  };
  check(psd.children ?? []);
  let encoder = engine;
  const add = (pixels: PixelData) =>
    pixels.data instanceof Uint16Array || pixels.data instanceof Float32Array
      ? assets.addRaster({
          width: pixels.width,
          height: pixels.height,
          data: pixels.data as RasterPixels["data"],
        })
      : addPixels(assets, pixels, (encoder ??= new ImageEngine()));
  let decodedBytes = 0;
  const reserve = (width: number, height: number) => {
    assertSize(width, height);
    decodedBytes += width * height * 4 * (channelDepth / 8);
    if (decodedBytes > memoryLimit)
      throw new Error("PSD exceeds the 512 MB decoded pixel budget.");
  };
  const sourcePixels = (item: PsdLayer) => {
    if (channelDepth === 8) return item.imageData;
    if (
      item.rawData?.channels.some((c) => ![-3, -2, -1, 0, 1, 2].includes(c.id))
    )
      throw new Error("PSD auxiliary layer channels are not yet supported.");
    // Raw high-depth decoding must distinguish an absent raster cache from
    // a black plane. Mask-only streams do not supply layer color pixels.
    if (
      !item.rawData?.channels.some(
        (c) => c.id !== -2 && c.id !== -3 && c.data?.length,
      )
    )
      return undefined;
    const width = (item.right ?? 0) - (item.left ?? 0),
      height = (item.bottom ?? 0) - (item.top ?? 0);
    if (width <= 0 || height <= 0) return undefined;
    reserve(width, height);
    return getLayerImageData(item);
  };
  try {
    const resources = readPsdImageResources(bytes);
    if (resources.length)
      document.psdResourcesAsset = await assets.add(
        new Blob([encodePsdImageResources(resources)], {
          type: psdResourcesMimeType,
        }),
      );
    const metadata = readPsdMetadata(bytes);
    if (metadata.globalMask.length || metadata.tags.length)
      document.psdMetadataAsset = await assets.add(
        new Blob([encodePsdMetadata(metadata)], { type: psdMetadataMimeType }),
      );
    const convert = async (item: PsdLayer): Promise<Layer> => {
      const adjustment = importPsdAdjustment(item, channelDepth);
      const pixels =
        item.children || adjustment || supportedVector(item) ? undefined : sourcePixels(item);
      const l = layer(
        adjustment ? "adjustment" : item.children ? "group" : supportedVector(item) ? "vector" : "image",
        item.name ?? "Layer",
        pixels?.width || document.width,
        pixels?.height || document.height,
      );
      l.visible = !item.hidden;
      l.psdId = item.id;
      l.locked = !!(
        item.protected?.transparency &&
        item.protected.composite &&
        item.protected.position
      );
      if (item.protected)
        l.protection = {
          transparency: !!item.protected.transparency,
          composite: !!item.protected.composite,
          position: !!item.protected.position,
          ...(item.protected.artboards !== undefined
            ? { artboards: item.protected.artboards }
            : {}),
        };
      if (item.transparencyProtected !== undefined)
        l.transparencyProtected = item.transparencyProtected;
      l.opacity = item.opacity ?? 1;
      l.blend = (item.blendMode ?? "normal") as Layer["blend"];
      // The compositor renders clipping groups, so clipped layers stay editable.
      if (item.clipping) l.clipped = true;
      const advanced = importBlending(item);
      if (advanced) l.blending = advanced;
      if (adjustment) l.adjustment = adjustment;
      else if (item.children) {
        // ag-psd's layer arrays, like our compositor, run bottom-to-top.
        for (const child of item.children)
          l.children.push(await convert(child));
        const artboard = item.artboard && importPsdArtboard(item.artboard);
        if (artboard) {
          l.artboard = artboard;
          // Artboards composite their contents in isolation.
          if (l.blend === "pass through") l.blend = "normal";
        }
      } else if (l.kind === "vector") {
        const mask = structuredClone(
          item.vectorMask ?? { paths: [], fillStartsWithAllPixels: true },
        );
        validateVectorMask(mask);
        const bounds = vectorUnbounded(mask) ? null : vectorBounds(mask);
        const reference =
          bounds && bounds.width > 0 && bounds.height > 0
            ? bounds
            : { x: 0, y: 0, width: document.width, height: document.height };
        l.vector = {
          mask,
          reference,
          psdBounds: psdLayerBounds(item),
          fill: item.vectorFill?.type === 'solid'
            ? {
                ...(item.vectorFill as unknown as PsdSolidGradientFill),
                frame: gradientFrame(
                  { x: 0, y: 0, width: document.width, height: document.height },
                  item.vectorFill!.align !== false,
                  psdLayerBounds(item),
                  bounds,
                ),
              }
            : item.vectorFill?.type === 'pattern'
            ? { ...(item.vectorFill as PsdPatternFill), asset: document.psdMetadataAsset!,
                ...(item.referencePoint ? { referencePoint: { ...item.referencePoint } } : {}) }
            : { rgb: vectorColor(item)!, space: "document" },
          ...(item.vectorStroke ? { stroke: importVectorStroke(item)! } : {}),
        };
        l.sourceWidth = document.width;
        l.sourceHeight = document.height;
        l.transform = { ...reference, rotation: 0 };
        if (isVectorPattern(l.vector.fill)) {
          if (!document.psdMetadataAsset) throw new Error('Missing embedded pattern metadata.');
          await assets.pattern(l.vector.fill.asset, l.vector.fill.id, memoryLimit - decodedBytes);
        } else if (!isVectorGradient(l.vector.fill)) l.color = vectorDisplayHex(l, document);
      } else {
        l.transform.x = item.left ?? 0;
        l.transform.y = item.top ?? 0;
        if (pixels) l.asset = await add(pixels);
        else if (
          (item.right ?? 0) > (item.left ?? 0) &&
          (item.bottom ?? 0) > (item.top ?? 0)
        )
          throw new Error(
            "PSD layer pixels are missing. Re-save the file with its layer pixel data and a composite image included.",
          );
        const text =
          item.text && !item.placedLayer && !item.vectorFill
            ? importPsdText(item.text, documentPpi(document))
            : undefined;
        if (text) {
          const missing = editableText(l, text, item.text!);
          if (missing.length) {
            // Without the fonts the editor cannot reproduce the saved text;
            // keep the original file so an unchanged document exports intact.
            preserveOriginal = true;
            textNotice = `Text set in ${missing.join(", ")} shows its saved appearance until edited (the font is not available here).`;
          }
        } else if (item.text || item.placedLayer || item.vectorFill) {
          preserveOriginal = true;
          notice =
            "Text, shapes and embedded objects were opened as raster layers.";
        }
      }
      await importPsdPixelMask(item,l,assets,reserve);
      return l;
    };
    if (!psd.children?.length || psd.children.some(item => requiresComposite(item, supportedVector, channelDepth))) {
      if (channelDepth > 8) {
        reserve(document.width, document.height);
        psd.imageData = getCompositeImageData(psd);
      }
      if (!psd.imageData)
        throw new Error(
          "This PSD needs a saved composite image. Re-save the file with a composite image included.",
        );
      const l = layer(
        "image",
        "PSD composite",
        document.width,
        document.height,
      );
      l.asset = await add(psd.imageData);
      document.layers.push(l);
      preserveOriginal = !!psd.children?.length;
      notice = psd.children?.length
        ? "This PSD uses unsupported masks, effects or compositing. Its saved composite was opened as one raster layer."
        : "Opened the PSD composite as one raster layer.";
    } else {
      for (const item of psd.children)
        document.layers.push(await convert(item));
      // Artboards only exist at the top level; nested ones open as groups.
      for (const top of document.layers)
        for (const nested of allLayers(top.children)) delete nested.artboard;
    }
    if (preserveOriginal) {
      const asset = await assets.add(
        blob.slice(0, blob.size, psdOriginalMimeType),
      );
      document.psdOriginal = {
        asset,
        previewFingerprint: '',
      };
      document.psdOriginal.previewFingerprint = await psdPreviewFingerprint(document);
      notice += ' The complete original file is retained in .photo projects. Download PSD preserves its original layers when the preview is unchanged. After preview edits, save a .photo project or export PNG; File → Download original PSD retrieves the original without those edits.';
    }
    validateDocument(document);
    return {
      document,
      assets,
      notice: [notice, textNotice, colorNotice].filter(Boolean).join(" "),
    };
  } catch (error) {
    assets.clear();
    throw error;
  } finally {
    if (!engine) encoder?.dispose();
  }
}

export type RenderPsdPixels = (
  doc: PhotoDocument,
) => Promise<Uint8Array | Float32Array>;
export type ReadPsdSourcePixels = (l: Layer) => Promise<{
  width: number;
  height: number;
  data: Uint8Array | Uint16Array | Float32Array;
}>;
export type ReadPsdMetadataAsset = (id: string) => Blob | Promise<Blob>;
// Painted layer masks (`maskGrid`) as one 8-bit plane in document space;
// pixels outside `bounds` have `defaultColor`.
export type ReadPsdMaskGrid = (l: Layer) => {
  bounds: { x: number; y: number; width: number; height: number };
  data: Uint8Array;
  defaultColor: 0 | 255;
} | undefined;

// Return unchanged unsupported originals without touching their layer records.
// Otherwise rasterize through the preview compositor. Preserve layer metadata,
// but bake transforms, masks, text, brush strokes and adjustments into layer pixels.
export async function savePsd(
  doc: PhotoDocument,
  render: RenderPsdPixels,
  readSource?: ReadPsdSourcePixels,
  readMetadata?: ReadPsdMetadataAsset,
  readMaskGrid?: ReadPsdMaskGrid,
  // Without a composite ("maximize compatibility" off) the merged image is
  // left blank: smaller files that other readers rebuild from the layers.
  options: { composite?: boolean } = {},
): Promise<Blob> {
  validateDocument(doc);
  if (doc.psdOriginal) return (await saveOriginalPsd(doc, readMetadata)).blob;
  let metadata;
  if (doc.psdMetadataAsset) {
    if (!readMetadata)
      throw new Error(
        "PSD export requires the original document metadata asset.",
      );
    const blob = await readMetadata(doc.psdMetadataAsset);
    if (blob.type !== psdMetadataMimeType || blob.size > memoryLimit)
      throw new Error("Invalid PSD document metadata asset.");
    metadata = decodePsdMetadata(new Uint8Array(await blob.arrayBuffer()));
  }
  // Pattern references are asset-scoped in native projects, but file-scoped in
  // PSD files. Copying a shape may bring a different metadata asset with it.
  const patternLayers = allLayers(doc.layers).filter((l) =>
    isVectorPattern(l.vector?.fill),
  );
  if (patternLayers.length) {
    if (!readMetadata)
      throw new Error(
        "PSD export requires the embedded pattern metadata assets.",
      );
    metadata ??= { globalMask: new Uint8Array(), tags: [] };
    const definitions = new Map<string, Uint8Array>();
    const ingest = (records: PsdPatternResource[]) => {
      for (const record of records) {
        const old = definitions.get(record.id);
        if (
          old &&
          (old.length !== record.raw.length ||
            !old.every((v, i) => v === record.raw[i]))
        )
          throw new Error(
            "Conflicting embedded pattern definitions cannot share a PSD identifier.",
          );
        definitions.set(record.id, record.raw);
      }
    };
    const sources = new Map<string, Map<string, PsdPatternResource>>();
    const additions: Uint8Array[] = [];
    const originalDefinitions = new Map<string, PsdPatternResource>();
    for (const tag of metadata.tags)
      if (["Patt", "Pat2", "Pat3"].includes(tag.key)) {
        const records = indexPsdPatterns(tag.data);
        ingest(records);
        for (const record of records)
          originalDefinitions.set(record.id, record);
      }
    if (doc.psdMetadataAsset)
      sources.set(doc.psdMetadataAsset, originalDefinitions);
    for (const l of patternLayers) {
      const fill = l.vector!.fill;
      if (!isVectorPattern(fill)) continue;
      let source = sources.get(fill.asset);
      if (!source) {
        const blob = await readMetadata(fill.asset);
        if (blob.type !== psdMetadataMimeType || blob.size > memoryLimit)
          throw new Error("Invalid pattern definition asset.");
        source = new Map();
        for (const tag of decodePsdMetadata(
          new Uint8Array(await blob.arrayBuffer()),
        ).tags)
          if (["Patt", "Pat2", "Pat3"].includes(tag.key))
            for (const record of indexPsdPatterns(tag.data)) {
              const previous = source.get(record.id);
              if (
                previous &&
                (previous.raw.length !== record.raw.length ||
                  !previous.raw.every((v, i) => v === record.raw[i]))
              )
                throw new Error("Ambiguous embedded pattern identifier.");
              source.set(record.id, record);
            }
        sources.set(fill.asset, source);
      }
      const record = source.get(fill.id);
      if (!record) throw new Error("Missing embedded pattern definition.");
      const exists = definitions.has(fill.id);
      ingest([record]);
      if (!exists) additions.push(record.raw);
    }
    if (additions.length) {
      // A tagged-block key is file-scoped. Repeating Pat3 can make readers
      // retain only its last block, losing patterns from copied layers.
      const target = metadata.tags.find((tag) => tag.key === "Pat3");
      const records = target ? [target.data, ...additions] : additions;
      const length = records.reduce((sum, record) => sum + record.length, 0);
      if (length > memoryLimit)
        throw new Error("PSD pattern definitions exceed the 512 MB budget.");
      const data = new Uint8Array(length);
      let offset = 0;
      for (const record of records) {
        data.set(record, offset);
        offset += record.length;
      }
      if (target) target.data = data;
      else metadata.tags.push({ key: "Pat3", data });
    }
  }
  let resources;
  if (doc.psdResourcesAsset) {
    if (!readMetadata)
      throw new Error(
        "PSD export requires the original image resources asset.",
      );
    const blob = await readMetadata(doc.psdResourcesAsset);
    if (blob.type !== psdResourcesMimeType || blob.size > memoryLimit)
      throw new Error("Invalid PSD image resources asset.");
    resources = decodePsdImageResources(
      new Uint8Array(await blob.arrayBuffer()),
    );
  }
  const depth = doc.bitsPerChannel ?? 8,
    bytesPerSample = depth / 8;
  const channelData = (
    data: Uint8Array | Uint16Array | Float32Array,
    width: number,
    height: number,
  ): PixelData => {
    if (data.length !== width * height * 4)
      throw new Error("PSD pixel dimensions do not match the source.");
    if (depth === 8) {
      if (!(data instanceof Uint8Array))
        throw new Error("8-bit PSD export requires byte readback.");
      return {
        width,
        height,
        data: new Uint8ClampedArray(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        ),
      };
    }
    if (depth === 16 && data instanceof Uint16Array)
      return { width, height, data };
    if (!(data instanceof Float32Array))
      throw new Error(
        "High-depth PSD export requires typed floating-point readback.",
      );
    if (depth === 32) return { width, height, data };
    const codes = new Uint16Array(data.length);
    for (let i = 0; i < codes.length; i++) {
      if (
        !Number.isFinite(data[i]) ||
        (i % 4 === 3 && (data[i] < 0 || data[i] > 1))
      )
        throw new Error("Invalid high-depth PSD sample.");
      codes[i] = Math.round(Math.max(0, Math.min(1, data[i])) * 65535);
    }
    return { width, height, data: codes };
  };
  const gradientExport = (l: Layer) => {
    const fill = l.vector!.fill;
    if (!isVectorGradient(fill))
      throw new Error("Expected a gradient material.");
    const targetFrame = gradientFrame(
      { x: 0, y: 0, width: doc.width, height: doc.height },
      fill.align !== false,
      transformedVectorPsdBounds(l),
      vectorBounds(transformedVectorMask(l)),
    );
    return exportGradientDefinition(fill, vectorPaintMatrix(l), targetFrame);
  };
  const checkVectorExport = (layers: Layer[]) => {
    for (const l of layers) {
      if (
        l.kind === "vector" &&
        ((hasMask(l) && !l.pixelMask) || l.filters.blur)
      )
        throw new Error(
          "PSD export for vector shapes with pixel masks or blur is not yet supported. Save a .photo project to retain their editable geometry.",
        );
      if (l.vector) {
        transformedVectorPsdBounds(l);
        if (isVectorGradient(l.vector.fill)) {
          if (Object.values(l.filters).some(Boolean))
            throw new Error("PSD export of filtered gradient fills is not yet supported. Save a .photo project to retain the editable fill.");
          gradientExport(l);
        }
        if (
          isVectorPattern(l.vector.fill) &&
          Object.values(l.filters).some(Boolean)
        )
          throw new Error(
            "PSD export of filtered pattern fills is not yet supported. Save a .photo project to retain the editable fill.",
          );
        if (l.vector.stroke && Object.values(l.filters).some(Boolean))
          throw new Error(
            "PSD export for filtered vector strokes is not yet supported. Save a .photo project to retain their editable appearance.",
          );
        // The format reserves three guard bits in signed 8.24 path coordinates:
        // valid document-axis fractions are [-16,16). Reject overflow rather
        // than wrapping or clipping editable geometry in the codec.
        for (const path of transformedVectorMask(l).paths)
          for (const knot of path.knots)
            for (let i = 0; i < 6; i++) {
              const fixed = Math.round(
                (knot.points[i] / (i % 2 ? doc.height : doc.width)) * 0x1000000,
              );
              if (fixed < -0x10000000 || fixed > 0x0fffffff)
                throw new Error(
                  "Vector coordinates exceed PSD signed 8.24 path values.",
                );
            }
      }
      checkVectorExport(l.children);
    }
  };
  checkVectorExport(doc.layers);
  let allocated = doc.width * doc.height * 4 * bytesPerSample;
  const pixels = async (layers: Layer[]): Promise<PixelData> => {
    if (allocated > memoryLimit)
      throw new Error("PSD export exceeds the 512 MB pixel budget.");
    const data = await render({ ...doc, layers, selection: null });
    return channelData(data, doc.width, doc.height);
  };
  const composite = options.composite !== false;
  const blank = (n: number) => (depth === 32 ? new Float32Array(n) : depth === 16 ? new Uint16Array(n) : new Uint8Array(n));
  const imageData = composite ? await pixels(doc.layers) : channelData(blank(doc.width * doc.height * 4), doc.width, doc.height);
  // Keep source identities and assign new ones only to layers without an ID
  // (or copied layers that share one). Never let new IDs displace imported IDs.
  const importedIds = new Set<number>();
  const exportIds = new Map<string, number>();
  const layers = allLayers(doc.layers);
  for (const l of layers)
    if (l.psdId !== undefined && !importedIds.has(l.psdId)) {
      importedIds.add(l.psdId);
      exportIds.set(l.id, l.psdId);
    }
  let nextId = 1;
  for (const l of layers)
    if (!exportIds.has(l.id)) {
      while (importedIds.has(nextId)) nextId++;
      importedIds.add(nextId);
      exportIds.set(l.id, nextId++);
    }
  // Painted masks become PSD user masks; inversion is baked into the values.
  const gridMask = (l: Layer): PsdLayer["mask"] | undefined => {
    if (!l.maskGrid || l.pixelMask || hasMask(l) || !readMaskGrid) return;
    const plane = readMaskGrid(l);
    if (!plane) return;
    const flip = (v: number) => (l.maskInverted ? 255 - v : v);
    const { bounds: b } = plane;
    let imageData: PixelData | undefined;
    if (b.width > 0 && b.height > 0) {
      allocated += b.width * b.height * 4 * bytesPerSample;
      if (allocated > memoryLimit)
        throw new Error("PSD export exceeds the 512 MB pixel budget.");
      const n = b.width * b.height;
      const data =
        depth === 32 ? new Float32Array(n * 4) : depth === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
      const max = depth === 32 ? 1 : depth === 16 ? 65535 : 255;
      for (let i = 0; i < n; i++) {
        const v = flip(plane.data[i]);
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = depth === 32 ? v / 255 : depth === 16 ? v * 257 : v;
        data[i * 4 + 3] = max;
      }
      imageData = { width: b.width, height: b.height, data };
    }
    return {
      left: b.x,
      top: b.y,
      right: b.x + b.width,
      bottom: b.y + b.height,
      defaultColor: flip(plane.defaultColor),
      disabled: !!l.maskDisabled,
      imageData,
    };
  };
  const convert = async (l: Layer): Promise<PsdLayer> => {
    const paintedMask = gridMask(l);
    const result: PsdLayer = {
      id: exportIds.get(l.id),
      name: l.name,
      hidden: !l.visible,
      opacity: l.opacity,
      blendMode: l.blend,
      ...(l.clipped ? { clipping: true } : {}),
      ...exportBlending(l),
      transparencyProtected: l.transparencyProtected,
      protected: exportProtection(l),
      mask: paintedMask ?? await exportPsdPixelMask(l, depth, readMetadata, (w, h) => {
        allocated += w * h * 4 * bytesPerSample;
        if (allocated > memoryLimit)
          throw new Error("PSD export exceeds the 512 MB pixel budget.");
      }),
    };
    // Layer styles have no PSD effect records here: styled layers export as
    // pixels with their effects baked in (see renderer/layer-style.ts).
    const styled = !!activeLayerStyle(l);
    if (l.kind === "vector" && !styled) {
      Object.assign(result, transformedVectorPsdBounds(l));
      if (isVectorGradient(l.vector!.fill))
        result.vectorFill = gradientExport(l) as unknown as PsdLayer["vectorFill"];
      else if (isVectorPattern(l.vector!.fill)) {
        const {
          asset: _asset,
          referencePoint: _reference,
          ...definition
        } = l.vector!.fill;
        result.vectorFill = definition;
        result.referencePoint = patternReferencePoint(
          l.vector!.fill,
          vectorPaintMatrix(l),
        );
      } else {
        let rgb = vectorDocumentRgb(l, doc);
        const f = l.filters;
        if (f.brightness || f.contrast || f.saturation) {
          if (depth === 8)
            rgb = rgb.map(
              (v) => Math.round(Math.max(0, Math.min(1, v)) * 255) / 255,
            );
          rgb = rgb.map(
            (v) =>
              (v + f.brightness / 100 - 0.5) * (1 + f.contrast / 100) + 0.5,
          );
          const gray = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          rgb = rgb.map((v) => gray + (v - gray) * (1 + f.saturation / 100));
          if (depth !== 32) rgb = rgb.map((v) => Math.max(0, Math.min(1, v)));
        }
        result.vectorFill = {
          type: "color",
          color: { r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255 },
        };
      }
      result.vectorMask = transformedVectorMask(l);
      if (l.vector!.stroke)
        result.vectorStroke = exportVectorStroke(
          l.vector!.stroke,
          vectorColorRgb(l.vector!.stroke.color, doc),
        );
    } else if (l.kind === "adjustment" && exportPsdAdjustment(l.adjustment)) {
      // Real adjustment layer: no pixels, the painted mask if any.
      result.adjustment = exportPsdAdjustment(l.adjustment);
      if (l.clipped) result.clipping = true;
      result.mask ??= await exportGridMask(l, doc, async (probe) => {
        allocated += doc.width * doc.height * 4 * bytesPerSample;
        return pixels(probe);
      });
    } else if (
      l.kind === "group" &&
      // Frames have no PSD equivalent; they export as their masked pixels.
      !l.frame &&
      !styled &&
      (!hasMask(l) || !!l.pixelMask) &&
      !Object.values(l.filters).some(Boolean)
    ) {
      result.children = [];
      for (const child of l.children)
        result.children.push(await convert(child));
      result.opened = true;
      if (l.artboard) result.artboard = exportPsdArtboard(l.artboard);
    } else {
      const t = l.transform;
      const plainRaster =
        !styled &&
        ((l.kind === "image" && l.asset) || (l.kind === "pixel" && l.pixels?.bounds)) &&
        readSource &&
        (!hasMask(l) || !!l.pixelMask) &&
        (!l.maskGrid || !!paintedMask) &&
        !Object.values(l.filters).some(Boolean) &&
        t.rotation % 360 === 0 &&
        Number.isInteger(t.x) &&
        Number.isInteger(t.y) &&
        t.width === l.sourceWidth &&
        t.height === l.sourceHeight;
      if (plainRaster) {
        // Layer rectangles are signed 32-bit coordinates in PSD and PSB.
        if (
          t.x < -0x80000000 ||
          t.y < -0x80000000 ||
          t.x + l.sourceWidth > 0x7fffffff ||
          t.y + l.sourceHeight > 0x7fffffff
        )
          throw new Error("Layer bounds exceed PSD signed 32-bit coordinates.");
        if (
          allocated + l.sourceWidth * l.sourceHeight * 4 * bytesPerSample >
          memoryLimit
        )
          throw new Error("PSD export exceeds the 512 MB pixel budget.");
        const source = await readSource!(l);
        assertSize(source.width, source.height);
        if (
          source.width !== l.sourceWidth ||
          source.height !== l.sourceHeight ||
          source.data.length !== source.width * source.height * 4
        )
          throw new Error("PSD source dimensions do not match the layer.");
        allocated += source.width * source.height * 4 * bytesPerSample;
        result.imageData = channelData(
          source.data,
          source.width,
          source.height,
        );
        result.left = t.x;
        result.top = t.y;
      } else {
        allocated += doc.width * doc.height * 4 * bytesPerSample;
        result.imageData = await pixels([
          {
            ...l,
            visible: true,
            opacity: 1,
            blend: "normal",
            clipped: false,
            // Blend If and knockout are written as layer properties.
            blending: undefined,
            ...(paintedMask
              ? { maskGrid: undefined, maskInverted: false, maskDisabled: false }
              : {}),
            ...(l.pixelMask
              ? {
                  pixelMask: undefined,
                  maskStrokes: undefined,
                  maskInverted: false,
                  maskDisabled: false,
                }
              : {}),
          },
        ]);
        result.left = 0;
        result.top = 0;
      }
      // Editable text travels with its rendered pixels (cropped to the ink)
      // as the appearance readers show without the fonts.
      if (l.kind === "text" && l.textData) {
        // Path and area text have no PSD equivalent here: their pixels are
        // written, and .photo projects keep them editable.
        if (!l.textData.path && !l.textData.block) result.text = exportPsdText(l.textData, textMatrix(l), documentPpi(doc));
        const crop = cropToInk(result.imageData!);
        if (crop) {
          result.imageData = crop.pixels;
          result.left = (result.left ?? 0) + crop.x;
          result.top = (result.top ?? 0) + crop.y;
        }
      }
    }
    return result;
  };
  const children: PsdLayer[] = [];
  for (const l of doc.layers) children.push(await convert(l));
  const artboardCount = doc.layers.filter((l) => l.artboard).length;
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    bitsPerChannel: depth,
    imageData,
    children,
    ...(artboardCount ? { artboards: { count: artboardCount } } : {}),
    imageResources: {
      resolutionInfo: doc.resolution ? { ...doc.resolution } : undefined,
      pixelAspectRatio: doc.pixelAspect ? { aspect: doc.pixelAspect } : undefined,
      iccUntaggedProfile: doc.iccUntaggedProfile,
      versionInfo: {
        hasRealMergedData: composite,
        writerName: "Photo Editor",
        readerName: "Photo Editor",
        fileVersion: 1,
      },
    },
  };
  let buffer =
    depth === 8
      ? writePsdWithPreciseStrokes(psd, { noBackground: true })
      : writeHighDepthPsd(psd);
  // ag-psd 31 underallocates the composite RLE buffer for widths 1 and 2.
  // Replace only that final section with valid uncompressed planar RGB(A).
  if (depth === 8 && doc.width < 3) buffer = narrowComposite(buffer, imageData);
  if (doc.iccProfile)
    buffer = replacePsdImageResource(
      new Uint8Array(buffer),
      1039,
      decodeIccProfile(doc.iccProfile),
    );
  if (metadata) buffer = restorePsdMetadata(new Uint8Array(buffer), metadata);
  if (resources)
    buffer = restorePsdImageResources(new Uint8Array(buffer), resources);
  return new Blob([buffer], { type: "image/vnd.adobe.photoshop" });
}

function narrowComposite(buffer: ArrayBuffer, pixels: PixelData): ArrayBuffer {
  const view = new DataView(buffer);
  let offset = 26;
  // Color mode data, image resources, then layer/mask data (PSD v1 lengths).
  for (let i = 0; i < 3; i++) offset += 4 + view.getUint32(offset);
  const channels = view.getUint16(12);
  const size = pixels.width * pixels.height;
  const result = new Uint8Array(offset + 2 + channels * size);
  result.set(new Uint8Array(buffer, 0, offset));
  // The zero compression word is followed by one plane per channel.
  for (let channel = 0; channel < channels; channel++) {
    for (let i = 0; i < size; i++) {
      const alpha = pixels.data[i * 4 + 3];
      const value = pixels.data[i * 4 + channel];
      result[offset + 2 + channel * size + i] =
        channel < 3 && channels === 4 && alpha > 0 && alpha < 255
          ? Math.round((value * alpha) / 255 + 255 - alpha)
          : value;
    }
  }
  return result.buffer;
}

// Turns an imported raster layer into editable text placed like the PSD
// layer. Returns the families that are not available for rendering; while
// any is missing the saved pixels stay as the layer's appearance.
function editableText(l: Layer, text: ImportedText, source: NonNullable<PsdLayer["text"]>): string[] {
  const families = new Set(text.data.content.paragraphs.flatMap((p) => p.runs.map((r) => r.style.family)));
  const missing = [...families].filter((f) => !findBundled(f) && !isFontAvailable(f));
  const [a, b, c, d, e, f] = text.matrix;
  const [sx, sy] = text.scale;
  const rotated = Math.abs(text.rotation) > 1e-6;
  const raster = l.asset ? { x: l.transform.x, y: l.transform.y, width: l.sourceWidth, height: l.sourceHeight } : undefined;
  l.kind = "text";
  l.textData = text.data;
  if (raster && !rotated) {
    // The saved raster rectangle is the frame, so the fallback pixels and the
    // live text share one placement.
    l.textFrame = { x: (raster.x - e) / sx, y: (raster.y - f) / sy, width: raster.width / sx, height: raster.height / sy };
    l.transform = { ...raster, rotation: 0 };
  } else {
    const bb = source.boundingBox;
    let local = { x: 0, y: -1, width: 1, height: 1 };
    if (bb && [bb.left, bb.top, bb.right, bb.bottom].every((v) => Number.isFinite(v?.value)) && bb.right.value > bb.left.value && bb.bottom.value > bb.top.value)
      local = { x: bb.left.value, y: bb.top.value, width: bb.right.value - bb.left.value, height: bb.bottom.value - bb.top.value };
    else if (raster) {
      // Local box enclosing the saved pixels; refit when the text is edited.
      const det = a * d - b * c;
      const inv = (x: number, y: number) => [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
      const pts = [[raster.x, raster.y], [raster.x + raster.width, raster.y], [raster.x, raster.y + raster.height], [raster.x + raster.width, raster.y + raster.height]].map(([x, y]) => inv(x, y));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      local = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    const cx = local.x + local.width / 2, cy = local.y + local.height / 2;
    const width = local.width * sx, height = local.height * sy;
    const mx = a * cx + c * cy + e, my = b * cx + d * cy + f;
    l.textFrame = local;
    l.transform = { x: mx - width / 2, y: my - height / 2, width, height, rotation: text.rotation };
  }
  if (!missing.length || rotated) {
    delete l.asset;
    delete l.assetColorSpace;
  }
  syncLegacyFields(l);
  return missing;
}

// Smallest rectangle with nonzero alpha in 4-channel pixels (any depth).
function cropToInk(p: PixelData): { pixels: PixelData; x: number; y: number } | undefined {
  const { width: w, height: h, data } = p;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0, i = y * w * 4 + 3; x < w; x++, i += 4)
      if (data[i] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1)) return;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = new (data.constructor as new (n: number) => typeof data)(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4) as never, y * cw * 4);
  return { pixels: { width: cw, height: ch, data: out } as PixelData, x: x0, y: y0 };
}
