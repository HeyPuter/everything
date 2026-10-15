// Resolved realtime-engine settings: every optional field with its default, plus the mapping of
// older documents (Ambient Occlusion toggle) onto the Fast GI options. Pure, unit tested.
import type { RenderSettings, LightData, WorldData } from '../../data/types';

export interface TraceSettings {
  /** screen-space reflections are traced */
  reflections: boolean;
  /** horizon scan (ambient occlusion and optional one-bounce indirect light) */
  fastGi: boolean;
  giBounce: boolean;
  /** divisor of the traced buffer resolution */
  resolution: number;
  maxRoughness: number;
  thickness: number;
  /** tracing steps along a reflection ray */
  steps: number;
  denoise: boolean;
  spatial: boolean;
  temporal: boolean;
  giRays: number;
  giSteps: number;
  /** 0 = unlimited */
  giDistance: number;
  giThickness: number;
  giBias: number;
  /** extra margin of the traced buffer (fraction of the frame size per side) */
  overscan: number;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Fast GI is on when it was enabled explicitly, or when an older document had Ambient Occlusion on. */
export function fastGiEnabled(r: RenderSettings): boolean {
  return r.use_fast_gi ?? !!r.use_gtao;
}

/** Ray tracing (Render ▸ Raytracing) is on; older documents with Ambient Occlusion keep it through Fast GI. */
export function raytracingEnabled(r: RenderSettings): boolean {
  return !!r.use_ssr || (r.use_fast_gi === undefined && !!r.use_gtao);
}

export function traceSettings(r: RenderSettings): TraceSettings {
  const on = raytracingEnabled(r);
  const legacyAo = r.use_fast_gi === undefined && !!r.use_gtao;
  const method = r.ray_tracing_method ?? (legacyAo && !r.use_ssr ? 'PROBE' : 'SCREEN');
  const fastGi = on && fastGiEnabled(r);
  const quality = clamp(num(r.screen_trace_quality, 0.25), 0, 1);
  const giQuality = clamp(num(r.fast_gi_quality, 0.25), 0, 1);
  const denoise = r.use_ray_tracing_denoise !== false;
  return {
    reflections: on && method === 'SCREEN',
    fastGi,
    giBounce: fastGi && (r.fast_gi_method ?? (legacyAo ? 'AMBIENT_OCCLUSION_ONLY' : 'GLOBAL_ILLUMINATION')) === 'GLOBAL_ILLUMINATION',
    resolution: Math.min(Number(r.ray_tracing_resolution ?? 2) || 2, fastGi ? Number(r.fast_gi_resolution ?? 2) || 2 : 16),
    maxRoughness: clamp(num(r.trace_max_roughness, 0.5), 0, 1),
    thickness: Math.max(1e-4, num(r.screen_trace_thickness, 0.2)),
    steps: Math.round(16 + quality * 48),
    denoise,
    spatial: denoise && r.ray_tracing_denoise_spatial !== false,
    temporal: !denoise || r.ray_tracing_denoise_temporal !== false,
    giRays: clamp(Math.round(num(r.fast_gi_ray_count, 2)), 1, 16),
    giSteps: clamp(Math.round(num(r.fast_gi_step_count, 8) * (0.5 + giQuality * 2)), 1, 128),
    giDistance: Math.max(0, num(r.fast_gi_distance, legacyAo ? r.gtao_distance : 0)),
    giThickness: Math.max(1e-4, num(r.fast_gi_thickness_near, 0.25)),
    giBias: clamp(num(r.fast_gi_bias, 0.05), 0, 1),
    overscan: r.use_overscan ? clamp(num(r.overscan_size, 3), 0, 50) / 100 : 0,
  };
}

export interface ShadowSettings {
  enabled: boolean;
  scale: number;
  /** radiance below which lights stop contributing (sets light ranges) */
  threshold: number;
  jitterViewport: boolean;
}

export function shadowSettings(r: RenderSettings): ShadowSettings {
  return {
    enabled: r.use_shadows !== false,
    scale: clamp(num(r.shadow_resolution_scale, 1), 0.05, 1),
    threshold: Math.max(0, num(r.light_threshold, 0.01)),
    jitterViewport: !!r.use_shadow_jitter_viewport,
  };
}

/**
 * Range of a light given the render's light threshold: the distance where its (inverse-square)
 * intensity drops below the threshold. `intensity` is the three.js candela-like value.
 */
export function lightRange(intensity: number, threshold: number): number {
  if (!(threshold > 0) || !(intensity > 0)) return 0;
  return Math.sqrt(intensity / threshold);
}

/** Shadow map size of a light: the coverage divided by the texel size limit, within the budget. */
export function shadowMapSize(coverage: number, limit: number, max: number, scale: number): number {
  const cap = Math.max(64, Math.round(max * scale));
  let want = cap;
  if (limit > 0 && coverage > 0) want = Math.min(cap, Math.max(64, coverage / limit));
  // power of two not above the cap
  return Math.max(64, Math.min(1 << Math.floor(Math.log2(cap)), 1 << Math.ceil(Math.log2(want))));
}

export interface LightShadowOptions {
  jitter: boolean;
  /** extra blur in percent of the light size */
  overblur: number;
  filter: number;
  limit: number;
  absolute: boolean;
}

export function lightShadowOptions(la: LightData): LightShadowOptions {
  return {
    jitter: !!la.use_shadow_jitter,
    overblur: Math.max(0, num(la.shadow_jitter_overblur, 10)),
    filter: Math.max(0, num(la.shadow_filter_radius, 1)),
    limit: Math.max(0, num(la.shadow_maximum_resolution, 0.001)),
    absolute: !!la.use_absolute_resolution,
  };
}

export function worldSunOptions(w: WorldData | null | undefined) {
  return {
    threshold: Math.max(0, num(w?.sun_threshold, 10)),
    angle: clamp(num(w?.sun_angle, (0.526 * Math.PI) / 180), 0, Math.PI),
    shadow: w?.use_sun_shadow !== false,
    filter: Math.max(0, num(w?.sun_shadow_filter_radius, 1)),
    limit: Math.max(0, num(w?.sun_shadow_maximum_resolution, 0.001)),
    jitter: !!w?.use_sun_shadow_jitter,
    overblur: Math.max(0, num(w?.sun_shadow_jitter_overblur, 10)),
  };
}

/** Bloom options (Render ▸ Bloom) in the compositor Glare node's terms. */
export function bloomOptions(r: RenderSettings) {
  const threshold = Math.max(0, num(r.bloom_threshold, 0.8));
  return {
    threshold,
    /** soft knee as a fraction of the threshold (Glare ▸ Highlights Smoothness) */
    smoothness: clamp(num(r.bloom_knee, 0.5), 0, 1),
    /** 0..1 spread (Glare ▸ Size) from the radius in 0..10 */
    size: clamp(num(r.bloom_radius, 6.5) / 10, 0, 1),
    strength: Math.max(0, num(r.bloom_intensity, 0.05)) * 20,
    color: (r.bloom_color ?? [1, 1, 1]) as [number, number, number],
    /** 0 = no clamp */
    clamp: Math.max(0, num(r.bloom_clamp, 0)),
  };
}
