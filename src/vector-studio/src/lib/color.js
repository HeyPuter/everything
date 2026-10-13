/**
 * Color conversions. Document colors are stored as '#rrggbb' strings; the
 * Color panel shows them in RGB, HSB, CMYK, Grayscale or Web Safe RGB using
 * these conversions (device-independent naive CMYK, as in a basic color
 * picker, not an ICC-managed transform).
 */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function hexToRgb(hex) {
  let s = String(hex || '').trim().replace(/^#/, '');
  if (s.length === 3 || s.length === 4) s = [...s.slice(0, 3)].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}/i.test(s)) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

export function rgbToHex({ r, g, b }) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function isHex(s) {
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(s || '').trim());
}

export function normalizeHex(s) {
  return rgbToHex(hexToRgb(s));
}

/** h in [0, 360), s and v in [0, 100]. */
export function rgbToHsb({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}

export function hsbToRgb({ h, s, v }) {
  s /= 100;
  v /= 100;
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** c, m, y, k in [0, 100]. */
export function rgbToCmyk({ r, g, b }) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: ((1 - rr - k) / (1 - k)) * 100,
    m: ((1 - gg - k) / (1 - k)) * 100,
    y: ((1 - bb - k) / (1 - k)) * 100,
    k: k * 100,
  };
}

export function cmykToRgb({ c, m, y, k }) {
  const kk = 1 - k / 100;
  return { r: 255 * (1 - c / 100) * kk, g: 255 * (1 - m / 100) * kk, b: 255 * (1 - y / 100) * kk };
}

/**
 * The CMYK conversion of Edit > Convert to CMYK and the Color panel: plain
 * by default; color management swaps in the document's CMYK profile.
 * gamut(rgb) returns the closest printable color when rgb cannot print
 * (null when it can, or without color management).
 */
export const cmykEngine = { toCmyk: rgbToCmyk, toRgb: cmykToRgb, gamut: () => null };

/** Grayscale percentage (0 = white, 100 = black) like the Color panel's K slider. */
export function rgbToGray({ r, g, b }) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return 100 - (lum / 255) * 100;
}

export function grayToRgb(k) {
  const v = 255 * (1 - k / 100);
  return { r: v, g: v, b: v };
}

/** Nearest web-safe color (multiples of 0x33). */
export function webSafe(hex) {
  const { r, g, b } = hexToRgb(hex);
  const q = (v) => Math.round(v / 51) * 51;
  return rgbToHex({ r: q(r), g: q(g), b: q(b) });
}

/** Complement: hue rotated 180 degrees keeping saturation and brightness. */
export function complement(hex) {
  const hsb = rgbToHsb(hexToRgb(hex));
  return rgbToHex(hsbToRgb({ ...hsb, h: (hsb.h + 180) % 360 }));
}

/** Inverse: 255 minus each channel. */
export function invert(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: 255 - r, g: 255 - g, b: 255 - b });
}

export function mix(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}

/** Relative luminance for contrast decisions. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Parse any CSS color the SVG importer may meet into '#rrggbb' (or null for none). */
const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00', teal: '#008080', navy: '#000080',
  purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c', khaki: '#f0e68c',
  beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', tan: '#d2b48c', chocolate: '#d2691e',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkblue: '#00008b',
  darkred: '#8b0000', darkgreen: '#006400', lightblue: '#add8e6', lightgreen: '#90ee90', steelblue: '#4682b4',
  skyblue: '#87ceeb', royalblue: '#4169e1', slategray: '#708090', dimgray: '#696969', whitesmoke: '#f5f5f5',
};

export function parseCssColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  if (s.startsWith('#')) {
    if (/^#[0-9a-f]{8}$/.test(s)) return { hex: s.slice(0, 7), alpha: parseInt(s.slice(7), 16) / 255 };
    if (/^#[0-9a-f]{4}$/.test(s)) return { hex: normalizeHex(s.slice(0, 4)), alpha: parseInt(s[4] + s[4], 16) / 255 };
    return isHex(s) ? { hex: normalizeHex(s), alpha: 1 } : null;
  }
  if (NAMED[s]) return { hex: NAMED[s], alpha: 1 };
  let m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (v) => (v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    const alpha = parts[3] != null ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return { hex: rgbToHex({ r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]) }), alpha };
  }
  m = s.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = parseFloat(parts[0]);
    const sat = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const alpha = parts[3] != null ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    const v = l + sat * Math.min(l, 1 - l);
    const sv = v ? 2 * (1 - l / v) : 0;
    return { hex: rgbToHex(hsbToRgb({ h, s: sv * 100, v: v * 100 })), alpha };
  }
  return null;
}
