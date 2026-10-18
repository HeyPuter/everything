import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stylesheet, parseRules, declared, declarations, rulesFor } from './helpers/css.js';

// Dark mode comes two ways: the system's setting (the default, no stamp on <html>) and the app's own
// dark stamp. The desktop dialogs' button borders, their shadow and the segmented controls' track were
// darkened for the stamp alone, so with the system in dark mode the buttons kept a light grey outline and
// the tab track of Format Cells and the other segmented controls vanished. The status bar's pressed view
// button had a black wash in both, invisible on the dark frame.
const STAMP = ':root[data-theme="dark"]';
const OS_DARK = ':root:where(:not([data-theme="light"]))';

describe('dark mode reaches the dialogs whichever way it is set', () => {
  it('no rule styles the dark-stamped app without the same rule for the system dark mode', () => {
    const missing = [];
    for (const file of fs.readdirSync(path.resolve(process.cwd(), 'src/styles')).filter((f) => f.endsWith('.css'))) {
      const rules = parseRules(stylesheet(file));
      for (const rule of rules) {
        for (const selector of rule.selectors) {
          if (!selector.startsWith(`${STAMP} `)) continue; // descendant rules; token blocks are compared below
          const twin = [selector.replace(STAMP, OS_DARK), selector.replace(STAMP, ':root:not([data-theme="light"])')];
          const found = rules.some((other) => other.selectors.some((s) => twin.includes(s))
            && other.media.some((m) => m.includes('prefers-color-scheme: dark'))
            && JSON.stringify(declarations(other.body)) === JSON.stringify(declarations(rule.body)));
          if (!found) missing.push(`${file}: ${selector}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives the dialog tokens the same dark values for the system setting and the stamp', () => {
    const css = stylesheet('chrome.css');
    const light = declared(css, ':root', false);
    const stamped = declared(css, STAMP, false);
    const system = declared(css, OS_DARK, 'prefers-color-scheme: dark');
    for (const token of ['--dialog-btn-line', '--seg-track', '--dialog-shadow', '--chrome-pressed']) {
      expect(light[token], token).toBeTruthy();
      expect(stamped[token], token).toBeTruthy();
      expect(system[token], token).toBe(stamped[token]);
      expect(stamped[token], token).not.toBe(light[token]);
    }
  });

  it('draws the dialog buttons, shadow, segment track and pressed view button with those tokens', () => {
    const css = stylesheet('chrome.css');
    const dialogs = 'min-width: 640px';
    expect(declared(css, '.modal-panel', dialogs)['box-shadow']).toBe('var(--dialog-shadow)');
    expect(declared(css, '.modal-panel .btn', dialogs).border).toBe('1px solid var(--dialog-btn-line)');
    // A Cancel (ghost) button has no outline in any theme.
    expect(declared(css, '.modal-panel .btn-ghost', dialogs)['border-color']).toBe('transparent');
    for (const selector of ['.segmented', '.seg', '.fc-tabs']) expect(declared(css, selector, dialogs).background).toBe('var(--seg-track)');
    expect(rulesFor(css, '.status-view[aria-pressed="true"]', 'pointer: fine').map((r) => declarations(r.body).background)).toEqual(['var(--chrome-pressed)']);
  });
});
