import type { KindEditors } from './host';

// Glyph names in app/icons.ts (original artwork, `custom` map).
export const kindIcon: Record<keyof KindEditors, string> = {
  'brightness-contrast': 'adj-brightness-contrast',
  levels: 'adj-levels',
  curves: 'adj-curves',
  exposure: 'adj-exposure',
  vibrance: 'adj-vibrance',
  'hue-saturation': 'adj-hue-saturation',
  'color-balance': 'adj-color-balance',
  'black-white': 'adj-black-white',
  'photo-filter': 'adj-photo-filter',
  'channel-mixer': 'adj-channel-mixer',
  'color-lookup': 'adj-color-lookup',
  invert: 'adj-invert',
  posterize: 'adj-posterize',
  threshold: 'adj-threshold',
  'gradient-map': 'adj-gradient-map',
  'selective-color': 'adj-selective-color',
  'light-tone': 'adj-light-tone',
  'color-vibrance': 'adj-color-vibrance',
  'clarity-dehaze': 'adj-clarity-dehaze',
  grain: 'adj-grain',
  relight: 'adj-relight',
};
