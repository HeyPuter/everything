import { syncUserMenuTheme } from './usermenu.js';

const LS_KEY = 'signatures:theme';
const LIGHT = '#f6f6f4';
const DARK = '#101013';

/** 'system' removes the stamp so the OS preference decides. */
export function applyTheme(mode) {
  const rootEl = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    rootEl.dataset.theme = mode;
  } else {
    delete rootEl.dataset.theme;
  }
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem(LS_KEY, mode);
    else localStorage.removeItem(LS_KEY);
  } catch {}
  updateThemeColorMeta();
  syncUserMenuTheme();
}

export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

function updateThemeColorMeta() {
  const dark = currentTheme() === 'dark' ||
    (currentTheme() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.setAttribute('content', dark ? DARK : LIGHT);
  }
}

if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColorMeta);
}
