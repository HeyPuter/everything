// Preset menus of the render panels (the stacked-lines button in the panel header): path tracer
// sampling / viewport sampling / light paths / performance, realtime raytracing, white balance
// illuminants and camera safe areas. Users add their own through the menu (stored per kind).
import { app } from '../../../app/app';
import { panelPresets } from '../../../ui/presetkinds';
import { registerPresetKind, presetButton, type PresetValues } from '../../../ui/presets';
import { panelHeaderExtras } from '../../../ui/widgets';
import { DEFAULT_SAFE_AREAS } from '../cameraoverlay';

// --- path tracer

panelPresets('rs-pt-sampling', 'Sampling Presets', 'render.cycles_sampling_preset_add', () => [
  ['Draft', { samples: 32, use_adaptive_sampling: true, adaptive_threshold: 0.1, adaptive_min_samples: 0, use_denoising: true }],
  ['Preview', { samples: 128, use_adaptive_sampling: true, adaptive_threshold: 0.05, adaptive_min_samples: 0, use_denoising: true }],
  ['Production', { samples: 1024, use_adaptive_sampling: true, adaptive_threshold: 0.01, adaptive_min_samples: 0, use_denoising: true }],
  ['High Quality', { samples: 4096, use_adaptive_sampling: true, adaptive_threshold: 0.005, adaptive_min_samples: 64, use_denoising: true }],
]);

panelPresets('rs-pt-samp-vp', 'Viewport Sampling Presets', 'render.cycles_viewport_sampling_preset_add', () => [
  ['Responsive', { preview_samples: 16, use_preview_adaptive_sampling: true, preview_adaptive_threshold: 0.2, preview_denoising: true }],
  ['Balanced', { preview_samples: 64, use_preview_adaptive_sampling: true, preview_adaptive_threshold: 0.1, preview_denoising: true }],
  ['Detailed', { preview_samples: 512, use_preview_adaptive_sampling: true, preview_adaptive_threshold: 0.03, preview_denoising: true }],
]);

const bounces = (total: number, diffuse: number, glossy: number, transmission: number, volume: number, transparent: number, fastGi = false): PresetValues => ({
  max_bounces: total,
  diffuse_bounces: diffuse,
  glossy_bounces: glossy,
  transmission_bounces: transmission,
  volume_bounces: volume,
  transparent_max_bounces: transparent,
  use_fast_gi: fastGi,
});

panelPresets('rs-pt-lightpaths', 'Light Paths Presets', 'render.cycles_integrator_preset_add', () => [
  ['Direct Light', bounces(4, 0, 1, 2, 0, 8)],
  ['Limited Global Illumination', bounces(4, 1, 2, 4, 0, 8)],
  ['Fast Global Illumination', { ...bounces(8, 2, 2, 6, 0, 8, true), ao_bounces: 1, ao_bounces_render: 2 }],
  ['Full Global Illumination', bounces(32, 16, 16, 32, 8, 32)],
]);

panelPresets('rs-pt-perf', 'Performance Presets', 'render.cycles_performance_preset_add', () => [
  ['Responsive', { use_auto_tile: true, tile_size: 256, preview_pixel_size: '2' }],
  ['Balanced', { use_auto_tile: true, tile_size: 640, preview_pixel_size: 'AUTO' }],
  ['Throughput', { use_auto_tile: false, tile_size: 2048, preview_pixel_size: '1' }],
]);

// --- realtime raytracing

panelPresets('rs-raytracing', 'Raytracing Presets', 'render.eevee_raytracing_preset_add', () => [
  ['Performance', { ray_tracing_method: 'PROBE', ray_tracing_resolution: '4', trace_max_roughness: 0.3, screen_trace_quality: 0.1, fast_gi_resolution: '4', fast_gi_ray_count: 1, fast_gi_step_count: 4 }],
  ['Balanced', { ray_tracing_method: 'SCREEN', ray_tracing_resolution: '2', trace_max_roughness: 0.5, screen_trace_quality: 0.25, fast_gi_resolution: '2', fast_gi_ray_count: 2, fast_gi_step_count: 8 }],
  ['High Quality', { ray_tracing_method: 'SCREEN', ray_tracing_resolution: '1', trace_max_roughness: 0.7, screen_trace_quality: 0.75, fast_gi_resolution: '1', fast_gi_ray_count: 4, fast_gi_step_count: 16 }],
]);

// --- colour management: common light sources (correlated colour temperature)

const ILLUMINANTS: [string, number][] = [
  ['Candle Flame', 1900],
  ['Tungsten Bulb', 2700],
  ['Studio Halogen', 3200],
  ['Cool Fluorescent', 4100],
  ['Noon Daylight', 5500],
  ['Overcast Sky', 6500],
  ['Open Shade', 7500],
];
// the White Balance sub-panel already has a preset menu (ui/presetkinds.ts); give it built-ins
{
  const kind = 'panel:rs-cm-wb';
  registerPresetKind({
    id: kind,
    label: 'White Balance Presets',
    addOp: 'render.color_management_white_balance_preset_add',
    capture: () => {
      const r = app.doc.scene.render;
      return { white_balance_temperature: r.white_balance_temperature ?? 6500, white_balance_tint: r.white_balance_tint ?? 10 };
    },
    apply: (v) => {
      const r = app.doc.scene.render;
      if (typeof v.white_balance_temperature === 'number') r.white_balance_temperature = v.white_balance_temperature;
      if (typeof v.white_balance_tint === 'number') r.white_balance_tint = v.white_balance_tint;
      r.use_white_balance = true;
    },
    builtins: () => ILLUMINANTS.map(([n, k]) => [`${n} (${k} K)`, { white_balance_temperature: k, white_balance_tint: 10 }]),
  });
}

// --- camera safe areas (fractions of the frame per side, x / y)

type Safe = { title: [number, number]; action: [number, number]; title_center: [number, number]; action_center: [number, number] };
const SAFE: [string, Safe][] = [
  ['Standard', { title: [0.1, 0.05], action: [0.035, 0.035], title_center: [0.175, 0.05], action_center: [0.15, 0.05] }],
  ['Broadcast (Tight)', { title: [0.1, 0.1], action: [0.05, 0.05], title_center: [0.2, 0.1], action_center: [0.175, 0.05] }],
  ['Web Video', { title: [0.05, 0.05], action: [0.02, 0.02], title_center: [0.15, 0.05], action_center: [0.125, 0.02] }],
];
registerPresetKind({
  id: 'camera_safe_areas',
  label: 'Safe Area Presets',
  addOp: 'camera.safe_areas_preset_add',
  capture: () => structuredClone((app.doc.scene.safe_areas ?? DEFAULT_SAFE_AREAS) as unknown as PresetValues),
  apply: (v) => {
    const sa = (app.doc.scene.safe_areas ??= structuredClone(DEFAULT_SAFE_AREAS)) as unknown as Record<string, unknown>;
    for (const k of ['title', 'action', 'title_center', 'action_center']) if (Array.isArray(v[k])) sa[k] = [...(v[k] as number[])];
  },
  builtins: () => SAFE.map(([n, s]) => [n, structuredClone(s) as unknown as PresetValues]),
});
panelHeaderExtras['ca-safe'] = () => presetButton('camera_safe_areas', 'Safe Area Presets');
