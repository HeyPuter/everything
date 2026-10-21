// Properties ▸ Render panels of the realtime engine: Sampling (with Shadows), Raytracing (Screen
// Tracing, Denoising, Fast GI Approximation), Volumes and Bloom.
import { h, type Child } from '../../ui/h';
import { panel } from '../../ui/widgets';
import { num, bool, enumProp, colorProp } from '../../ui/props';
import type { RenderSettings } from '../../data/types';
import { headerToggle, sub } from '../final/props/common';
import { fastGiEnabled, raytracingEnabled } from './settings';
import './style';

const RES: [string, string][] = [
  ['1', '1:1'],
  ['2', '1:2'],
  ['4', '1:4'],
  ['8', '1:8'],
  ['16', '1:16'],
];

/**
 * Fill the realtime settings a document does not have yet (the Render tab edits them). Older
 * documents with Ambient Occlusion on keep it as probe-only raytracing with Fast GI occlusion.
 */
export function ensureRealtimeDefaults(r: RenderSettings) {
  if (r.use_fast_gi === undefined) {
    const legacy = !!r.use_gtao;
    r.use_fast_gi = legacy;
    if (legacy && !r.use_ssr) {
      r.use_ssr = true;
      r.ray_tracing_method ??= 'PROBE';
    }
    if (legacy) {
      r.fast_gi_method ??= 'AMBIENT_OCCLUSION_ONLY';
      r.fast_gi_distance ??= r.gtao_distance;
    }
    r.use_gtao = false;
  }
  const d: Partial<RenderSettings> = {
    ray_tracing_method: 'SCREEN',
    ray_tracing_resolution: '2',
    trace_max_roughness: 0.5,
    screen_trace_thickness: 0.2,
    screen_trace_quality: 0.25,
    use_ray_tracing_denoise: true,
    ray_tracing_denoise_spatial: true,
    ray_tracing_denoise_temporal: true,
    fast_gi_method: 'GLOBAL_ILLUMINATION',
    fast_gi_resolution: '2',
    fast_gi_step_count: 8,
    fast_gi_ray_count: 2,
    fast_gi_quality: 0.25,
    fast_gi_distance: 0,
    fast_gi_thickness_near: 0.25,
    fast_gi_bias: 0.05,
    use_shadows: true,
    shadow_resolution_scale: 1,
    light_threshold: 0.01,
    use_shadow_jitter_viewport: false,
    use_volumetric_shadows: false,
    volumetric_samples: 64,
    volumetric_start: 0.1,
    volumetric_end: 100,
    use_volume_custom_range: false,
    use_overscan: false,
    overscan_size: 3,
    clamp_surface_direct: 0,
    clamp_surface_indirect: 10,
    bloom_knee: 0.5,
    bloom_color: [1, 1, 1],
    bloom_clamp: 0,
  };
  const o = r as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(d)) if (o[k] === undefined) o[k] = Array.isArray(v) ? [...v] : v;
}

/** Sub-panel whose controls apply only while `on` (drawn dimmed otherwise). */
function subIf(on: boolean, id: string, title: string, body: () => Child, opts: { closed?: boolean; header?: Child } = {}): Child {
  return panel(id, title, body, { ...opts, sub: true, className: on ? undefined : 'rt-off' });
}

const sizeItems = (sizes: number[]) => sizes.map((v) => ({ value: String(v), label: `${v} px` }));

export function samplingShadowsPanel(r: RenderSettings): Child {
  return sub(
    'rs-samp-shadows',
    'Shadows',
    () => [
      num(r, 'shadow_resolution_scale', 'Resolution', { min: 0, max: 1, slider: true, tip: 'Scale of every shadow map resolution: lower is faster with blurrier shadows' }),
      enumProp(r, 'shadow_cube_size', 'Cube Size', sizeItems([512, 1024, 2048, 4096]) as never, { tip: 'Largest shadow map of point, spot and area lights' }),
      enumProp(r, 'shadow_cascade_size', 'Cascade Size', sizeItems([512, 1024, 2048, 4096]) as never, { tip: 'Largest shadow map of sun lights' }),
      bool(r, 'use_soft_shadows', 'Soft Shadows', { tip: 'Blur shadows according to the size of each light' }),
      bool(r, 'use_volumetric_shadows', 'Volume Shadows', { tip: 'Volumes such as smoke shade themselves from the lights' }),
    ],
    { closed: true, header: headerToggle(r, 'use_shadows', 'Shadows') },
  );
}

export function samplingAdvancedPanel(r: RenderSettings): Child {
  return sub(
    'rs-samp-advanced',
    'Advanced',
    () => [
      num(r, 'light_threshold', 'Light Threshold', { min: 0, softMax: 1, precision: 3, tip: 'Light below this brightness is ignored: lights reach only as far as they are brighter than this (faster with many lights)' }),
    ],
    { closed: true },
  );
}

export function raytracingPanel(r: RenderSettings): Child {
  const on = raytracingEnabled(r);
  const screen = r.ray_tracing_method !== 'PROBE';
  return panel(
    'rs-raytracing',
    'Raytracing',
    () => [
      enumProp(r, 'ray_tracing_method', 'Method', [['PROBE', 'Light Probe'], ['SCREEN', 'Screen-Trace']], { tip: 'How reflections find what they reflect: light probes and the world only, or also what is visible on screen' }),
      enumProp(r, 'ray_tracing_resolution', 'Resolution', RES, { tip: 'Resolution of the traced buffer: lower is faster and blurrier' }),
      num(r, 'trace_max_roughness', 'Max Roughness', { min: 0, max: 1, slider: true, tip: 'Rougher surfaces use light probes and the world instead of traced reflections' }),
      subIf(screen, 'rs-rt-screen', 'Screen Tracing', () => [
          num(r, 'screen_trace_quality', 'Precision', { min: 0, max: 1, slider: true, tip: 'More tracing steps per ray: fewer missed reflections, slower' }),
          num(r, 'screen_trace_thickness', 'Thickness', { unit: 'distance', min: 0.0001, softMax: 1, tip: 'How deep surfaces on screen are assumed to be: larger closes gaps behind thin objects' }),
      ]),
      sub(
        'rs-rt-denoise',
        'Denoising',
        () => [
          bool(r, 'ray_tracing_denoise_spatial', 'Spatial Reuse', { tip: 'Blur rough reflections across neighbouring pixels' }),
          bool(r, 'ray_tracing_denoise_temporal', 'Temporal Accumulation', { tip: 'Vary the tracing noise between samples so that it averages out as samples accumulate' }),
        ],
        { closed: true, header: headerToggle(r, 'use_ray_tracing_denoise', 'Denoising') },
      ),
      subIf(
          fastGiEnabled(r),
          'rs-rt-fastgi',
          'Fast GI Approximation',
          () => [
            enumProp(r, 'fast_gi_method', 'Method', [['AMBIENT_OCCLUSION_ONLY', 'Ambient Occlusion'], ['GLOBAL_ILLUMINATION', 'Global Illumination']], { tip: 'Only darken occluded indirect light, or also add light bounced off nearby surfaces on screen' }),
            enumProp(r, 'fast_gi_resolution', 'Resolution', RES, { tip: 'Resolution of the scanned buffer' }),
            num(r, 'fast_gi_ray_count', 'Rays', { int: true, min: 1, max: 16, tip: 'Directions scanned per pixel and sample' }),
            num(r, 'fast_gi_step_count', 'Steps', { int: true, min: 1, max: 64, tip: 'Steps along each direction' }),
            num(r, 'fast_gi_quality', 'Precision', { min: 0, max: 1, slider: true, tip: 'More steps for distant occluders' }),
            num(r, 'fast_gi_distance', 'Distance', { unit: 'distance', min: 0, softMax: 100, tip: 'How far occluders are searched (0: a distance relative to the screen)' }),
            num(r, 'fast_gi_thickness_near', 'Thickness', { unit: 'distance', min: 0, softMax: 10, tip: 'Assumed thickness of surfaces seen on screen' }),
            num(r, 'fast_gi_bias', 'Bias', { min: 0, max: 1, slider: true, tip: 'Offset of the scan from the surface: removes self-occlusion on curved surfaces' }),
          ],
          { closed: true, header: headerToggle(r, 'use_fast_gi', 'Fast GI Approximation') },
      ),
    ],
    { closed: true, header: headerToggle(r, 'use_ssr', 'Raytracing'), className: on ? undefined : 'rt-off' },
  );
}

export function volumesPanel(r: RenderSettings): Child {
  return panel(
    'rs-volumes',
    'Volumes',
    () => [
      num(r, 'volumetric_samples', 'Steps', { int: true, min: 1, max: 256, tip: 'Samples taken through volumes such as smoke: more is smoother and slower' }),
      sub(
        'rs-vol-range',
        'Custom Range',
        () => [
          num(r, 'volumetric_start', 'Start', { unit: 'distance', min: 0.000001, tip: 'Distance from the camera where the world volume starts' }),
          num(r, 'volumetric_end', 'End', { unit: 'distance', min: 0.000001, tip: 'Distance from the camera where the world volume ends' }),
        ],
        { closed: true, header: headerToggle(r, 'use_volume_custom_range', 'Custom Range') },
      ),
    ],
    { closed: true },
  );
}

export function bloomPanel(r: RenderSettings): Child {
  return panel(
    'rs-bloom',
    'Bloom',
    () => [
      num(r, 'bloom_threshold', 'Threshold', { min: 0, softMax: 10, tip: 'Brightness above which pixels glow' }),
      num(r, 'bloom_knee', 'Knee', { min: 0, max: 1, slider: true, tip: 'Softness of the transition at the threshold' }),
      num(r, 'bloom_radius', 'Radius', { min: 0, max: 10, tip: 'Spread of the glow' }),
      colorProp(r as never, 'bloom_color' as never, 'Color'),
      num(r, 'bloom_intensity', 'Intensity', { min: 0, softMax: 1, precision: 3, tip: 'Strength of the glow (0.05 matches a Glare node at Strength 1)' }),
      num(r, 'bloom_clamp', 'Clamp', { min: 0, softMax: 1000, tip: 'Maximum brightness of glowing pixels (0 for no limit)' }),
      h('div', { class: 'prop-note' }, 'Same look as the compositor’s Glare node in Bloom mode.'),
    ],
    { header: headerToggle(r, 'use_bloom', 'Bloom'), closed: true },
  );
}
