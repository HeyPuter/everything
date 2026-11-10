// Light, dark and system themes. The choice is resolved before first paint by
// an inline script in index.html; this module keeps it in sync afterwards.

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'parametric:theme';

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function resolvedTheme(choice = getThemeChoice()): 'light' | 'dark' {
  return choice === 'dark' || (choice === 'system' && !!media?.matches) ? 'dark' : 'light';
}

/** Browser toolbar colours (index.html), which otherwise follow the system theme, not the choice. */
const TOOLBAR = { light: '#f7f8fa', dark: '#1f2226' };

export function applyTheme(choice: ThemeChoice = getThemeChoice()) {
  const root = document.documentElement;
  const resolved = resolvedTheme(choice);
  root.dataset.theme = choice;
  root.dataset.themeResolved = resolved;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = choice === 'system' ? TOOLBAR[meta.media.includes('dark') ? 'dark' : 'light'] : TOOLBAR[resolved];
  }
  window.dispatchEvent(new CustomEvent('themechange'));
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable: still apply for this session */
  }
  applyTheme(choice);
}

media?.addEventListener('change', () => {
  if (getThemeChoice() === 'system') applyTheme('system');
});

// The choice made in another tab applies to this one too.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) applyTheme();
  });
}

/** Reads a CSS colour token as linear 0..1 RGB for the renderer. */
export function cssColor(name: string, el: Element = document.documentElement): [number, number, number] {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return parseColor(v);
}

export function parseColor(v: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(v);
  if (rgb) {
    const p = rgb[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255];
  }
  return [0.5, 0.5, 0.5];
}

export function toHex(c: [number, number, number]): string {
  return '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
}
