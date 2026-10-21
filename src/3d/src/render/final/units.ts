// Pure conversions between the document's settings and renderer units.
// Light units (calibrated on the default scene):
// point/spot radiant intensity I = P / 4π (W/sr), sun irradiance = strength (W/m²),
// area light radiance L = P / (π · A).
import type { LightData, RenderSettings, SceneData } from '../../data/types';

export function lightIntensity(la: Pick<LightData, 'type' | 'energy' | 'shape' | 'size' | 'size_y' | 'normalize'>): number {
  switch (la.type) {
    case 'SUN':
      return la.energy;
    case 'AREA':
      // without normalisation the power is given per square metre of the light
      return la.energy / (Math.PI * (la.normalize === false ? 1 : Math.max(1e-6, areaLightArea(la))));
    default:
      return la.energy / (4 * Math.PI);
  }
}

export function areaLightSize(la: Pick<LightData, 'shape' | 'size' | 'size_y'>): [number, number] {
  const rect = la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE';
  return [Math.max(1e-4, la.size), Math.max(1e-4, rect ? la.size_y : la.size)];
}

export function areaLightArea(la: Pick<LightData, 'shape' | 'size' | 'size_y'>): number {
  const [w, h] = areaLightSize(la);
  const round = la.shape === 'DISK' || la.shape === 'ELLIPSE';
  return w * h * (round ? Math.PI / 4 : 1);
}

/** Final render resolution in pixels (resolution × percentage). */
export function renderSize(r: Pick<RenderSettings, 'resolution_x' | 'resolution_y' | 'resolution_percentage'>): [number, number] {
  const p = Math.max(1, r.resolution_percentage) / 100;
  return [Math.max(1, Math.round(r.resolution_x * p)), Math.max(1, Math.round(r.resolution_y * p))];
}

/** Frames rendered by an animation render. */
export function frameList(s: Pick<SceneData, 'frame_start' | 'frame_end' | 'frame_step'>): number[] {
  const out: number[] = [];
  const step = Math.max(1, Math.round(s.frame_step || 1));
  for (let f = s.frame_start; f <= s.frame_end; f += step) out.push(f);
  return out;
}

/** Halton low-discrepancy sequence (sub-pixel jitter for temporal anti-aliasing). */
export function halton(index: number, base: number): number {
  let f = 1,
    r = 0,
    i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Sub-pixel jitter (in pixels, centred on 0) of TAA sample `i`. Sample 0 is unjittered. */
export function jitter(i: number): [number, number] {
  if (i === 0) return [0, 0];
  return [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5];
}

/**
 * Time offset (in frames) of motion-blur sample `i` of `n`, distributed over the shutter
 * interval centred on the frame.
 */
export function shutterOffset(i: number, n: number, shutter: number, position: 'START' | 'CENTER' | 'END' = 'CENTER', curve?: ArrayLike<number> | null): number {
  if (n <= 1 || shutter <= 0) return 0;
  const u = (i + 0.5) / n;
  const t = curve ? shutterTime(u, curve) : u;
  return (position === 'START' ? t : position === 'END' ? t - 1 : t - 0.5) * shutter;
}

/**
 * Time (0..1 across the shutter interval) of the sample at fraction `u` when the shutter opens and
 * closes following `curve` (openness sampled evenly over the interval): samples are placed by the
 * inverse of the openness' running total, so they are denser where the shutter is wide open.
 */
export function shutterTime(u: number, curve: ArrayLike<number>): number {
  const n = curve.length;
  if (n < 2) return u;
  // running total of the openness (trapezoids)
  const cdf = new Float64Array(n);
  for (let i = 1; i < n; i++) cdf[i] = cdf[i - 1] + Math.max(0, (curve[i - 1] + curve[i]) / 2);
  const total = cdf[n - 1];
  if (!(total > 0)) return u;
  const target = Math.min(1, Math.max(0, u)) * total;
  let i = 1;
  while (i < n - 1 && cdf[i] < target) i++;
  const a = cdf[i - 1],
    b = cdf[i];
  const f = b > a ? (target - a) / (b - a) : 0;
  return (i - 1 + f) / (n - 1);
}

/** Shapes of the shutter curve presets (openness over the shutter interval). */
export type ShutterShape = 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINE' | 'MAX';

/** Control points of a shutter curve preset: opens over the first half and closes over the second. */
export function shutterCurvePoints(shape: ShutterShape): [number, number][] {
  if (shape === 'MAX') return [[0, 1], [1, 1]];
  const f = (x: number) => {
    switch (shape) {
      case 'SMOOTH':
        return x * x * (3 - 2 * x);
      case 'SPHERE':
        return Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
      case 'ROOT':
        return Math.sqrt(x);
      case 'SHARP':
        return x * x;
      default:
        return x;
    }
  };
  const out: [number, number][] = [];
  const steps = shape === 'LINE' ? 1 : 4;
  for (let k = 0; k <= steps; k++) out.push([(0.5 * k) / steps, f(k / steps)]);
  for (let k = steps - 1; k >= 0; k--) out.push([1 - (0.5 * k) / steps, f(k / steps)]);
  return out.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}

/** Mist factor (0 near → 1 far) with the default quadratic falloff. */
export function mistFactor(dist: number, start: number, depth: number, falloff: 'QUADRATIC' | 'LINEAR' | 'INVERSE_QUADRATIC' = 'QUADRATIC'): number {
  if (depth <= 0) return dist >= start ? 1 : 0;
  const x = Math.min(1, Math.max(0, (dist - start) / depth));
  return falloff === 'LINEAR' ? x : falloff === 'INVERSE_QUADRATIC' ? Math.sqrt(x) : x * x;
}

/** Light-path settings → path tracer bounces. */
export function bounceSettings(r: Pick<RenderSettings, 'max_bounces' | 'diffuse_bounces' | 'glossy_bounces' | 'transmission_bounces'>) {
  const total = Math.max(0, r.max_bounces);
  const surface = Math.max(r.diffuse_bounces ?? total, r.glossy_bounces ?? total);
  return { bounces: Math.max(1, Math.min(total, surface)), transmissive: Math.max(0, Math.min(total, r.transmission_bounces ?? total)) };
}

/** Format seconds for the status text (MM:SS.cc). */
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Output file name for a frame, following the output path's file prefix. */
export function frameFileName(filepath: string, frame: number, ext: string, useExtension = true): string {
  const seg = filepath.replace(/\\/g, '/').split('/').pop() ?? '';
  const hashes = seg.match(/#+/);
  const suffix = useExtension ? `.${ext}` : '';
  if (hashes) return seg.replace(/#+/, String(frame).padStart(hashes[0].length, '0')) + suffix;
  return `${seg}${String(frame).padStart(4, '0')}${suffix}`;
}

/** Transparent film: the Film ▸ Transparent setting or the view layer's Environment filter. */
export function filmTransparent(r: { film_transparent: boolean; use_sky?: boolean }) {
  return r.film_transparent || r.use_sky === false;
}

/** Path tracer tiling: tiles of about `tile_size` pixels (one tile when tiling is off). */
export function tileCount(r: { use_auto_tile?: boolean; tile_size?: number }, W: number, H: number): [number, number] {
  if (r.use_auto_tile === false) return [1, 1];
  const t = Math.max(8, r.tile_size ?? 640);
  return [Math.max(1, Math.ceil(W / t)), Math.max(1, Math.ceil(H / t))];
}

/** Place a region buffer (`ch` channels) at `rect` into a transparent W×H frame. */
export function expandRegion(buf: Float32Array, ch: number, rect: { x: number; y: number; w: number; h: number }, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H * ch);
  for (let y = 0; y < rect.h; y++) out.set(buf.subarray(y * rect.w * ch, (y + 1) * rect.w * ch), ((rect.y + y) * W + rect.x) * ch);
  return out;
}

const FPS_PRESETS = [23.98, 24, 25, 29.97, 30, 50, 59.94, 60, 120, 240];
export { FPS_PRESETS };

/** Frame rate menu value of the settings ('custom' when not a preset). */
export function fpsPreset(r: { fps: number; fps_base: number }): string {
  const f = r.fps / (r.fps_base || 1);
  const p = FPS_PRESETS.find((x) => Math.abs(x - f) < 0.005);
  return p !== undefined ? String(p) : 'custom';
}

/** fps / fps_base for a preset rate (NTSC rates use a base of 1.001). */
export function fpsFromPreset(rate: number): { fps: number; fps_base: number } {
  if (Number.isInteger(rate)) return { fps: rate, fps_base: 1 };
  const fps = Math.round(rate);
  return { fps, fps_base: Math.abs(fps / rate - 1.001) < 1e-4 ? 1.001 : fps / rate };
}

/**
 * Normalised render region (bottom-up, like the scene setting) of an image-pixel rectangle
 * (top-down) of a W×H result. A cropped result maps into the region it was rendered with.
 */
export function regionFromImageRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  W: number,
  H: number,
  r: { use_border?: boolean; use_crop_to_border?: boolean; border_min_x?: number; border_min_y?: number; border_max_x?: number; border_max_y?: number },
  frame: [number, number],
) {
  const cl = (v: number) => Math.max(0, Math.min(1, v));
  let fx0 = Math.min(x0, x1) / W,
    fx1 = Math.max(x0, x1) / W;
  let fy0 = 1 - Math.max(y0, y1) / H,
    fy1 = 1 - Math.min(y0, y1) / H;
  if (r.use_border && r.use_crop_to_border && (W !== frame[0] || H !== frame[1])) {
    const bx = r.border_min_x ?? 0,
      by = r.border_min_y ?? 0,
      bw = (r.border_max_x ?? 1) - bx,
      bh = (r.border_max_y ?? 1) - by;
    fx0 = bx + fx0 * bw;
    fx1 = bx + fx1 * bw;
    fy0 = by + fy0 * bh;
    fy1 = by + fy1 * bh;
  }
  return { min_x: cl(fx0), max_x: cl(fx1), min_y: cl(fy0), max_y: cl(fy1) };
}
