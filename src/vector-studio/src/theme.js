/**
 * Theme: interface brightness. 'system' follows prefers-color-scheme live
 * (dark or light); 'dark', 'medium-dark', 'medium-light' and 'light' force a
 * level. <html data-brightness> holds the level and <html data-theme-resolved>
 * the light/dark family it belongs to (what canvas colors and icons key on).
 */
let media = null;
let current = 'system';

/** Brightness levels, darkest first, with their light/dark family. */
export const BRIGHTNESS_LEVELS = [
  { value: 'dark', label: 'Dark', family: 'dark' },
  { value: 'medium-dark', label: 'Medium Dark', family: 'dark' },
  { value: 'medium-light', label: 'Medium Light', family: 'light' },
  { value: 'light', label: 'Light', family: 'light' },
];

/** Theme preference values with menu labels ('system' first). */
export const THEME_OPTIONS = [{ value: 'system', label: 'Use System Setting' }, ...BRIGHTNESS_LEVELS.map(({ value, label }) => ({ value, label }))];

function resolve() {
  const level = BRIGHTNESS_LEVELS.find((l) => l.value === current);
  const dark = level ? level.family === 'dark' : Boolean(media?.matches);
  const root = document.documentElement;
  root.dataset.theme = level ? current : 'system';
  root.dataset.themeResolved = dark ? 'dark' : 'light';
  root.dataset.brightness = level ? current : dark ? 'dark' : 'light';
  try {
    localStorage.setItem('vector-studio:theme', current);
  } catch {
    // Storage unavailable: the theme still applies for this session.
  }
}

export function applyTheme(theme = 'system') {
  current = BRIGHTNESS_LEVELS.some((l) => l.value === theme) ? theme : 'system';
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
  window.dispatchEvent(new CustomEvent('themechange'));
}

export function resolvedTheme() {
  return document.documentElement.dataset.themeResolved || 'light';
}

/** The interface brightness level in effect ('dark' ... 'light'). */
export function brightness() {
  return document.documentElement.dataset.brightness || resolvedTheme();
}
