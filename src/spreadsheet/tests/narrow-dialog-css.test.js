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
});
