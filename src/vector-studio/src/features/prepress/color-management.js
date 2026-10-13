/**
 * Color management without ICC profiles: parametric RGB working spaces and
 * press models for CMYK output.
 *
 * RGB spaces are defined by primaries, white point and transfer curve, so
 * colors convert between them exactly (through CIE XYZ).
 *
 * A press model (CMYK "profile") describes a printing condition: the
 * paper's color, the color of each process ink, midtone dot gain, the
 * total ink limit, the black ink limit and how much black replaces the
 * gray part of a color (black generation). From it:
 *   separate(rgb)  -> { c, m, y, k } percentages, as plates would carry them
 *                     (dot gain compensated, ink limited)
 *   simulate(cmyk) -> the RGB a press sheet would show (inks multiply over
 *                     the paper; gain applied)
 * Both are smooth and cheap, so the Separations Preview can run them per
 * pixel and Proof Colors can fit a display filter to them.
 *
 * Color Settings (Edit > Color Settings) live in the preferences under
 * `colorSettings`; a document may carry its own profile in
 * doc.root.colorProfile ('none', or an RGB/CMYK profile id).
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- RGB working spaces ----

const D65 = [0.3127, 0.329];
const SRGB_TRC = {
  decode: (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
  encode: (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
};
const gammaTrc = (g) => ({ decode: (v) => Math.max(0, v) ** g, encode: (v) => Math.max(0, v) ** (1 / g) });

export const RGB_SPACES = {
  srgb: { label: 'sRGB (IEC 61966-2.1)', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: SRGB_TRC },
  p3: { label: 'Display P3', primaries: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: D65, trc: SRGB_TRC },
  rec709: { label: 'Rec. 709 (gamma 2.4)', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: gammaTrc(2.4) },
  rec2020: { label: 'Rec. 2020', primaries: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: D65, trc: gammaTrc(2.4) },
  wide: { label: 'Wide Gamut Print RGB (gamma 2.2)', primaries: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], white: D65, trc: gammaTrc(2.2) },
  mac18: { label: 'Legacy Mac RGB (gamma 1.8)', primaries: [[0.625, 0.34], [0.28, 0.595], [0.155, 0.07]], white: D65, trc: gammaTrc(1.8) },
  monitor: { label: 'Monitor RGB (this display)', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: SRGB_TRC },
};

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const mul3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

const matrixCache = new Map();
/** Linear RGB -> XYZ matrix of a space (row-major 3x3). */
export function rgbToXyzMatrix(id) {
  if (matrixCache.has(id)) return matrixCache.get(id);
  const s = RGB_SPACES[id] || RGB_SPACES.srgb;
  const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
  const [r, g, b] = s.primaries.map(xyz);
  const P = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const S = mul3(inv3(P), xyz(s.white));
  const M = [P[0] * S[0], P[1] * S[1], P[2] * S[2], P[3] * S[0], P[4] * S[1], P[5] * S[2], P[6] * S[0], P[7] * S[1], P[8] * S[2]];
  matrixCache.set(id, M);
  return M;
}

/** Convert [r, g, b] (0..1, encoded) from one RGB space to another, clipping to the destination gamut. */
export function convertRgb(rgb, from, to) {
  if (from === to || !RGB_SPACES[from] || !RGB_SPACES[to]) return rgb.slice(0, 3);
  const a = RGB_SPACES[from];
  const b = RGB_SPACES[to];
  const lin = rgb.map((v) => a.trc.decode(clamp01(v)));
  const xyz = mul3(rgbToXyzMatrix(from), lin);
  const out = mul3(inv3(rgbToXyzMatrix(to)), xyz);
  return out.map((v) => clamp01(b.trc.encode(clamp01(v))));
}

// ---- press models (CMYK profiles) ----

/**
 * Printing conditions. Ink colors are what a solid of the ink looks like on
 * white; paper is the unprinted sheet. gain is the midtone dot gain (a 50%
 * dot prints as 50% + gain * 100%); til the total ink limit (percent); kmax
 * the black ink limit; bg the black generation.
 */
export const CMYK_PROFILES = {
  coatedWeb: {
    label: 'Coated Web Press (300% ink)',
    paper: '#fbfbf8',
    inks: { c: '#0098da', m: '#e5097f', y: '#fde800', k: '#252223' },
    gain: 0.15,
    til: 300,
    kmax: 0.95,
    bg: 'medium',
  },
  coatedSheet: {
    label: 'Coated Sheetfed Press (340% ink)',
    paper: '#fdfdfb',
    inks: { c: '#009fe3', m: '#e6007e', y: '#ffed00', k: '#1d1b1b' },
    gain: 0.12,
    til: 340,
    kmax: 0.98,
    bg: 'medium',
  },
  uncoated: {
    label: 'Uncoated Press (260% ink)',
    paper: '#f6f4ec',
    inks: { c: '#3a95c9', m: '#d4387e', y: '#f4dc33', k: '#3a3737' },
    gain: 0.22,
    til: 260,
    kmax: 0.92,
    bg: 'medium',
  },
  newsprint: {
    label: 'Newsprint (240% ink)',
    paper: '#ebe8de',
    inks: { c: '#4a8fba', m: '#c64a80', y: '#e9d548', k: '#45423f' },
    gain: 0.28,
    til: 240,
    kmax: 0.9,
    bg: 'heavy',
  },
  basic: {
    label: 'Basic CMYK (ideal inks)',
    paper: '#ffffff',
    inks: { c: '#00ffff', m: '#ff00ff', y: '#ffff00', k: '#000000' },
    gain: 0,
    til: 400,
    kmax: 1,
    bg: 'max',
  },
};

export const BLACK_GENERATION = {
  none: { label: 'None', start: 2 },
  light: { label: 'Light', start: 0.45 },
  medium: { label: 'Medium', start: 0.2 },
  heavy: { label: 'Heavy', start: 0 },
  max: { label: 'Maximum', start: -1 },
};

export const PROCESS_INKS = ['c', 'm', 'y', 'k'];
export const INK_NAMES = { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' };

const hex3 = (hex) => {
  const n = parseInt(String(hex || '#000000').slice(1), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export function cmykProfile(id) {
  return CMYK_PROFILES[id] || CMYK_PROFILES.coatedWeb;
}

/** Profile with colors unpacked for fast use. */
const compiled = new Map();
function compile(p) {
  let c = compiled.get(p);
  if (c) return c;
  const inks = PROCESS_INKS.map((k) => hex3(p.inks[k]));
  c = { p, paper: hex3(p.paper), inks, absorb: inks.map((ink) => ink.map((v) => 1 - v)), start: BLACK_GENERATION[p.bg]?.start ?? 0.2, lut: null };
  // The darkest the press prints: black at its limit with the colored inks sharing what the ink limit leaves.
  const rich = Math.min(1, Math.max(0, p.til / 100 - p.kmax) / 3);
  c.richBlack = [rich, rich, rich, p.kmax];
  c.blackRel = simulateRel(c, c.richBlack);
  compiled.set(p, c);
  return c;
}

/** Printed dot area for a plate value v (0..1) with midtone gain g. */
export const dotGain = (v, g) => clamp01(v + g * 4 * v * (1 - v));
const dotGainSlope = (v, g) => 1 + g * 4 * (1 - 2 * v);

/** Plate value that prints as area a under gain g (inverse of dotGain). */
export function compensateGain(a, g) {
  if (g <= 0) return a;
  // g*4*v^2 - (1 + 4g) v + a = 0, smaller root.
  const A = 4 * g;
  const B = -(1 + 4 * g);
  const disc = B * B - 4 * A * a;
  return clamp01((-B - Math.sqrt(Math.max(0, disc))) / (2 * A));
}

/** Press color relative to the paper (paper = white) for plate values [c, m, y, k] (0..1). */
function simulateRel(c, plates) {
  const out = [1, 1, 1];
  for (let i = 0; i < 4; i++) {
    const a = dotGain(clamp01(plates[i]), c.p.gain);
    if (a <= 0) continue;
    const ab = c.absorb[i];
    out[0] *= 1 - a * ab[0];
    out[1] *= 1 - a * ab[1];
    out[2] *= 1 - a * ab[2];
  }
  return out;
}

/**
 * Plates for an RGB color (0..1, relative to the paper). Black comes from
 * the gray component (black generation); the colored inks are then solved
 * so the simulated press color matches (projected Gauss-Newton, which
 * also clips colors outside the press gamut to the nearest printable one).
 * The darkest display color maps to the press's richest black.
 */
function separateExact(c, rgb) {
  const p = c.p;
  const t = [0, 1, 2].map((i) => c.blackRel[i] + clamp01(rgb[i]) * (1 - c.blackRel[i]));
  const gray = 1 - Math.max(clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]));
  const k = Math.min(p.kmax, c.start >= 1 ? 0 : c.start < 0 ? gray * p.kmax : gray * p.kmax * clamp01((gray - c.start) / (1 - c.start)));
  const ka = dotGain(k, p.gain);
  const kf = c.absorb[3].map((ab) => 1 - ka * ab);
  // Solid black ink hides everything under it: no colored ink is needed.
  if (Math.max(kf[0], kf[1], kf[2]) < 1e-3) return [0, 0, 0, k];
  // Start from the plain inversion, then refine.
  let x = [0, 1, 2].map((i) => clamp01(1 - t[i] / Math.max(1e-6, kf[i])));
  for (let it = 0; it < 12; it++) {
    const a = x.map((v) => dotGain(v, p.gain));
    const f = [0, 1, 2].map((ch) => (1 - a[0] * c.absorb[0][ch]) * (1 - a[1] * c.absorb[1][ch]) * (1 - a[2] * c.absorb[2][ch]) * kf[ch]);
    const r = f.map((v, ch) => v - t[ch]);
    if (Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) < 1e-5) break;
    // J[ch][i] = d f_ch / d x_i
    const J = [0, 1, 2].map((ch) => [0, 1, 2].map((i) => {
      const fi = 1 - a[i] * c.absorb[i][ch];
      const d = -c.absorb[i][ch] * dotGainSlope(x[i], p.gain);
      return Math.abs(fi) < 1e-9 ? 0 : (f[ch] / fi) * d;
    }));
    // Normal equations with a little damping keep the step stable near the gamut boundary.
    const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J[0][i] * J[0][j] + J[1][i] * J[1][j] + J[2][i] * J[2][j] + (i === j ? 1e-4 : 0)));
    const g = [0, 1, 2].map((i) => J[0][i] * r[0] + J[1][i] * r[1] + J[2][i] * r[2]);
    const step = solve3(A, g);
    x = x.map((v, i) => clamp01(v - step[i]));
  }
  // Total ink limit: pull the colored inks back.
  const limit = p.til / 100;
  const cs = x[0] + x[1] + x[2];
  if (cs + k > limit && cs > 0) x = x.map((v) => (v * Math.max(0, limit - k)) / cs);
  return [...x, k];
}

function solve3(A, b) {
  const [a, bb, cc, d, e, f, g, h, i] = [A[0][0], A[0][1], A[0][2], A[1][0], A[1][1], A[1][2], A[2][0], A[2][1], A[2][2]];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + cc * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return [0, 0, 0];
  const inv = [e * i - f * h, -(bb * i - cc * h), bb * f - cc * e, -(d * i - f * g), a * i - cc * g, -(a * f - cc * d), d * h - e * g, -(a * h - bb * g), a * e - bb * d];
  return [0, 1, 2].map((r) => (inv[r * 3] * b[0] + inv[r * 3 + 1] * b[1] + inv[r * 3 + 2] * b[2]) / det);
}

const LUT_N = 17;
/** Separation lookup table (LUT_N^3 entries of 4 plates) for per-pixel work. */
function lutOf(c) {
  if (c.lut) return c.lut;
  const n = LUT_N;
  const lut = new Float32Array(n * n * n * 4);
  for (let r = 0; r < n; r++) {
    for (let g = 0; g < n; g++) {
      for (let b = 0; b < n; b++) {
        const v = separateExact(c, [r / (n - 1), g / (n - 1), b / (n - 1)]);
        lut.set(v, ((r * n + g) * n + b) * 4);
      }
    }
  }
  c.lut = lut;
  return lut;
}

/** Plates (0..1) for r, g, b in 0..255 by trilinear lookup, written into out[o..o+3]. */
export function separatePixel(profile, r, g, b, out, o = 0) {
  const c = compile(typeof profile === 'string' ? cmykProfile(profile) : profile);
  const lut = lutOf(c);
  const n1 = LUT_N - 1;
  const fr = (r / 255) * n1;
  const fg = (g / 255) * n1;
  const fb = (b / 255) * n1;
  const r0 = Math.min(n1 - 1, Math.floor(fr));
  const g0 = Math.min(n1 - 1, Math.floor(fg));
  const b0 = Math.min(n1 - 1, Math.floor(fb));
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  for (let ch = 0; ch < 4; ch++) {
    const at = (ri, gi, bi) => lut[(((r0 + ri) * LUT_N + g0 + gi) * LUT_N + b0 + bi) * 4 + ch];
    const c00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * tr;
    const c01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * tr;
    const c10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * tr;
    const c11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * tr;
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    out[o + ch] = c0 + (c1 - c0) * tb;
  }
  return out;
}

/** RGB ([0..1]) -> CMYK percentages for a profile id or object. */
export function separate(rgb, profile = 'coatedWeb') {
  const c = compile(typeof profile === 'string' ? cmykProfile(profile) : profile);
  const v = separateExact(c, rgb);
  return { c: v[0] * 100, m: v[1] * 100, y: v[2] * 100, k: v[3] * 100 };
}

/**
 * CMYK percentages -> the RGB ([0..1]) of the printed color.
 *   paper  true: show the paper's own color (absolute); false: paper is white
 *   black  true: show the press's real black; false: its richest black maps to black
 */
export function simulate(cmyk, profile = 'coatedWeb', { paper = false, black = false } = {}) {
  const c = compile(typeof profile === 'string' ? cmykProfile(profile) : profile);
  let out = simulateRel(c, [cmyk.c / 100, cmyk.m / 100, cmyk.y / 100, cmyk.k / 100]);
  if (!black) out = out.map((v, i) => clamp01((v - c.blackRel[i]) / Math.max(1e-6, 1 - c.blackRel[i])));
  if (paper) out = out.map((v, i) => v * c.paper[i]);
  return out;
}

/** Simulated press color for plate values (0..1) relative to the paper, black as printed: the per-pixel path. */
export function simulatePlates(profile, plates) {
  return simulateRel(compile(typeof profile === 'string' ? cmykProfile(profile) : profile), plates);
}

/** Ink colors and paper of a profile as [r, g, b] in 0..1. */
export function profileColors(profile) {
  const c = compile(typeof profile === 'string' ? cmykProfile(profile) : profile);
  return { paper: c.paper, inks: c.inks };
}

// ---- rendering intents ----

export const INTENTS = {
  perceptual: 'Perceptual',
  saturation: 'Saturation',
  relative: 'Relative Colorimetric',
  absolute: 'Absolute Colorimetric',
};

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Show an RGB color as it would print: separate, then simulate with the
 * intent. Perceptual compresses saturated colors a little before
 * separating so out-of-gamut detail survives; saturation keeps vivid
 * colors vivid; absolute shows the paper; black point compensation maps
 * the press black to display black.
 */
export function proofCmyk(rgb, profile, { intent = 'relative', bpc = true, paper = false, black = false } = {}) {
  let src = rgb;
  if (intent === 'perceptual') {
    const l = lum(rgb);
    src = rgb.map((v) => l + (v - l) * 0.9);
  }
  const plates = separate(src, profile);
  let out = simulate(plates, profile, { paper: paper || intent === 'absolute', black: black || !bpc });
  if (intent === 'saturation') {
    const l = lum(out);
    out = out.map((v) => clamp01(l + (v - l) * 1.12));
  }
  return out;
}

// ---- color settings ----

export const POLICIES = {
  off: 'Off',
  preserve: 'Preserve Embedded Profiles',
  convert: 'Convert to Working Space',
  preserveNumbers: 'Preserve Numbers (Ignore Linked Profiles)',
};

export const DEFAULT_COLOR_SETTINGS = Object.freeze({
  preset: 'general',
  rgb: 'srgb',
  cmyk: 'coatedWeb',
  policyRgb: 'preserve',
  policyCmyk: 'preserveNumbers',
  askOpen: false,
  askPaste: false,
  askMissing: false,
  intent: 'relative',
  bpc: true,
});

/** Named color settings (presets). Values override the defaults. */
export const COLOR_SETTING_PRESETS = {
  general: { label: 'General Purpose (print and screen)', values: {} },
  prepress: { label: 'Commercial Prepress', values: { cmyk: 'coatedSheet', policyCmyk: 'preserve', askOpen: true, askPaste: true, askMissing: true } },
  uncoated: { label: 'Uncoated Print', values: { cmyk: 'uncoated' } },
  news: { label: 'Newspaper', values: { cmyk: 'newsprint', policyCmyk: 'preserve', askOpen: true, askMissing: true } },
  screen: { label: 'Screen and Web', values: { policyRgb: 'convert', policyCmyk: 'preserve', intent: 'perceptual' } },
  wide: { label: 'Wide Gamut Displays', values: { rgb: 'p3', intent: 'perceptual' } },
  unmanaged: { label: 'Monitor Color (unmanaged)', values: { rgb: 'monitor', cmyk: 'basic', policyRgb: 'off', policyCmyk: 'off', bpc: false } },
};

const SETTING_KEYS = Object.keys(DEFAULT_COLOR_SETTINGS);

/** Clean settings: known keys only, valid values, the matching preset name (or 'custom'). */
export function normalizeColorSettings(v = {}) {
  const out = { ...DEFAULT_COLOR_SETTINGS };
  for (const k of SETTING_KEYS) if (v[k] !== undefined) out[k] = v[k];
  if (!RGB_SPACES[out.rgb]) out.rgb = DEFAULT_COLOR_SETTINGS.rgb;
  if (!CMYK_PROFILES[out.cmyk]) out.cmyk = DEFAULT_COLOR_SETTINGS.cmyk;
  if (!['off', 'preserve', 'convert'].includes(out.policyRgb)) out.policyRgb = DEFAULT_COLOR_SETTINGS.policyRgb;
  if (!POLICIES[out.policyCmyk]) out.policyCmyk = DEFAULT_COLOR_SETTINGS.policyCmyk;
  if (!INTENTS[out.intent]) out.intent = DEFAULT_COLOR_SETTINGS.intent;
  for (const k of ['askOpen', 'askPaste', 'askMissing', 'bpc']) out[k] = Boolean(out[k]);
  out.preset = matchPreset(out);
  return out;
}

/** Settings of a preset. */
export function presetSettings(id) {
  const p = COLOR_SETTING_PRESETS[id];
  return p ? { ...DEFAULT_COLOR_SETTINGS, ...p.values, preset: id } : null;
}

function matchPreset(s) {
  for (const id of Object.keys(COLOR_SETTING_PRESETS)) {
    const p = presetSettings(id);
    if (SETTING_KEYS.every((k) => k === 'preset' || p[k] === s[k])) return id;
  }
  return 'custom';
}

export function colorSettings(app) {
  return normalizeColorSettings(app?.prefs?.get('colorSettings') || {});
}

/** The CMYK profile id output uses for a document: its assigned profile, else the working CMYK. */
export function documentCmykProfile(app, doc) {
  const p = doc?.root?.colorProfile;
  if (p && CMYK_PROFILES[p]) return p;
  if (p === 'none') return 'basic';
  return colorSettings(app).cmyk;
}

/** The RGB space of a document: its assigned profile, else the working RGB. */
export function documentRgbSpace(app, doc) {
  const p = doc?.root?.colorProfile;
  if (p && RGB_SPACES[p]) return p;
  if (p === 'none') return 'monitor';
  return colorSettings(app).rgb;
}

/** Label of a document's profile for status lines (Document Info, title bars). */
export function documentProfileLabel(app, doc) {
  const p = doc?.root?.colorProfile;
  if (p === 'none') return 'Not color managed';
  if (doc?.root?.colorMode === 'CMYK') return cmykProfile(documentCmykProfile(app, doc)).label;
  return RGB_SPACES[documentRgbSpace(app, doc)].label;
}

/** Plate values (0..1, [c, m, y, k]) for an RGB color (0..1). */
export function platesFor(rgb, profile = 'coatedWeb') {
  return separateExact(compile(typeof profile === 'string' ? cmykProfile(profile) : profile), rgb);
}

/** The press black point relative to the paper ([r, g, b], 0..1). */
export function blackPoint(profile = 'coatedWeb') {
  return compile(typeof profile === 'string' ? cmykProfile(profile) : profile).blackRel.slice();
}

const lutCache = new Map();
/**
 * A 3D lookup table for the GPU: n^3 RGBA bytes, red fastest, holding
 * fn([r, g, b]) (up to 4 values in 0..1). Cached by `key`.
 */
export function buildLut(key, n, fn) {
  if (key && lutCache.has(key)) return lutCache.get(key);
  const data = new Uint8Array(n * n * n * 4);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const v = fn([r / (n - 1), g / (n - 1), b / (n - 1)]);
        const o = ((b * n + g) * n + r) * 4;
        data[o] = Math.round(clamp01(v[0]) * 255);
        data[o + 1] = Math.round(clamp01(v[1]) * 255);
        data[o + 2] = Math.round(clamp01(v[2]) * 255);
        data[o + 3] = v.length > 3 ? Math.round(clamp01(v[3]) * 255) : 255;
      }
    }
  }
  const lut = { n, data };
  if (key) {
    if (lutCache.size > 16) lutCache.delete(lutCache.keys().next().value);
    lutCache.set(key, lut);
  }
  return lut;
}
