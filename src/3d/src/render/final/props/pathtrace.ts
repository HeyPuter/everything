// Properties ▸ Render panels of the path tracer: Sampling (adaptive sampling, denoising,
// advanced), Light Paths (bounces per kind, clamping, caustics, fast GI), Film and Performance.
import type { Child } from '../../../ui/h';
import { panel } from '../../../ui/widgets';
import { num, bool, enumProp } from '../../../ui/props';
import type { RenderSettings } from '../../../data/types';
import { headerToggle, sub, checkNum } from './common';
import { ptSettings, type PathTraceSettings } from '../ptsettings';

const PASSES: [string, string][] = [
  ['RGB', 'None'],
  ['RGB_ALBEDO', 'Albedo'],
  ['RGB_ALBEDO_NORMAL', 'Albedo and Normal'],
];
const PREFILTER: [string, string][] = [
  ['NONE', 'None'],
  ['FAST', 'Fast'],
  ['ACCURATE', 'Accurate'],
];
const QUALITY: [string, string][] = [
  ['HIGH', 'High'],
  ['BALANCED', 'Balanced'],
  ['FAST', 'Fast'],
];

function denoisePanel(id: string, r: RenderSettings, c: PathTraceSettings, viewport: boolean): Child {
  const p = viewport ? 'preview_' : '';
  const k = <K extends string>(s: K) => `${p}${s}` as keyof PathTraceSettings & string;
  const on = viewport ? r.preview_denoising !== false : r.use_denoising;
  return sub(
    id,
    'Denoise',
    () => [
      enumProp(c, k('denoising_input_passes'), 'Passes', PASSES, { disabled: !on, tip: 'Extra render buffers that guide the denoiser: albedo keeps texture detail, normals keep geometric edges' }),
      enumProp(c, k('denoising_prefilter'), 'Prefilter', PREFILTER, { disabled: !on, tip: 'Remove isolated bright pixels before denoising; Accurate also adapts the filter strength to the local noise' }),
      enumProp(c, k('denoising_quality'), 'Quality', QUALITY, { disabled: !on, tip: 'Number of filter passes: High keeps more detail on noisy images, Fast filters less' }),
      viewport ? num(c, 'preview_denoising_start_sample', 'Start Sample', { int: true, min: 0, max: 1 << 24, softMax: 128, disabled: !on, tip: 'Show the denoised image from this sample on' }) : null,
    ],
    { closed: true, header: headerToggle(r, viewport ? 'preview_denoising' : 'use_denoising', 'Denoise') },
  );
}

function samplingPanel(r: RenderSettings, c: PathTraceSettings): Child {
  return panel('rs-pt-sampling', 'Sampling', () => [
    sub('rs-pt-samp-vp', 'Viewport', () => [
      checkNum(c, 'use_preview_adaptive_sampling', 'preview_adaptive_threshold', 'Noise Threshold', { min: 0, max: 1, softMin: 0.001, precision: 4, step: 0.01, tip: 'Pixels stop sampling once their estimated noise is below this level' }),
      num(r, 'preview_samples', 'Max Samples', { int: true, min: 1, max: 65536, tip: 'Samples of the Rendered viewport' }),
      num(c, 'preview_adaptive_min_samples', 'Min Samples', { int: true, min: 0, max: 4096, disabled: !c.use_preview_adaptive_sampling, tip: 'Samples before pixels may stop (0 chooses from the threshold)' }),
      denoisePanel('rs-samp-vp-denoise', r, c, true),
    ]),
    sub('rs-pt-samp-render', 'Render', () => [
      checkNum(c, 'use_adaptive_sampling', 'adaptive_threshold', 'Noise Threshold', { min: 0, max: 1, softMin: 0.001, precision: 4, step: 0.01, tip: 'Pixels stop sampling once their estimated noise is below this level' }),
      num(r, 'samples', 'Max Samples', { int: true, min: 1, max: 65536, tip: 'Samples per pixel of final renders' }),
      num(c, 'adaptive_min_samples', 'Min Samples', { int: true, min: 0, max: 4096, disabled: !c.use_adaptive_sampling, tip: 'Samples before pixels may stop (0 chooses from the threshold)' }),
      num(r, 'time_limit', 'Time Limit', { unit: 'time', min: 0, softMax: 3600, tip: 'Stop sampling after this time (0 for no limit)' }),
      denoisePanel('rs-samp-render-denoise', r, c, false),
    ]),
    sub(
      'rs-pt-samp-advanced',
      'Advanced',
      () => [
        num(c, 'seed', 'Seed', { int: true, min: 0, max: 2147483647, tip: 'Seed of the noise pattern: renders with the same seed have the same noise' }),
        bool(c, 'use_animated_seed', 'Animated Seed', { tip: 'Change the seed every frame so the noise does not stay in place during animation' }),
        num(c, 'min_light_bounces', 'Min Light Bounces', { int: true, min: 0, max: 1024, tip: 'Bounces every path makes before dim paths may be ended at random (0 uses the default of 3)' }),
        num(c, 'min_transparent_bounces', 'Min Transparent Bounces', { int: true, min: 0, max: 1024, tip: 'Transparent surfaces always passed before paths may end at random' }),
      ],
      { closed: true },
    ),
  ]);
}

function lightPathsPanel(r: RenderSettings, c: PathTraceSettings): Child {
  return panel(
    'rs-pt-lightpaths',
    'Light Paths',
    () => [
      sub('rs-lp-bounces', 'Max Bounces', () => [
        num(r, 'max_bounces', 'Total', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Total number of light bounces' }),
        num(r, 'diffuse_bounces' as never, 'Diffuse', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Bounces off rough (diffuse) surfaces' }),
        num(r, 'glossy_bounces' as never, 'Glossy', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Reflections off glossy surfaces' }),
        num(r, 'transmission_bounces' as never, 'Transmission', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Passes through refractive surfaces (glass)' }),
        num(c, 'volume_bounces', 'Volume', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Scattering events inside volumes' }),
        num(c, 'transparent_max_bounces', 'Transparent', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Transparent (alpha) surfaces a ray may pass through' }),
      ]),
      sub('rs-lp-clamp', 'Clamping', () => [
        num(r, 'sample_clamp_direct', 'Direct Light', { min: 0, softMax: 100, tip: 'Limit the brightness of direct light samples to reduce noise (0 disables)' }),
        num(r, 'sample_clamp_indirect', 'Indirect Light', { min: 0, softMax: 100, tip: 'Limit the brightness of bounced light samples to reduce fireflies (0 disables)' }),
      ]),
      sub(
        'rs-lp-caustics',
        'Caustics',
        () => [
          num(r, 'blur_glossy', 'Filter Glossy', { min: 0, max: 10, tip: 'Blur glossy reflections seen after rough bounces to reduce caustic noise' }),
          bool(c, 'caustics_reflective', 'Reflective', { tip: 'Light reflected by glossy surfaces onto rough ones' }),
          bool(c, 'caustics_refractive', 'Refractive', { tip: 'Light focused through glass onto rough surfaces' }),
        ],
        { closed: true },
      ),
      sub(
        'rs-lp-fastgi',
        'Fast GI Approximation',
        () => [
          enumProp(c, 'fast_gi_method', 'Method', [['REPLACE', 'Replace'], ['ADD', 'Add']], { disabled: !c.use_fast_gi, tip: 'Replace: later bounces see the world unless something is close; Add: add that light to the full bounces' }),
          num(c, 'ao_factor', 'AO Factor', { min: 0, softMax: 1, disabled: !c.use_fast_gi, tip: 'Strength of the approximated light' }),
          num(c, 'ao_distance', 'AO Distance', { unit: 'distance', min: 0, disabled: !c.use_fast_gi, tip: 'Surfaces closer than this block the world light' }),
          num(c, 'ao_bounces', 'Viewport Bounces', { int: true, min: 0, max: 1024, disabled: !c.use_fast_gi, tip: 'Full bounces in the viewport before the approximation' }),
          num(c, 'ao_bounces_render', 'Render Bounces', { int: true, min: 0, max: 1024, disabled: !c.use_fast_gi, tip: 'Full bounces in final renders before the approximation' }),
        ],
        { closed: true, header: headerToggle(c, 'use_fast_gi', 'Fast GI Approximation') },
      ),
    ],
    { closed: true },
  );
}

function filmPanel(r: RenderSettings, c: PathTraceSettings): Child {
  return panel(
    'rs-film',
    'Film',
    () => [
      num(r, 'film_exposure', 'Exposure', { min: 0, softMax: 10, tip: 'Image brightness scale' }),
      sub('rs-film-filter', 'Pixel Filter', () => [
        enumProp(r, 'pixel_filter_type' as never, 'Type', [['BOX', 'Box'], ['GAUSSIAN', 'Gaussian'], ['BLACKMAN_HARRIS', 'Blackman-Harris']], { tip: 'Shape of the anti-aliasing filter' }),
        num(r, 'filter_width', 'Width', { min: 0.01, max: 10, precision: 2, disabled: r.pixel_filter_type === 'BOX', tip: 'Width (pixels) of the anti-aliasing filter' }),
      ]),
      sub(
        'rs-film-transparent',
        'Transparent',
        () => [
          bool(c, 'film_transparent_glass', 'Transparent Glass', { disabled: !r.film_transparent, tip: 'The background seen through smooth glass also renders transparent' }),
          num(c, 'film_transparent_roughness', 'Roughness Threshold', { min: 0, max: 1, slider: true, disabled: !r.film_transparent || !c.film_transparent_glass, tip: 'Glass rougher than this stays opaque' }),
        ],
        { header: headerToggle(r, 'film_transparent', 'Transparent'), closed: true },
      ),
    ],
    { closed: true },
  );
}

/** Sampling, Light Paths and Film panels of the path tracer (the rest stay in render.ts). */
export function pathTraceMainPanels(r: RenderSettings): { sampling: Child; lightPaths: Child; film: Child } {
  const c = ptSettings(r);
  return { sampling: samplingPanel(r, c), lightPaths: lightPathsPanel(r, c), film: filmPanel(r, c) };
}
