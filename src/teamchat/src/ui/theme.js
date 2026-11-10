import { syncUserMenuTheme } from './usermenu.js';

const LS_KEY = 'teamchat:theme';

export function applyTheme(mode) {
  const rootEl = document.documentElement;
  if (mode === 'light' || mode === 'dark') rootEl.dataset.theme = mode;
  else delete rootEl.dataset.theme;
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem(LS_KEY, mode);
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* storage unavailable */
  }
  updateThemeColorMeta();
  syncUserMenuTheme();
}

export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function isDark() {
  return currentTheme() === 'dark'
    || (currentTheme() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function updateThemeColorMeta() {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.setAttribute('content', isDark() ? '#0f0f10' : '#f7f7f5');
  }
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColorMeta);

// The page's theme is stamped before the first paint by a script in
// index.html, from what was chosen on this device; the browser's own colour
// for the bars round the page (the title bar of the installed app, a phone's
// status bar) comes from two metas bound to the system's scheme, which know
// nothing of that stamp. Brought in step here, as the modules load: a dark
// theme chosen on a light system stood under a light bar on the sign-in page,
// and in the app for as long as the account's preferences took to arrive
// (or for good, when the choice had been kept on this device alone).
updateThemeColorMeta();
