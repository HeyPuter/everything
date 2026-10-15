// Settings of the realtime (raster) engine that extend the scene, light, material and world
// data-blocks. All fields are optional: `settings.ts` resolves them with their defaults.

/** Scene render settings of the realtime engine (Render ▸ Raytracing, Shadows, Volumes, …). */
export interface RealtimeRenderSettings {
  // --- raytracing (screen-space reflections / refraction); the toggle is `use_ssr`
  ray_tracing_method?: 'PROBE' | 'SCREEN';
  /** resolution divisor of the traced buffers: '1' full, '2' half, … */
  ray_tracing_resolution?: '1' | '2' | '4' | '8' | '16';
  /** surfaces rougher than this use light probes / the world instead of traced reflections */
  trace_max_roughness?: number;
  /** assumed thickness of surfaces seen by the screen tracer (distance) */
  screen_trace_thickness?: number;
  /** 0..1: more tracing steps (slower, fewer missed hits) */
  screen_trace_quality?: number;
  use_ray_tracing_denoise?: boolean;
  /** blur traced reflections according to roughness */
  ray_tracing_denoise_spatial?: boolean;
  /** vary the tracing noise between samples so that accumulation smooths it */
  ray_tracing_denoise_temporal?: boolean;
  // --- fast global illumination (horizon scan)
  use_fast_gi?: boolean;
  fast_gi_method?: 'AMBIENT_OCCLUSION_ONLY' | 'GLOBAL_ILLUMINATION';
  fast_gi_resolution?: '1' | '2' | '4' | '8' | '16';
  fast_gi_step_count?: number;
  fast_gi_ray_count?: number;
  fast_gi_quality?: number;
  /** 0 = unlimited (bounded by the screen) */
  fast_gi_distance?: number;
  fast_gi_thickness_near?: number;
  fast_gi_bias?: number;
  // --- shadows
  use_shadows?: boolean;
  /** 0..1 multiplier of every shadow map resolution */
  shadow_resolution_scale?: number;
  /** lights dimmer than this (radiance) stop influencing surfaces: sets their range */
  light_threshold?: number;
  /** jitter soft shadows in the viewport too (final renders always jitter) */
  use_shadow_jitter_viewport?: boolean;
  use_volumetric_shadows?: boolean;
  // --- volumes
  volumetric_samples?: number;
  volumetric_start?: number;
  volumetric_end?: number;
  use_volume_custom_range?: boolean;
  // --- bloom (same algorithm as the compositor's Glare ▸ Bloom)
  bloom_knee?: number;
  bloom_color?: [number, number, number];
  bloom_clamp?: number;
  // --- view layer (shader AOVs, AO pass distance)
  aovs?: { name: string; type: 'COLOR' | 'VALUE' }[];
  active_aov_index?: number;
  ambient_occlusion_distance?: number;
  use_pass_bloom?: boolean;
  // --- light probes
  gi_cubemap_resolution?: '128' | '256' | '512' | '1024';
}

/** Per-light settings of the realtime engine. */
export interface RealtimeLightSettings {
  use_shadow_jitter?: boolean;
  /** percent of extra blur added to jittered shadows */
  shadow_jitter_overblur?: number;
  /** softening of the shadow map lookups (multiplies the filter radius) */
  shadow_filter_radius?: number;
  /** smallest world-space size of a shadow map texel (0 = no limit) */
  shadow_maximum_resolution?: number;
  use_absolute_resolution?: boolean;
}

/** Per-material settings of the realtime engine (Material ▸ Settings). */
export interface RealtimeMaterialSettings {
  /** cull back faces when casting shadows */
  use_backface_culling_shadow?: boolean;
  /** refract what is behind the surface on screen (off: refract the light probes / world only) */
  use_raytrace_refraction?: boolean;
  /** thickness of refractive objects (0 = automatic) */
  refraction_depth?: number;
  use_transparent_shadow?: boolean;
}

/** Per-world settings of the realtime engine (World ▸ Settings). */
export interface RealtimeWorldSettings {
  /** world lighting brighter than this is turned into a sun light that casts shadows (0 = off) */
  sun_threshold?: number;
  sun_angle?: number;
  use_sun_shadow?: boolean;
  sun_shadow_filter_radius?: number;
  sun_shadow_maximum_resolution?: number;
  use_sun_shadow_jitter?: boolean;
  sun_shadow_jitter_overblur?: number;
  /** resolution of the world's reflection probe */
  probe_resolution?: '128' | '256' | '512' | '1024' | '2048';
}

/** A light probe object's settings (stored on the object, like a speaker's). */
export interface LightProbeSettings {
  type: 'SPHERE' | 'PLANE' | 'VOLUME';
  /** sphere: radius of the influence; plane: distance above/below; volume: border falloff */
  influence_distance: number;
  influence_type?: 'ELIPSOID' | 'BOX';
  falloff: number;
  clip_start: number;
  clip_end: number;
  use_custom_parallax?: boolean;
  parallax_type?: 'ELIPSOID' | 'BOX';
  parallax_distance?: number;
  /** collection whose objects are seen (or, inverted, not seen) by the probe */
  visibility_collection?: string | null;
  invert_visibility_collection?: boolean;
  // volume
  intensity?: number;
  resolution_x?: number;
  resolution_y?: number;
  resolution_z?: number;
  capture_distance?: number;
  capture_world?: boolean;
  capture_indirect?: boolean;
  capture_emission?: boolean;
  bake_samples?: number;
  /** extra light bounces captured by the bake */
  bake_bounces?: number;
  // display
  show_influence?: boolean;
  show_clip?: boolean;
  show_parallax?: boolean;
  show_data?: boolean;
  data_display_size?: number;
  /** set when a bake exists (the baked data itself lives on the GPU for the session) */
  baked?: { time: number; key: string } | null;
}
