/**
 * Color modes for the Color panel, the Color Picker and Swatch Options:
 * Grayscale, RGB, HSB, CMYK and Web Safe RGB. Each mode converts a
 * '#rrggbb' color to channel values and back, and describes the slider
 * ramps (CSS gradients showing what each channel would do to the color).
 */
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, cmykEngine, rgbToGray, grayToRgb, webSafe, clamp } from '../../lib/color.js';

const pct = (key, label) => ({ key, label, min: 0, max: 100, step: 1, unit: '%' });
const byte = (key, label) => ({ key, label, min: 0, max: 255, step: 1, unit: '' });

export const MODES = {
  gray: {
    id: 'gray',
    label: 'Grayscale',
    channels: [pct('k', 'K')],
    from: (hex) => [rgbToGray(hexToRgb(hex))],
    to: ([k]) => rgbToHex(grayToRgb(clamp(k, 0, 100))),
  },
  rgb: {
    id: 'rgb',
    label: 'RGB',
    channels: [byte('r', 'R'), byte('g', 'G'), byte('b', 'B')],
    from: (hex) => {
      const { r, g, b } = hexToRgb(hex);
      return [r, g, b];
    },
    to: ([r, g, b]) => rgbToHex({ r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) }),
  },
  hsb: {
    id: 'hsb',
    label: 'HSB',
    channels: [{ key: 'h', label: 'H', min: 0, max: 360, step: 1, unit: '°' }, pct('s', 'S'), pct('v', 'B')],
    from: (hex) => {
      const { h, s, v } = rgbToHsb(hexToRgb(hex));
      return [h, s, v];
    },
    to: ([h, s, v]) => rgbToHex(hsbToRgb({ h: clamp(h, 0, 360) % 360, s: clamp(s, 0, 100), v: clamp(v, 0, 100) })),
  },
  cmyk: {
    id: 'cmyk',
    label: 'CMYK',
    channels: [pct('c', 'C'), pct('m', 'M'), pct('y', 'Y'), pct('k', 'K')],
    // Through the color-managed CMYK conversion (the document's CMYK profile) when color management is installed.
    from: (hex) => {
      const { c, m, y, k } = cmykEngine.toCmyk(hexToRgb(hex));
      return [c, m, y, k];
    },
    to: ([c, m, y, k]) => rgbToHex(cmykEngine.toRgb({ c: clamp(c, 0, 100), m: clamp(m, 0, 100), y: clamp(y, 0, 100), k: clamp(k, 0, 100) })),
  },
  web: {
    id: 'web',
    label: 'Web Safe RGB',
    channels: [
      { key: 'r', label: 'R', min: 0, max: 255, step: 51, unit: '', hex: true },
      { key: 'g', label: 'G', min: 0, max: 255, step: 51, unit: '', hex: true },
      { key: 'b', label: 'B', min: 0, max: 255, step: 51, unit: '', hex: true },
    ],
    from: (hex) => {
      const { r, g, b } = hexToRgb(webSafe(hex));
      return [r, g, b];
    },
    to: ([r, g, b]) => webSafe(rgbToHex({ r, g, b })),
  },
};

export const MODE_IDS = ['gray', 'rgb', 'hsb', 'cmyk', 'web'];

/** Channel values of a color in a mode, rounded for display. */
export function channelValues(hex, mode) {
  return MODES[mode].from(hex);
}

/** Color with one channel replaced. */
export function withChannel(hex, mode, index, value, base = null) {
  const vals = (base || MODES[mode].from(hex)).slice();
  vals[index] = value;
  return MODES[mode].to(vals);
}

/**
 * CSS gradient for the ramp of channel `index` given the other channel
 * values: what the color looks like as that channel goes from min to max.
 */
export function rampCss(mode, values, index, samples = null) {
  const def = MODES[mode];
  const ch = def.channels[index];
  const n = samples || (mode === 'hsb' && index === 0 ? 13 : mode === 'rgb' || mode === 'web' ? 2 : 7);
  const stops = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const v = values.slice();
    v[index] = ch.min + (ch.max - ch.min) * t;
    stops.push(`${def.to(v)} ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function isWebSafe(hex) {
  return webSafe(hex).toLowerCase() === String(hex).toLowerCase();
}

/** Format a channel value for its field. */
export function formatChannel(ch, v) {
  if (ch.hex) return Math.round(v).toString(16).padStart(2, '0').toUpperCase();
  return String(Math.round(v));
}

export function parseChannel(ch, text) {
  const s = String(text).trim().replace(/[%°]$/, '');
  const v = ch.hex ? parseInt(s, 16) : Number(s);
  if (!Number.isFinite(v)) return null;
  let c = clamp(v, ch.min, ch.max);
  if (ch.step > 1) c = Math.round(c / ch.step) * ch.step;
  return c;
}

/**
 * Hue spectrum color at (u, v) in [0,1]^2 like the Color panel's spectrum
 * bar: hue left to right, white at the top, full color in the middle and
 * black at the bottom.
 */
export function spectrumColor(u, v) {
  const h = clamp(u, 0, 1) * 360;
  const t = clamp(v, 0, 1);
  if (t <= 0.5) {
    const s = (t / 0.5) * 100;
    return rgbToHex(hsbToRgb({ h, s, v: 100 }));
  }
  const b = (1 - (t - 0.5) / 0.5) * 100;
  return rgbToHex(hsbToRgb({ h, s: 100, v: b }));
}
