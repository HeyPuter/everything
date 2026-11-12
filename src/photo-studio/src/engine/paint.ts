import type { IRect, Mask8 } from '../imaging/types';
import { blendColor, blendModeIndex, hash01, type BlendMode } from '../imaging/blend/modes';
import {
  TILE,
  computeBounds,
  tileBytes,
  tileKey,
  unionRect,
  type TileData,
  type TileGrid,
  type TileStore,
} from '../model/tiles';

// Brush dynamics: flow accumulates within one stroke, and opacity caps the stroke's coverage,
// so overlapping dabs of one stroke never exceed the chosen opacity.
export type BrushTip = {
  size: number;
  // 0 = fully soft, 1 = hard edge with one pixel of anti-aliasing.
  hardness: number;
  // Fraction of the diameter between dabs.
  spacing: number;
  // Ellipse minor/major ratio and rotation of the major axis, in degrees.
  roundness: number;
  angle: number;
  // Optional sampled tip; coverage is scaled to the dab size and rotated.
  sample?: Mask8;
  // Pencil: pixels inside the tip are painted fully and the rest not at all
  // (no anti-aliasing); the pixel under the center is always painted.
  aliased?: boolean;
};
export type BrushDynamics = {
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  pressureFlow?: boolean;
  // Fractions in [0, 1], applied per dab from a deterministic sequence.
  sizeJitter?: number;
  minimumDiameter?: number;
  angleJitter?: number;
  roundnessJitter?: number;
  scatter?: number;
  count?: number;
  opacityJitter?: number;
  flowJitter?: number;
};
// Painting uses every layer blend mode, plus Behind (paint only where the
// layer is transparent) and Clear (erase with the brush).
export type PaintMode = BlendMode | 'behind' | 'clear';
export type PaintTarget =
  | {
      kind: 'color';
      rgb: [number, number, number];
      mode: PaintMode;
      erase?: boolean;
      preserveAlpha?: boolean;
      // Per-pixel source color (clone stamp, pattern stamp, history brush).
      // Writes straight RGBA into `out` and returns false where there is no source.
      source?: (x: number, y: number, out: Uint8ClampedArray) => boolean;
    }
  | {
      // Per-pixel processing of existing pixels (dodge, burn, sponge, blur...).
      kind: 'process';
      process: (x: number, y: number, base: Uint8ClampedArray, out: Uint8ClampedArray) => void;
      preserveAlpha?: boolean;
    }
  // Layer masks, alpha channels and Quick Mask: paint a coverage value.
  | { kind: 'mask'; value: number }
  | {
      // Brushes that carry paint (mixer brush): each dab is announced with
      // its center and size, then every covered pixel receives the stroke's
      // current pixel and writes the new value. `alpha` is tip coverage times
      // selection and flow; the engine applies no opacity cap.
      kind: 'custom';
      // `read` gives pixels as the stroke has left them so far (neighbours
      // for tools whose effect builds up, such as Blur and Sharpen).
      dab?: (cx: number, cy: number, size: number, read: LiveReader) => void;
      pixel: (x: number, y: number, alpha: number, current: Uint8ClampedArray, out: Uint8ClampedArray) => void;
      preserveAlpha?: boolean;
    };
/** Writes the RGBA at (x, y) into `out`; false where there are no pixels. */
export type LiveReader = (x: number, y: number, out: Uint8ClampedArray) => boolean;
export type StrokeOptions = {
  tip: BrushTip;
  dynamics?: BrushDynamics;
  opacity: number;
  flow: number;
  target: PaintTarget;
  // Coverage limit from the active selection (document space).
  selection?: TileGrid | null;
  // Optional clip to a document-space rectangle (e.g. the canvas).
  clip?: IRect;
  // Pattern preview: dabs repeat with this period so strokes wrap across
  // the edges of a tile anchored at the document origin.
  wrap?: { width: number; height: number };
  seed?: number;
};
type Working = {
  id: string;
  base: TileData | null;
  work: TileData;
  cov: Float32Array;
};

export class StrokeSession {
  private working = new Map<string, Working>();
  private selectionTiles = new Map<string, TileData | number>();
  private last?: { x: number; y: number; pressure: number };
  private distance = 0;
  private random: () => number;
  private touched = new Set<string>();
  readonly channels: 1 | 4;
  private preview: TileGrid;
  private scratch = new Uint8ClampedArray(4);
  private scratch2 = new Uint8ClampedArray(4);
  private blendScratch = { b: [0, 0, 0], s: [0, 0, 0], out: [0, 0, 0] };
  private seed: number;
  dabs = 0;
  constructor(
    private store: TileStore,
    private original: TileGrid,
    private options: StrokeOptions,
  ) {
    this.channels = original.channels;
    if ((options.target.kind === 'mask') !== (this.channels === 1))
      throw new Error('The paint target does not match the tile format.');
    this.preview = { ...original, tiles: { ...original.tiles } };
    this.seed = options.seed ?? 1;
    let state = (options.seed ?? 1) >>> 0 || 1;
    this.random = () => {
      // xorshift32: cheap and deterministic for replayable jitter.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  }
  /** The live grid: untouched tiles shared, touched tiles replaced by working copies. */
  get grid() {
    return this.preview;
  }
  /** Add a pointer sample; dabs are placed along the segment at the tip spacing. */
  addPoint(x: number, y: number, pressure = 1): IRect | null {
    const { tip } = this.options;
    let dirty: IRect | null = null;
    if (!this.last) {
      dirty = this.dab(x, y, pressure);
      this.last = { x, y, pressure };
      return dirty;
    }
    const from = this.last;
    const dx = x - from.x,
      dy = y - from.y,
      length = Math.hypot(dx, dy);
    const step = () => Math.max(0.5, tip.spacing * this.sizeAt(this.last!.pressure));
    let travelled = 0;
    while (this.distance + (length - travelled) >= step()) {
      // With pressure dropping the spacing shrinks, so a dab can already be
      // due (even when the pen rests in place): place it at once, never
      // before the segment start.
      const need = Math.max(0, step() - this.distance);
      travelled += need;
      this.distance = 0;
      const t = length > 0 ? travelled / length : 1;
      const p = from.pressure + (pressure - from.pressure) * t;
      dirty = unionRect(dirty, this.dab(from.x + dx * t, from.y + dy * t, p));
      this.last = { x: from.x + dx * t, y: from.y + dy * t, pressure: p };
    }
    this.distance += length - travelled;
    this.last = { x, y, pressure };
    return dirty;
  }
  /** Airbrush build-up: another dab where the stroke rests, at its last pressure. */
  hold(): IRect | null {
    const l = this.last;
    return l ? this.dab(l.x, l.y, l.pressure) : null;
  }
  /** End the current segment so the next point starts a separate stroke
   * within the same session (one undo step for many strokes). */
  lift() {
    this.last = undefined;
    this.distance = 0;
  }
  private sizeAt(pressure: number) {
    const d = this.options.dynamics;
    return Math.max(0.5, this.options.tip.size * (d?.pressureSize ? Math.max(0.02, pressure) : 1));
  }
  private dab(cx: number, cy: number, pressure: number): IRect | null {
    const { tip, dynamics: d = {}, opacity } = this.options;
    let dirty: IRect | null = null;
    const count = Math.max(1, Math.round(d.count ?? 1));
    for (let n = 0; n < count; n++) {
      let size = this.sizeAt(pressure);
      if (d.sizeJitter) size *= Math.max(d.minimumDiameter ?? 0, 1 - d.sizeJitter * this.random());
      let x = cx,
        y = cy;
      if (d.scatter) {
        const a = this.random() * Math.PI * 2,
          r = this.random() * d.scatter * size;
        x += Math.cos(a) * r;
        y += Math.sin(a) * r;
      }
      const angle = tip.angle + (d.angleJitter ? (this.random() - 0.5) * 360 * d.angleJitter : 0);
      const roundness = Math.max(0.01, tip.roundness * (d.roundnessJitter ? 1 - d.roundnessJitter * this.random() : 1));
      let flow = this.options.flow * (d.pressureFlow ? pressure : 1);
      if (d.flowJitter) flow *= 1 - d.flowJitter * this.random();
      let cap = opacity * (d.pressureOpacity ? pressure : 1);
      if (d.opacityJitter) cap *= 1 - d.opacityJitter * this.random();
      dirty = unionRect(dirty, this.wrapped(x, y, size, angle, roundness, flow, cap));
    }
    this.dabs++;
    return dirty;
  }
  /** Stamp a dab, repeated across tile edges when wrapping is on. */
  private wrapped(x: number, y: number, size: number, angle: number, roundness: number, flow: number, cap: number): IRect | null {
    const wrap = this.options.wrap;
    if (!wrap) return this.stamp(x, y, size, angle, roundness, flow, cap);
    let dirty: IRect | null = null;
    for (const [sx, sy] of wrapPositions(x, y, size / 2 + 1, wrap.width, wrap.height))
      dirty = unionRect(dirty, this.stamp(sx, sy, size, angle, roundness, flow, cap));
    return dirty;
  }
  private selectionAt(tx: number, ty: number) {
    const sel = this.options.selection!;
    // Selection tiles align with document tiles only when the grid origin is 0.
    const key = tileKey(tx, ty);
    let entry = this.selectionTiles.get(key);
    if (entry === undefined) {
      const id = sel.tiles[key];
      entry = id ? this.store.get(id) : (sel.fill ?? 0);
      this.selectionTiles.set(key, entry);
    }
    return entry;
  }
  private workingTile(tx: number, ty: number): Working {
    const key = tileKey(tx, ty);
    let w = this.working.get(key);
    if (!w) {
      const old = this.original.tiles[key];
      const base = old ? this.store.get(old) : null;
      const work = base ? new Uint8ClampedArray(base) : new Uint8ClampedArray(tileBytes(this.channels));
      if (!base && this.channels === 1 && this.original.fill) work.fill(this.original.fill);
      w = { id: this.store.add(work), base, work, cov: new Float32Array(TILE * TILE) };
      this.working.set(key, w);
      this.preview.tiles[key] = w.id;
      // Live reads must see the new working copy.
      this.liveTx = NaN;
      // Grow the preview bounds to whole tiles so the renderer's texture covers new paint.
      const tileRect = { x: tx * TILE, y: ty * TILE, width: TILE, height: TILE };
      if (!this.original.fill) this.preview.bounds = unionRect(this.preview.bounds, tileRect);
    }
    return w;
  }
  private stamp(cx: number, cy: number, size: number, angle: number, roundness: number, flow: number, cap: number): IRect | null {
    const { tip, clip, selection, target } = this.options;
    const radius = size / 2;
    // Bounding box of the rotated ellipse (plus one pixel for anti-aliasing).
    const a = (angle * Math.PI) / 180,
      cos = Math.cos(a),
      sin = Math.sin(a);
    const rx = radius,
      ry = radius * roundness;
    const ex = Math.sqrt(rx * rx * cos * cos + ry * ry * sin * sin) + 1,
      ey = Math.sqrt(rx * rx * sin * sin + ry * ry * cos * cos) + 1;
    let x0 = Math.floor(cx - ex),
      y0 = Math.floor(cy - ey),
      x1 = Math.ceil(cx + ex),
      y1 = Math.ceil(cy + ey);
    if (clip) {
      x0 = Math.max(x0, clip.x);
      y0 = Math.max(y0, clip.y);
      x1 = Math.min(x1, clip.x + clip.width);
      y1 = Math.min(y1, clip.y + clip.height);
    }
    if (x1 <= x0 || y1 <= y0) return null;
    const gx = this.original.x,
      gy = this.original.y;
    const hard = Math.min(0.999, Math.max(0, tip.hardness));
    // Soft region width in pixels; hard tips keep a one-pixel anti-aliased rim.
    const inner = radius * hard,
      soft = Math.max(1, radius - inner);
    const sample = tip.sample;
    const c = this.channels;
    const px = this.scratch,
      src = this.scratch2;
    if (target.kind === 'custom') target.dab?.(cx, cy, size, this.readLive);
    for (let ty = Math.floor((y0 - gy) / TILE); ty <= Math.floor((y1 - 1 - gy) / TILE); ty++)
      for (let tx = Math.floor((x0 - gx) / TILE); tx <= Math.floor((x1 - 1 - gx) / TILE); tx++) {
        const w = this.workingTile(tx, ty);
        const ox = gx + tx * TILE,
          oy = gy + ty * TILE;
        const sx0 = Math.max(x0, ox),
          sx1 = Math.min(x1, ox + TILE),
          sy0 = Math.max(y0, oy),
          sy1 = Math.min(y1, oy + TILE);
        let changed = false;
        for (let y = sy0; y < sy1; y++) {
          const dy = y + 0.5 - cy;
          for (let x = sx0; x < sx1; x++) {
            const dx = x + 0.5 - cx;
            // Rotate into the tip frame.
            const u = dx * cos + dy * sin,
              v = (-dx * sin + dy * cos) / roundness;
            let alpha: number;
            if (tip.aliased && !sample) {
              if (u * u + v * v > radius * radius && (x !== Math.floor(cx) || y !== Math.floor(cy))) continue;
              alpha = 1;
            } else if (sample) {
              const sxp = Math.floor((u / size + 0.5) * sample.width),
                syp = Math.floor((v / size + 0.5) * sample.height);
              if (sxp < 0 || syp < 0 || sxp >= sample.width || syp >= sample.height) continue;
              alpha = sample.data[syp * sample.width + sxp] / 255;
            } else {
              const r = Math.sqrt(u * u + v * v);
              if (r >= radius + 0.5) continue;
              if (r <= inner - 0.5 || (hard > 0.99 && r <= radius - 0.5)) alpha = 1;
              else if (hard > 0.99) alpha = radius + 0.5 - r;
              else {
                const t = Math.min(1, Math.max(0, (r - inner) / soft));
                // Smooth falloff close to a Gaussian profile.
                alpha = (1 - t * t) * (1 - t * t);
              }
            }
            if (alpha <= 0) continue;
            if (selection) {
              const sel = this.selectionAt(Math.floor(x / TILE), Math.floor(y / TILE));
              const sv = typeof sel === 'number' ? sel : sel[(((y % TILE) + TILE) % TILE) * TILE + (((x % TILE) + TILE) % TILE)];
              if (!sv) continue;
              alpha *= sv / 255;
            }
            const li = (y - oy) * TILE + (x - ox);
            if (target.kind === 'custom') {
              const i = li * 4,
                work = w.work;
              px[0] = work[i]; px[1] = work[i + 1]; px[2] = work[i + 2]; px[3] = work[i + 3];
              target.pixel(x, y, alpha * flow, px, src);
              work[i] = src[0];
              work[i + 1] = src[1];
              work[i + 2] = src[2];
              if (!target.preserveAlpha) work[i + 3] = src[3];
              changed = true;
              continue;
            }
            const before = w.cov[li];
            const cov = before + alpha * flow * (1 - before);
            w.cov[li] = cov;
            const k = Math.min(1, cov) * cap;
            if (c === 1) {
              const b = w.base ? w.base[li] : (this.original.fill ?? 0);
              w.work[li] = b + ((target as { value: number }).value - b) * k;
              changed = true;
              continue;
            }
            const i = li * 4;
            const base = w.base;
            const br = base ? base[i] : 0,
              bg = base ? base[i + 1] : 0,
              bb = base ? base[i + 2] : 0,
              ba = base ? base[i + 3] : 0;
            if (target.kind === 'process') {
              px[0] = br; px[1] = bg; px[2] = bb; px[3] = ba;
              target.process(x, y, px, src);
              const na = target.preserveAlpha ? ba : ba + (src[3] - ba) * k;
              w.work[i] = br + (src[0] - br) * k;
              w.work[i + 1] = bg + (src[1] - bg) * k;
              w.work[i + 2] = bb + (src[2] - bb) * k;
              w.work[i + 3] = na;
              changed = true;
              continue;
            }
            const t = target as Extract<PaintTarget, { kind: 'color' }>;
            let sr = t.rgb[0],
              sg = t.rgb[1],
              sb = t.rgb[2],
              sa = 1;
            if (t.source) {
              if (!t.source(x, y, src)) continue;
              sr = src[0]; sg = src[1]; sb = src[2]; sa = src[3] / 255;
            }
            // Behind paints only transparent pixels and Clear removes alpha:
            // neither can change a layer whose transparency is locked.
            if (t.preserveAlpha && (t.mode === 'behind' || t.mode === 'clear')) continue;
            let a = k * sa;
            // Dissolve turns partial coverage into a stable per-pixel choice.
            if (t.mode === 'dissolve') a = hash01(x, y, this.seed) < a ? 1 : 0;
            if (!a) continue;
            if (t.erase || t.mode === 'clear') {
              w.work[i] = br; w.work[i + 1] = bg; w.work[i + 2] = bb;
              w.work[i + 3] = ba * (1 - a);
              changed = true;
              continue;
            }
            const ba1 = ba / 255;
            let mr = sr, mg = sg, mb = sb;
            if (t.mode !== 'normal' && t.mode !== 'behind' && t.mode !== 'dissolve' && ba) {
              blendInto(t.mode, br, bg, bb, sr, sg, sb, px, this.blendScratch);
              // The blended color applies where the backdrop exists.
              mr = sr + (px[0] - sr) * ba1;
              mg = sg + (px[1] - sg) * ba1;
              mb = sb + (px[2] - sb) * ba1;
            }
            if (t.preserveAlpha) {
              w.work[i] = br + (mr - br) * a;
              w.work[i + 1] = bg + (mg - bg) * a;
              w.work[i + 2] = bb + (mb - bb) * a;
              w.work[i + 3] = ba;
            } else if (t.mode === 'behind') {
              const oa = ba1 + a * (1 - ba1);
              if (oa > 0) {
                w.work[i] = (br * ba1 + sr * a * (1 - ba1)) / oa;
                w.work[i + 1] = (bg * ba1 + sg * a * (1 - ba1)) / oa;
                w.work[i + 2] = (bb * ba1 + sb * a * (1 - ba1)) / oa;
              }
              w.work[i + 3] = oa * 255;
            } else {
              const oa = a + ba1 * (1 - a);
              if (oa > 0) {
                w.work[i] = (mr * a + br * ba1 * (1 - a)) / oa;
                w.work[i + 1] = (mg * a + bg * ba1 * (1 - a)) / oa;
                w.work[i + 2] = (mb * a + bb * ba1 * (1 - a)) / oa;
              }
              w.work[i + 3] = oa * 255;
            }
            changed = true;
          }
        }
        if (changed) {
          this.store.touch(w.id);
          this.touched.add(tileKey(tx, ty));
        }
      }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  // The last tile `readLive` looked up (neighbouring reads mostly share it).
  private liveKey = '';
  private liveTile: Uint8ClampedArray | null = null;
  private liveTx = NaN;
  private liveTy = NaN;
  private readLive: LiveReader = (x, y, out) => {
    const lx = x - this.original.x,
      ly = y - this.original.y;
    const tx = Math.floor(lx / TILE),
      ty = Math.floor(ly / TILE);
    if (tx !== this.liveTx || ty !== this.liveTy) {
      this.liveTx = tx;
      this.liveTy = ty;
      this.liveKey = tileKey(tx, ty);
      const w = this.working.get(this.liveKey);
      const id = this.original.tiles[this.liveKey];
      this.liveTile = w ? w.work : id ? this.store.get(id) : null;
    }
    const d = this.liveTile;
    if (!d) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return false;
    }
    const i = ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4;
    out[0] = d[i];
    out[1] = d[i + 1];
    out[2] = d[i + 2];
    out[3] = d[i + 3];
    return true;
  };
  /** Finish the stroke: drop unchanged/empty working tiles and compute bounds. */
  commit(): TileGrid {
    const grid: TileGrid = { ...this.original, tiles: { ...this.original.tiles } };
    const fill = this.channels === 1 ? (this.original.fill ?? 0) : 0;
    for (const [key, w] of this.working) {
      if (!this.touched.has(key)) {
        this.store.delete(w.id);
        continue;
      }
      let empty = true;
      for (let i = 0; i < w.work.length; i++)
        if (w.work[i] !== fill && (this.channels === 1 || (i & 3) === 3)) {
          empty = false;
          break;
        }
      if (empty) {
        this.store.delete(w.id);
        delete grid.tiles[key];
      } else grid.tiles[key] = w.id;
    }
    grid.bounds = computeBounds(this.store, grid);
    this.working.clear();
    return grid;
  }
  cancel() {
    for (const w of this.working.values()) this.store.delete(w.id);
    this.working.clear();
  }
}

// Blend formulas come from the layer blend reference (imaging/blend), so
// brush modes match layer modes exactly. Channels are 0..255 here.
function blendInto(
  mode: Exclude<PaintMode, 'behind' | 'clear'>,
  br: number,
  bg: number,
  bb: number,
  sr: number,
  sg: number,
  sb: number,
  out: Uint8ClampedArray,
  scratch: { b: number[]; s: number[]; out: number[] },
) {
  const { b, s, out: o } = scratch;
  b[0] = br / 255; b[1] = bg / 255; b[2] = bb / 255;
  s[0] = sr / 255; s[1] = sg / 255; s[2] = sb / 255;
  blendColor(blendModeIndex(mode), b, s, o);
  out[0] = o[0] * 255;
  out[1] = o[1] * 255;
  out[2] = o[2] * 255;
}
/** Positions where a dab of radius `r` at (x, y) touches a width×height tile,
 * repeating the tile in every direction. */
export function wrapPositions(x: number, y: number, r: number, width: number, height: number): [number, number][] {
  const bx = ((x % width) + width) % width,
    by = ((y % height) + height) % height;
  const out: [number, number][] = [];
  for (let ky = -1; ky <= 1; ky++)
    for (let kx = -1; kx <= 1; kx++) {
      const px = bx + kx * width,
        py = by + ky * height;
      if (px + r <= 0 || px - r >= width || py + r <= 0 || py - r >= height) continue;
      out.push([px, py]);
    }
  return out;
}
