// Path tracer settings beyond the basic sample counts (`scene.render.cycles`, named like the
// scripting API's `scene.cycles`), their defaults, and pure helpers the renderer uses:
// adaptive sampling masks, integrator uniforms and denoiser options.
import type { RenderSettings } from '../../data/types';

export type DenoisePasses = 'RGB' | 'RGB_ALBEDO' | 'RGB_ALBEDO_NORMAL';
export type DenoisePrefilter = 'NONE' | 'FAST' | 'ACCURATE';
export type DenoiseQuality = 'HIGH' | 'BALANCED' | 'FAST';

export interface PathTraceSettings {
  // --- sampling
  use_adaptive_sampling: boolean;
  /** noise level at which a pixel stops sampling */
  adaptive_threshold: number;
  /** samples before pixels may stop (0 = automatic) */
  adaptive_min_samples: number;
  use_preview_adaptive_sampling: boolean;
  preview_adaptive_threshold: number;
  preview_adaptive_min_samples: number;
  denoising_input_passes: DenoisePasses;
  denoising_prefilter: DenoisePrefilter;
  denoising_quality: DenoiseQuality;
  preview_denoising_input_passes: DenoisePasses;
  preview_denoising_prefilter: DenoisePrefilter;
  preview_denoising_quality: DenoiseQuality;
  /** viewport: first sample that is denoised */
  preview_denoising_start_sample: number;
  seed: number;
  use_animated_seed: boolean;
  /** bounces before paths may be terminated at random (0 = automatic) */
  min_light_bounces: number;
  min_transparent_bounces: number;
  // --- light paths
  volume_bounces: number;
  transparent_max_bounces: number;
  caustics_reflective: boolean;
  caustics_refractive: boolean;
  use_fast_gi: boolean;
  fast_gi_method: 'REPLACE' | 'ADD';
  ao_bounces: number;
  ao_bounces_render: number;
  /** strength of the approximated light (world ▸ AO factor) */
  ao_factor: number;
  /** rays travelling further than this see the world (world ▸ AO distance) */
  ao_distance: number;
  // --- film
  film_transparent_glass: boolean;
  film_transparent_roughness: number;
  // --- motion blur
  rolling_shutter_type: 'NONE' | 'TOP';
  rolling_shutter_duration: number;
  // --- simplify ▸ culling
  use_camera_cull: boolean;
  camera_cull_margin: number;
  use_distance_cull: boolean;
  distance_cull_margin: number;
  // --- performance
  use_persistent_data: boolean;
}

export function defaultPathTraceSettings(): PathTraceSettings {
  return {
    use_adaptive_sampling: true,
    adaptive_threshold: 0.01,
    adaptive_min_samples: 0,
    use_preview_adaptive_sampling: true,
    preview_adaptive_threshold: 0.1,
    preview_adaptive_min_samples: 0,
    denoising_input_passes: 'RGB_ALBEDO_NORMAL',
    denoising_prefilter: 'ACCURATE',
    denoising_quality: 'HIGH',
    preview_denoising_input_passes: 'RGB_ALBEDO',
    preview_denoising_prefilter: 'FAST',
    preview_denoising_quality: 'BALANCED',
    preview_denoising_start_sample: 1,
    seed: 0,
    use_animated_seed: false,
    min_light_bounces: 0,
    min_transparent_bounces: 0,
    volume_bounces: 0,
    transparent_max_bounces: 8,
    caustics_reflective: true,
    caustics_refractive: true,
    use_fast_gi: false,
    fast_gi_method: 'REPLACE',
    ao_bounces: 1,
    ao_bounces_render: 1,
    ao_factor: 1,
    ao_distance: 10,
    film_transparent_glass: false,
    film_transparent_roughness: 0.1,
    rolling_shutter_type: 'NONE',
    rolling_shutter_duration: 0.1,
    use_camera_cull: false,
    camera_cull_margin: 0.1,
    use_distance_cull: false,
    distance_cull_margin: 50,
    use_persistent_data: false,
  };
}

/** The scene's path tracer settings with every field present. */
export function ptSettings(r: RenderSettings): PathTraceSettings {
  const d = defaultPathTraceSettings();
  const c = (r.cycles ??= d) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(d)) if (c[k] === undefined) c[k] = v;
  return r.cycles!;
}

// ---------------------------------------------------------------------------
// adaptive sampling

/** Samples before the first convergence test (`min` 0 = automatic, from the threshold). */
export function adaptiveMinSamples(threshold: number, min: number): number {
  if (min > 0) return Math.max(2, Math.round(min));
  // noisier targets need fewer samples before a meaningful estimate
  return Math.max(16, Math.min(256, Math.round(2 / Math.sqrt(Math.max(threshold, 1e-4)))));
}

/** Sample counts at which pixels are tested: the minimum, then each doubling. */
export function adaptiveCheckpoints(min: number, max: number): number[] {
  const out: number[] = [];
  for (let n = min; n < max; n *= 2) out.push(n);
  return out;
}

/**
 * Per-pixel noise of the running average `cur` (RGBA, n samples) estimated from its difference
 * to the average `half` at n/2 samples (the difference has the variance of `cur`), relative to
 * the square root of the brightness so that the threshold is perceptual.
 */
export function pixelError(cur: Float32Array, half: Float32Array, i: number): number {
  const r = cur[i],
    g = cur[i + 1],
    b = cur[i + 2];
  const d = Math.abs(r - half[i]) + Math.abs(g - half[i + 1]) + Math.abs(b - half[i + 2]) + Math.abs(cur[i + 3] - half[i + 3]) * 0.25;
  // the difference of two averages underestimates rare bright samples: be conservative
  return (2 * d) / (1e-4 + Math.sqrt(Math.max(0, r + g + b)));
}

/**
 * Update the convergence mask (1 = stop sampling) from two running averages of a w×h image.
 * A pixel converges when the largest error in its 5×5 neighbourhood is below the threshold, so
 * that the active region keeps a margin around noisy areas. Converged pixels stay converged.
 * Returns the number of pixels that are still active.
 */
export function updateAdaptiveMask(mask: Uint8Array, cur: Float32Array, half: Float32Array, w: number, h: number, threshold: number): number {
  const err = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) err[p] = pixelError(cur, half, i);
  let active = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mask[p]) continue;
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const e = err[yy * w + xx];
          if (e > m) m = e;
        }
      }
      if (m < threshold) mask[p] = 255;
      else active++;
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// integrator

export interface IntegratorValues {
  /** max bounces of each kind: diffuse, glossy, transmission, volume */
  bounces: [number, number, number, number];
  /** caustics allowed: reflective, refractive */
  caustics: [boolean, boolean];
  /** fast GI: on, bounces before approximating, distance, factor; mode 1 = add */
  fastGi: [number, number, number, number];
  fastGiAdd: boolean;
  /** transparent glass: on, roughness threshold */
  glass: [boolean, number];
  /** bounces before russian roulette */
  minBounces: number;
  /** total surface bounces and transparent/transmissive traversals */
  total: number;
  transmissive: number;
}

export function integratorValues(r: RenderSettings, viewport: boolean): IntegratorValues {
  const c = ptSettings(r);
  const total = Math.max(0, Math.round(r.max_bounces));
  const lim = (v: number | undefined) => Math.max(0, Math.min(total, Math.round(v ?? total)));
  const trans = lim(r.transmission_bounces);
  return {
    bounces: [lim(r.diffuse_bounces), lim(r.glossy_bounces), trans, lim(c.volume_bounces)],
    caustics: [c.caustics_reflective, c.caustics_refractive],
    fastGi: [c.use_fast_gi ? 1 : 0, Math.max(0, Math.round(viewport ? c.ao_bounces : c.ao_bounces_render)), Math.max(0, c.ao_distance), Math.max(0, c.ao_factor)],
    fastGiAdd: c.fast_gi_method === 'ADD',
    glass: [r.film_transparent && c.film_transparent_glass, Math.max(0, c.film_transparent_roughness)],
    minBounces: c.min_light_bounces > 0 ? Math.round(c.min_light_bounces) : 3,
    total: Math.max(1, total),
    transmissive: Math.max(trans, Math.min(total + 64, Math.max(0, Math.round(c.transparent_max_bounces)))),
  };
}

/** Seed of the noise pattern for a frame. */
export function noiseSeed(r: RenderSettings, frame: number): number {
  const c = ptSettings(r);
  return Math.max(0, Math.round(c.seed)) + (c.use_animated_seed ? Math.round(frame) * 1009 : 0);
}

// ---------------------------------------------------------------------------
// denoiser

export interface DenoiseOptions {
  /** use the albedo buffer to keep texture detail */
  albedo: boolean;
  /** use normals / depth as edge stops */
  normal: boolean;
  prefilter: DenoisePrefilter;
  /** iteration offset: +1 high quality, -1 fast */
  quality: number;
}

export function denoiseOptions(r: RenderSettings, viewport: boolean): DenoiseOptions {
  const c = ptSettings(r);
  const passes = viewport ? c.preview_denoising_input_passes : c.denoising_input_passes;
  const q = viewport ? c.preview_denoising_quality : c.denoising_quality;
  return {
    albedo: passes !== 'RGB',
    normal: passes === 'RGB_ALBEDO_NORMAL',
    prefilter: viewport ? c.preview_denoising_prefilter : c.denoising_prefilter,
    quality: q === 'HIGH' ? 1 : q === 'FAST' ? -1 : 0,
  };
}
