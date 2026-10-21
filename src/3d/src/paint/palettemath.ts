// Color palettes: data types and pure helpers (sorting, moving, joining, extracting colors from
// image pixels). Colors are scene linear RGB like the brush colors.
import { rgbToHsv } from './paintmath';

export interface PaletteColor {
  color: [number, number, number];
  strength: number;
  weight: number;
}

export interface PaletteData {
  id: string;
  name: string;
  colors: PaletteColor[];
  /** index of the active color (-1: none) */
  active_index: number;
  use_fake_user?: boolean;
  asset_data?: unknown;
}

export type PaletteSort = 'HSV' | 'SVH' | 'VHS' | 'LUMINANCE';

export const paletteColor = (c: ArrayLike<number>): PaletteColor => ({ color: [c[0], c[1], c[2]], strength: 1, weight: 1 });

const EPS = 1e-5;
const cmp = (a: number, b: number) => (Math.abs(a - b) < EPS ? 0 : a < b ? -1 : 1);

/** Relative luminance of a linear color. */
export const luminance = (c: ArrayLike<number>) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

/**
 * Sort colors (stable). HSV: hue up, then saturation up, then value down; SVH: saturation up,
 * value down, hue up; VHS: value down, hue up, saturation up; LUMINANCE: brightest first.
 */
export function sortColors(colors: PaletteColor[], type: PaletteSort): PaletteColor[] {
  const keyed = colors.map((c, i) => ({ c, i, hsv: rgbToHsv(c.color[0], c.color[1], c.color[2]), lum: luminance(c.color) }));
  keyed.sort((a, b) => {
    const [ha, sa, va] = a.hsv,
      [hb, sb, vb] = b.hsv;
    let r = 0;
    if (type === 'HSV') r = cmp(ha, hb) || cmp(sa, sb) || cmp(vb, va);
    else if (type === 'SVH') r = cmp(sa, sb) || cmp(vb, va) || cmp(ha, hb);
    else if (type === 'VHS') r = cmp(vb, va) || cmp(ha, hb) || cmp(sa, sb);
    else r = cmp(b.lum, a.lum);
    return r || a.i - b.i;
  });
  return keyed.map((k) => k.c);
}

/** Move the color at `index` one place up (toward the start) or down. Returns the new index. */
export function moveColor(colors: PaletteColor[], index: number, dir: 'UP' | 'DOWN'): number {
  const j = dir === 'UP' ? index - 1 : index + 1;
  if (index < 0 || index >= colors.length || j < 0 || j >= colors.length) return index;
  const t = colors[index];
  colors[index] = colors[j];
  colors[j] = t;
  return j;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4;

/** Whether the palette already holds this color. */
export const hasColor = (colors: PaletteColor[], c: ArrayLike<number>) => colors.some((x) => same(x.color, c));

/** Append the colors of `from` that `into` does not have yet. Returns how many were added. */
export function joinColors(into: PaletteColor[], from: PaletteColor[]): number {
  let n = 0;
  for (const c of from)
    if (!hasColor(into, c.color)) {
      into.push({ color: [...c.color], strength: c.strength, weight: c.weight });
      n++;
    }
  return n;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Distinct colors of 8-bit RGBA pixels (display / sRGB encoded). Each channel is rounded down to
 * `threshold` decimal places first, so a lower threshold merges more similar colors. Fully
 * transparent pixels are skipped. Returns linear colors, sorted by hue (HSV order), at most `max`.
 */
export function extractColors(rgba: ArrayLike<number>, threshold: number, max = 1024): PaletteColor[] {
  const t = Math.max(1, Math.min(6, Math.round(threshold)));
  const scale = Math.pow(10, t);
  const seen = new Map<string, number[]>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const q = [0, 1, 2].map((k) => Math.floor(Math.min(0.99999, rgba[i + k] / 255) * scale) / scale);
    const key = q.join(',');
    if (!seen.has(key)) {
      seen.set(key, q);
      if (seen.size > max * 8) break;
    }
  }
  const out = [...seen.values()].map((q) => paletteColor(q.map(srgbToLinear)));
  return sortColors(out, 'HSV').slice(0, max);
}
