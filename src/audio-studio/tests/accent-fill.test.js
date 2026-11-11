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

  it('keeps white text at 4.5:1 on every accent fill in both themes', () => {
    for (const a of ACCENTS.filter((x) => x.id !== 'blue')) {
      for (const theme of ['dark', 'light']) {
        const vars = appearanceVars(prefs({ accentColor: a.id }), theme);
        expect(vars['--accent']).toBe(a[theme]);
        expect(whiteContrast(vars['--accent-fill'])).toBeGreaterThanOrEqual(4.5);
        expect(whiteContrast(vars['--accent-fill-hover'])).toBeGreaterThanOrEqual(4.5);
      }
      // Light-theme accents that already pass keep their own fill and hover colors.
      const light = appearanceVars(prefs({ accentColor: a.id }), 'light');
      if (whiteContrast(a.light) >= 4.5) {
        expect(light['--accent-fill']).toBe(a.light);
        expect(light['--accent-fill-hover']).toBe(light['--accent-strong']);
      } else expect(light['--accent-fill']).not.toBe(a.light);
    }
    // The default (blue) light theme fills with the accent tokens themselves.
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/tokens.css`, 'utf8');
    const light = css.slice(css.indexOf(":root[data-theme-resolved='light']"));
    const token = (name) => light.match(new RegExp(`${name}: (#[0-9a-f]{6});`))[1];
    expect(whiteContrast(token('--accent'))).toBeGreaterThanOrEqual(4.5);
    expect(whiteContrast(token('--accent-strong'))).toBeGreaterThanOrEqual(4.5);
  });
});
