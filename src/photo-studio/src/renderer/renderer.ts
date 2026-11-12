import { isVectorGradient, gradientSampler, type RgbaSample } from "../model/vector-gradient";
import { hasMask } from '../model/masks';
import {
  allLayers,
  blends,
  type Layer,
  type PhotoDocument,
  localPoint,
} from '../model/document';
import type { Assets } from '../model/assets';
import type { ImageEngine } from '../engine/engine';
import { UNIFORM_FLOATS, type Backend, type Texture } from './backend';
import { blendingUniforms } from '../model/blending';
import { WebGPUBackend } from './webgpu';
import { WebGLBackend } from './webgl';
import {
  colorTransform,
  packColorTransform,
  readRgbProfile,
  srgbProfile,
  linearSrgbProfile,
} from "../color/profile";
import { decodeIccProfile } from "../model/psd-resources";
import { floatRaster } from "../model/raster";
import { vectorBounds, vectorMatrix, vectorUnbounded } from "../model/vector";
import { vectorDocumentRgb, vectorColorRgb } from "../color/vector";
import { isVectorPattern, patternSampler } from '../model/vector-pattern';
import { vectorPaintMatrix } from '../model/vector';
import type { PatternPixels } from '../model/psd-patterns';
import { strokePixels } from "../model/vector-stroke";
import type { FloatVectorRaster } from "../model/vector";
import { documentPpi, placeTextRect } from "../model/text-layer";
import { renderTextLayer, textRenderScale, usesTextFallback } from "./text-source";
import type { StrokeRaster } from "../engine/vector";
import type { Rect } from "../model/document";
import { floatCoverage } from '../model/coverage';
import { inverseMaskMatrix, pixelMaskMatrix } from '../model/pixel-mask';
import { TILE, gridDocBounds, intersectRect, parseKey, tileKey, type TileGrid } from '../model/tiles';
import { packLut, type CompiledLut } from './lut-shaders';
import { SpatialPasses, type SpatialFilter } from './spatial-pass';
import type { AdjustmentSpec, Transform } from '../model/document';
import { defaultFilters } from '../model/document';
import type { IRect } from '../imaging/types';
import { StyleCache, activeLayerStyle, type StyleContext } from './layer-style';
import { fillLayerPixels } from '../model/fill-layer';
import { artboardFill } from '../model/artboard';
import { ellipseCoverage } from '../model/frame';
import { hdrPreviewUniforms } from '../model/hdr-preview';

// Adjustment math lives in imaging/adjust; the editor registers its compiler so
// the renderer stays independent of individual adjustment kinds.
let adjustmentCompiler: ((spec: AdjustmentSpec) => CompiledLut | null) | undefined;
export function registerAdjustmentCompiler(fn: (spec: AdjustmentSpec) => CompiledLut | null) {
  adjustmentCompiler = fn;
}
// Time-based features (the video timeline) hide and fade layers when a
// document is drawn; layers read back alone are drawn as they are.
let presentation: ((doc: PhotoDocument) => PhotoDocument) | undefined;
export function registerPresentation(fn: (doc: PhotoDocument) => PhotoDocument) {
  presentation = fn;
}
// Spatial adjustment kinds (Clarity & Dehaze, Grain) run as filter passes.
let spatialCompiler: ((spec: AdjustmentSpec) => SpatialFilter | null) | undefined;
export function registerSpatialAdjustment(fn: (spec: AdjustmentSpec) => SpatialFilter | null) {
  spatialCompiler = fn;
}
const zeroTile = new Uint8ClampedArray(TILE * TILE * 4);
// Plain layer fields for synthetic layers (artboard backgrounds, clip passes).
function layerTemplate(): Layer {
  return {
    id: '', name: '', kind: 'solid', visible: true, locked: false, opacity: 1, blend: 'normal',
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, filters: defaultFilters(), mask: null,
    color: '#ffffff', text: '', fontSize: 12, sourceWidth: 1, sourceHeight: 1, strokes: [], children: [],
  };
}
function floatBytes(bytes: Uint8ClampedArray) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
  return out;
}
function alignedExtent(b: IRect): IRect {
  const x = Math.floor(b.x / TILE) * TILE,
    y = Math.floor(b.y / TILE) * TILE;
  return {
    x,
    y,
    width: Math.ceil((b.x + b.width) / TILE) * TILE - x,
    height: Math.ceil((b.y + b.height) / TILE) * TILE - y,
  };
}
/** Placement of a pixel layer's tile-aligned texture. The layer transform
 * describes its tight content bounds; during a live Free Transform it differs
 * from them, and the texture follows the same scale and rotation. */
// Source alpha of a pixel layer at a document point, through masks and opacity.
function pixelCoverage(l: Layer, parents: Layer[], assets: Assets, x: number, y: number) {
  const px = Math.floor(x), py = Math.floor(y);
  const sample = (grid: TileGrid, channel: number) => {
    const lx = px - grid.x, ly = py - grid.y;
    const id = grid.tiles[tileKey(Math.floor(lx / TILE), Math.floor(ly / TILE))];
    if (!id) return (grid.fill ?? 0) / 255;
    const i = (((ly % TILE) + TILE) % TILE) * TILE + (((lx % TILE) + TILE) % TILE);
    return assets.tiles.get(id)[i * grid.channels + channel] / 255;
  };
  let value = sample(l.pixels!, 3);
  for (const item of [l, ...parents]) {
    value *= item.opacity * (item === l ? (item.fillOpacity ?? 1) : 1);
    if (item.maskGrid && !item.maskDisabled) {
      const m = sample(item.maskGrid, 0);
      value *= item.maskInverted ? 1 - m : m;
    }
  }
  return value;
}
export function pixelPlacement(l: Layer, extent: IRect): Transform {
  const t = l.transform,
    b = gridDocBounds(l.pixels!)!;
  const sx = t.width / b.width,
    sy = t.height / b.height;
  const dx = (extent.x + extent.width / 2 - (b.x + b.width / 2)) * sx,
    dy = (extent.y + extent.height / 2 - (b.y + b.height / 2)) * sy;
  const a = (t.rotation * Math.PI) / 180,
    cx = t.x + t.width / 2 + dx * Math.cos(a) - dy * Math.sin(a),
    cy = t.y + t.height / 2 + dx * Math.sin(a) + dy * Math.cos(a);
  const width = extent.width * sx,
    height = extent.height * sy;
  return { x: cx - width / 2, y: cy - height / 2, width, height, rotation: t.rotation };
}
export function pixelMaskUniforms(l: Layer, u: Float32Array) {
  if (!l.pixelMask || l.maskDisabled) return;
  const mask = l.pixelMask, m = inverseMaskMatrix(pixelMaskMatrix(l));
  u.set(m.slice(0,4),36);
  u.set([m[4]-mask.bounds.x,m[5]-mask.bounds.y,mask.defaultColor/255,Number(!!l.maskInverted)],40);
  u.set([mask.userMaskDensity ?? 1,1,Number(!!mask.asset),0],44);
}
export function uniforms(
  l: Layer,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
): Float32Array {
  const u = new Float32Array(UNIFORM_FLOATS),
    t = l.transform,
    a = (t.rotation * Math.PI) / 180;
  u.set([
    width,
    height,
    0,
    0,
    t.x,
    t.y,
    t.width,
    t.height,
    Math.cos(a),
    Math.sin(a),
    l.opacity,
    blends.indexOf(l.blend),
    l.filters.brightness / 100,
    l.filters.contrast / 100,
    l.filters.saturation / 100,
    l.filters.blur,
  ]);
  const painted = !!l.maskStrokes?.length || !!l.maskInverted;
  if (l.mask && !l.maskDisabled && !painted) {
    u.set([l.mask.x, l.mask.y, l.mask.width, l.mask.height], 16);
    u[20] = 1;
  }
  u[21] = !l.maskDisabled && (l.pixelMask ? !!l.maskStrokes?.length : (l.maskAsset || (hasMask(l) && painted))) ? 1 : 0;
  u[24] = sourceWidth;
  u[25] = sourceHeight;
  pixelMaskUniforms(l,u);
  return u;
}
type SourceEntry = {
  key: string;
  texture: Texture;
  assets: Assets;
  viewport?: Rect;
  coverage?: Float32Array;
  geometry?: FloatVectorRaster | StrokeRaster;
  paintKey?: string;
  pixels?: Float32Array;
  constantRgb?: number[];
  paintSample?: RgbaSample;
  pattern?: { key: string; pixels: PatternPixels; sample: ReturnType<typeof patternSampler> };
  fillPath?: Path2D;
  strokePath?: Path2D;
  paintPrefix?: { key: string; texture: Texture };
  tiles?: Map<string, string>;
  lut?: Float32Array;
  // Local text-space rectangle covered by an editable text texture.
  textRect?: Rect;
};
export class Renderer {
  private vectorPickContext?: OffscreenCanvasRenderingContext2D;
  private sources = new Map<string, SourceEntry>();
  private destroySource(entry: SourceEntry, keep: Texture[] = []) {
    for (const texture of new Set([entry.texture, entry.paintPrefix?.texture]))
      if (texture && texture !== this.white && !keep.includes(texture)) this.backend.destroy(texture);
  }
  private trimPaintPrefixes(current: string) {
    // A second source texture accelerates active painting, but must not double
    // every large document/layer allocation. Cap the optional shared cache.
    const budget = 64 * 1024 * 1024;
    const bytes = (t: Texture) =>
      t.width * t.height * (t.format === 'rgba32float' ? 16 : 4);
    let total = 0;
    for (const entry of this.sources.values())
      if (entry.paintPrefix) total += bytes(entry.paintPrefix.texture);
    for (const [, entry] of [...this.sources].sort(
      ([a], [b]) => Number(a === current) - Number(b === current),
    )) {
      if (total <= budget) break;
      if (entry.paintPrefix) {
        total -= bytes(entry.paintPrefix.texture);
        this.backend.destroy(entry.paintPrefix.texture);
        entry.paintPrefix = undefined;
      }
    }
  }
  private targets: Texture[] = [];
  private cursor = 0;
  private final?: Texture;
  private white: Texture;
  private size = '';
  private active = false;
  private queued?: { doc: PhotoDocument; assets: Assets };
  private idle: Promise<void> = Promise.resolve();
  private picks: Promise<void> = Promise.resolve();
  private profileKey = '';
  private profileDepth = 0;
  private profileRevision = 0;
  private fromSrgb?: Texture;
  private toSrgb?: Texture;
  private displayTarget?: Texture;
  private floating = false;
  private boundedRgb = false;
  private document?: PhotoDocument;
  // Layer style results; `progressiveStyles` draws ready effects without
  // waiting (interactive canvas), otherwise draws wait for them (exports).
  private styles: StyleCache;
  private spatial?: SpatialPasses;
  progressiveStyles = false;
  private lastRender?: { doc: PhotoDocument; assets: Assets };
  private exclusiveDepth = 0;
  // Display-only color pass (soft proofing, duotone preview): a 3D LUT from
  // document values to display sRGB applied after compositing. It replaces the
  // profile conversion for the canvas and never changes `final`, so exports
  // and pixel readbacks are unaffected.
  private displayLut?: { texture: Texture; uniforms: Float32Array };
  private displayLutTarget?: Texture;
  private displayLutSource?: { size: number; data: Float32Array };
  setDisplayLut(lut: { size: number; data: Float32Array } | null) {
    if (this.displayLut) this.backend.destroy(this.displayLut.texture);
    this.displayLut = undefined;
    this.displayLutSource = lut ?? undefined;
    if (!lut) return;
    const packed = packLut({ lut3d: lut });
    if (packed.width > this.backend.maxSize) throw new Error('This display table exceeds GPU texture limits.');
    packed.uniforms[3] = 1;
    this.displayLut = { texture: this.backend.floatTexture(packed.width, packed.height, packed.data), uniforms: packed.uniforms };
  }
  private constructor(
    public backend: Backend,
    private canvas: HTMLCanvasElement,
    private engine: ImageEngine,
  ) {
    this.white = backend.texture(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.styles = new StyleCache(backend);
    this.watchLoss(backend);
  }
  private disposed = false;
  /** Set while a lost GPU context or device is being re-created. */
  recovering?: Promise<void>;
  private watchLoss(backend: Backend) {
    void backend.lost?.then(() => {
      if (this.disposed || backend !== this.backend) return;
      // Readbacks wait for the new backend (a lost context reads blank), but
      // not for long: a context the browser never restores must not block
      // saving. Recovery itself goes on.
      const wait: Promise<void> = Promise.race([this.recover(backend).catch(() => this.reportLost()), new Promise((r) => setTimeout(r, 5000))]).then(() => {
        if (this.recovering === wait) this.recovering = undefined;
      });
      this.recovering = wait;
    });
  }
  /** Re-create the backend after its context or device was lost and draw
   * the last document again; every texture is rebuilt from tiles and assets.
   * Without a new backend the editor shows the lost-context message. */
  private async recover(lost: Backend) {
    let next: Backend | undefined;
    if (lost instanceof WebGLBackend) {
      // The browser restores a lost WebGL context when it can; say so when
      // it takes long, but keep waiting.
      const notice = setTimeout(() => this.reportLost(), 5000);
      await new Promise((resolve) => this.canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
      clearTimeout(notice);
      try {
        if (!this.disposed) next = new WebGLBackend(this.canvas);
      } catch {
        // Reported below.
      }
    } else
      for (let attempt = 0; attempt < 3 && !next && !this.disposed; attempt++) {
        try {
          next = await WebGPUBackend.create(this.canvas);
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    if (this.disposed) {
      next?.dispose();
      return;
    }
    if (!next) return this.reportLost();
    // The draw in progress ran on the lost context; replace everything after it.
    while (this.active) await this.idle.catch(() => {});
    this.replaceBackend(next);
    const last = this.lastRender;
    if (last) await this.render(last.doc, last.assets).catch(() => {});
  }
  private reportLost() {
    this.canvas.dispatchEvent(new CustomEvent('renderer-lost', { detail: 'The graphics processor was reset. Save your project and reload the page.' }));
  }
  /** Use a new backend: textures of the old one died with its context, so
   * they are dropped (not destroyed) and rebuilt on the next draw. */
  private replaceBackend(backend: Backend) {
    this.backend = backend;
    this.sources.clear();
    this.targets = [];
    this.cursor = 0;
    this.final = undefined;
    this.white = backend.texture(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.size = '';
    this.profileKey = '';
    this.profileDepth = 0;
    this.profileRevision++;
    this.fromSrgb = this.toSrgb = undefined;
    this.displayTarget = this.displayLutTarget = undefined;
    this.knockStack = [];
    this.knockBase = undefined;
    this.styles = new StyleCache(backend);
    this.spatial = undefined;
    const lut = this.displayLutSource;
    this.displayLut = undefined;
    if (lut) this.setDisplayLut(lut);
    this.watchLoss(backend);
  }
  private styleContext(doc: PhotoDocument, assets: Assets): StyleContext {
    return {
      backend: this.backend,
      white: this.white,
      floating: this.floating,
      boundedRgb: this.boundedRgb,
      progressive: this.progressiveStyles && this.exclusiveDepth === 0,
      target: (w, h) => this.target(w, h),
      mark: () => this.cursor,
      reset: (mark) => (this.cursor = mark),
      drawPlain: (l, back, next, clipped) => this.drawLayer(l, doc, assets, back, next, clipped),
      maskedPass: async (l, back, source, next, opacity, clipped) => {
        const actual = this.documentLayer({ ...l, opacity, blend: 'normal', filters: defaultFilters() }, doc);
        const u = uniforms(actual, doc.width, doc.height, doc.width, doc.height);
        u[23] = this.boundedRgb ? 1 : 0;
        if (clipped) u[29] = 2;
        const gridMask = this.gridMaskUniforms(l, u, assets);
        pixelMaskUniforms(l, u);
        this.backend.pass(back, source, await this.mask(actual, assets), u, next, gridMask ?? this.pixelMask(l, assets));
      },
      redraw: () => {
        const last = this.lastRender;
        if (!last) return;
        if (this.active) this.queued ??= last;
        else void this.render(last.doc, last.assets).catch(() => {});
      },
      afterFrame: (task) => this.exclusive(task),
    };
  }
  /** A compositor on `canvas`: WebGPU with a WebGL2 fallback, or the
   * backend named by `prefer` (Preferences → Performance). */
  static async create(canvas: HTMLCanvasElement, engine: ImageEngine, prefer: 'auto' | 'webgpu' | 'webgl2' = 'auto') {
    let backend: Backend;
    try {
      if (prefer === 'webgl2') throw new Error('WebGL2 requested');
      backend = await WebGPUBackend.create(canvas);
    } catch {
      // Replace the canvas if a failed WebGPU initialization bound its context.
      const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(replacement);
      canvas = replacement;
      backend = new WebGLBackend(canvas);
    }
    return new Renderer(backend, canvas, engine);
  }
  get name() {
    return this.backend.name;
  }
  private configureProfile(doc: PhotoDocument) {
    const embedded = doc.iccUntaggedProfile ? '' : (doc.iccProfile ?? '');
    // The editor's untagged sRGB policy uses linear channels for float RGB.
    // Byte/16-bit untagged projects keep encoded sRGB.
    const depth = doc.bitsPerChannel ?? 8;
    if (embedded === this.profileKey && depth === this.profileDepth) return;
    if (this.fromSrgb) this.backend.destroy(this.fromSrgb);
    if (this.toSrgb) this.backend.destroy(this.toSrgb);
    this.fromSrgb = this.toSrgb = undefined;
    this.profileKey = embedded;
    this.profileDepth = depth;
    this.profileRevision++;
    if (!embedded && doc.bitsPerChannel !== 32) return;
    let profile;
    try {
      profile = embedded
        ? readRgbProfile(decodeIccProfile(embedded))
        : linearSrgbProfile;
    } catch (error) {
      this.canvas.dispatchEvent(
        new CustomEvent('renderer-notice', {
          detail: `The embedded ICC profile cannot be used for display (${String(error)}). Its bytes are retained; colors are shown as sRGB.`,
        }),
      );
      return;
    }
    try {
      const from = packColorTransform(
        colorTransform(srgbProfile, profile),
        this.backend.maxSize,
      );
      const to = packColorTransform(
        colorTransform(profile, srgbProfile),
        this.backend.maxSize,
      );
      this.fromSrgb = this.backend.floatTexture(
        from.width,
        from.height,
        from.data,
      );
      this.toSrgb = this.backend.floatTexture(to.width, to.height, to.data);
    } catch (error) {
      if (this.fromSrgb) this.backend.destroy(this.fromSrgb);
      this.fromSrgb = undefined;
      this.profileKey = "";
      this.profileDepth = 0;
      throw error;
    }
  }
  private target(w: number, h: number) {
    const index = this.cursor++;
    return (
      this.targets[index] ??
      (this.targets[index] = this.floating
        ? this.backend.floatTexture(w, h)
        : this.backend.texture(w, h))
    );
  }
  private convertedSource(texture: Texture, inputSrgb: boolean): Texture {
    if (!inputSrgb || !this.fromSrgb) return texture;
    const converted = this.floating
      ? this.backend.floatTexture(texture.width, texture.height)
      : this.backend.texture(texture.width, texture.height);
    try {
      this.backend.colorPass(
        texture,
        this.fromSrgb,
        converted,
        this.boundedRgb,
      );
    } catch (error) {
      this.backend.destroy(converted);
      throw error;
    }
    this.backend.destroy(texture);
    return converted;
  }
  private async rasterSource(l: Layer, width: number, height: number) {
    const bitmap = await this.engine.raster(l, width, height);
    try {
      return this.backend.texture(width, height, bitmap);
    } finally {
      bitmap.close();
    }
  }
  private async textSource(l: Layer, assets: Assets): Promise<Texture> {
    const ppi = this.document ? documentPpi(this.document) : 72;
    const scale = textRenderScale(l, this.backend.maxSize);
    const key = JSON.stringify(["text", l.textData, ppi, scale, this.profileRevision, this.floating]);
    const old = this.sources.get(l.id);
    if (old?.key === key && old.assets === assets) return old.texture;
    const r = await renderTextLayer(l.textData!, ppi, scale);
    const data = new Uint8Array(r.image.data.buffer, r.image.data.byteOffset, r.image.data.byteLength);
    const texture = this.convertedSource(this.backend.texture(r.image.width, r.image.height, data), true);
    const current = this.sources.get(l.id);
    if (current) this.destroySource(current, [texture]);
    this.sources.set(l.id, { key, texture, assets, textRect: r.rect });
    return texture;
  }
  /** Layer as drawn: editable text is placed at its rendered extent. */
  private placed(l: Layer, source: Texture): Layer {
    const rect = l.textData ? this.sources.get(l.id)?.textRect : undefined;
    if (!rect) return l;
    return { ...l, transform: placeTextRect(l, rect), sourceWidth: source.width, sourceHeight: source.height };
  }
  private async source(l: Layer, assets: Assets): Promise<Texture> {
    if (l.textData && !usesTextFallback(l)) return this.textSource(l, assets);
    const inputSrgb = l.asset ? l.assetColorSpace === "srgb" : true;
    const keyFor = (strokes = l.strokes) =>
      JSON.stringify([
        l.asset
          ? [l.asset, strokes]
          : l.kind === "solid"
            ? l.fill
              ? [l.fill, l.sourceWidth, l.sourceHeight, l.fill.type === 'pattern' ? this.document?.patterns?.find((p) => p.id === (l.fill as { patternId: string }).patternId)?.grid.tiles : 0]
              : l.color
            : [
                l.text,
                l.fontSize,
                l.color,
                strokes,
                l.sourceWidth,
                l.sourceHeight,
              ],
        inputSrgb,
        this.profileRevision,
        this.floating,
      ]);
    const key = keyFor();
    const old = this.sources.get(l.id);
    if (old?.key === key && old.assets === assets) return old.texture;
    // Keep the batched raster path for ordinary 8-bit sRGB brush layers. Paint
    // on native sources, in high depth, with a profile or with protected alpha
    // must blend in document space on straight samples. An sRGB Canvas would
    // mix the wrong colors for linear/HDR profiles and quantize native alpha.
    const firstLocked = l.strokes.findIndex((s) => s.preserveAlpha);
    const overlay =
      (l.kind === "paint" || l.kind === "image") &&
      l.strokes.length > 0 &&
      (firstLocked >= 0 || !!l.asset || this.floating || !!this.fromSrgb);
    let start = l.asset || this.floating || this.fromSrgb ? 0 : firstLocked;
    const prefixKey = overlay ? keyFor(l.strokes.slice(0, -1)) : undefined;
    // Retain just the source before the current stroke. Pointer previews can
    // extend that stroke without replaying every earlier protected stroke.
    let prefix =
      old?.assets === assets && prefixKey !== undefined
        ? old.key === prefixKey
          ? { key: prefixKey, texture: old.texture }
          : old.paintPrefix?.key === prefixKey
            ? old.paintPrefix
            : undefined
        : undefined;
    let texture: Texture | undefined = prefix?.texture;
    try {
      if (texture) start = l.strokes.length - 1;
      else if (l.asset) {
        const raster = assets.raster(l.asset);
        if (raster)
          texture = this.backend.floatTexture(
            raster.width,
            raster.height,
            floatRaster(raster),
          );
        else {
          const b = assets.get(l.asset);
          texture = this.backend.texture(b.width, b.height, b);
        }
      } else if (l.kind === "solid" && l.fill) {
        const img = fillLayerPixels(l, this.document ?? { patterns: [] }, assets.tiles)!;
        texture = this.backend.texture(img.width, img.height, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
      } else if (l.kind === "solid") {
        texture = this.backend.texture(
          1,
          1,
          new Uint8Array([
            parseInt(l.color.slice(1, 3), 16),
            parseInt(l.color.slice(3, 5), 16),
            parseInt(l.color.slice(5, 7), 16),
            255,
          ]),
        );
      } else {
        const base = overlay ? { ...l, strokes: l.strokes.slice(0, start) } : l;
        const width = Math.max(1, Math.round(l.sourceWidth)),
          height = Math.max(1, Math.round(l.sourceHeight));
        if (overlay && start === 0) {
          texture = this.floating
            ? this.backend.floatTexture(width, height)
            : this.backend.texture(width, height);
          this.backend.clear(texture);
        } else texture = await this.rasterSource(base, width, height);
      }
      if (!prefix) texture = this.convertedSource(texture, inputSrgb);
      if (overlay) {
        for (let i = start; i < l.strokes.length; i++) {
          const stroke = l.strokes[i];
          if (i === l.strokes.length - 1 && !prefix)
            prefix = { key: prefixKey!, texture };
          let stamp: Texture | undefined;
          let target: Texture | undefined;
          try {
            stamp = await this.rasterSource(
              { ...l, kind: "paint", asset: undefined, strokes: [stroke] },
              texture.width,
              texture.height,
            );
            stamp = this.convertedSource(stamp, true);
            target =
              this.floating || texture.format === "rgba32float"
                ? this.backend.floatTexture(texture.width, texture.height)
                : this.backend.texture(texture.width, texture.height);
            const u = new Float32Array(32);
            u[0] = u[6] = u[24] = texture.width;
            u[1] = u[7] = u[25] = texture.height;
            u[8] = u[10] = 1;
            u[23] = this.boundedRgb ? 1 : 0;
            // 0 = layer RGBA, 1 = constant vector fill, 2 = alpha-locked
            // painting, 3 = ordinary painting preserving untouched source RGB.
            u[29] = stroke.preserveAlpha ? 2 : 3;
            this.backend.pass(texture, stamp, this.white, u, target);
            if (texture !== prefix?.texture) this.backend.destroy(texture);
            texture = target;
            target = undefined;
          } finally {
            if (stamp) this.backend.destroy(stamp);
            if (target) this.backend.destroy(target);
          }
        }
      }
      if (old)
        this.destroySource(old, [texture, ...(prefix ? [prefix.texture] : [])]);
      this.sources.set(l.id, { key, texture, assets, paintPrefix: prefix });
      if (prefix) this.trimPaintPrefixes(l.id);
      return texture;
    } catch (error) {
      for (const t of new Set([texture, prefix?.texture]))
        if (t && t !== old?.texture && t !== old?.paintPrefix?.texture)
          this.backend.destroy(t);
      throw error;
    }
  }
  // `clipped`: the layer draws inside a clipping group, whose pass needs the
  // shape's color in the texture instead of in the uniforms.
  private async vectorSource(l: Layer, doc: PhotoDocument, assets: Assets, clipped = false) {
    const vector = l.vector!,
      matrix = vectorMatrix(l),
      stroke = vector.stroke,
      radius =
        stroke?.enabled && stroke.alignment !== "inside"
          ? strokePixels(stroke) *
            (stroke.alignment === "center" ? 0.5 : 1) *
            Math.max(
              Math.SQRT2,
              stroke.join === "miter" ? stroke.miterLimit : 1,
            )
          : 0,
      padding = Math.ceil(Math.max(0, l.filters.blur) + radius);
    const bounds = vectorUnbounded(vector.mask)
      ? { x: 0, y: 0, width: doc.width, height: doc.height }
      : vectorBounds(vector.mask, matrix);
    let viewport: Rect;
    if (!bounds) viewport = { x: 0, y: 0, width: 1, height: 1 };
    else {
      const x = Math.max(-padding, Math.floor(bounds.x) - padding),
        y = Math.max(-padding, Math.floor(bounds.y) - padding);
      const right = Math.min(
          doc.width + padding,
          Math.ceil(bounds.x + bounds.width) + padding,
        ),
        bottom = Math.min(
          doc.height + padding,
          Math.ceil(bounds.y + bounds.height) + padding,
        );
      viewport =
        right <= x || bottom <= y
          ? { x: 0, y: 0, width: 1, height: 1 }
          : { x, y, width: right - x, height: bottom - y };
    }
    const key = JSON.stringify([
      "vector",
      vector.mask,
      vector.reference,
      matrix,
      viewport,
      stroke && { ...stroke, color: undefined, opacity: undefined },
    ]);
    const old = this.sources.get(l.id);
    const patternFill = isVectorPattern(vector.fill) ? vector.fill : undefined;
    const gradientFill = isVectorGradient(vector.fill) ? vector.fill : undefined;
    const component = (value: number) =>
      this.floating
        ? value
        : Math.round(Math.max(0, Math.min(1, value)) * 255) / 255;
    const rgb = patternFill || gradientFill
      ? undefined
      : vectorDocumentRgb(l, doc).map(component);
    const ink = stroke && vectorColorRgb(stroke.color, doc).map(component);
    const paintMatrix = patternFill || gradientFill ? vectorPaintMatrix(l) : undefined;
    const plainKey = patternFill || gradientFill
      ? JSON.stringify([
          patternFill ?? gradientFill,
          paintMatrix,
          ink,
          stroke?.opacity,
          this.floating,
        ])
      : stroke
        ? JSON.stringify([rgb, ink, stroke.opacity])
        : "";
    // A solid color is baked into the texture only for clipped layers.
    const solid = !patternFill && !gradientFill && (!stroke || !stroke.fillEnabled);
    const paintKey = clipped && solid ? JSON.stringify(["clipped", plainKey, rgb, ink]) : plainKey;
    const reuse = old?.key === key && old.assets === assets;
    if (reuse && old.paintKey === paintKey) return old;
    const raster: FloatVectorRaster | StrokeRaster = reuse
      ? old.geometry!
      : stroke
        ? await this.engine.vectorStroke(vector.mask, viewport, matrix, stroke)
        : await this.engine.vectorCoverage(vector.mask, viewport, matrix);
    let pixels: Float32Array | undefined;
    let pattern: SourceEntry["pattern"];
    if (patternFill) {
      const patternKey = JSON.stringify([patternFill.asset, patternFill.id]);
      const tile =
        old?.assets === assets && old.pattern?.key === patternKey
          ? old.pattern.pixels
          : await assets.pattern(patternFill.asset, patternFill.id);
      if (
        raster.coverage.byteLength * (stroke ? 8 : 6) + tile.data.byteLength >
        512 * 1024 * 1024
      )
        throw new Error("Pattern painting exceeds the 512 MB pixel budget.");
      pattern = {
        key: patternKey,
        pixels: tile,
        sample: patternSampler(patternFill, tile, paintMatrix!),
      };
      pixels = new Float32Array(raster.coverage.length * 4);
    }
    if (gradientFill) {
      if (raster.coverage.byteLength * (stroke ? 8 : 6) > 512 * 1024 * 1024)
        throw new Error("Gradient painting exceeds the 512 MB pixel budget.");
      pixels = new Float32Array(raster.coverage.length * 4);
    }
    const paintSample = pattern?.sample ??
      (gradientFill ? gradientSampler(gradientFill, paintMatrix!) : undefined);
    let coverage = raster.coverage;
    // Reuse one sample tuple across the viewport rather than allocating one
    // JavaScript array for every painted document pixel.
    const paintTuple: [number, number, number, number] = [0, 0, 0, 0];
    const constantRgb = stroke && !stroke.fillEnabled ? ink : undefined;
    if (stroke && "strokeCoverage" in raster) {
      const areas = raster as StrokeRaster;
      coverage = new Float32Array(raster.coverage.length);
      if (!constantRgb && !pixels)
        pixels = new Float32Array(raster.coverage.length * 4);
      for (let i = 0; i < raster.coverage.length; i++) {
        const sampled = paintSample?.(
          viewport.x + (i % viewport.width),
          viewport.y + Math.floor(i / viewport.width),
          paintTuple,
        );
        const fill = raster.coverage[i],
          fillAlpha = sampled?.[3] ?? 1,
          edge = areas.strokeCoverage[i],
          overlap = areas.overlapCoverage[i],
          alpha = Math.min(
            1,
            Math.max(
              0,
              fill * fillAlpha + stroke.opacity * (edge - overlap * fillAlpha),
            ),
          );
        coverage[i] = alpha;
        if (pixels) {
          for (let c = 0; c < 3; c++)
            pixels[i * 4 + c] =
              alpha > 0
                ? ((sampled ? component(sampled[c]) : rgb![c]) *
                    fillAlpha *
                    (fill - stroke.opacity * overlap) +
                    ink![c] * stroke.opacity * edge) /
                  alpha
                : 0;
          pixels[i * 4 + 3] = alpha;
        }
      }
    } else if (paintSample && pixels) {
      coverage = new Float32Array(raster.coverage.length);
      for (let i = 0; i < raster.coverage.length; i++) {
        const rgba = paintSample(
          viewport.x + (i % viewport.width),
          viewport.y + Math.floor(i / viewport.width),
          paintTuple,
        );
        for (let c = 0; c < 3; c++) pixels[i * 4 + c] = component(rgba[c]);
        pixels[i * 4 + 3] = coverage[i] = raster.coverage[i] * rgba[3];
      }
    }
    if (clipped && !pixels) {
      const color = constantRgb ?? rgb!;
      pixels = new Float32Array(coverage.length * 4);
      for (let i = 0; i < coverage.length; i++) {
        pixels.set(color, i * 4);
        pixels[i * 4 + 3] = coverage[i];
      }
    }
    const texture = pixels
      ? this.backend.floatTexture(viewport.width, viewport.height, pixels)
      : this.backend.coverageTexture(viewport.width, viewport.height, coverage);
    if (old) this.destroySource(old);
    const result = {
      key,
      texture,
      assets,
      viewport,
      coverage,
      constantRgb,
      geometry: raster,
      paintKey,
      pixels,
      pattern,
      paintSample,
      ...(stroke && "strokePath" in raster
        ? {
            fillPath: new Path2D(raster.path),
            strokePath: new Path2D((raster as StrokeRaster).strokePath),
          }
        : {}),
    };
    this.sources.set(l.id, result);
    return result;
  }
  private async mask(l: Layer, assets: Assets, viewport?: Rect) {
    if (!hasMask(l) || l.maskDisabled) return this.white;
    if (l.pixelMask && l.maskStrokes?.length && !viewport)
      viewport = {x:0,y:0,width:this.document!.width,height:this.document!.height};
    const id = `mask:${l.id}`;
    const key = JSON.stringify([
      l.maskAsset,
      l.mask,
      l.maskStrokes,
      l.pixelMask ? undefined : l.maskInverted,
      l.pixelMask ? [pixelMaskMatrix(l),l.pixelMask.reference] : l.transform,
      l.sourceWidth,
      l.sourceHeight,
      viewport,
      !!l.pixelMask,
    ]);
    const old = this.sources.get(id);
    if (l.pixelMask && !l.maskStrokes?.length) {
      if (old) { this.destroySource(old); this.sources.delete(id); }
      return this.white;
    }
    if (old?.key === key && old.assets === assets) return old.texture;
    const painted = !!l.maskStrokes?.length || !!l.maskInverted;
    if (!painted && !l.maskAsset && !viewport) return this.white;
    const b = l.pixelMask ? await this.engine.maskBasis(l, viewport?.width ?? l.sourceWidth,
      viewport?.height ?? l.sourceHeight, viewport) : await this.engine.mask(
      painted || viewport ? l : { ...l, mask: null },
      viewport?.width ?? l.sourceWidth,
      viewport?.height ?? l.sourceHeight,
      l.maskAsset ? assets.get(l.maskAsset) : undefined,
      viewport,
    );
    const texture = this.backend.texture(b.width, b.height, 'data' in b ? b.data : b);
    if (!('data' in b)) b.close();
    if (old) this.destroySource(old);
    this.sources.set(id, { key, texture, assets });
    return texture;
  }
  private pixelMask(l: Layer, assets: Assets) {
    if (!l.pixelMask?.asset || l.maskDisabled) return this.white;
    const id = `pixel-mask:${l.id}`, key = l.pixelMask.asset;
    const old = this.sources.get(id);
    const samples = assets.coverage(key);
    if (samples.width !== l.pixelMask.bounds.width || samples.height !== l.pixelMask.bounds.height)
      throw new Error('Pixel mask dimensions do not match its coverage asset.');
    if (samples.width > this.backend.maxSize || samples.height > this.backend.maxSize)
      throw new Error(`This GPU supports mask planes up to ${this.backend.maxSize} pixels per side.`);
    if (old?.key === key && old.assets === assets) return old.texture;
    const texture = this.backend.coverageTexture(samples.width,samples.height,floatCoverage(samples));
    if (old) this.destroySource(old);
    this.sources.set(id,{key,texture,assets});
    return texture;
  }
  // Pixel layers upload only tiles whose ID or live-stroke version changed.
  private pixelSource(l: Layer, grid: TileGrid, assets: Assets, id = l.id) {
    const b = grid.bounds;
    if (!b) return undefined;
    let ext = alignedExtent(b);
    const max = this.backend.maxSize;
    // A layer larger than a texture (a big layer scaled up, say) uploads only
    // the tiles over the canvas; its other pixels are kept, just not drawn.
    if ((ext.width > max || ext.height > max) && this.document) {
      const canvas = alignedExtent({ x: -grid.x, y: -grid.y, width: this.document.width, height: this.document.height });
      const shown = intersectRect(ext, canvas);
      if (!shown) return undefined;
      ext = shown;
    }
    if (ext.width > max || ext.height > max)
      throw new Error(`This GPU supports layers up to ${max} pixels per side.`);
    const key = JSON.stringify([ext, this.floating]);
    let entry = this.sources.get(id);
    if (!entry || entry.key !== key || entry.assets !== assets || !entry.tiles) {
      if (entry) this.destroySource(entry);
      const texture = this.floating
        ? this.backend.floatTexture(ext.width, ext.height)
        : this.backend.texture(ext.width, ext.height);
      this.backend.clear(texture);
      entry = { key, texture, assets, tiles: new Map() };
      this.sources.set(id, entry);
    }
    const store = assets.tiles;
    for (let ty = ext.y / TILE; ty < (ext.y + ext.height) / TILE; ty++)
      for (let tx = ext.x / TILE; tx < (ext.x + ext.width) / TILE; tx++) {
        const k = tileKey(tx, ty),
          tile = grid.tiles[k];
        const state = tile ? `${tile}:${store.version(tile)}` : '';
        if ((entry.tiles!.get(k) ?? '') === state) continue;
        const bytes = tile ? store.get(tile) : zeroTile;
        const data = this.floating ? floatBytes(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.backend.write(entry.texture, tx * TILE - ext.x, ty * TILE - ext.y, TILE, TILE, data);
        if (state) entry.tiles!.set(k, state);
        else entry.tiles!.delete(k);
      }
    return { texture: entry.texture, extent: { ...ext, x: ext.x + grid.x, y: ext.y + grid.y } };
  }
  // Painted layer masks are document-space coverage tiles sampled through the
  // same scalar-mask path as imported pixel masks.
  private gridMask(l: Layer, assets: Assets) {
    const grid = l.maskGrid!;
    const keys = Object.keys(grid.tiles);
    if (!keys.length) return undefined;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of keys) {
      const [tx, ty] = parseKey(k);
      x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
    }
    const ext = { x: x0 * TILE, y: y0 * TILE, width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE };
    const id = `mask-grid:${l.id}`, key = JSON.stringify([ext, grid.fill ?? 0]);
    let entry = this.sources.get(id);
    if (!entry || entry.key !== key || entry.assets !== assets || !entry.tiles) {
      if (entry) this.destroySource(entry);
      const texture = this.backend.coverageTexture(ext.width, ext.height, new Float32Array(ext.width * ext.height).fill((grid.fill ?? 0) / 255));
      entry = { key, texture, assets, tiles: new Map() };
      this.sources.set(id, entry);
    }
    const store = assets.tiles;
    const fillTile = new Float32Array(TILE * TILE).fill((grid.fill ?? 0) / 255);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const k = tileKey(tx, ty), tile = grid.tiles[k];
        const state = tile ? `${tile}:${store.version(tile)}` : '';
        if ((entry.tiles!.get(k) ?? '') === state) continue;
        let data = fillTile;
        if (tile) {
          const bytes = store.get(tile);
          data = new Float32Array(TILE * TILE);
          for (let i = 0; i < data.length; i++) data[i] = bytes[i] / 255;
        }
        this.backend.write(entry.texture, tx * TILE - ext.x, ty * TILE - ext.y, TILE, TILE, data);
        if (state) entry.tiles!.set(k, state);
        else entry.tiles!.delete(k);
      }
    return { texture: entry.texture, extent: { ...ext, x: ext.x + grid.x, y: ext.y + grid.y } };
  }
  private gridMaskUniforms(l: Layer, u: Float32Array, assets: Assets) {
    if (!l.maskGrid || l.maskDisabled) return undefined;
    const mask = this.gridMask(l, assets);
    u[20] = 0;
    u[21] = 0;
    u.set([1, 0, 0, 1], 36);
    u.set([-(mask?.extent.x ?? 0), -(mask?.extent.y ?? 0), (l.maskGrid.fill ?? 0) / 255, Number(!!l.maskInverted)], 40);
    u.set([1, 1, Number(!!mask), 0], 44);
    return mask?.texture;
  }
  private lutTexture(l: Layer) {
    const id = `lut:${l.id}`, key = JSON.stringify(l.adjustment);
    const old = this.sources.get(id);
    if (old?.key === key) return old.lut ? { texture: old.texture, uniforms: old.lut } : undefined;
    if (old) {
      this.destroySource(old);
      this.sources.delete(id);
    }
    const compiled = adjustmentCompiler?.(l.adjustment!);
    if (!compiled || (!compiled.curves && !compiled.lut3d)) {
      this.sources.set(id, { key, texture: this.white, assets: undefined as unknown as Assets });
      return undefined;
    }
    const packed = packLut(compiled);
    if (packed.width > this.backend.maxSize) throw new Error('This adjustment exceeds GPU texture limits.');
    const texture = this.backend.floatTexture(packed.width, packed.height, packed.data);
    if (!this.floating) packed.uniforms[3] = 1;
    this.sources.set(id, { key, texture, assets: undefined as unknown as Assets, lut: packed.uniforms });
    return { texture, uniforms: packed.uniforms };
  }
  private documentLayer(l: Layer, doc: PhotoDocument): Layer {
    return {
      ...l,
      sourceWidth: doc.width,
      sourceHeight: doc.height,
      transform: { x: 0, y: 0, width: doc.width, height: doc.height, rotation: 0 },
    };
  }
  /** A group's composited children. Artboards add their background under
   * the contents; artboards (unless clipping is off) and frames clip to their
   * rectangle or ellipse. */
  private async groupSource(l: Layer, doc: PhotoDocument, assets: Assets): Promise<Texture> {
    if (!l.artboard && !l.frame) return this.composite(l.children, doc, assets);
    const fill = l.artboard ? artboardFill(l.artboard) : null;
    const children = fill
      ? [{ ...layerTemplate(), id: `artboard-bg:${l.id}`, kind: 'solid' as const, color: fill, transform: { ...l.artboard!.rect, rotation: 0 } }, ...l.children]
      : l.children;
    const inner = await this.composite(children, doc, assets);
    const shape = l.frame ?? (l.artboard!.clip !== false ? { shape: 'rect' as const, rect: l.artboard!.rect } : undefined);
    if (!shape) return inner;
    const empty = this.target(doc.width, doc.height);
    this.backend.clear(empty);
    const out = this.target(doc.width, doc.height);
    const u = uniforms(this.documentLayer({ ...layerTemplate(), id: l.id }, doc), doc.width, doc.height, doc.width, doc.height);
    u[23] = this.boundedRgb ? 1 : 0;
    const r = shape.rect;
    if (shape.shape === 'rect') {
      u.set([r.x, r.y, r.width, r.height], 16);
      u[20] = 1;
      this.backend.pass(empty, inner, this.white, u, out);
      return out;
    }
    const coverage = this.ellipseMask(l.id, r);
    u.set([1, 0, 0, 1], 36);
    u.set([-coverage.extent.x, -coverage.extent.y, 0, 0], 40);
    u.set([1, 1, 1, 0], 44);
    this.backend.pass(empty, inner, this.white, u, out, coverage.texture);
    return out;
  }
  private ellipseMask(id: string, r: Rect) {
    const extent = { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.max(1, Math.ceil(r.x + r.width) - Math.floor(r.x)), height: Math.max(1, Math.ceil(r.y + r.height) - Math.floor(r.y)) };
    if (extent.width > this.backend.maxSize || extent.height > this.backend.maxSize)
      throw new Error(`This GPU supports frames up to ${this.backend.maxSize} pixels per side.`);
    const key = JSON.stringify(r);
    const old = this.sources.get(`frame-clip:${id}`);
    if (old?.key === key) return { texture: old.texture, extent };
    if (old) this.destroySource(old);
    const texture = this.backend.coverageTexture(extent.width, extent.height, ellipseCoverage(r, extent));
    this.sources.set(`frame-clip:${id}`, { key, texture, assets: undefined as unknown as Assets });
    return { texture, extent };
  }
  private async composite(
    layers: Layer[],
    doc: PhotoDocument,
    assets: Assets,
    nested = true,
  ): Promise<Texture> {
    const back = this.target(doc.width, doc.height);
    this.backend.clear(back);
    const next = this.target(doc.width, doc.height);
    return (await this.compositeInto(layers, doc, assets, back, next, nested))[0];
  }
  // A copy of a document-sized texture from the pool.
  private copyOf(t: Texture) {
    const copy = this.target(t.width, t.height);
    const u = new Float32Array(UNIFORM_FLOATS);
    u[31] = 1;
    this.backend.pass(this.white, t, this.white, u, copy);
    return copy;
  }
  // Backdrops that knockouts reveal: the start of each enclosing group
  // (shallow) and the Background layer alone (deep, made once per draw).
  private knockStack: Texture[] = [];
  private knockBase?: Texture;
  private async deepBase(doc: PhotoDocument, assets: Assets) {
    if (this.knockBase) return this.knockBase;
    const base = this.floating ? this.backend.floatTexture(doc.width, doc.height) : this.backend.texture(doc.width, doc.height);
    this.backend.clear(base);
    this.knockBase = base;
    const bg = doc.layers[0];
    if (bg?.background && bg.visible) {
      const mark = this.cursor;
      try {
        let a = this.target(doc.width, doc.height), b = this.target(doc.width, doc.height);
        this.backend.clear(a);
        [a, b] = await this.drawLayer(bg, doc, assets, a, b);
        const u = new Float32Array(UNIFORM_FLOATS);
        u[31] = 1;
        this.backend.pass(this.white, a, this.white, u, base);
      } finally {
        this.cursor = mark;
      }
    }
    return base;
  }
  /** Knockout: replaces the backdrop inside the layer's shape (coverage with
   * opacity and masks, without effects) by the knockout backdrop, into `next`. */
  private async knockOut(l: Layer, doc: PhotoDocument, assets: Assets, back: Texture, next: Texture) {
    const base = l.blending!.knockout === 'shallow' && this.knockStack.length ? this.knockStack[this.knockStack.length - 1] : await this.deepBase(doc, assets);
    const mark = this.cursor;
    try {
      let shape = this.target(doc.width, doc.height), scratch = this.target(doc.width, doc.height);
      this.backend.clear(shape);
      [shape, scratch] = await this.drawLayer({ ...l, style: undefined, blending: undefined, fillOpacity: 1, blend: 'normal', clipped: false }, doc, assets, shape, scratch);
      this.replacePass(doc, back, base, shape, next);
    } finally {
      this.cursor = mark;
    }
  }
  // next = mix(back, source, shape alpha), all document-sized.
  private replacePass(doc: PhotoDocument, back: Texture, source: Texture, shape: Texture, next: Texture) {
    const u = uniforms(this.documentLayer({ ...layerTemplate(), id: 'replace' }, doc), doc.width, doc.height, doc.width, doc.height);
    u[23] = this.boundedRgb ? 1 : 0;
    u[29] = 4;
    this.backend.pass(back, source, shape, u, next);
  }
  private async compositeInto(
    layers: Layer[],
    doc: PhotoDocument,
    assets: Assets,
    back: Texture,
    next: Texture,
    nested = true,
  ): Promise<[Texture, Texture]> {
    // Shallow knockouts at the top level reveal the Background layer.
    const knocks = nested && layers.some((x) => x.visible && x.blending?.knockout === 'shallow');
    if (knocks) this.knockStack.push(this.copyOf(back));
    try {
      return await this.compositeLayers(layers, doc, assets, back, next);
    } finally {
      if (knocks) this.knockStack.pop();
    }
  }
  private async compositeLayers(
    layers: Layer[],
    doc: PhotoDocument,
    assets: Assets,
    back: Texture,
    next: Texture,
  ): Promise<[Texture, Texture]> {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      let j = i + 1;
      while (j < layers.length && layers[j].clipped) j++;
      // A hidden base hides its clipping group.
      if (!l.visible) {
        i = j - 1;
        continue;
      }
      const clippedRun = layers.slice(i + 1, j).filter((c) => c.visible);
      if (!clippedRun.length) {
        [back, next] = await this.drawLayer(l, doc, assets, back, next);
        continue;
      }
      i = j - 1;
      if (l.blending?.clippedAsGroup === false) {
        [back, next] = await this.clipSeparately(l, clippedRun, doc, assets, back, next);
        continue;
      }
      // Clipping groups composite in isolation: base, then clipped layers inside
      // the base's coverage, then the group with the base's opacity and mode.
      const mark = this.cursor;
      let groupBack = this.target(doc.width, doc.height);
      this.backend.clear(groupBack);
      let groupNext = this.target(doc.width, doc.height);
      // The base's Blend If and knockout apply to the whole group below.
      [groupBack, groupNext] = await this.drawLayer({ ...l, opacity: 1, blend: 'normal', blending: undefined }, doc, assets, groupBack, groupNext);
      const knocks = clippedRun.some((c) => c.blending?.knockout === 'shallow');
      // Shallow knockouts of clipped layers stop at the base.
      if (knocks) this.knockStack.push(this.copyOf(groupBack));
      try {
        // Fill fades only the base's own pixels: its full-fill shape still
        // decides where the clipped layers show.
        if ((l.fillOpacity ?? 1) < 1) [groupBack, groupNext] = await this.clipToShape(l, clippedRun, doc, assets, groupBack, groupNext);
        else
          for (const c of clippedRun)
            [groupBack, groupNext] = await this.drawLayer(c, doc, assets, groupBack, groupNext, true);
      } finally {
        if (knocks) this.knockStack.pop();
      }
      if (l.blending?.knockout) {
        await this.knockOut(l, doc, assets, back, next);
        [back, next] = [next, back];
      }
      const plain = { ...l, filters: defaultFilters(), mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined };
      const u = uniforms(this.documentLayer(plain, doc), doc.width, doc.height, doc.width, doc.height);
      u[23] = this.boundedRgb ? 1 : 0;
      blendingUniforms(l, u);
      this.backend.pass(back, groupBack, this.white, u, next);
      [back, next] = [next, back];
      this.cursor = mark;
    }
    return [back, next];
  }
  /** Clipped layers that do not blend as a group with their base: the base
   * draws as usual; each clipped layer then blends with the full backdrop,
   * kept inside the base's shape. */
  private async clipSeparately(base: Layer, run: Layer[], doc: PhotoDocument, assets: Assets, back: Texture, next: Texture): Promise<[Texture, Texture]> {
    [back, next] = await this.drawLayer(base, doc, assets, back, next);
    return this.clipToShape(base, run, doc, assets, back, next);
  }
  /** Draw `run` over `back`, each kept inside the shape of `base` drawn
   * alone at full opacity and fill (its mask applies; its effects do not). */
  private async clipToShape(base: Layer, run: Layer[], doc: PhotoDocument, assets: Assets, back: Texture, next: Texture): Promise<[Texture, Texture]> {
    const mark = this.cursor;
    try {
      let shape = this.target(doc.width, doc.height), scratch = this.target(doc.width, doc.height);
      this.backend.clear(shape);
      [shape, scratch] = await this.drawLayer({ ...base, style: undefined, blending: undefined, opacity: 1, fillOpacity: 1, blend: 'normal', clipped: false }, doc, assets, shape, scratch);
      for (const c of run) {
        const inner = this.cursor;
        let drawn = this.copyOf(back), spare = this.target(doc.width, doc.height);
        [drawn, spare] = await this.drawLayer({ ...c, clipped: false }, doc, assets, drawn, spare);
        this.replacePass(doc, back, drawn, shape, next);
        [back, next] = [next, back];
        this.cursor = inner;
      }
    } finally {
      this.cursor = mark;
    }
    return [back, next];
  }
  private async drawLayer(
    l: Layer,
    doc: PhotoDocument,
    assets: Assets,
    back: Texture,
    next: Texture,
    clipped = false,
  ): Promise<[Texture, Texture]> {
    const mark = this.cursor;
    try {
      if (l.blending?.knockout && l.visible) {
        await this.knockOut(l, doc, assets, back, next);
        [back, next] = [next, back];
        l = { ...l, blending: { ...l.blending, knockout: undefined } };
      }
      const style = l.kind !== 'adjustment' && l.style ? activeLayerStyle(l) : undefined;
      if (style) return await this.styles.draw(this.styleContext(doc, assets), l, style, doc, assets, back, next, clipped);
      if (l.kind === 'adjustment') {
        const spatial = spatialCompiler?.(l.adjustment!);
        const adjusted = this.target(doc.width, doc.height);
        if (spatial)
          (this.spatial ??= new SpatialPasses(this.backend)).run(back, spatial, adjusted, {
            docMax: Math.max(doc.width, doc.height),
            clampTop: !this.floating || this.boundedRgb,
          });
        else {
          const lut = this.lutTexture(l);
          if (!lut) return [back, next];
          this.backend.lutPass(back, lut.texture, lut.uniforms, adjusted);
        }
        const actual = this.documentLayer(l, doc);
        const u = uniforms(actual, doc.width, doc.height, doc.width, doc.height);
        u[23] = this.boundedRgb ? 1 : 0;
        if (clipped) u[29] = 2;
        blendingUniforms(l, u);
        const gridMask = this.gridMaskUniforms(l, u, assets);
        pixelMaskUniforms(l, u);
        this.backend.pass(back, adjusted, await this.mask(actual, assets), u, next, gridMask ?? this.pixelMask(l, assets));
        return [next, back];
      }
      // Artboards and frames always composite their contents in isolation, and
      // so does a clipped group (its result is kept inside the base).
      if (l.kind === 'group' && l.blend === 'pass through' && !l.artboard && !l.frame && !clipped) {
        const plain = l.opacity === 1 && !hasMask(l) && !l.maskGrid && !l.blending?.ranges && !l.blending?.exclude && Object.values(l.filters).every((v) => !v);
        if (plain) return await this.compositeInto(l.children, doc, assets, back, next);
        // Children blend with the backdrop; the group's opacity and mask then
        // mix that result back over the untouched backdrop.
        let copy = this.target(doc.width, doc.height);
        const copyU = new Float32Array(UNIFORM_FLOATS);
        copyU[31] = 1;
        this.backend.pass(this.white, back, this.white, copyU, copy);
        let scratch = this.target(doc.width, doc.height);
        [copy, scratch] = await this.compositeInto(l.children, doc, assets, copy, scratch);
        const actual = this.documentLayer({ ...l, blend: 'normal' }, doc);
        const u = uniforms(actual, doc.width, doc.height, doc.width, doc.height);
        u[23] = this.boundedRgb ? 1 : 0;
        blendingUniforms(l, u);
        const gridMask = this.gridMaskUniforms(l, u, assets);
        pixelMaskUniforms(l, u);
        this.backend.pass(back, copy, await this.mask(actual, assets), u, next, gridMask ?? this.pixelMask(l, assets));
        return [next, back];
      }
      const pixel = l.kind === 'pixel' ? this.pixelSource(l, l.pixels!, assets) : undefined;
      if (l.kind === 'pixel' && !pixel) return [back, next];
      const vector =
        l.kind === "vector"
          ? await this.vectorSource(l, doc, assets, clipped)
          : undefined;
      const source = pixel
        ? pixel.texture
        : vector
          ? vector.texture
          : l.kind === "group"
            ? await this.groupSource(l, doc, assets)
            : await this.source(l, assets);
      const fill = l.fillOpacity ?? 1;
      const actual =
        l.kind === "group"
          ? this.documentLayer(l.blend === 'pass through' ? { ...l, blend: 'normal' } : l, doc)
          : pixel
            ? {
                ...l,
                transform: pixelPlacement(l, pixel.extent),
                sourceWidth: source.width,
                sourceHeight: source.height,
              }
            : vector
              ? {
                  ...l,
                  transform: { ...vector.viewport!, rotation: 0 },
                  sourceWidth: source.width,
                  sourceHeight: source.height,
                }
              : this.placed(l, source);
      const u = uniforms(
        { ...actual, opacity: actual.opacity * fill },
        doc.width,
        doc.height,
        source.width,
        source.height,
      );
      if (vector) {
        const rgb = vector.pixels ? undefined : (vector.constantRgb ?? vectorDocumentRgb(l, doc)).map(
          (v) =>
            this.floating
              ? v
              : Math.round(Math.max(0, Math.min(1, v)) * 255) / 255,
        );
        if (rgb) { u[2] = rgb[0]; u[3] = rgb[1]; u[28] = rgb[2]; }
        u[29] = vector.pixels ? 0 : 1;
        if (hasMask(l) && !l.maskDisabled) {
          u[20] = 0;
          u[21] = l.pixelMask ? Number(!!l.maskStrokes?.length) : 1;
        }
      }
      if (clipped) {
        if (u[29] === 1) throw new Error('Clip solid-color vector shapes by rasterizing them first.');
        u[29] = 2;
      }
      // 16-bit integer RGB cannot represent values outside [0,1]. Keep its
      // arithmetic in float, applying gamut/range clipping without byte rounding.
      u[23] = this.boundedRgb || (!this.floating && (!!vector || !!l.pixelMask)) ? 1 : 0;
      if (l.pixelMask && l.maskStrokes?.length) {
        const b=vector?.viewport ?? {x:0,y:0,width:doc.width,height:doc.height};
        u.set([b.x,b.y,b.width,b.height],16);
      }
      pixelMaskUniforms(l,u);
      blendingUniforms(l, u);
      const gridMask = this.gridMaskUniforms(l, u, assets);
      this.backend.pass(
        back,
        source,
        await this.mask(vector ? l : actual, assets, vector?.viewport),
        u,
        next,
        gridMask ?? this.pixelMask(l,assets),
      );
      return [next, back];
    } finally {
      this.cursor = mark;
    }
  }
  render(doc: PhotoDocument, assets: Assets): Promise<void> {
    this.queued = { doc, assets };
    this.lastRender = { doc, assets };
    if (this.active) return this.idle;
    this.active = true;
    this.idle = (async () => {
      try {
        while (this.queued) {
          const task = this.queued;
          this.queued = undefined;
          await this.draw(task.doc, task.assets);
        }
      } finally {
        this.active = false;
      }
    })();
    return this.idle;
  }
  // Run a draw that must not be superseded by queued previews, then let the
  // queue continue with the latest document.
  private exclusiveChain: Promise<unknown> = Promise.resolve();
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    // Exclusive readbacks run one after another; each also waits for a
    // render in progress. Without the chain, two callers would both spin on
    // an already-settled `idle` promise.
    const run = this.exclusiveChain.then(() => this.runExclusive(task));
    this.exclusiveChain = run.catch(() => {});
    return run;
  }
  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    // Readbacks from a lost context would return blank pixels.
    while (this.recovering) await this.recovering;
    while (this.active) await this.idle.catch(() => {});
    this.active = true;
    this.exclusiveDepth++;
    try {
      return await task();
    } finally {
      this.exclusiveDepth--;
      this.active = false;
      const queued = this.queued;
      this.queued = undefined;
      if (queued) void this.render(queued.doc, queued.assets).catch(() => {});
    }
  }
  // Work that readbacks wait for, such as cached renders of embedded object
  // frames made stale by the latest edit (set by the embedded feature).
  beforeReadback?: () => Promise<void>;
  /** Render one layer alone (opacity 1, normal, no clipping) at document size. */
  async layerPixels(l: Layer, doc: PhotoDocument, assets: Assets): Promise<Uint8Array | Float32Array> {
    await this.beforeReadback?.();
    const single: PhotoDocument = {
      ...doc,
      layers: [{ ...l, visible: true, opacity: 1, blend: 'normal', clipped: false, blending: undefined }],
    };
    return this.exclusive(async () => {
      await this.draw(single, assets, false);
      return this.final!.format === 'rgba32float' ? this.backend.readFloat(this.final!) : this.backend.read(this.final!);
    });
  }
  /** Composite of a document (all visible layers) as stored samples. */
  async documentPixels(doc: PhotoDocument, assets: Assets): Promise<Uint8Array | Float32Array> {
    await this.beforeReadback?.();
    return this.exclusive(async () => {
      await this.draw(doc, assets);
      return this.final!.format === 'rgba32float' ? this.backend.readFloat(this.final!) : this.backend.read(this.final!);
    });
  }
  async settle() {
    // Replacement must wait for source users before releasing the old assets.
    // A failed preview of the discarded document must not prevent replacement.
    await this.idle.catch(() => {});
    // Replacement must also wait for source/mask users in a pending pick.
    await this.picks;
  }
  pickCoverage(
    doc: PhotoDocument,
    assets: Assets,
    l: Layer,
    parents: Layer[],
    x: number,
    y: number,
    signal?: AbortSignal,
  ): number | Promise<number> {
    if (signal?.aborted) return 0;
    if (l.kind === 'pixel') return pixelCoverage(l, parents, assets, x, y);
    // Vectors are selected by editable geometry, rather than pixel area. An
    // unmasked, opaque shape needs no readback. The same is true for an opaque
    // solid rectangle aligned to the document's pixel grid.
    const unmaskedOpaque = [l, ...parents].every(
      (item) => item.opacity === 1 && (!hasMask(item) || item.maskDisabled),
    );
    if (unmaskedOpaque && l.kind === "vector" && !l.vector!.stroke && !isVectorPattern(l.vector!.fill) && !isVectorGradient(l.vector!.fill)) return 1;
    const t = l.transform;
    if (
      unmaskedOpaque &&
      l.kind === "solid" &&
      t.rotation % 360 === 0 &&
      [t.x, t.y, t.width, t.height].every(Number.isInteger)
    ) {
      const [u, v] = localPoint(t, Math.floor(x) + 0.5, Math.floor(y) + 0.5);
      return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? 1 : 0;
    }
    const task = this.picks.then(() =>
      this.projectCoverage(doc, assets, l, parents, x, y, signal),
    );
    this.picks = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async projectCoverage(
    doc: PhotoDocument,
    assets: Assets,
    l: Layer,
    parents: Layer[],
    x: number,
    y: number,
    signal?: AbortSignal,
  ) {
    await this.idle;
    if (signal?.aborted) return 0;
    if (this.document !== doc) await this.render(doc, assets);
    if (signal?.aborted || this.document !== doc) return 0;
    const floating = (doc.bitsPerChannel ?? 8) > 8;
    const allocate = () =>
      floating ? this.backend.floatTexture(1, 1) : this.backend.texture(1, 1);
    const textures: Texture[] = [];
    const target = () => {
      const texture = allocate();
      textures.push(texture);
      return texture;
    };
    try {
      const clear = target(),
        first = target(),
        second = target();
      this.backend.clear(clear);
      const vector =
        l.kind === "vector"
          ? await this.vectorSource(l, doc, assets)
          : undefined;
      let vectorAlpha = 1;
      const paintAlpha =
        vector?.paintSample?.(Math.floor(x), Math.floor(y))[3] ?? 1;
      if (vector?.paintSample) vectorAlpha = paintAlpha;
      if (vector?.fillPath && vector.strokePath && l.vector!.stroke) {
        const context = (this.vectorPickContext ??= new OffscreenCanvas(
          1,
          1,
        ).getContext("2d")!);
        const px = x - vector.viewport!.x,
          py = y - vector.viewport!.y,
          stroke = l.vector!.stroke,
          fillHit =
            stroke.fillEnabled &&
            context.isPointInPath(
              vector.fillPath,
              px,
              py,
              vector.geometry!.fillRule,
            ),
          strokeHit = context.isPointInPath(
            vector.strokePath,
            px,
            py,
            (vector.geometry as StrokeRaster).strokeRule,
          );
        vectorAlpha =
          (fillHit ? paintAlpha : 0) +
          (strokeHit ? stroke.opacity : 0) * (1 - (fillHit ? paintAlpha : 0));
        if (!vectorAlpha) return 0;
      }
      if (!vectorAlpha) return 0;
      const source = vector ? this.white : await this.source(l, assets);
      if (signal?.aborted || this.document !== doc) return 0;
      const actual = vector
        ? {
            ...l,
            opacity: l.opacity * vectorAlpha,
            transform: { ...vector.viewport!, rotation: 0 },
            sourceWidth: vector.texture.width,
            sourceHeight: vector.texture.height,
            filters: { ...l.filters, blur: 0 },
          }
        : this.placed(l, source);
      // Raster picking reads the visible document pixel. Vector picking uses
      // its continuous geometry point and samples only opacity/pixel masks.
      const world = vector
        ? [x, y]
        : [Math.floor(x) + 0.5, Math.floor(y) + 0.5];
      const parameters = (item: Layer, texture: Texture) => {
        const u = new Float32Array(UNIFORM_FLOATS);
        u.set(
          uniforms(item, doc.width, doc.height, texture.width, texture.height),
        );
        u.set([world[0] - 0.5, world[1] - 0.5, 1, 1], 32);
        u[23] = floating && doc.bitsPerChannel === 16 ? 1 : 0;
        return u;
      };
      let current = first,
        next = second;
      const u = parameters(actual, source);
      if (l.pixelMask && l.maskStrokes?.length) {
        const b=vector?.viewport ?? {x:0,y:0,width:doc.width,height:doc.height};
        u.set([b.x,b.y,b.width,b.height],16);
      }
      if (vector && hasMask(l) && !l.maskDisabled) {
        u[20] = 0;
        u[21] = l.pixelMask ? Number(!!l.maskStrokes?.length) : 1;
      }
      const mask = await this.mask(
        vector ? l : actual,
        assets,
        vector?.viewport,
      );
      if (signal?.aborted || this.document !== doc) return 0;
      pixelMaskUniforms(l,u);
      this.backend.pass(clear, source, mask, u, current, this.pixelMask(l,assets));
      for (const parent of [...parents].reverse()) {
        // Auto-select addresses editable child content. Ancestor appearance
        // filters do not create new child geometry; their masks/opacity do
        // control whether that content is visible and selectable.
        const group = {
          ...parent,
          sourceWidth: doc.width,
          sourceHeight: doc.height,
          transform: {
            x: 0,
            y: 0,
            width: doc.width,
            height: doc.height,
            rotation: 0,
          },
          filters: { ...parent.filters, blur: 0 },
        };
        const mask = await this.mask(group, assets);
        if (signal?.aborted || this.document !== doc) return 0;
        const groupU=parameters(group,current);
        if (parent.pixelMask && parent.maskStrokes?.length) groupU.set([0,0,doc.width,doc.height],16);
        // Contents outside a clipping artboard or a frame cannot be picked.
        const clip = parent.frame?.rect ?? (parent.artboard && parent.artboard.clip !== false ? parent.artboard.rect : undefined);
        if (clip && !hasMask(parent)) {
          groupU.set([clip.x, clip.y, clip.width, clip.height], 16);
          groupU[20] = 1;
        }
        this.backend.pass(
          clear,
          current,
          mask,
          groupU,
          next,
          this.pixelMask(parent,assets),
        );
        [current, next] = [next, current];
      }
      const data = floating
        ? await this.backend.readFloat(current)
        : await this.backend.read(current);
      return signal?.aborted ? 0 : data[3] / (floating ? 1 : 255);
    } finally {
      for (const texture of textures) this.backend.destroy(texture);
    }
  }
  private async draw(doc: PhotoDocument, assets: Assets, present = true) {
    if (present && presentation) doc = presentation(doc);
    this.document = doc;
    this.floating = (doc.bitsPerChannel ?? 8) > 8;
    this.boundedRgb = doc.bitsPerChannel === 16;
    this.configureProfile(doc);
    if (doc.width > this.backend.maxSize || doc.height > this.backend.maxSize)
      throw new Error(
        `This GPU supports images up to ${this.backend.maxSize} pixels per side.`,
      );
    const size = `${doc.width}:${doc.height}:${this.floating}`;
    if (size !== this.size) {
      for (const t of this.targets) this.backend.destroy(t);
      this.targets = [];
      if (this.displayTarget) this.backend.destroy(this.displayTarget);
      this.displayTarget = undefined;
      if (this.displayLutTarget) this.backend.destroy(this.displayLutTarget);
      this.displayLutTarget = undefined;
      this.size = size;
      this.canvas.width = doc.width;
      this.canvas.height = doc.height;
    }
    const active = new Set(
      allLayers(doc.layers).flatMap((l) => [
        l.id,
        ...(hasMask(l) ? [`mask:${l.id}`] : []),
        ...(l.pixelMask ? [`pixel-mask:${l.id}`] : []),
        ...(l.maskGrid ? [`mask-grid:${l.id}`] : []),
        ...(l.adjustment ? [`lut:${l.id}`] : []),
        ...(l.artboard ? [`artboard-bg:${l.id}`] : []),
        ...(l.frame?.shape === 'ellipse' ? [`frame-clip:${l.id}`] : []),
      ]),
    );
    for (const [id, entry] of this.sources)
      if (!active.has(id)) {
        this.destroySource(entry);
        this.sources.delete(id);
      }
    // Single-layer readbacks must not discard the canvas's style results.
    if (!this.exclusiveDepth) this.styles.prune(active);
    this.cursor = 0;
    this.knockStack = [];
    try {
      this.final = await this.composite(doc.layers, doc, assets, false);
    } finally {
      if (this.knockBase) this.backend.destroy(this.knockBase);
      this.knockBase = undefined;
    }
    const u = new Float32Array(32);
    u[31] = 1;
    if (this.displayLut) {
      const target = (this.displayLutTarget ??= this.floating
        ? this.backend.floatTexture(doc.width, doc.height)
        : this.backend.texture(doc.width, doc.height));
      this.backend.lutPass(this.final, this.displayLut.texture, this.displayLut.uniforms, target);
      this.backend.pass(this.white, target, this.white, u);
    } else if (this.toSrgb)
      // 32-bit documents can tone-map the presented frame (display only).
      this.backend.colorPass(this.final, this.toSrgb, undefined, false, doc.bitsPerChannel === 32 ? hdrPreviewUniforms(doc.hdrPreview) : undefined);
    else this.backend.pass(this.white, this.final, this.white, u);
    // The presented frame can be copied only before this task ends.
    if (!this.exclusiveDepth)
      for (const listener of this.frameListeners) {
        try {
          listener(this.canvas, doc);
        } catch (error) {
          console.error(error);
        }
      }
  }
  // Called with the canvas right after each interactive frame (document views
  // and pattern preview copy it into 2D canvases).
  readonly frameListeners = new Set<(canvas: HTMLCanvasElement, doc: PhotoDocument) => void>();
  /** Composite a document to the canvas and hand the frame to `use` before it
   * is presented (for previews of documents that are not active). The caller
   * re-renders the active document afterwards. */
  drawFrame(doc: PhotoDocument, assets: Assets, use: (canvas: HTMLCanvasElement) => void) {
    return this.exclusive(async () => {
      await this.draw(doc, assets);
      use(this.canvas);
    });
  }
  async pixels() {
    await this.idle;
    if (!this.final) throw new Error("No rendered document");
    return this.backend.read(this.final);
  }
  async rawPixels(): Promise<Uint8Array | Float32Array> {
    await this.idle;
    if (!this.final) throw new Error("No rendered document");
    return this.final.format === "rgba32float"
      ? this.backend.readFloat(this.final)
      : this.backend.read(this.final);
  }
  async displayPixels() {
    await this.idle;
    if (!this.final) throw new Error("No rendered document");
    if (!this.toSrgb && this.final.format === "rgba8unorm")
      return this.backend.read(this.final);
    const target = (this.displayTarget ??= this.backend.texture(
      this.final.width,
      this.final.height,
    ));
    if (this.toSrgb) this.backend.colorPass(this.final, this.toSrgb, target);
    else {
      const u = new Float32Array(32);
      u[31] = 1;
      this.backend.pass(this.white, this.final, this.white, u, target);
    }
    return this.backend.read(target);
  }
  // Interchange can retain unmodified raster sources, including off-canvas pixels
  // and straight RGB at zero alpha, without recompositing them onto transparency.
  async sourcePixels(l: Layer, assets: Assets) {
    await this.idle;
    if (l.kind === "vector") return this.vectorPixels(l, assets, false);
    const source = await this.source(l, assets);
    if (source.format === "rgba8unorm")
      return {
        width: source.width,
        height: source.height,
        data: await this.backend.read(source),
      };
    // This explicitly byte-valued API is used only by the current 8-bit writer.
    // High-depth interchange uses rawSourcePixels and retains typed samples.
    const target = this.backend.texture(source.width, source.height);
    try {
      const u = new Float32Array(32);
      u[31] = 1;
      this.backend.pass(this.white, source, this.white, u, target);
      return {
        width: source.width,
        height: source.height,
        data: await this.backend.read(target),
      };
    } finally {
      this.backend.destroy(target);
    }
  }
  async rawSourcePixels(l: Layer, assets: Assets) {
    await this.idle;
    if (l.kind === "vector") return this.vectorPixels(l, assets, this.floating);
    const source = await this.source(l, assets);
    return {
      width: source.width,
      height: source.height,
      data:
        source.format === "rgba32float"
          ? await this.backend.readFloat(source)
          : await this.backend.read(source),
    };
  }
  private async vectorPixels<T extends boolean>(
    l: Layer,
    assets: Assets,
    floating: T,
  ) {
    if (!this.document)
      throw new Error(
        "Render the vector document before requesting source pixels.",
      );
    const source = await this.vectorSource(l, this.document, assets);
    if (source.pixels) {
      const data = floating
        ? source.pixels.slice()
        : new Uint8Array(source.pixels.length);
      if (!floating)
        for (let i = 0; i < data.length; i++)
          data[i] = Math.round(
            Math.max(0, Math.min(1, source.pixels[i])) * 255,
          );
      return {
        width: source.texture.width,
        height: source.texture.height,
        data: data as T extends true ? Float32Array : Uint8Array,
        viewport: source.viewport,
      };
    }
    const coverage = source.coverage!;
    const rgb = source.constantRgb ?? vectorDocumentRgb(l, this.document);
    const data = floating
      ? new Float32Array(coverage.length * 4)
      : new Uint8Array(coverage.length * 4);
    for (let i = 0; i < coverage.length; i++) {
      for (let c = 0; c < 3; c++)
        data[i * 4 + c] = floating
          ? rgb[c]
          : Math.round(Math.max(0, Math.min(1, rgb[c])) * 255);
      data[i * 4 + 3] = floating ? coverage[i] : Math.round(coverage[i] * 255);
    }
    return {
      width: source.texture.width,
      height: source.texture.height,
      data: data as T extends true ? Float32Array : Uint8Array,
      viewport: source.viewport,
    };
  }
  dispose() {
    this.disposed = true;
    this.styles.dispose();
    this.spatial?.dispose();
    for (const s of this.sources.values()) this.destroySource(s);
    for (const t of this.targets) this.backend.destroy(t);
    this.backend.destroy(this.white);
    for (const texture of [this.fromSrgb, this.toSrgb, this.displayTarget, this.displayLutTarget, this.displayLut?.texture])
      if (texture) this.backend.destroy(texture);
    this.backend.dispose();
  }
}
