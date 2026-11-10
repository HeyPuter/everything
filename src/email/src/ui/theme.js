/** Light / dark / system theme. System is the default: no attribute, no key. */

import { syncUserMenuTheme } from './usermenu.js';

const LS_KEY = 'puter-mail:theme';

export const THEMES = [
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

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
    m.setAttribute('content', dark ? '#131314' : '#f8fafd');
  }
}

/**
 * The document ships a theme-color per colour scheme, which is the right
 * answer only while the theme follows the system. An explicit light or dark
 * choice is applied before this module's first caller runs -- by the inline
 * script in index.html, so there is no flash -- and nothing told the browser
 * about it, so the address bar and status bar stayed light behind a dark app
 * (and dark behind a light one) until the theme menu was touched.
 */
updateThemeColorMeta();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColorMeta);
