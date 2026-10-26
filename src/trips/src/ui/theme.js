const listeners = new Set();
const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const valid = (value) => ['light', 'dark'].includes(value) ? value : 'system';
export function currentTheme() { return valid(document.documentElement.dataset.theme); }
export function isDark() { return currentTheme() === 'dark' || (currentTheme() === 'system' && Boolean(media?.matches)); }
function notify() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const color = style.getPropertyValue('--page').trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (currentTheme() === 'system') {
      if (meta.dataset.media) meta.setAttribute('media', meta.dataset.media);
      meta.content = style.getPropertyValue(meta.media.includes('dark') ? '--page-dark' : '--page-light').trim();
    } else { meta.removeAttribute('media'); meta.content = color; }
  }
  for (const listener of listeners) listener({ theme: currentTheme(), dark: isDark() });
}
export function applyTheme(value, { persist = true } = {}) {
  const theme = valid(value);
  for (const meta of document.querySelectorAll('meta[name="theme-color"][media]')) meta.dataset.media = meta.media;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem('trips:theme', theme); } catch { /* Storage may be disabled. */ } }
  notify();
}
export function onThemeChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
media?.addEventListener('change', () => { if (currentTheme() === 'system') notify(); });
