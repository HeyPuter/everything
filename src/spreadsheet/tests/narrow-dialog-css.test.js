import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the rules that keep dialogs inside a phone-width window are checked as text.
const read = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `@media` block whose query starts with `query`. */
const media = (css, query) => {
  const at = css.indexOf(`@media ${query}`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
  }
  return null;
};

/** The declarations of the first rule whose selector list contains `selector`. */
const rule = (css, selector) => {
  for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.split(',').some((s) => s.trim() === selector)) return declarations;
  }
  return null;
};

describe('dialogs at phone width', () => {
  it('lets the Options dialog shrink to the window, with the section bar scrolling inside it', () => {
    const narrow = media(read('options.css'), '(max-width: 720px)');
    // A bare 1fr track grows to the widest child, here the row of section names.
    expect(rule(narrow, '.opt-dialog')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule(narrow, '.opt-nav-list')).toMatch(/overflow-x:\s*auto/);
  });

  it('wraps the Sheet View Options buttons onto a second row instead of pushing Delete off screen', () => {
    const narrow = media(read('layout-views.css'), '(max-width: 560px)');
    expect(rule(narrow, '.cv-buttons')).toMatch(/flex-direction:\s*row/);
    expect(rule(narrow, '.cv-buttons')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('wraps the Share dialog footer so Done stays inside the window', () => {
    const foot = rule(read('components.css'), '.share-foot');
    expect(foot).toMatch(/flex-wrap:\s*wrap/);
    expect(foot).toMatch(/row-gap:\s*\d+px/);
  });

  it('wraps the text box Bold, Italic and Border checks once the dialog narrows', () => {
    const css = read('components.css');
    expect(rule(css, '.textbox-style-checks')).toMatch(/gap:\s*14px/);
    expect(rule(media(css, '(max-width: 480px) { .textbox-style-checks'), '.textbox-style-checks')).toMatch(/flex-wrap:\s*wrap/);
    const js = readFileSync(new URL('../src/ui/textboxdialog.js', import.meta.url), 'utf8');
    expect(js).toContain("el('div.row.textbox-style-checks'");
  });
});
