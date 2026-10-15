// Pure conversions between the document's settings and renderer units.
// Light units (calibrated on the default scene):
// point/spot radiant intensity I = P / 4π (W/sr), sun irradiance = strength (W/m²),
// area light radiance L = P / (π · A).
import type { LightData, RenderSettings, SceneData } from '../../data/types';

export function lightIntensity(la: Pick<LightData, 'type' | 'energy' | 'shape' | 'size' | 'size_y'>): number {
  switch (la.type) {
    case 'SUN':
      return la.energy;
    case 'AREA':
      return la.energy / (Math.PI * Math.max(1e-6, areaLightArea(la)));
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
export function shutterOffset(i: number, n: number, shutter: number): number {
  if (n <= 1 || shutter <= 0) return 0;
  return ((i + 0.5) / n - 0.5) * shutter;
}

/** Mist factor (0 near → 1 far) with the default quadratic falloff. */
export function mistFactor(dist: number, start: number, depth: number): number {
  if (depth <= 0) return dist >= start ? 1 : 0;
  const x = Math.min(1, Math.max(0, (dist - start) / depth));
  return x * x;
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
export function frameFileName(filepath: string, frame: number, ext: string): string {
  const seg = filepath.replace(/\\/g, '/').split('/').pop() ?? '';
  const hashes = seg.match(/#+/);
  if (hashes) return seg.replace(/#+/, String(frame).padStart(hashes[0].length, '0')) + `.${ext}`;
  return `${seg}${String(frame).padStart(4, '0')}.${ext}`;
}
