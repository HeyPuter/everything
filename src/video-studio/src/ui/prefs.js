/** Per-device UI preferences in localStorage (theme, panel sizes, toggles). */
const KEY = 'video-studio:prefs';
const DEFAULTS = {
  leftW: 440,
  rightW: 360,
  upperH: 0.56,
  toggles: { ripple: true, snap: true, linkOverlays: true, hoverPreview: false },
  assetsTab: 'media',
  homeView: 'grid',
  homeSort: 'modified',
  zoom: null,
  exportSettings: null,
};

let cache = null;

export function prefs() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setPref(key, value) {
  prefs()[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode or quota: preferences just do not persist */
  }
}

// Theme lives under its own key so index.html can apply it before first paint.
const THEME_KEY = 'video-studio:theme';

export function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'dark';
  } catch {
    return 'dark';
  }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set();

export function resolvedTheme(theme = getTheme()) {
  if (theme === 'dark' || theme === 'light') return theme;
  return media?.matches ? 'dark' : 'light';
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeResolved = resolvedTheme(theme);
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  const color = resolvedTheme(theme) === 'dark' ? '#121212' : '#f4f4f5';
  meta.forEach((m) => m.setAttribute('content', color));
  // puter.js's <puter-user-menu> (see user-menu.js) follows an explicit Light or Dark; System leaves it to the OS.
  document.querySelectorAll('puter-user-menu').forEach((m) => (theme === 'light' || theme === 'dark' ? m.setAttribute('theme', theme) : m.removeAttribute('theme')));
  listeners.forEach((fn) => fn(resolvedTheme(theme)));
}

export function setTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media?.addEventListener?.('change', () => {
  if (getTheme() === 'system') applyTheme('system');
});
