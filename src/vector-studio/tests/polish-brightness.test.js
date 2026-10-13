import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { applyTheme, brightness, resolvedTheme, BRIGHTNESS_LEVELS } from '../src/theme.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', 'tokens.css'), 'utf8');

/** Tokens in effect for each brightness level (base + family + level overrides). */
function levelTokens() {
  const block = (sel) => {
    const at = css.indexOf(`${sel} {`);
    if (at < 0) return {};
    const body = css.slice(at, css.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  };
  const base = block(':root');
  const light = { ...base, ...block(":root[data-theme-resolved='light']") };
  const dark = { ...base, ...block(":root[data-theme-resolved='dark']") };
  return {
    dark,
    'medium-dark': { ...dark, ...block(":root[data-brightness='medium-dark']") },
    'medium-light': { ...light, ...block(":root[data-brightness='medium-light']") },
    light,
  };
}

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

afterEach(() => applyTheme('system'));

describe('interface brightness levels', () => {
  it('sets the level and its light or dark family', () => {
    for (const { value, family } of BRIGHTNESS_LEVELS) {
      applyTheme(value);
      expect(brightness()).toBe(value);
      expect(resolvedTheme()).toBe(family);
    }
    applyTheme('system'); // jsdom: the system is light
    expect(brightness()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('system');
    applyTheme('bogus');
    expect(document.documentElement.dataset.theme).toBe('system');
  });

  for (const [level, t] of Object.entries(levelTokens())) {
    it(`${level}: text, links and focus keep enough contrast on every surface`, () => {
      for (const fg of ['--text', '--text-2', '--text-3']) {
        for (const bg of ['--bg-app', '--bg-topbar', '--bg-panel', '--bg-panel-2', '--bg-elev', '--bg-input']) {
          expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const bg of ['--bg-app', '--bg-panel', '--bg-elev']) expect(contrast(t['--link'], t[bg]), `link on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // Focus rings and control borders are non-text: 3:1 against the panel.
      expect(contrast(t['--focus'], t['--bg-panel'])).toBeGreaterThanOrEqual(3);
      expect(contrast(t['--on-accent'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('brightness in Preferences > User Interface and the Window menu', () => {
  it('previews a level, restores it on Cancel and saves it on OK', async () => {
    const app = await bootAppWithFeatures();
    app.prefs.set('theme', 'light');
    applyTheme('light');
    let done = app.commands.run('edit.preferences.ui');
    await tick();
    let dlg = document.querySelector('dialog[open]');
    const group = dlg.querySelector('.brightness-swatches[role="radiogroup"]');
    expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    const radios = [...group.querySelectorAll('input[type="radio"]')];
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Dark', 'Medium Dark', 'Medium Light', 'Light']);
    expect(radios[3].checked).toBe(true);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change'));
    expect(brightness()).toBe('medium-dark');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await done;
    expect(brightness()).toBe('light');
    expect(app.prefs.get('theme')).toBe('light');

    done = app.commands.run('edit.preferences.ui');
    await tick();
    dlg = document.querySelector('dialog[open]');
    const ml = dlg.querySelector('input[type="radio"][value="medium-light"]');
    ml.checked = true;
    ml.dispatchEvent(new Event('change'));
    const canvas = [...dlg.querySelectorAll('.form-row')].find((r) => r.textContent.startsWith('Canvas Color')).querySelector('select');
    expect([...canvas.options].map((o) => o.textContent)).toEqual(['Match User Interface Brightness', 'White']);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(app.prefs.get('theme')).toBe('medium-light');
    expect(brightness()).toBe('medium-light');

    // Use System Setting.
    done = app.commands.run('edit.preferences.ui');
    await tick();
    dlg = document.querySelector('dialog[open]');
    const sys = [...dlg.querySelectorAll('.form-row.check')].find((r) => r.textContent === 'Use System Setting').querySelector('input');
    expect(sys.checked).toBe(false);
    sys.checked = true;
    sys.dispatchEvent(new Event('change'));
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(app.prefs.get('theme')).toBe('system');
  });

  it('offers every level as a checked command', async () => {
    const app = await bootAppWithFeatures();
    for (const id of ['theme.system', 'theme.dark', 'theme.medium-dark', 'theme.medium-light', 'theme.light']) expect(app.commands.get(id), id).toBeTruthy();
    app.commands.run('theme.medium-dark');
    expect(app.prefs.get('theme')).toBe('medium-dark');
    expect(brightness()).toBe('medium-dark');
    expect(app.commands.isChecked?.('theme.medium-dark') ?? app.commands.get('theme.medium-dark').checked(app)).toBe(true);
  });
});
