import type { Layer, PhotoDocument } from '../model/document';
import type { Assets } from '../model/assets';
import { allLayers, blends, defaultFilters } from '../model/document';
import { hasMask } from '../model/masks';
import { gridDocBounds, readMask, readRGBA, type TileGrid } from '../model/tiles';
import { pixelTransformKind } from '../model/pixel-layer';
import { documentPatternPixels, stylePatternIds } from '../model/fill-layer';
import type { IRect, RGBA8 } from '../imaging/types';
import type { LayerStyle } from '../imaging/effects/types';
import type { LayerStyleResult } from '../imaging/effects/render';
import { styleBoundsExpansion } from '../imaging/effects/bounds';
import type { BlendMode } from '../imaging/blend/modes';
import { activeLayerStyle, sanitizeStyle } from '../model/layer-style';
export { activeLayerStyle };
import type { Pattern } from '../imaging/pattern/pattern';
import { UNIFORM_FLOATS, type Backend, type Texture } from './backend';
import { blendingUniforms, maskHidesEffects } from '../model/blending';

// Layer styles in the compositor. A styled layer's document-space pixels are
// read (from tiles for plain pixel layers, otherwise by rendering the layer
// alone and reading it back), the effects are rendered off the main thread
// by a registered renderer (see features/effects), and the resulting below /
// layer / above images are uploaded and composited in place of the layer.
// Results are cached per layer by content and style; a move only changes
// the layer's anchor, so the cached images are translated, not recomputed.
export type StyleJob = {
  input: RGBA8;
  origin: { x: number; y: number };
  documentSize: { width: number; height: number };
  style: LayerStyle;
  fillOpacity: number;
  interiorAsGroup?: boolean;
  // Document-defined patterns the style refers to (presets resolve in the worker).
  patterns: Pattern[];
};
export type StyleRenderFn = (job: StyleJob) => Promise<LayerStyleResult>;
let styleRenderer: StyleRenderFn | undefined;
export function registerStyleRenderer(fn: StyleRenderFn | undefined) {
  styleRenderer = fn;
}

// Whether the style samples document-anchored content (non-aligned
// gradients, unlinked patterns), which a translation would misplace.
function documentAnchored(s: LayerStyle) {
  return !!s.gradientOverlay?.some((g) => g.enabled && g.alignWithLayer === false) ||
    (!!s.patternOverlay?.enabled && !s.patternOverlay.linkWithLayer) ||
    (!!s.bevel?.enabled && !!s.bevel.texture && !s.bevel.texture.linkWithLayer) ||
    !!s.stroke?.some((st) => st.enabled && ((st.fill.type === 'pattern' && !st.fill.linkWithLayer) || (st.fill.type === 'gradient' && st.fill.alignWithLayer === false)));
}

type Pass = { texture: Texture; mode: BlendMode };
type Result = {
  contentKey: string;
  styleKey: string;
  anchor: { x: number; y: number };
  pinned: boolean;
  bounds: IRect;
  below: Pass[];
  layer: Texture | null;
  above: Pass[];
};
type Entry = { result?: Result; inflight?: Promise<void>; scheduled?: object; seen: number };
export type StyleContext = {
  backend: Backend;
  white: Texture;
  floating: boolean;
  boundedRgb: boolean;
  // Wait for effects (exports, readbacks) or draw what is ready (interactive).
  progressive: boolean;
  target: (w: number, h: number) => Texture;
  mark: () => number;
  reset: (mark: number) => void;
  // Draw a layer without its style (into the given back/next pair).
  drawPlain: (l: Layer, back: Texture, next: Texture, clipped: boolean) => Promise<[Texture, Texture]>;
  // Draw a document-sized `source` over `back` through the layer's masks
  // with the given opacity (into `next`).
  maskedPass: (l: Layer, back: Texture, source: Texture, next: Texture, opacity: number, clipped: boolean) => Promise<void>;
  redraw: () => void;
  // Run a task once the frame being drawn is done, with the compositor to itself.
  afterFrame: <T>(task: () => Promise<T>) => Promise<T>;
};

function tileState(grid: TileGrid | undefined, assets: Assets) {
  if (!grid) return '';
  const store = assets.tiles;
  let s = `${grid.fill ?? 0}|`;
  for (const [k, id] of Object.entries(grid.tiles)) s += `${k}=${id}:${store.version(id)};`;
  return s;
}
const presentation = new Set(['style', 'opacity', 'blend', 'visible', 'name', 'fillOpacity', 'locked', 'protection', 'colorLabel', 'psdId', 'clipped', 'transparencyProtected']);

export class StyleCache {
  private entries = new Map<string, Entry>();
  private frame = 0;
  constructor(private backend: Backend) {}
  // Content identity independent of position; `pin` forces the position in.
  private contentKey(l: Layer, assets: Assets, fast: boolean, pin: boolean) {
    const t = l.transform;
    if (fast) {
      const g = l.pixels!;
      return JSON.stringify(['px', tileState(g, assets), g.bounds, t.width, t.height, t.rotation,
        l.maskGrid ? [tileState(l.maskGrid, assets), l.maskGrid.x, l.maskGrid.y, l.maskInverted, l.maskDisabled, t.x, t.y] : 0, pin ? [t.x, t.y] : 0]);
    }
    const versions = allLayers([l]).map((x) => tileState(x.pixels, assets) + tileState(x.maskGrid, assets)).join('/');
    // Only the layer's own presentation and position are left out: children's
    // opacity or a vector stroke's opacity do change the pixels.
    const stripped = JSON.stringify(l, function (this: unknown, k, v) {
      if (this !== l) return v;
      if (presentation.has(k) && k !== 'clipped') return undefined;
      return k === 'transform' ? { ...v, x: 0, y: 0 } : v;
    });
    return JSON.stringify(['gen', stripped.length > 200000 ? stripped.length : stripped, versions, pin || hasMask(l) || !!l.maskGrid || l.kind === 'group' ? [t.x, t.y] : 0]);
  }
  /** Plain pixel layers are read straight from their tiles. */
  private fastPath(l: Layer) {
    return l.kind === 'pixel' && !!l.pixels?.bounds && !l.pixelMask && !l.mask && !l.maskAsset && !l.maskStrokes?.length &&
      !Object.values(l.filters).some(Boolean) && pixelTransformKind(l) !== 'resample';
  }
  prune(ids: Set<string>) {
    for (const [id, e] of this.entries)
      if (!ids.has(id) && !e.inflight) {
        this.release(e.result);
        this.entries.delete(id);
      }
  }
  private release(r?: Result) {
    if (!r) return;
    for (const t of [...r.below.map((p) => p.texture), r.layer, ...r.above.map((p) => p.texture)]) if (t) this.backend.destroy(t);
  }
  dispose() {
    for (const e of this.entries.values()) this.release(e.result);
    this.entries.clear();
  }
  async draw(ctx: StyleContext, l: Layer, rawStyle: LayerStyle, doc: PhotoDocument, assets: Assets, back: Texture, next: Texture, clipped: boolean): Promise<[Texture, Texture]> {
    if (!styleRenderer) return ctx.drawPlain({ ...l, style: undefined }, back, next, clipped);
    const fill = Math.max(0, Math.min(1, l.fillOpacity ?? 1));
    const style = sanitizeStyle(rawStyle);
    // The document's global light replaces each style's own.
    if (doc.globalLight) {
      style.globalAngle = doc.globalLight.angle;
      style.globalAltitude = doc.globalLight.altitude;
    }
    const interiorAsGroup = !!l.blending?.interiorAsGroup;
    // When the mask hides effects, they are rendered from the unmasked
    // content and the whole result is drawn through the mask.
    const hides = maskHidesEffects(l) && (hasMask(l) || !!l.maskGrid) && !l.maskDisabled;
    const source: Layer = hides ? { ...l, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskInverted: undefined } : l;
    const userPatterns = stylePatternIds(style)
      .map((id) => doc.patterns?.find((p) => p.id === id))
      .filter((p) => !!p)
      .map((p) => documentPatternPixels(p!, assets.tiles))
      .filter((p): p is Pattern => !!p);
    const styleKey = JSON.stringify([style, fill, interiorAsGroup, userPatterns.map((p) => p.id + ':' + p.tile.width + 'x' + p.tile.height + ':' + doc.patterns?.find((d) => d.id === p.id)?.grid.tiles)]);
    const fast = this.fastPath(source);
    const pin = documentAnchored(style);
    const contentKey = this.contentKey(source, assets, fast, pin) + (hides ? '|unmasked' : '');
    const anchor = { x: l.transform.x, y: l.transform.y };
    let entry = this.entries.get(l.id);
    if (!entry) this.entries.set(l.id, (entry = { seen: 0 }));
    entry.seen = ++this.frame;
    const matches = (r?: Result) =>
      !!r && r.contentKey === contentKey && r.styleKey === styleKey && (!r.pinned || (r.anchor.x === anchor.x && r.anchor.y === anchor.y));
    const start = async () => {
      const captured = fast ? this.readPixels(source, style, doc, assets) : await this.renderPixels(ctx, source, style, doc);
      if (!captured) return null;
      const job: StyleJob = { input: captured.input, origin: captured.origin, documentSize: { width: doc.width, height: doc.height }, style, fillOpacity: fill, interiorAsGroup, patterns: userPatterns };
      const e = entry!;
      const task = (async () => {
        try {
          const r = await styleRenderer!(job);
          const result = this.upload(r, captured.origin, { contentKey, styleKey, anchor, pinned: pin || captured.clipped });
          this.release(e.result);
          e.result = result;
        } finally {
          e.inflight = undefined;
          if (ctx.progressive) ctx.redraw();
        }
      })();
      e.inflight = task;
      // Wrapped so awaiting the capture does not await the job.
      return { task };
    };
    if (!matches(entry.result)) {
      if (ctx.progressive) {
        // Latest wins: a running job's completion triggers a redraw, which
        // starts the job for whatever the document looks like by then.
        if (fast) {
          if (!entry.inflight) (await start())?.task.catch((error: unknown) => console.error(error));
        } else if (!entry.inflight) {
          // A GPU readback in the middle of an interactive frame can wait for
          // that frame to be shown, which may not happen until the page
          // repaints for another reason: capture after the frame instead.
          const e = entry;
          const scheduled = e.scheduled = {};
          const deferred: Promise<void> = ctx.afterFrame(async () => {
            if (e.scheduled !== scheduled) return;
            e.scheduled = undefined;
            return start();
          }).then((started) => started?.task).catch((error: unknown) => {
            console.error(error);
          }).finally(() => {
            if (e.inflight === deferred) e.inflight = undefined;
          });
          e.inflight = deferred;
        }
      } else {
        // This readback owns the compositor. A capture still queued behind it
        // cannot run until we finish, so supersede that capture and render here.
        if (entry.scheduled) {
          entry.scheduled = undefined;
          entry.inflight = undefined;
        }
        for (let attempt = 0; attempt < 3 && !matches(entry.result); attempt++) {
          if (entry.inflight) await entry.inflight.catch(() => {});
          else {
            const started = await start();
            if (!started) break;
            await started.task.catch((error: unknown) => console.error(error));
          }
        }
      }
    }
    const r = entry.result;
    if (!r) return ctx.drawPlain({ ...l, style: undefined }, back, next, clipped);
    const dx = anchor.x - r.anchor.x, dy = anchor.y - r.anchor.y;
    const contentCurrent = r.contentKey === contentKey && (!r.pinned || (dx === 0 && dy === 0));
    const composite = async (b: Texture, n: Texture, groupClipped: boolean): Promise<[Texture, Texture]> => {
      for (const p of r.below) [b, n] = this.place(ctx, l, doc, p.texture, r.bounds, dx, dy, p.mode, 1, groupClipped, b, n);
      if (contentCurrent && r.layer) [b, n] = this.place(ctx, l, doc, r.layer, r.bounds, dx, dy, l.blend === 'pass through' ? 'normal' : l.blend, 1, groupClipped, b, n);
      // While new effects render, show the live layer between the previous ones.
      else if (!contentCurrent) [b, n] = await ctx.drawPlain({ ...source, style: undefined, opacity: 1, blend: l.blend === 'pass through' ? 'normal' : l.blend }, b, n, groupClipped);
      for (const p of r.above) [b, n] = this.place(ctx, l, doc, p.texture, r.bounds, dx, dy, p.mode, 1, groupClipped, b, n);
      return [b, n];
    };
    if (l.opacity >= 1 && !hides) return composite(back, next, clipped);
    // Layer opacity (and a mask that hides effects) applies to layer and
    // effects together: composite onto a copy of the backdrop, then mix that
    // copy over the backdrop.
    const mark = ctx.mark();
    try {
      let copy = ctx.target(doc.width, doc.height);
      const copyU = new Float32Array(UNIFORM_FLOATS);
      copyU[31] = 1;
      ctx.backend.pass(ctx.white, back, ctx.white, copyU, copy);
      let scratch = ctx.target(doc.width, doc.height);
      [copy, scratch] = await composite(copy, scratch, clipped);
      if (hides) {
        await ctx.maskedPass(l, back, copy, next, l.opacity, clipped);
        return [next, back];
      }
      const u = layerUniforms({ x: 0, y: 0, width: doc.width, height: doc.height }, doc, doc.width, doc.height, l.opacity, 'normal');
      u[23] = ctx.boundedRgb ? 1 : 0;
      if (clipped) u[29] = 2;
      ctx.backend.pass(back, copy, ctx.white, u, next);
      return [next, back];
    } finally {
      ctx.reset(mark);
    }
  }
  private place(ctx: StyleContext, l: Layer, doc: PhotoDocument, texture: Texture, bounds: IRect, dx: number, dy: number, mode: string, opacity: number, clipped: boolean, back: Texture, next: Texture): [Texture, Texture] {
    const u = layerUniforms({ x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height }, doc, texture.width, texture.height, opacity, mode);
    u[23] = ctx.boundedRgb ? 1 : 0;
    if (clipped) u[29] = 2;
    // Blend If and excluded channels apply to the effects as well.
    blendingUniforms(l, u);
    ctx.backend.pass(back, texture, ctx.white, u, next);
    return [next, back];
  }
  private upload(r: LayerStyleResult, origin: { x: number; y: number }, keys: Omit<Result, 'bounds' | 'below' | 'layer' | 'above'>): Result {
    const tex = (img: RGBA8) => this.backend.texture(img.width, img.height, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    const bounds = { x: r.bounds.x + origin.x, y: r.bounds.y + origin.y, width: r.bounds.width, height: r.bounds.height };
    const ok = bounds.width > 0 && bounds.height > 0;
    const passes = r.passes ?? [];
    return {
      ...keys,
      bounds,
      below: ok ? passes.filter((p) => p.stage === 'below').map((p) => ({ texture: tex(p.image), mode: p.mode })) : [],
      layer: ok ? tex(r.layer) : null,
      above: ok ? passes.filter((p) => p.stage === 'above').map((p) => ({ texture: tex(p.image), mode: p.mode })) : [],
    };
  }
  // Region the effects can reach around `content` (document coordinates).
  private reach(style: LayerStyle, content: IRect) {
    const e = styleBoundsExpansion(style);
    return { x: content.x - e.left - 2, y: content.y - e.top - 2, width: content.width + e.left + e.right + 4, height: content.height + e.top + e.bottom + 4 };
  }
  private readPixels(l: Layer, style: LayerStyle, doc: PhotoDocument, assets: Assets) {
    const grid = l.pixels!, b = gridDocBounds(grid)!;
    // A pending move shows the content at the transform's position.
    const ox = l.transform.x - b.x, oy = l.transform.y - b.y;
    let r = this.reach(style, { x: b.x + ox, y: b.y + oy, width: b.width, height: b.height });
    // Content far outside the canvas is not needed (and is bounded in size).
    const e = styleBoundsExpansion(style);
    const limit = { x: -e.left - 2, y: -e.top - 2, width: doc.width + e.left + e.right + 4, height: doc.height + e.top + e.bottom + 4 };
    const x0 = Math.max(r.x, limit.x), y0 = Math.max(r.y, limit.y);
    const x1 = Math.min(r.x + r.width, limit.x + limit.width), y1 = Math.min(r.y + r.height, limit.y + limit.height);
    if (x1 <= x0 || y1 <= y0) return null;
    const clipped = x0 > r.x || y0 > r.y || x1 < r.x + r.width || y1 < r.y + r.height;
    r = { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1) - Math.floor(x0), height: Math.ceil(y1) - Math.floor(y0) };
    const input = readRGBA(assets.tiles, grid, { x: r.x - Math.round(ox), y: r.y - Math.round(oy), width: r.width, height: r.height });
    if (l.maskGrid && !l.maskDisabled) {
      const m = readMask(assets.tiles, l.maskGrid, r).data;
      for (let i = 0; i < m.length; i++) {
        const v = l.maskInverted ? 255 - m[i] : m[i];
        input.data[i * 4 + 3] = (input.data[i * 4 + 3] * v + 127) / 255;
      }
    }
    return { input, origin: { x: r.x, y: r.y }, clipped };
  }
  private async renderPixels(ctx: StyleContext, l: Layer, style: LayerStyle, doc: PhotoDocument) {
    const mark = ctx.mark();
    let samples: Uint8Array | Float32Array;
    try {
      let a = ctx.target(doc.width, doc.height);
      ctx.backend.clear(a);
      let b = ctx.target(doc.width, doc.height);
      const plain: Layer = { ...l, style: undefined, opacity: 1, blend: 'normal', fillOpacity: 1, clipped: false, blending: undefined };
      [a, b] = await ctx.drawPlain(plain, a, b, false);
      samples = a.format === 'rgba32float' ? await ctx.backend.readFloat(a) : await ctx.backend.read(a);
    } finally {
      ctx.reset(mark);
    }
    const w = doc.width, h = doc.height;
    const alphaAt = samples instanceof Float32Array ? (i: number) => samples[i * 4 + 3] > 0.5 / 255 : (i: number) => samples[i * 4 + 3] > 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (alphaAt(y * w + x)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
    if (x1 < 0) return null;
    const want = this.reach(style, { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
    const cx0 = Math.max(0, want.x), cy0 = Math.max(0, want.y);
    const cx1 = Math.min(w, want.x + want.width), cy1 = Math.min(h, want.y + want.height);
    const clipped = cx0 > want.x || cy0 > want.y || cx1 < want.x + want.width || cy1 < want.y + want.height;
    const cw = cx1 - cx0, ch = cy1 - cy0;
    const data = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const s = ((cy0 + y) * w + cx0) * 4;
      if (samples instanceof Float32Array) for (let i = 0; i < cw * 4; i++) data[y * cw * 4 + i] = Math.round(Math.max(0, Math.min(1, samples[s + i])) * 255);
      else data.set(samples.subarray(s, s + cw * 4), y * cw * 4);
    }
    return { input: { width: cw, height: ch, data }, origin: { x: cx0, y: cy0 }, clipped };
  }
}

/** Uniforms placing an image at a document rectangle with plain compositing. */
function layerUniforms(rect: IRect, doc: PhotoDocument, sourceWidth: number, sourceHeight: number, opacity: number, mode: string): Float32Array {
  const u = new Float32Array(UNIFORM_FLOATS);
  const f = defaultFilters();
  u.set([doc.width, doc.height, 0, 0, rect.x, rect.y, rect.width, rect.height, 1, 0, opacity, Math.max(0, blends.indexOf(blendName(mode))), f.brightness, f.contrast, f.saturation, f.blur]);
  u[24] = sourceWidth;
  u[25] = sourceHeight;
  return u;
}
// Effect passes use engine mode IDs ("color-burn"); layers use PSD names ("color burn").
const blendName = (mode: string) => mode.replace(/-/g, ' ') as Layer['blend'];
