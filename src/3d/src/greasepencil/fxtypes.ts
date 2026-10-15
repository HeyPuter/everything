// Visual effect types of grease pencil objects and their defaults (no UI dependencies, so the
// scripting API can use them).
import { uid } from '../data/defaults';
import type { ShaderFx } from './types';

export const FX_TYPES: { type: string; label: string; icon: string; defaults: Record<string, unknown> }[] = [
  { type: 'FX_BLUR', label: 'Blur', icon: 'fx_blur', defaults: { size: [50, 50], samples: 8, rotation: 0 } },
  { type: 'FX_COLORIZE', label: 'Colorize', icon: 'fx_colorize', defaults: { mode: 'GRAYSCALE', factor: 0.5, low_color: [0, 0, 0, 1], high_color: [1, 1, 1, 1] } },
  { type: 'FX_FLIP', label: 'Flip', icon: 'fx_flip', defaults: { use_flip_x: true, use_flip_y: false } },
  { type: 'FX_GLOW', label: 'Glow', icon: 'fx_glow', defaults: { mode: 'LUMINANCE', threshold: 0.1, select_color: [0, 0, 0], glow_color: [0.75, 1, 1], opacity: 1, blend_mode: 'REGULAR', size: [50, 50], samples: 8, rotation: 0, use_glow_under: false } },
  { type: 'FX_PIXEL', label: 'Pixelate', icon: 'fx_pixel', defaults: { size: [5, 5], use_antialiasing: true } },
  { type: 'FX_RIM', label: 'Rim', icon: 'fx_rim', defaults: { offset: [50, -100], rim_color: [1, 1, 0.5], mask_color: [0, 0, 0], mode: 'OVERLAY', blur: [0, 0], samples: 2 } },
  { type: 'FX_SHADOW', label: 'Shadow', icon: 'fx_shadow', defaults: { offset: [15, 20], scale: [1, 1], rotation: 0, shadow_color: [0, 0, 0, 0.8], blur: [5, 5], samples: 2, use_object: false, object: null, use_wave: false, orientation: 'VERTICAL', amplitude: 10, period: 20, phase: 0 } },
  { type: 'FX_SWIRL', label: 'Swirl', icon: 'fx_swirl', defaults: { object: null, radius: 100, angle: Math.PI / 2, use_transparent: false } },
  { type: 'FX_WAVE', label: 'Wave Distortion', icon: 'fx_wave', defaults: { orientation: 'VERTICAL', amplitude: 10, period: 20, phase: 0 } },
];

export function newEffect(type: string, existing: { name: string }[]): ShaderFx {
  const t = FX_TYPES.find((x) => x.type === type)!;
  let name = t.label;
  for (let i = 1; existing.some((e) => e.name === name); i++) name = `${t.label}.${String(i).padStart(3, '0')}`;
  return { id: uid('fx'), name, type, show_viewport: true, show_render: true, show_expanded: true, ...structuredClone(t.defaults) };
}
