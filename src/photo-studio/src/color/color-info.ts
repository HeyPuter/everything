// Color picker helpers: one color described in every model the picker shows,
// plus original swatch library generators (no proprietary color libraries).
import { decodeLab } from './color-math';
import { deltaE2000 } from './delta-e';
import type { Profile } from './icc-lut';
import { builtinProfile } from './builtin-profiles';
import { cachedTransform } from './transform';

export type ColorInfo = {
  rgb: [number, number, number];
  hex: string;
  // Hue in degrees, saturation and brightness in percent.
  hsb: { h: number; s: number; b: number };
  // CIELAB D50, media-relative to the document profile.
  lab: { L: number; a: number; b: number };
  // Ink percentages in the CMYK profile (relative colorimetric, with BPC
  // unless turned off).
  cmyk: { c: number; m: number; y: number; k: number };
  outOfGamutForCMYK: boolean;
  // CIEDE2000 between the color and its printed version.
  cmykDeltaE: number;
  webSafe: { hex: string; exact: boolean };
};

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
export const toHex = (rgb: ArrayLike<number>) => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
export function parseHex(hex: string): [number, number, number] {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Invalid hex color ${hex}.`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

export { rgbToHsb, hsbToRgb } from './hsb';
import { hsbToRgb, rgbToHsb } from './hsb';
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

// rgb in 0-255 document-space values.
export function colorInfo(
  rgb: [number, number, number],
  docProfile: Profile = builtinProfile('srgb'),
  opts: { cmykProfile?: Profile; gamutThreshold?: number; bpc?: boolean } = {},
): ColorInfo {
  const cmykProfile = opts.cmykProfile ?? builtinProfile('generic-coated-cmyk');
  const lab = builtinProfile('lab-d50');
  const n = rgb.map((v) => v / 255);
  const labN = cachedTransform(docProfile, lab, 'relative').one(n);
  const L = decodeLab(labN, 'v4');
  const bpc = opts.bpc ?? true;
  const cmyk = cachedTransform(docProfile, cmykProfile, 'relative', { bpc }).one(n);
  // Gamut test: the round trip through the press with the same black point
  // compensation as the ink values (in-gamut colors come back unchanged).
  const back = bpc
    ? decodeLab(cachedTransform(docProfile, lab, 'relative').one(cachedTransform(cmykProfile, docProfile, 'relative', { bpc }).one(cmyk)), 'v4')
    : decodeLab(cachedTransform(cmykProfile, lab, 'relative').one(cmyk), 'v4');
  const dE = deltaE2000(L, back);
  const safe = rgb.map((v) => Math.round(v / 51) * 51);
  return {
    rgb: [...rgb],
    hex: toHex(rgb),
    hsb: rgbToHsb(rgb[0], rgb[1], rgb[2]),
    lab: { L: L[0], a: L[1], b: L[2] },
    cmyk: { c: cmyk[0] * 100, m: cmyk[1] * 100, y: cmyk[2] * 100, k: cmyk[3] * 100 },
    outOfGamutForCMYK: dE > (opts.gamutThreshold ?? 2),
    cmykDeltaE: dE,
    webSafe: { hex: toHex(safe), exact: safe.every((v, i) => v === Math.round(rgb[i])) },
  };
}

// --- Swatch libraries ------------------------------------------------------

export type Swatch = { name: string; hex: string };
export type SwatchLibrary = { name: string; swatches: Swatch[] };
export type SwatchKind = 'hue-ramps' | 'grays' | 'web-safe' | 'pastels' | 'earth';

const HUE_NAMES = ['Red', 'Orange', 'Yellow', 'Chartreuse', 'Green', 'Spring', 'Cyan', 'Azure', 'Blue', 'Violet', 'Magenta', 'Rose'];

export function generateSwatchLibrary(kind: SwatchKind): SwatchLibrary {
  const sw = (name: string, rgb: ArrayLike<number>): Swatch => ({ name, hex: toHex(rgb) });
  switch (kind) {
    case 'hue-ramps': {
      const out: Swatch[] = [];
      HUE_NAMES.forEach((hue, i) => {
        for (const l of [85, 70, 50, 35, 20]) out.push(sw(`${hue} ${l}`, hslToRgb(i * 30, l === 50 ? 90 : 75, l)));
      });
      return { name: 'Hue Ramps', swatches: out };
    }
    case 'grays':
      return {
        name: 'Grays',
        swatches: Array.from({ length: 11 }, (_, i) => sw(`Gray ${i * 10}%`, [0, 0, 0].map(() => 255 - i * 25.5))),
      };
    case 'web-safe': {
      const out: Swatch[] = [];
      for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) out.push(sw(toHex([r * 51, g * 51, b * 51]).toUpperCase(), [r * 51, g * 51, b * 51]));
      return { name: 'Web Safe', swatches: out };
    }
    case 'pastels':
      return { name: 'Pastels', swatches: HUE_NAMES.map((h, i) => sw(`Pastel ${h}`, hslToRgb(i * 30, 70, 85))) };
    case 'earth':
      return {
        name: 'Earth Tones',
        swatches: [15, 25, 35, 45, 60, 80, 100].flatMap((h) => [sw(`Earth ${h}° light`, hslToRgb(h, 35, 60)), sw(`Earth ${h}° deep`, hslToRgb(h, 45, 30))]),
      };
  }
}

export type HarmonyScheme = 'complementary' | 'analogous' | 'triadic' | 'split-complementary' | 'tetradic' | 'monochromatic';
// Classic hue-wheel harmonies around a base color (HSB wheel).
export function harmonySwatches(baseHex: string, scheme: HarmonyScheme): Swatch[] {
  const [r, g, b] = parseHex(baseHex);
  const { h, s, b: v } = rgbToHsb(r, g, b);
  const offsets: Record<HarmonyScheme, number[]> = {
    complementary: [0, 180],
    analogous: [-30, 0, 30],
    triadic: [0, 120, 240],
    'split-complementary': [0, 150, 210],
    tetradic: [0, 90, 180, 270],
    monochromatic: [0, 0, 0, 0, 0],
  };
  return offsets[scheme].map((o, i) => {
    const vv = scheme === 'monochromatic' ? Math.max(10, Math.min(100, v - 40 + i * 20)) : v;
    const rgb = hsbToRgb((h + o + 360) % 360, s, vv);
    return { name: `${scheme} ${i + 1}`, hex: toHex(rgb) };
  });
}
