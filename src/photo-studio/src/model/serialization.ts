import { allLayers, assertSize, blends, type Layer, type PhotoDocument } from "./document";
import { Assets } from "./assets";
import { rasterMimeType } from './raster';
import { maxIccProfileBytes, psdResourcesMimeType } from './psd-resources';
import { validateVectorShape } from './vector';
import { validateTextData } from './text-layer';
import { validateDocumentPaths, validateLayerVectorMask } from './paths';
import { psdMetadataMimeType } from './psd-metadata';
import { inverseMaskMatrix, validatePixelMask } from './pixel-mask';
import { coverageMimeType } from './coverage';
import { psdOriginalMimeType } from './psd-original';
import { isVectorPattern } from './vector-pattern';
import { packGrid, tilePackMimeType, unpackGrid, type TileGrid } from './tiles';
import { validDocumentPatterns, validLayerFill } from './fill-layer';
import { validateAnnotations } from './annotations';
import { validateAnimation } from './animation';
import { validateTimeline } from './video-timeline';
import { validateVideoLayer } from './video-layer';
import { validateArtboard } from './artboard';
import { validateFrame } from './frame';
import { validateLayerComps } from './layer-comps';
import { validateSlices } from './slices';
import { validateVariables } from './variables';
import { embedAssetIds, projectMimeType, sourceMimeType, usedEmbeds, validateEmbeds } from './embedded';
import { migratePinWarps, validatePinWarp } from './pin-warp';
import { validTextStyles } from '../imaging/text/styles';
import { validateHdrPreview } from './hdr-preview';
import { validateBlending } from './blending';
import { migrateGuides } from './guides';
// Tile grids are stored as one packed asset each; the saved JSON names the pack
// in place of the live tile map.
type PackedRef = { pack: string };
const maxLayers = 1000;
// A portable binary bundle: magic, JSON byte length, metadata, then original image blobs.
const magic = new TextEncoder().encode("PHOTO001");
export async function serialize(
  live: PhotoDocument,
  assets: Assets,
): Promise<Blob> {
  const packs = new Map<string, Blob>();
  const doc = structuredClone(live);
  const pack = async (grid: TileGrid): Promise<PackedRef> => {
    const id = crypto.randomUUID();
    packs.set(id, await packGrid(assets.tiles, grid));
    return { pack: id };
  };
  for (const l of allLayers(doc.layers)) {
    if (l.pixels) l.pixels = (await pack(l.pixels)) as unknown as TileGrid;
    if (l.maskGrid) l.maskGrid = (await pack(l.maskGrid)) as unknown as TileGrid;
    if (l.liveSource) l.liveSource = (await pack(l.liveSource)) as unknown as TileGrid;
    if (l.liveMask) l.liveMask = (await pack(l.liveMask)) as unknown as TileGrid;
    for (const [k, g] of Object.entries(l.video?.altered ?? {})) l.video!.altered![k] = (await pack(g)) as unknown as TileGrid;
  }
  for (const c of doc.channels ?? []) c.grid = (await pack(c.grid)) as unknown as TileGrid;
  for (const p of doc.patterns ?? []) p.grid = (await pack(p.grid)) as unknown as TileGrid;
  // The active selection is session state and is not saved; channels persist.
  doc.selectionMask = undefined;
  // Content left over from deleted embedded objects is not written; a layer
  // whose content is missing still draws its own image.
  // Layers turned into pixels by any edit no longer draw embedded contents.
  for (const l of allLayers(doc.layers)) if (l.embed && l.kind !== 'image') delete l.embed;
  doc.embeds = usedEmbeds(doc);
  for (const l of allLayers(doc.layers)) if (l.embed && !doc.embeds?.[l.embed.contents]) delete l.embed;
  const blobOf = (id: string) => packs.get(id) ?? assets.blob(id);
  const ids = [
    ...new Set(
      [
        doc.psdMetadataAsset,
        doc.psdResourcesAsset,
        doc.psdOriginal?.asset,
        ...allLayers(doc.layers).flatMap((l) => [
          l.asset,
          l.pinWarp?.source,
          l.maskAsset,
          l.pixelMask?.asset,
          l.video?.footage?.asset,
          isVectorPattern(l.vector?.fill) ? l.vector!.fill.asset : undefined,
        ]),
        ...Object.values(doc.embeds ?? {}).flatMap(embedAssetIds),
      ].filter((id): id is string => !!id),
    ),
    ...packs.keys(),
  ];
  const records = ids.map((id) => ({
    id,
    size: blobOf(id).size,
    type: blobOf(id).type,
  }));
  const json = new TextEncoder().encode(
    JSON.stringify({ document: doc, assets: records }),
  );
  const header = new Uint8Array(12);
  if (
    json.length > 16 * 1024 * 1024 ||
    12 + json.length + records.reduce((sum, a) => sum + a.size, 0) > 512 * 1024 * 1024
  )
    throw new Error('This project exceeds the 512 MB file or 16 MB metadata limit.');
  header.set(magic);
  new DataView(header.buffer).setUint32(8, json.length, true);
  return new Blob([header, json, ...ids.map(blobOf)], {
    type: "application/x-photo-editor",
  });
}
// Live Filters: a pixel layer with an unfiltered source and a list of filter
// settings. Operation IDs are checked when rendering, so unknown filters from
// newer versions load and are reported instead of failing the whole project.
function validateLiveFilters(l: Layer, packed: (g: unknown) => boolean) {
  if (l.liveSource === undefined && l.liveFilters === undefined && l.liveMask === undefined && l.liveMaskDisabled === undefined) return;
  if (l.kind !== 'pixel' || !packed(l.liveSource) || !Array.isArray(l.liveFilters) || l.liveFilters.length > 100 ||
    (l.liveMask !== undefined && !packed(l.liveMask)) || (l.liveMaskDisabled !== undefined && typeof l.liveMaskDisabled !== 'boolean'))
    throw new Error('Invalid Live Filters.');
  for (const f of l.liveFilters)
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id || f.id.length > 64 ||
      !f.params || typeof f.params !== 'object' || Array.isArray(f.params) ||
      typeof f.enabled !== 'boolean' || !Number.isFinite(f.opacity) || f.opacity < 0 || f.opacity > 1 ||
      !blends.includes(f.blend) || !Number.isInteger(f.seed) || f.seed < 0 || f.seed > 0xffffffff)
      throw new Error('Invalid Live Filter.');
}
export function validateDocument(value: unknown): PhotoDocument {
  const doc = value as PhotoDocument;
  if (
    !doc ||
    doc.version !== 1 ||
    typeof doc.name !== "string" ||
    !Array.isArray(doc.layers)
  )
    throw new Error("Invalid Photo Editor project.");
  assertSize(doc.width, doc.height);
  if (doc.bitsPerChannel !== undefined && ![8, 16, 32].includes(doc.bitsPerChannel))
    throw new Error('Invalid document channel depth.');
  if (doc.iccProfile !== undefined && (
    typeof doc.iccProfile !== 'string' || !doc.iccProfile.length ||
    doc.iccProfile.length > 4 * Math.ceil(maxIccProfileBytes / 3) ||
    doc.iccProfile.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(doc.iccProfile) ||
    (doc.iccProfile.length / 4 * 3 - (doc.iccProfile.endsWith('==') ? 2 : doc.iccProfile.endsWith('=') ? 1 : 0)) > maxIccProfileBytes
  )) throw new Error('Invalid document ICC profile.');
  if (doc.iccUntaggedProfile !== undefined && typeof doc.iccUntaggedProfile !== 'boolean')
    throw new Error('Invalid document ICC untagged state.');
  validateColorMode(doc);
  if (doc.hdrPreview !== undefined) doc.hdrPreview = validateHdrPreview(doc.hdrPreview);
  if (doc.psdMetadataAsset !== undefined &&
    (typeof doc.psdMetadataAsset !== 'string' || !doc.psdMetadataAsset.length))
    throw new Error('Invalid PSD metadata asset reference.');
  if (doc.psdResourcesAsset !== undefined &&
    (typeof doc.psdResourcesAsset !== 'string' || !doc.psdResourcesAsset.length))
    throw new Error('Invalid PSD image resources asset reference.');
  if (doc.psdOriginal !== undefined && (
    !doc.psdOriginal || typeof doc.psdOriginal !== 'object' ||
    typeof doc.psdOriginal.asset !== 'string' || !doc.psdOriginal.asset.length ||
    typeof doc.psdOriginal.previewFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(doc.psdOriginal.previewFingerprint)
  )) throw new Error('Invalid original PSD reference.');
  if (doc.resolution !== undefined) {
    const r = doc.resolution;
    const measurements = [
      "Inches",
      "Centimeters",
      "Points",
      "Picas",
      "Columns",
    ];
    // PSD's codec uses signed 16.16 fixed point for resolution.
    if (
      !r ||
      ![r.horizontalResolution, r.verticalResolution].every(
        (n) => Number.isFinite(n) && n > 0 && n <= 0x7fffffff / 0x10000,
      ) ||
      !["PPI", "PPCM"].includes(r.horizontalResolutionUnit) ||
      !["PPI", "PPCM"].includes(r.verticalResolutionUnit) ||
      !measurements.includes(r.widthUnit) ||
      !measurements.includes(r.heightUnit)
    )
      throw new Error("Invalid document resolution.");
  }
  const finite = (o: unknown, keys: string[]) =>
    !!o &&
    typeof o === "object" &&
    keys.every(
      (k) =>
        typeof (o as Record<string, unknown>)[k] === "number" &&
        Number.isFinite((o as Record<string, unknown>)[k]),
    );
  if (doc.pixelAspect !== undefined && !(typeof doc.pixelAspect === 'number' && Number.isFinite(doc.pixelAspect) && doc.pixelAspect >= 0.1 && doc.pixelAspect <= 10))
    throw new Error('Invalid pixel aspect ratio.');
  if (doc.selection && !finite(doc.selection, ["x", "y", "width", "height"]))
    throw new Error("Invalid selection.");
  validateDocumentPaths(doc.paths, doc.workPath);
  validateAnnotations(doc.annotations);
  const ids = new Set<string>();
  let count = 0;
  const walk = (layers: PhotoDocument["layers"], depth: number) => {
    if (depth > 12) throw new Error("Too many nested groups.");
    for (const l of layers) {
      if (
        ++count > maxLayers ||
        typeof l.id !== "string" ||
        ids.has(l.id) ||
        !["image", "paint", "text", "group", "solid", "vector", "pixel", "adjustment"].includes(l.kind) ||
        !(blends.includes(l.blend) || (l.blend === "pass through" && l.kind === "group")) ||
        !Array.isArray(l.children) ||
        !Array.isArray(l.strokes) ||
        typeof l.name !== "string" ||
        typeof l.text !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(l.color)
      )
        throw new Error("Invalid layer.");
      ids.add(l.id);
      const protection = l.protection;
      if (
        typeof l.locked !== 'boolean' ||
        (l.transparencyProtected !== undefined && typeof l.transparencyProtected !== 'boolean') ||
        (protection !== undefined && (
          !protection || typeof protection !== 'object' ||
          !(['transparency', 'composite', 'position'] as const).every(k => typeof protection[k] === 'boolean') ||
          (protection.artboards !== undefined && typeof protection.artboards !== 'boolean')
        ))
      ) throw new Error('Invalid layer protection.');
      // Saved projects name a tile pack; live documents (PSD export) carry the grid.
      const packed = (g: unknown) =>
        !!g && (typeof (g as PackedRef).pack === 'string' ||
          (typeof (g as TileGrid).tiles === 'object' && [1, 4].includes((g as TileGrid).channels)));
      if ((l.kind === 'pixel') !== (l.pixels !== undefined) || (l.pixels && !packed(l.pixels)) || (l.maskGrid && !packed(l.maskGrid)))
        throw new Error('Invalid pixel layer.');
      validateLiveFilters(l, packed);
      if (l.video !== undefined) {
        if (l.kind !== 'pixel') throw new Error('Invalid video layer.');
        validateVideoLayer(l.video, packed);
      }
      if ((l.kind === 'adjustment') !== (l.adjustment !== undefined) ||
        (l.adjustment && (typeof l.adjustment.kind !== 'string' || !l.adjustment.params || typeof l.adjustment.params !== 'object')))
        throw new Error('Invalid adjustment layer.');
      if ((l.clipped !== undefined && typeof l.clipped !== 'boolean') ||
        (l.fillOpacity !== undefined && !(Number.isFinite(l.fillOpacity) && l.fillOpacity >= 0 && l.fillOpacity <= 1)) ||
        (l.style !== undefined && (!l.style || typeof l.style !== 'object')) ||
        (l.fill !== undefined && (l.kind !== 'solid' || !validLayerFill(l.fill))))
        throw new Error('Invalid layer options.');
      validateBlending(l.blending);
      if (l.psdId !== undefined && (!Number.isInteger(l.psdId) || l.psdId < 0 || l.psdId > 0xffffffff))
        throw new Error('Invalid PSD layer identifier.');
      if (l.kind === 'vector') {
        validateVectorShape(l.vector!);
        if (l.asset || l.children.length) throw new Error('A vector shape cannot contain raster sources or children.');
      } else if (l.vector) throw new Error('Invalid vector layer kind.');
      if (l.textData !== undefined || l.textFrame !== undefined) {
        if (l.kind !== 'text') throw new Error('Invalid text layer kind.');
        validateTextData(l.textData);
        if (l.textFrame !== undefined && !(finite(l.textFrame, ['x', 'y', 'width', 'height']) && l.textFrame.width > 0 && l.textFrame.height > 0))
          throw new Error('Invalid text frame.');
      }
      if (l.vectorMask !== undefined) validateLayerVectorMask(l.vectorMask);
      validateArtboard(l, depth === 0);
      validateFrame(l);
      validatePinWarp(l);
      const gen = l.generated;
      if (gen !== undefined && (!gen || typeof gen !== 'object' || !['generate', 'edit', 'upscale'].includes(gen.kind) || typeof gen.prompt !== 'string' || gen.prompt.length > 4000 ||
        (gen.model !== undefined && typeof gen.model !== 'string') || (gen.style !== undefined && typeof gen.style !== 'string')))
        throw new Error('Invalid generated layer information.');
      if (l.assetColorSpace !== undefined && !['document', 'srgb'].includes(l.assetColorSpace))
        throw new Error('Invalid source color space.');
      assertSize(l.sourceWidth, l.sourceHeight);
      if (
        !l.transform ||
        !l.filters ||
        !finite(l.transform, ["x", "y", "width", "height", "rotation"]) ||
        l.transform.width <= 0 ||
        l.transform.height <= 0 ||
        !finite(l.filters, ["brightness", "contrast", "saturation", "blur"]) ||
        !Number.isFinite(l.opacity) ||
        l.opacity < 0 ||
        l.opacity > 1 ||
        !Number.isFinite(l.fontSize) ||
        l.fontSize <= 0
      )
        throw new Error("Invalid layer properties.");
      if (l.mask && !finite(l.mask, ["x", "y", "width", "height"]))
        throw new Error("Invalid mask.");
      if (l.pixelMask) {
        validatePixelMask(l.pixelMask);
        if (l.mask || l.maskAsset) throw new Error('A pixel mask cannot contain another mask source.');
        if (l.pixelMask.fromVectorData || l.pixelMask.userMaskFeather || l.pixelMask.vectorMaskFeather ||
          (l.pixelMask.vectorMaskDensity !== undefined && l.pixelMask.vectorMaskDensity !== 1))
          throw new Error('Pixel mask rendering parameters are not yet supported.');
      }
      if (l.linkGroup !== undefined && (typeof l.linkGroup !== 'string' || !l.linkGroup || l.linkGroup.length > 64))
        throw new Error('Invalid layer link.');
      for (const flag of [l.maskDisabled, l.maskInverted, l.maskUnlinked, l.background])
        if (flag !== undefined && typeof flag !== "boolean")
          throw new Error("Invalid mask state.");
      if (l.maskStrokes !== undefined) {
        if (!Array.isArray(l.maskStrokes))
          throw new Error("Invalid mask strokes.");
        const points = (p: unknown): boolean =>
          Array.isArray(p) &&
          p.length > 0 &&
          p.every(
            (q) =>
              Array.isArray(q) && q.length === 2 && q.every(Number.isFinite),
          );
        for (const s of l.maskStrokes) {
          if (s?.matrix !== undefined) {
            if (!l.pixelMask || !Array.isArray(s.matrix) || s.matrix.length !== 6 || !s.matrix.every(Number.isFinite))
              throw new Error('Invalid mask stroke transform.');
            inverseMaskMatrix(s.matrix);
          }
          if (
            !s ||
            !points(s.points) ||
            !Number.isFinite(s.size) ||
            s.size <= 0 ||
            !Number.isFinite(s.softness) ||
            s.softness < 0 ||
            s.softness > 1 ||
            !Number.isFinite(s.opacity) ||
            s.opacity < 0 ||
            s.opacity > 1 ||
            typeof s.restore !== "boolean" ||
            (s.aspect !== undefined &&
              (!Number.isFinite(s.aspect) || s.aspect <= 0)) ||
            (s.clip !== undefined && (!points(s.clip) || s.clip.length !== 4))
          )
            throw new Error("Invalid mask stroke.");
        }
      }
      for (const s of l.strokes)
        if (
          !/^#[0-9a-f]{6}$/i.test(s.color) ||
          !Number.isFinite(s.size) ||
          s.size <= 0 ||
          (s.preserveAlpha !== undefined && typeof s.preserveAlpha !== 'boolean') ||
          !Array.isArray(s.points) ||
          !s.points.every((p) => p.length === 2 && p.every(Number.isFinite))
        )
          throw new Error("Invalid brush stroke.");
      walk(l.children, depth + 1);
    }
  };
  walk(doc.layers, 0);
  validateLayerComps(doc.layerComps, doc.lastComp);
  if (doc.globalLight !== undefined && !(finite(doc.globalLight, ['angle', 'altitude']) && Math.abs(doc.globalLight.angle) <= 360 && doc.globalLight.altitude >= 0 && doc.globalLight.altitude <= 90))
    throw new Error('Invalid global light.');
  validateSlices(doc.slices);
  validateVariables(doc.variables);
  validateEmbeds(doc);
  if (doc.patterns !== undefined && !validDocumentPatterns(doc.patterns)) throw new Error('Invalid document patterns.');
  if (doc.animation !== undefined) validateAnimation(doc.animation);
  if (doc.timeline !== undefined) {
    if (doc.animation !== undefined) throw new Error('A document has either a frame animation or a video timeline.');
    validateTimeline(doc.timeline);
  }
  if (doc.textStyles !== undefined && !validTextStyles(doc.textStyles)) throw new Error('Invalid text styles.');
  if (
    doc.perspectivePlanes !== undefined &&
    !(Array.isArray(doc.perspectivePlanes) && doc.perspectivePlanes.length <= 64 && doc.perspectivePlanes.every((q) => Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))))
  )
    throw new Error('Invalid perspective planes.');
  // Canvas guides of older projects stay canvas guides; invalid entries go.
  migrateGuides(doc);
  return doc;
}
/** Read a .photo project. With `into`, its assets are added to an existing
 * store (assets already present keep their data; IDs are immutable content). */
export async function deserialize(
  blob: Blob,
  into?: Assets,
): Promise<{ document: PhotoDocument; assets: Assets }> {
  if (blob.size > 512 * 1024 * 1024) throw new Error("Project exceeds 512 MB.");
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (head.length !== 12 || !magic.every((v, i) => v === head[i]))
    throw new Error("Choose a .photo project.");
  const length = new DataView(head.buffer).getUint32(8, true);
  if (length > 16 * 1024 * 1024 || length + 12 > blob.size)
    throw new Error("Invalid project header.");
  const data = JSON.parse(await blob.slice(12, 12 + length).text()) as {
    document: unknown;
    assets: { id: string; size: number; type: string }[];
  };
  const document = validateDocument(data.document),
    assets = into ?? new Assets();
  let offset = 12 + length;
  const packs = new Map<string, Blob>();
  try {
    // Up to two image/mask assets per supported layer, plus three document
    // assets and three per embedded object.
    // Altered video frames are one tile pack each.
    const altered = allLayers(document.layers).reduce((n, l) => n + Object.keys(l.video?.altered ?? {}).length, 0);
    if (!Array.isArray(data.assets) || data.assets.length > maxLayers * 3 + 64 + Object.keys(document.embeds ?? {}).length * 3 + altered)
      throw new Error("Invalid asset table.");
    const assetIds = new Set<string>();
    for (const a of data.assets) {
      if (assetIds.has(a.id)) throw new Error("Duplicate asset identifier.");
      assetIds.add(a.id);
      if (
        !Number.isInteger(a.size) ||
        a.size < 0 ||
        offset + a.size > blob.size ||
        typeof a.id !== "string" ||
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/avif",
          rasterMimeType,
          coverageMimeType,
          psdMetadataMimeType,
          psdResourcesMimeType,
          psdOriginalMimeType,
          tilePackMimeType,
          projectMimeType,
          sourceMimeType,
        ].includes(a.type)
      )
        throw new Error("Invalid project image.");
      const part = blob.slice(offset, offset + a.size, a.type);
      if (a.type === tilePackMimeType) packs.set(a.id, part);
      else if (!into?.has(a.id)) await assets.add(part, a.id);
      offset += a.size;
    }
    const unpack = async (ref: unknown) => {
      const part = packs.get((ref as PackedRef).pack);
      if (!part) throw new Error('Missing pixel tile pack.');
      packs.delete((ref as PackedRef).pack);
      return unpackGrid(assets.tiles, part);
    };
    for (const l of allLayers(document.layers)) {
      if (l.pixels) {
        l.pixels = await unpack(l.pixels);
        if (l.pixels.channels !== 4) throw new Error('Invalid pixel layer tiles.');
      }
      if (l.maskGrid) {
        l.maskGrid = await unpack(l.maskGrid);
        if (l.maskGrid.channels !== 1) throw new Error('Invalid layer mask tiles.');
      }
      if (l.liveSource) {
        l.liveSource = await unpack(l.liveSource);
        if (l.liveSource.channels !== 4) throw new Error('Invalid Live Filter source tiles.');
      }
      if (l.liveMask) {
        l.liveMask = await unpack(l.liveMask);
        if (l.liveMask.channels !== 1) throw new Error('Invalid Live Filter mask tiles.');
      }
      for (const [k, g] of Object.entries(l.video?.altered ?? {})) {
        l.video!.altered![k] = await unpack(g);
        if (l.video!.altered![k].channels !== 4) throw new Error('Invalid altered video frame tiles.');
      }
    }
    if (document.channels !== undefined && !Array.isArray(document.channels)) throw new Error('Invalid channels.');
    for (const c of document.channels ?? []) {
      if (typeof c.id !== 'string' || typeof c.name !== 'string' ||
        (c.spot !== undefined && typeof c.spot !== 'boolean') || (c.hidden !== undefined && typeof c.hidden !== 'boolean') ||
        (c.color !== undefined && !hexColor(c.color))) throw new Error('Invalid channel.');
      c.grid = await unpack(c.grid);
      if (c.grid.channels !== 1) throw new Error('Invalid channel tiles.');
    }
    for (const p of document.patterns ?? []) {
      p.grid = await unpack(p.grid);
      if (p.grid.channels !== 4) throw new Error('Invalid pattern tiles.');
    }

    if (document.psdMetadataAsset && assets.blob(document.psdMetadataAsset).type !== psdMetadataMimeType)
      throw new Error('Invalid PSD metadata asset type.');
    if (document.psdResourcesAsset && assets.blob(document.psdResourcesAsset).type !== psdResourcesMimeType)
      throw new Error('Invalid PSD image resources asset type.');
    if (document.psdOriginal && assets.blob(document.psdOriginal.asset).type !== psdOriginalMimeType)
      throw new Error('Invalid original PSD asset type.');
    for (const l of allLayers(document.layers)) {
      if (isVectorPattern(l.vector?.fill)) {
        const fill = l.vector!.fill;
        if (assets.blob(fill.asset).type !== psdMetadataMimeType)
          throw new Error("Invalid pattern definition asset type.");
        const resource = await assets.patternResource(fill.asset, fill.id);
        const { supportedPsdPattern } = await import("./psd-patterns");
        if (!supportedPsdPattern(resource))
          throw new Error("Unsupported pattern definition layout.");
      }
      if (l.asset) assets.dimensions(l.asset);
      if (l.pinWarp) assets.dimensions(l.pinWarp.source);
      if (l.maskAsset) assets.get(l.maskAsset);
      if (l.video?.footage && assets.blob(l.video.footage.asset).type !== sourceMimeType) throw new Error('Invalid video footage asset.');
      if (l.pixelMask?.asset) {
        const samples = assets.coverage(l.pixelMask.asset);
        if (samples.width !== l.pixelMask.bounds.width || samples.height !== l.pixelMask.bounds.height)
          throw new Error('Pixel mask dimensions do not match its coverage asset.');
      }
    }
    for (const c of Object.values(document.embeds ?? {})) {
      const { width, height } = assets.dimensions(c.composite);
      if (width !== c.width || height !== c.height) throw new Error('Embedded object size does not match its content.');
      if (c.project && assets.blob(c.project).type !== projectMimeType) throw new Error('Invalid embedded project asset type.');
      if (c.source) assets.blob(c.source);
    }
    // Warped image layers from before embedded contents become pin frames.
    migratePinWarps(document);
    return { document, assets };
  } catch (error) {
    if (!into) assets.clear();
    throw error;
  }
}

const colorModes = ['rgb', 'grayscale', 'cmyk', 'lab', 'indexed', 'bitmap', 'duotone', 'multichannel'];
const hexColor = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function validateColorMode(doc: PhotoDocument) {
  if (doc.mode !== undefined && !colorModes.includes(doc.mode)) throw new Error('Invalid document color mode.');
  const m = doc.modeData;
  if (m === undefined) return;
  const bad = () => new Error('Invalid document color mode data.');
  if (!m || typeof m !== 'object') throw bad();
  if (m.profile !== undefined && (typeof m.profile !== 'string' || !m.profile.length ||
    m.profile.length > 4 * Math.ceil(maxIccProfileBytes / 3) ||
    !(/^builtin:[a-z0-9-]+$/.test(m.profile) || (m.profile.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(m.profile)))))
    throw bad();
  if (m.palette !== undefined && (!Array.isArray(m.palette) || !m.palette.length || m.palette.length > 256 || !m.palette.every(hexColor))) throw bad();
  if (m.transparentIndex !== undefined && (!Number.isInteger(m.transparentIndex) || m.transparentIndex < -1 || m.transparentIndex >= (m.palette?.length ?? 0))) throw bad();
  if (m.bitmap !== undefined) {
    const b = m.bitmap;
    if (!b || typeof b !== 'object' || !['threshold', 'pattern', 'diffusion', 'halftone'].includes(b.method) ||
      !(Number.isFinite(b.resolution) && b.resolution > 0 && b.resolution <= 10000) ||
      (b.frequency !== undefined && !(Number.isFinite(b.frequency) && b.frequency > 0)) ||
      (b.angle !== undefined && !Number.isFinite(b.angle)) ||
      (b.shape !== undefined && typeof b.shape !== 'string'))
      throw bad();
  }
  if (m.inks !== undefined) {
    if (!Array.isArray(m.inks) || !m.inks.length || m.inks.length > 4) throw bad();
    for (const ink of m.inks) {
      if (!ink || typeof ink.name !== 'string' || ink.name.length > 64 || !hexColor(ink.color)) throw bad();
      if (ink.curve !== undefined && (!Array.isArray(ink.curve) || ink.curve.length > 16 ||
        !ink.curve.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && n >= 0 && n <= 100))))
        throw bad();
    }
  }
}
