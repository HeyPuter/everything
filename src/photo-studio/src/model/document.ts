import { isVectorGradient } from "./vector-gradient";
import type { VectorShape } from './vector';
import type { PixelMask } from './pixel-mask';
import { multiplyMaskMatrix } from './pixel-mask';
import { isVectorPattern } from './vector-pattern';
import type { TileGrid } from './tiles';
import type { TextLayerData } from '../imaging/text/model';
import type { DocumentPath, LayerVectorMask } from './paths';
import { mapAnnotations, type Annotations } from './annotations';
import { mapLayoutGeometry } from './layout-geometry';
import { matrixOfMap, transformVideo } from './video-layer';

// Values match the PSD blend-mode names used by ag-psd. The order of `blends`
// is the shader's mode index and the menu order.
export type Blend =
  | "normal" | "dissolve"
  | "darken" | "multiply" | "color burn" | "linear burn" | "darker color"
  | "lighten" | "screen" | "color dodge" | "linear dodge" | "lighter color"
  | "overlay" | "soft light" | "hard light" | "vivid light" | "linear light" | "pin light" | "hard mix"
  | "difference" | "exclusion" | "subtract" | "divide"
  | "hue" | "saturation" | "color" | "luminosity"
  // Groups only: children composite directly onto the backdrop.
  | "pass through";
export type Rect = { x: number; y: number; width: number; height: number };
export type Transform = Rect & { rotation: number };
export type Filters = {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
};
// Keep resolution independent of pixel dimensions. Resampling and cropping do not
// change the document's print density or its preferred physical measurement units.
export type ResolutionInfo = {
  horizontalResolution: number;
  horizontalResolutionUnit: "PPI" | "PPCM";
  widthUnit: "Inches" | "Centimeters" | "Points" | "Picas" | "Columns";
  verticalResolution: number;
  verticalResolutionUnit: "PPI" | "PPCM";
  heightUnit: ResolutionInfo["widthUnit"];
};
export type Stroke = {
  points: [number, number][];
  color: string;
  size: number;
  // Capture the painting policy when the stroke is made; toggling a lock later
  // must not change strokes that already exist.
  preserveAlpha?: boolean;
};
export type LayerProtection = {
  transparency: boolean;
  composite: boolean;
  position: boolean;
  artboards?: boolean;
};
export type MaskStroke = {
  // Capture pixel-mask brush placement before subsequent linking or transforms.
  matrix?: import('./vector').VectorMatrix;
  points: [number, number][];
  size: number;
  softness: number;
  aspect?: number;
  opacity: number;
  restore: boolean;
  clip?: [number, number][];
};
export interface Layer {
  id: string;
  name: string;
  // "pixel" layers hold destructively edited tiles; "image" layers keep an
  // immutable placed source with a non-destructive transform (embedded object).
  kind: "image" | "paint" | "text" | "group" | "solid" | "vector" | "pixel" | "adjustment";
  pixels?: TileGrid;
  // Live Filters: on a pixel layer, `liveSource` keeps the unfiltered tiles and
  // `pixels` caches the stack's rendered result (what the renderer shows).
  liveSource?: TileGrid;
  liveFilters?: LiveFilter[];
  // Optional filter mask limiting the whole stack (255 = filtered).
  liveMask?: TileGrid;
  // The filter mask is kept but not applied.
  liveMaskDisabled?: boolean;
  // Embedded object instance ("image" layers): which `doc.embeds` content it
  // draws and its non-affine placement, if any (see model/embedded).
  embed?: import('./embedded').LayerEmbed;
  // Non-destructive color adjustment applied to the composite below.
  adjustment?: AdjustmentSpec;
  // Layer mask edited with painting tools; values 0 hide and 255 reveal.
  maskGrid?: TileGrid;
  // Clipped to the nearest unclipped layer below (clipping mask).
  clipped?: boolean;
  // Scales layer pixels but not its effects.
  fillOpacity?: number;
  // Layer style (effects); see imaging/effects (LayerStyle).
  style?: Record<string, unknown>;
  // Advanced blending (Blend If, channels, knockout…); see model/blending.
  blending?: import('./blending').AdvancedBlending;
  // Gradient or pattern content of a fill layer (kind "solid"); see model/fill-layer.
  fill?: import('./fill-layer').LayerFill;
  colorLabel?: string;
  // Layers sharing a link group move and transform together (Layer → Link Layers).
  linkGroup?: string;
  // The document's Background layer: kept at the bottom with locked
  // transparency and position until converted (Layer → New → Layer from Background).
  background?: boolean;
  // Unlinked layer masks (maskGrid) stay in place when the layer moves.
  maskUnlinked?: boolean;
  vector?: VectorShape;
  // The PSD numeric layer ID is separate from the editor's UUID. Keep it
  // so preserved document metadata can still refer to imported layers.
  psdId?: number;
  visible: boolean;
  locked: boolean;
  protection?: LayerProtection;
  // The legacy layer-record flag is distinct from the lspf tagged-block flags.
  transparencyProtected?: boolean;
  opacity: number;
  blend: Blend;
  transform: Transform;
  filters: Filters;
  mask: Rect | null;
  maskAsset?: string;
  pixelMask?: PixelMask;
  // Editable vector mask geometry (document space), rasterized into maskGrid.
  vectorMask?: LayerVectorMask;
  maskStrokes?: MaskStroke[];
  maskDisabled?: boolean;
  maskInverted?: boolean;
  asset?: string;
  // Editable Pin Warp of an embedded image layer (see model/pin-warp).
  pinWarp?: import('./pin-warp').PinWarpRecord;
  // Existing PSD/native sources contain document-space channel codes. Newly
  // imported browser images are decoded to sRGB and converted by the renderer.
  assetColorSpace?: 'document' | 'srgb';
  color: string;
  // Legacy plain text (pixels); kept in step with `textData` when present.
  text: string;
  fontSize: number;
  // Editable typography (see model/text-layer.ts). `textFrame` is the local
  // rectangle that `transform` places in the document.
  textData?: TextLayerData;
  textFrame?: Rect;
  sourceWidth: number;
  sourceHeight: number;
  strokes: Stroke[];
  children: Layer[];
  // Artboard (a top-level group with its own rectangle and background) and
  // frame (a group whose shape masks its placed content); see model/artboard
  // and model/frame.
  artboard?: import('./artboard').ArtboardData;
  frame?: import('./frame').FrameData;
  // How the layer's pixels were made by an assisted command (Generate Image,
  // Edit with Prompt, the AI detail pass of Upscale): kept for reference.
  generated?: GeneratedInfo;
  // Video layer (a pixel layer showing one frame of a frame sequence at the
  // current time); see model/video-layer.
  video?: import('./video-layer').VideoLayerData;
}
export type GeneratedInfo = { kind: 'generate' | 'edit' | 'upscale' | 'fill' | 'expand'; prompt: string; model?: string; style?: string };
// One Live Filter: an operation ID from the filter catalog with its settings
// and blending options. `seed` keeps noise-like filters stable on re-render.
export type LiveFilter = {
  id: string;
  params: Record<string, unknown>;
  enabled: boolean;
  opacity: number;
  blend: Blend;
  seed: number;
};
export type ColorMode = 'rgb' | 'grayscale' | 'cmyk' | 'lab' | 'indexed' | 'bitmap' | 'duotone' | 'multichannel';
export type DuotoneInkSpec = { name: string; color: string; curve?: [number, number][] };
export type ColorModeData = {
  // Output profile for CMYK and Grayscale: "builtin:<id>" or base64 ICC bytes.
  profile?: string;
  // Indexed: palette colors (#rrggbb) and the transparent entry, or -1.
  palette?: string[];
  transparentIndex?: number;
  // Bitmap: conversion settings (output resolution in pixels per inch).
  bitmap?: { method: 'threshold' | 'pattern' | 'diffusion' | 'halftone'; resolution: number; frequency?: number; angle?: number; shape?: string };
  // Duotone: 1-4 inks, each with an optional transfer curve ([tone %, ink %]).
  inks?: DuotoneInkSpec[];
  // Multichannel: the locked pixel layer showing the overprinted ink channels.
  multichannelLayer?: string;
};
export type AdjustmentSpec = { kind: string; params: Record<string, unknown> };
export type Guide = { orientation: 'horizontal' | 'vertical'; position: number };
// `spot` marks an ink channel of a Multichannel document (values are ink
// coverage, 0 = full ink, printed in `color`); hidden ones leave the composite.
export type AlphaChannel = { id: string; name: string; grid: TileGrid; color?: string; opacity?: number; spot?: boolean; hidden?: boolean };
export interface PhotoDocument {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  // Omitted in older projects: 8-bit encoded RGB. High-depth composites use
  // float intermediates; 16-bit asset records retain their original integer codes.
  bitsPerChannel?: 8 | 16 | 32;
  resolution?: ResolutionInfo;
  // Original document RGB profile, retained opaquely as base64 for PSD export.
  iccProfile?: string;
  iccUntaggedProfile?: boolean;
  // Image mode. Omitted means RGB. Pixels stay stored as document RGB in every
  // mode; conversions constrain them to the mode's gamut (see features/color).
  mode?: ColorMode;
  modeData?: ColorModeData;
  // Immutable opaque document tags/global mask preferences stored in Assets.
  psdMetadataAsset?: string;
  // Original opaque image resources, independent of document/layer geometry.
  psdResourcesAsset?: string;
  // Retain layer records that currently open as a preview, including their
  // unknown data. The fingerprint prevents preview edits being silently omitted.
  psdOriginal?: { asset: string; previewFingerprint: string };
  layers: Layer[];
  // Bounding rectangle of the active selection, kept for rectangle-based code.
  selection: Rect | null;
  // Exact selection coverage; when absent a non-null `selection` is a hard rect.
  selectionMask?: TileGrid | null;
  channels?: AlphaChannel[];
  guides?: Guide[];
  // Display width of one pixel relative to its height (non-square video
  // pixels); omitted for square pixels. Shown corrected by the view.
  pixelAspect?: number;
  // File Info, written to exported metadata (PNG text, JPEG comments).
  info?: DocumentInfo;
  // Patterns defined from document pixels (Edit > Define Pattern).
  patterns?: import('./fill-layer').DocumentPattern[];
  // Saved paths and the work path, in document coordinates (Paths panel).
  paths?: DocumentPath[];
  // Content of embedded objects by ID, shared by their instances.
  embeds?: Record<string, import('./embedded').EmbeddedContents>;
  workPath?: import('./vector').VectorMask;
  // Color samplers, counts, notes and the measurement scale (not rendered).
  annotations?: Annotations;
  // Frame animation (Timeline panel); see model/animation.ts.
  animation?: import('./animation').FrameAnimation;
  // Video timeline (clips, keyframes, transitions); a document has either
  // this or a frame animation. See model/video-timeline.ts.
  timeline?: import('./video-timeline').VideoTimeline;
  // Saved layer states (Layer Comps panel) and user/layer-based slices.
  layerComps?: import('./layer-comps').LayerComp[];
  lastComp?: string;
  slices?: import('./slices').Slice[];
  // Character and paragraph styles (Type panels); text links to them by ID.
  textStyles?: import('../imaging/text/styles').TextStyles;
  // 32-bit preview options (display-only tone mapping of 32-bit documents).
  hdrPreview?: import('./hdr-preview').HdrPreview;
  // Perspective Planes: surfaces as four document points each (corners in order).
  perspectivePlanes?: [number, number][][];
  // Document-wide light for layer effects that use the global light
  // (degrees). When omitted each style keeps its own globalAngle/Altitude.
  globalLight?: { angle: number; altitude: number };
  // Variables bound to layers and the data sets that fill them (Image > Variables).
  variables?: import('./variables').DocumentVariables;
}
export type DocumentInfo = { title?: string; author?: string; copyright?: string; description?: string; contact?: string; keywords?: string };
export const blends: Blend[] = [
  "normal", "dissolve",
  "darken", "multiply", "color burn", "linear burn", "darker color",
  "lighten", "screen", "color dodge", "linear dodge", "lighter color",
  "overlay", "soft light", "hard light", "vivid light", "linear light", "pin light", "hard mix",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity",
];
// Menu separators fall before these modes.
export const blendGroupStarts: Blend[] = ["darken", "lighten", "overlay", "difference", "hue"];
export const blendLabel = (b: Blend) =>
  b === "linear dodge" ? "Linear Dodge (Add)" : b.replace(/\b\w/g, (c) => c.toUpperCase());
export const defaultFilters = (): Filters => ({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
});
export function layer(
  kind: Layer["kind"],
  name: string,
  width: number,
  height: number,
): Layer {
  return {
    id: crypto.randomUUID(),
    kind,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    transform: { x: 0, y: 0, width, height, rotation: 0 },
    filters: defaultFilters(),
    mask: null,
    color: "#ffffff",
    text: "",
    fontSize: 96,
    sourceWidth: width,
    sourceHeight: height,
    strokes: [],
    children: [],
  };
}
export function newDocument(
  width = 1600,
  height = 1000,
  name = "Untitled",
): PhotoDocument {
  assertSize(width, height);
  return {
    version: 1,
    id: crypto.randomUUID(),
    name,
    width,
    height,
    layers: [],
    selection: null,
  };
}
export function assertSize(w: number, h: number) {
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > 8192 ||
    h > 8192 ||
    w * h > 24_000_000
  )
    throw new Error(
      "Use dimensions from 1 to 8192 pixels, up to 24 megapixels.",
    );
}
export function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    const found = findLayer(l.children, id);
    if (found) return found;
  }
}
export function containerOf(layers: Layer[], id: string): Layer[] | undefined {
  for (const l of layers) {
    if (l.id === id) return layers;
    const found = containerOf(l.children, id);
    if (found) return found;
  }
}
export function allLayers(layers: Layer[]): Layer[] {
  return layers.flatMap((l) => [l, ...allLayers(l.children)]);
}
/** Make a history draft an exact copy of an earlier state (revert, restore):
 * properties the state does not have are removed. `keep` is applied last. */
export function replaceDocument(d: PhotoDocument, state: PhotoDocument, keep: Partial<PhotoDocument> = {}) {
  for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
  Object.assign(d, structuredClone(state), keep);
}
export function resizeDocument(
  doc: PhotoDocument,
  width: number,
  height: number,
  // Scale layer effects with the image (off keeps their pixel sizes).
  scaleStyles = true,
) {
  assertSize(width, height);
  const sx = width / doc.width,
    sy = height / doc.height;
  // Group contents use document coordinates; group transforms remain identity.
  for (const l of allLayers(doc.layers)) {
    if (isVectorGradient(l.vector?.fill) && l.vector.fill.align === false) {
      l.vector.fill.matrix = multiplyMaskMatrix(
        [sx, 0, 0, sy, 0, 0], l.vector.fill.matrix ?? [1, 0, 0, 1, 0, 0],
      );
    }
    if (l.pixelMask && (l.kind === 'group' || l.pixelMask.positionRelativeToLayer))
      l.pixelMask.matrix = multiplyMaskMatrix([sx,0,0,sy,0,0], l.pixelMask.matrix);
    for (const mask of [l.vector?.mask.notLink && l.vector.mask, l.vectorMask?.mask])
      if (mask)
        for (const path of mask.paths)
          for (const knot of path.knots)
            knot.points = knot.points.map((n, i) => n * (i % 2 ? sy : sx));
    if (l.kind === "group" && !l.pixelMask)
      for (const s of l.maskStrokes ?? []) {
        s.points = s.points.map(([x, y]) => [x * sx, y * sy]);
        s.clip = s.clip?.map(([x, y]) => [x * sx, y * sy]);
        s.size *= sx;
        s.aspect = ((s.aspect ?? 1) * sy) / sx;
      }
    const t = l.transform;
    t.x *= sx;
    t.y *= sy;
    t.width *= sx;
    t.height *= sy;
    if (l.mask) {
      l.mask.x *= sx;
      l.mask.y *= sy;
      l.mask.width *= sx;
      l.mask.height *= sy;
    }
  }
  mapDocumentGeometry(doc, (x, y) => [x * sx, y * sy]);
  // Layer effects keep their size relative to the image, also where frames
  // and comps keep their own copy of a style.
  const k = scaleStyles ? Math.sqrt(sx * sy) : 1;
  const scaleStyle = (s: Record<string, unknown> | null | undefined) => {
    if (s && k !== 1) s.scale = Math.min(10, Math.max(0.01, (typeof s.scale === 'number' ? s.scale : 1) * k));
  };
  for (const l of allLayers(doc.layers)) scaleStyle(l.style);
  for (const f of doc.animation?.frames ?? []) for (const st of Object.values(f.layers)) scaleStyle(st.style);
  for (const c of doc.layerComps ?? []) for (const st of Object.values(c.layers)) scaleStyle(st.style);
  doc.width = width;
  doc.height = height;
  doc.selection = null;
}
/** Move the document-space geometry kept beside the layers through a canvas
 * resize, crop or rotation: saved and work paths, annotations, layout
 * rectangles, perspective planes, guides (dropped when they no longer run
 * along an axis) and per-frame position offsets. */
export function mapDocumentGeometry(doc: PhotoDocument, f: (x: number, y: number) => [number, number]) {
  for (const mask of [...(doc.paths ?? []).map((p) => p.mask), ...(doc.workPath ? [doc.workPath] : [])])
    for (const path of mask.paths)
      for (const knot of path.knots)
        for (let i = 0; i < knot.points.length - 1; i += 2) [knot.points[i], knot.points[i + 1]] = f(knot.points[i], knot.points[i + 1]);
  mapAnnotations(doc.annotations, f);
  mapLayoutGeometry(doc, f);
  doc.perspectivePlanes = doc.perspectivePlanes?.map((q) => q.map(([px, py]) => f(px, py)));
  if (doc.guides) {
    const eps = 1e-6;
    doc.guides = doc.guides.flatMap((g): Guide[] => {
      const v = g.orientation === 'vertical';
      const a = f(v ? g.position : 0, v ? 0 : g.position),
        b = f(v ? g.position : 1, v ? 1 : g.position);
      if (Math.abs(a[0] - b[0]) < eps) return [{ ...g, orientation: 'vertical', position: a[0] }];
      if (Math.abs(a[1] - b[1]) < eps) return [{ ...g, orientation: 'horizontal', position: a[1] }];
      return [];
    });
  }
  // Offsets are vectors: they turn and scale with the image but do not shift.
  const [ox, oy] = f(0, 0);
  const vector = (v: [number, number]): [number, number] => {
    const [x, y] = f(v[0], v[1]);
    return [x - ox, y - oy];
  };
  for (const fr of doc.animation?.frames ?? [])
    for (const st of Object.values(fr.layers)) [st.dx, st.dy] = vector([st.dx, st.dy]);
  // Video timeline: position keyframes are offsets too, and every frame of a
  // video layer follows the canvas through its placement.
  for (const c of Object.values(doc.timeline?.clips ?? {})) {
    if (c.offset) c.offset = vector(c.offset);
    for (const k of c.keys?.position ?? []) k.v = vector(k.v);
  }
  let g: import('../imaging/filters/warp').Mat3 | undefined;
  for (const l of allLayers(doc.layers))
    if (l.video) l.video = transformVideo(l.video, (g ??= matrixOfMap(f, doc.width, doc.height)));
}
export function cropDocument(doc: PhotoDocument, rect: Rect) {
  // A rectangle reaching past the canvas enlarges it (canvas size, reveal all).
  const x = Math.round(rect.x),
    y = Math.round(rect.y);
  const w = Math.round(rect.width),
    h = Math.round(rect.height);
  assertSize(w, h);
  for (const l of allLayers(doc.layers)) {
    if (isVectorGradient(l.vector?.fill) && l.vector.fill.align === false) {
      l.vector.fill.matrix = multiplyMaskMatrix(
        [1, 0, 0, 1, -x, -y], l.vector.fill.matrix ?? [1, 0, 0, 1, 0, 0],
      );
    }
    if (isVectorPattern(l.vector?.fill) && l.vector.fill.align === false) {
      // Unlinked tiles use document coordinates. Cropping shifts that origin
      // just as it shifts geometry; preserve the pixels that remain inside.
      const fill = l.vector.fill;
      fill.phase ??= { x: 0, y: 0 };
      fill.phase.x -= x;
      fill.phase.y -= y;
    }
    if (l.pixelMask && (l.kind === 'group' || l.pixelMask.positionRelativeToLayer))
      l.pixelMask.matrix = multiplyMaskMatrix([1,0,0,1,-x,-y], l.pixelMask.matrix);
    for (const mask of [l.vector?.mask.notLink && l.vector.mask, l.vectorMask?.mask])
      if (mask)
        for (const path of mask.paths)
          for (const knot of path.knots)
            knot.points = knot.points.map((n, i) => n - (i % 2 ? y : x));
    if (l.kind === "group" && !l.pixelMask)
      for (const s of l.maskStrokes ?? []) {
        s.points = s.points.map(([px, py]) => [px - x, py - y]);
        s.clip = s.clip?.map(([px, py]) => [px - x, py - y]);
      }
    if (l.kind !== "group") {
      l.transform.x -= x;
      l.transform.y -= y;
    }
    if (l.mask) {
      l.mask.x -= x;
      l.mask.y -= y;
    }
  }
  mapDocumentGeometry(doc, (px, py) => [px - x, py - y]);
  // Guides that end up outside the canvas are removed.
  if (doc.guides) doc.guides = doc.guides.filter((g) => g.position >= 0 && g.position <= (g.orientation === 'vertical' ? w : h));
  doc.width = w;
  doc.height = h;
  doc.selection = null;
}
export function localPoint(
  t: Transform,
  x: number,
  y: number,
): [number, number] {
  const a = (-t.rotation * Math.PI) / 180,
    dx = x - t.x - t.width / 2,
    dy = y - t.y - t.height / 2;
  return [
    (dx * Math.cos(a) - dy * Math.sin(a)) / t.width + 0.5,
    (dx * Math.sin(a) + dy * Math.cos(a)) / t.height + 0.5,
  ];
}
export function normalizedRect(
  a: [number, number],
  b: [number, number],
  width: number,
  height: number,
): Rect {
  const x = Math.max(0, Math.min(width, Math.min(a[0], b[0]))),
    y = Math.max(0, Math.min(height, Math.min(a[1], b[1])));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, Math.max(a[0], b[0])) - x),
    height: Math.max(0, Math.min(height, Math.max(a[1], b[1])) - y),
  };
}
