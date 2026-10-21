// Sequencer colours (default theme values).
import type { Strip, StripType, ColorTag } from './types';

export const T = {
  back: '#181a1b',
  rowAlt: '#131416',
  outOfRange: 'rgba(0, 0, 0,0.35)',
  ruler: '#181a1b',
  rulerText: '#a0a1a2',
  grid: 'rgba(255, 255, 255,0.045)',
  channels: '#181a1b',
  playhead: '#4b70b5',
  selected: '#ff8f0d',
  active: '#ffffff',
  outline: 'rgba(0, 0, 0,0.85)',
  text: '#ffffff',
  textDim: 'rgba(255, 255, 255,0.75)',
  invalid: '#dc372e',
  previewBack: '#000000',
  frameRange: '#6e69ce',
  marker: 'rgba(255, 255, 255,0.5)',
  waveform: 'rgba(255, 255, 255,0.55)',
  waveformClip: '#fc4239',
};

const rgb = (r: number, g: number, b: number) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

export const TYPE_COLORS: Record<string, string> = {
  movie: rgb(0.384, 0.51, 0.639),
  image: rgb(0.549, 0.329, 0.549),
  scene: rgb(0.6, 0.6, 0.6),
  audio: rgb(0.337, 0.561, 0.427),
  effect: rgb(0.482, 0.373, 0.502),
  transition: rgb(0.525, 0.478, 0.8),
  color: rgb(0.6, 0.6, 0.361),
  meta: rgb(0.482, 0.6, 0.361),
  text: rgb(0.624, 0.573, 0.435),
  adjustment: '#645e7d',
  mask: rgb(0.561, 0.337, 0.337),
  clip: rgb(0.561, 0.431, 0.337),
};

/** Strip colour tags (theme.strip_color). */
export const TAG_COLORS: Record<Exclude<ColorTag, 'NONE'>, string> = {
  COLOR_01: rgb(0.8, 0.353, 0.322),
  COLOR_02: rgb(0.8, 0.541, 0.282),
  COLOR_03: rgb(0.702, 0.639, 0.247),
  COLOR_04: rgb(0.361, 0.6, 0.361),
  COLOR_05: rgb(0.318, 0.624, 0.8),
  COLOR_06: rgb(0.553, 0.349, 0.855),
  COLOR_07: rgb(0.776, 0.451, 0.722),
  COLOR_08: rgb(0.6, 0.412, 0.322),
  COLOR_09: rgb(0.502, 0.502, 0.502),
};

export function typeColor(t: StripType): string {
  switch (t) {
    case 'MOVIE':
      return TYPE_COLORS.movie;
    case 'IMAGE':
      return TYPE_COLORS.image;
    case 'SCENE':
      return TYPE_COLORS.scene;
    case 'SOUND':
      return TYPE_COLORS.audio;
    case 'COLOR':
      return TYPE_COLORS.color;
    case 'META':
      return TYPE_COLORS.meta;
    case 'TEXT':
      return TYPE_COLORS.text;
    case 'ADJUSTMENT':
      return TYPE_COLORS.adjustment;
    case 'MASK':
      return TYPE_COLORS.mask;
    case 'MOVIECLIP':
      return TYPE_COLORS.clip;
    case 'CROSS':
    case 'GAMMA_CROSS':
    case 'WIPE':
      return TYPE_COLORS.transition;
    default:
      return TYPE_COLORS.effect;
  }
}

export function stripColor(s: Strip): string {
  if (s.color_tag && s.color_tag !== 'NONE') return TAG_COLORS[s.color_tag];
  return typeColor(s.type);
}

/** Icon names for strip types (registered in icons.ts). */
export function stripIcon(t: StripType): string {
  switch (t) {
    case 'MOVIE':
      return 'file_movie';
    case 'IMAGE':
      return 'file_image';
    case 'SOUND':
      return 'file_sound';
    case 'SCENE':
      return 'scene_data';
    case 'COLOR':
      return 'seq_color';
    case 'TEXT':
      return 'seq_text';
    case 'ADJUSTMENT':
      return 'seq_adjustment';
    case 'META':
      return 'seq_meta';
    case 'MASK':
      return 'mod_mask';
    case 'MOVIECLIP':
      return 'clip_editor';
    case 'CROSS':
    case 'GAMMA_CROSS':
    case 'WIPE':
      return 'seq_transition';
    default:
      return 'seq_effect';
  }
}

export function cssColor(c: number[] | undefined, fallback = '#7f8082') {
  if (!c) return fallback;
  return rgb(Math.max(0, Math.min(1, c[0])), Math.max(0, Math.min(1, c[1])), Math.max(0, Math.min(1, c[2])));
}
