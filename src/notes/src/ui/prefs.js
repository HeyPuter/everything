/** Per-device UI preferences in localStorage (theme, pane widths, view). */
const KEY = 'notes:prefs';
const DEFAULTS = {
  sectionsWidth: 168,
  pagesWidth: 168,
  navVisible: true,
  pagesVisible: true,
  ribbonCollapsed: false,
  pageSort: 'manual',
  zoom: 1,
  surface: 'auto',
  lastPage: null,
  lastNotebook: null,
  lastSection: null,
  sectionPages: {},
  pens: null,
  defaultRules: null,
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
export function getTheme() {
  try {
    return localStorage.getItem('notes:theme') || 'system';
  } catch {
    return 'system';
  }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const themeListeners = new Set();

export function resolvedTheme(theme = getTheme()) {
  if (theme === 'dark' || theme === 'light') return theme;
  return media?.matches ? 'dark' : 'light';
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeResolved = resolvedTheme(theme);
  // The browser's toolbar and an installed app's title bar follow the
  // app's theme, not only the system's (index.html has one per scheme).
  const bar = root.dataset.themeResolved === 'dark' ? '#1c1c1c' : '#f5f5f5';
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', bar);
  for (const fn of themeListeners) fn(root.dataset.themeResolved);
}

export function setTheme(theme) {
  try {
    localStorage.setItem('notes:theme', theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function onThemeChange(fn) {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

media?.addEventListener?.('change', () => {
  if (getTheme() === 'system') applyTheme('system');
});
