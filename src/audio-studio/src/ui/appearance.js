// Appearance preferences beyond the light/dark theme: interface brightness,
// the accent color and the editor colors (waveform, background, selection,
// playhead and markers by type). They are applied as inline custom properties
// on <html>, over the theme tokens in tokens.css, and re-applied when the
// resolved theme changes. Canvas and WebGL drawing reads the same properties
// through cssVar(), so a 'themechange' event repaints.

import { resolvedTheme, parseColor, cssVar } from './theme.js';

/** Accent presets: [dark theme, light theme] colors. 'blue' is the default look. */
export const ACCENTS = [
  { id: 'blue', label: 'Blue', dark: '#2d8ceb', light: '#1473e6' },
  { id: 'violet', label: 'Violet', dark: '#8f6cf0', light: '#6d48d8' },
  { id: 'teal', label: 'Teal', dark: '#1fb5a5', light: '#0d8478' },
  { id: 'amber', label: 'Amber', dark: '#e0962b', light: '#b06a0b' },
  { id: 'rose', label: 'Rose', dark: '#e2577f', light: '#c0335c' },
  { id: 'graphite', label: 'Graphite', dark: '#8a96a8', light: '#55606f' },
];

/**
 * Editor colors a user can set (Preferences > Appearance), with the theme
 * token each one starts from. The waveColors preference holds { field: '#hex' }.
 */
export const EDITOR_COLORS = [
  { field: 'wave', label: 'Waveform', token: '--wave' },
  { field: 'background', label: 'Waveform Background', token: '--bg-editor' },
  { field: 'selection', label: 'Selection', token: '--sel-edge' },
  { field: 'playhead', label: 'Playhead', token: '--playhead' },
  { field: 'cue', label: 'Cue Markers', token: '--marker' },
  { field: 'subclip', label: 'Subclip Markers', token: '--marker' },
  { field: 'cart', label: 'Cart Timer Markers', token: '--marker' },
  { field: 'cd', label: 'CD Track Markers', token: '--marker' },
];
export const COLOR_FIELDS = EDITOR_COLORS.map((c) => c.field);

/** Built-in color sets; missing or `null` colors follow the theme. */
export const WAVE_PRESETS = [
  { name: 'Theme Colors' },
  { name: 'Phosphor', wave: '#46e8a8', selection: '#ffffff', background: '#030806', playhead: '#ff5a4e', cue: '#f4f4f4', subclip: '#6aa2f0', cart: '#a8f0b8', cd: '#f0c060' },
  { name: 'Deep Sea', wave: '#5cb8ff', selection: '#d6ecff', background: '#06111d', playhead: '#ffb347', cue: '#ffe08a', subclip: '#9fd0ff', cart: '#8ff0d8', cd: '#ff9fc8' },
  { name: 'Ember', wave: '#ffae4a', selection: '#fff1d9', background: '#120a02', playhead: '#4fc3ff', cue: '#fff6e0', subclip: '#ffd27a', cart: '#c7f07a', cd: '#ff8a7a' },
  { name: 'Orchid', wave: '#e28cf5', selection: '#fbe8ff', background: '#120716', playhead: '#7cf0c0', cue: '#ffffff', subclip: '#a8b8ff', cart: '#ffd0f0', cd: '#ffd27a' },
  { name: 'Ink on Paper', wave: '#24303f', selection: '#2f6fe0', background: '#fbfaf5', playhead: '#d0312d', cue: '#9a6a00', subclip: '#2f6fe0', cart: '#1f8a4c', cd: '#8a3fb0' },
];

/** Text colors kept readable on the surfaces when the brightness setting moves them closer. */
export const TEXT_TOKENS = [
  '--text-strong',
  '--text',
  '--text-dim',
  '--text-faint',
  '--accent-strong',
  '--hot',
];
const TEXT_SURFACES = ['--bg-app', '--bg-panel', '--bg-panel-alt', '--bg-raised', '--bg-input'];

/** Surface tokens that the brightness setting lightens or darkens. */
export const BRIGHTNESS_TOKENS = ['--bg-app', '--bg-panel', '--bg-panel-alt', '--bg-raised', '--bg-input', '--bg-hover', '--bg-active', '--bg-track', '--bg-track-alt', '--bg-ruler', '--border', '--border-soft', '--divider'];

const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** '#rrggbb' from a CSS color string. */
export function toHex(color) {
  const [r, g, b] = parseColor(color);
  return `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}`;
}

function rgba(color, a) {
  const [r, g, b] = parseColor(color);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/** Mixes two colors: t = 0 gives `a`, 1 gives `b`. */
export function mixColors(a, b, t) {
  const x = parseColor(a);
  const y = parseColor(b);
  return `#${hex2((x[0] + (y[0] - x[0]) * t) * 255)}${hex2((x[1] + (y[1] - x[1]) * t) * 255)}${hex2((x[2] + (y[2] - x[2]) * t) * 255)}`;
}

const luminance = (color) => {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = parseColor(color);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** Contrast ratio of two colors (1 to 21). */
export function contrastRatio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Contrast ratio of white text on `color`. */
export function whiteContrast(color) {
  return 1.05 / (luminance(color) + 0.05);
}

/** `color` deepened just enough (toward black) for white text to reach 4.5:1. */
export function fillForWhiteText(color) {
  for (let t = 0; t < 1; t += 0.02) {
    const c = mixColors(color, '#000000', t);
    if (whiteContrast(c) >= 4.6) return c;
  }
  return '#000000';
}

/** Valid '#rgb' / '#rrggbb' string or null. */
export function cleanColor(v) {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
}

/** Brightness preference as -100..100 (0 = the theme as designed). */
export function brightnessOf(prefs) {
  const v = Number(prefs.get('uiBrightness'));
  return Number.isFinite(v) ? Math.max(-100, Math.min(100, Math.round(v))) : 0;
}

/**
 * A surface color at a brightness: positive values blend toward white,
 * negative toward black. Light themes darken less so text stays readable.
 */
export function brighten(color, brightness, theme = 'dark') {
  if (!brightness) return toHex(color);
  if (brightness > 0) return mixColors(color, '#ffffff', (brightness / 100) * 0.3);
  return mixColors(color, '#000000', (-brightness / 100) * (theme === 'light' ? 0.3 : 0.7));
}

/**
 * Custom properties for the current preferences and theme: { name: value }
 * (an empty object means the theme tokens apply unchanged). `base(name)`
 * gives a theme token's own value; brightness is computed from it.
 */
export function appearanceVars(prefs, theme = resolvedTheme(), base = () => '') {
  const vars = {};
  const accent = ACCENTS.find((a) => a.id === prefs.get('accentColor'));
  if (accent && accent.id !== 'blue') {
    const b = theme === 'light' ? accent.light : accent.dark;
    const strong = theme === 'light' ? mixColors(b, '#000000', 0.15) : mixColors(b, '#ffffff', 0.18);
    Object.assign(vars, {
      '--accent': b,
      '--accent-strong': strong,
      '--accent-soft': rgba(b, theme === 'light' ? 0.16 : 0.22),
      '--hot': strong,
      '--focus': theme === 'light' ? b : mixColors(b, '#ffffff', 0.25),
      '--cti': b,
    });
    // White text sits on these fills: dark-theme accents are deepened to keep it readable.
    // In the light theme only accents below 4.5:1 change; the others keep their own colors.
    const keep = theme === 'light' && whiteContrast(b) >= 4.5;
    const fill = keep ? b : fillForWhiteText(b);
    vars['--accent-fill'] = fill;
    vars['--accent-fill-hover'] = keep ? strong : mixColors(fill, '#000000', 0.1);
  }
  const bright = brightnessOf(prefs);
  if (bright) {
    for (const name of BRIGHTNESS_TOKENS) {
      const v = base(name);
      if (v) vars[name] = brighten(v, bright, theme);
    }
    // Surfaces moved toward the text color (lighter in the dark theme, darker in
    // the light one): the text moves away until it reads as well as before, at
    // least up to 4.5:1.
    const surfaces = TEXT_SURFACES.filter((n) => base(n) && vars[n]);
    const away = theme === 'light' ? '#000000' : '#ffffff';
    const worst = (c, of) => Math.min(...surfaces.map((n) => contrastRatio(c, of(n))));
    for (const name of surfaces.length ? TEXT_TOKENS : []) {
      const v = vars[name] || base(name);
      if (!v) continue;
      const want = Math.min(4.5, worst(v, base));
      let c = v;
      for (let t = 0.02; worst(c, (n) => vars[n]) < want && t < 1.01; t += 0.02) {
        c = mixColors(v, away, Math.min(1, t));
      }
      if (c !== v) vars[name] = c;
    }
  }
  const w = prefs.get('waveColors') || {};
  const wave = cleanColor(w.wave);
  const sel = cleanColor(w.selection);
  const bg = cleanColor(w.background);
  if (bg) vars['--bg-editor'] = bg;
  if (wave) {
    vars['--wave'] = wave;
    vars['--wave-dim'] = mixColors(wave, bg || (theme === 'light' ? '#fbfbfb' : '#050505'), 0.55);
  }
  if (sel) {
    vars['--wave-sel'] = sel;
    vars['--sel-bg'] = rgba(sel, 0.24);
    vars['--sel-edge'] = rgba(sel, 0.6);
  }
  const playhead = cleanColor(w.playhead);
  if (playhead) {
    vars['--playhead'] = playhead;
    vars['--cti'] = playhead;
  }
  const cue = cleanColor(w.cue);
  if (cue) {
    vars['--marker'] = cue;
    vars['--marker-range'] = rgba(cue, theme === 'light' ? 0.16 : 0.18);
  }
  for (const type of ['subclip', 'cart', 'cd']) {
    const c = cleanColor(w[type]);
    if (c) vars[`--marker-${type}`] = c;
  }
  return vars;
}

/** Drawing color for a marker of `type` (cue markers and unset types use --marker). */
export function markerColor(type) {
  return (type && type !== 'cue' && cssVar(`--marker-${type}`)) || cssVar('--marker');
}

const APPLIED = ['--text-strong', '--text', '--text-dim', '--text-faint', '--accent', '--accent-strong', '--accent-soft', '--accent-fill', '--accent-fill-hover', '--hot', '--focus', '--cti', '--bg-editor', '--wave', '--wave-dim', '--wave-sel', '--sel-bg', '--sel-edge', '--playhead', '--marker', '--marker-range', '--marker-subclip', '--marker-cart', '--marker-cd', ...BRIGHTNESS_TOKENS];
let lastKey = '';

/** Writes the appearance properties onto <html>; repaints (via 'themechange') when they changed. */
export function applyAppearance(prefs) {
  if (typeof document === 'undefined') return;
  const theme = resolvedTheme();
  const key = JSON.stringify([theme, prefs.get('accentColor'), prefs.get('waveColors'), brightnessOf(prefs)]);
  if (key === lastKey) return;
  lastKey = key;
  const root = document.documentElement;
  for (const name of APPLIED) root.style.removeProperty(name);
  // With the overrides gone, computed values are the theme's own tokens.
  const computed = getComputedStyle(root);
  const vars = appearanceVars(prefs, theme, (name) => computed.getPropertyValue(name).trim());
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  window.dispatchEvent(new CustomEvent('themechange'));
}

/** Keeps the appearance applied as preferences and the resolved theme change. */
export function installAppearance(app) {
  applyAppearance(app.prefs);
  app.prefs.on('change', (key) => {
    if (key === 'accentColor' || key === 'waveColors' || key === 'theme' || key === 'uiBrightness') applyAppearance(app.prefs);
  });
  // A system light/dark switch changes which accent shade applies.
  window.addEventListener('themechange', () => applyAppearance(app.prefs));
}
