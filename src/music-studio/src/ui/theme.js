// Theme: 'system' follows prefers-color-scheme live; 'light' and 'dark' force
// a theme. The resolved theme is on <html data-theme-resolved>.

let media = null;
let current = 'system';

function resolve() {
  const dark = current === 'dark' || (current === 'system' && media?.matches);
  const root = document.documentElement;
  root.dataset.theme = current;
  root.dataset.themeResolved = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#16181b' : '#e9ebee';
}

export function applyTheme(theme = 'system') {
  current = theme;
  if (!media && typeof matchMedia !== 'undefined') {
    media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', () => {
      if (current === 'system') {
        resolve();
        window.dispatchEvent(new CustomEvent('themechange'));
      }
    });
  }
  resolve();
  cache.clear();
  window.dispatchEvent(new CustomEvent('themechange'));
}

export function resolvedTheme() {
  return document.documentElement.dataset.themeResolved || 'dark';
}

const cache = new Map();
if (typeof window !== 'undefined') window.addEventListener('themechange', () => cache.clear());

/** Reads a CSS custom property from :root (for canvas/WebGL drawing), cached per theme. */
export function cssVar(name) {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}

/** Parses a CSS color (hex or rgb/rgba) into [r, g, b, a] in 0..1. */
export function parseColor(str) {
  const s = (str || '').trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
  }
  return [0, 0, 0, 1];
}

/** Font for canvas text: a short stack so drawing never waits on font matching. */
export const CANVAS_FONT = '10px system-ui, -apple-system, sans-serif';
