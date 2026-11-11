// White text on accent fills (primary buttons, highlighted menu items) stays readable.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { appearanceVars, whiteContrast, ACCENTS } from '../src/ui/appearance.js';

const prefs = (values) => ({ get: (k) => values[k] });

describe('accent fills', () => {
  it('uses a deeper dark-theme fill for the default accent, leaving the accent alone', () => {
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/tokens.css`, 'utf8');
    const dark = css.slice(0, css.indexOf("data-theme-resolved='light'"));
    const token = (name) => dark.match(new RegExp(`${name}: (#[0-9a-f]{6});`))[1];
    expect(token('--accent')).toBe('#2d8ceb');
    expect(whiteContrast(token('--accent-fill'))).toBeGreaterThanOrEqual(4.5);
    expect(whiteContrast(token('--accent-fill-hover'))).toBeGreaterThanOrEqual(4.5);
    const base = fs.readFileSync(`${import.meta.dirname}/../src/styles/base.css`, 'utf8');
    expect(base).toMatch(/\.btn\.primary \{\s*background: var\(--accent-fill\);/);
    expect(base).toMatch(
      /\.btn\.primary:hover:not\(:disabled\) \{\s*background: var\(--accent-fill-hover\);/,
    );
  });

  it('deepens every other accent in the dark theme and keeps light-theme fills as the accent', () => {
    for (const a of ACCENTS.filter((x) => x.id !== 'blue')) {
      const dark = appearanceVars(prefs({ accentColor: a.id }), 'dark');
      expect(dark['--accent']).toBe(a.dark);
      expect(whiteContrast(dark['--accent-fill'])).toBeGreaterThanOrEqual(4.5);
      expect(whiteContrast(dark['--accent-fill-hover'])).toBeGreaterThanOrEqual(4.5);
      const light = appearanceVars(prefs({ accentColor: a.id }), 'light');
      expect(light['--accent-fill']).toBe(a.light);
    }
  });
});
