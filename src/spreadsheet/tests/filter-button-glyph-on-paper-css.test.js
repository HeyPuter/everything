import { describe, expect, it } from 'vitest';
import { stylesheet, parseRules, declared } from './helpers/css.js';

// The AutoFilter button sits in a cell, on the sheet's paper, which is white in every theme. With the app
// set to dark mode its arrow and funnel turned light grey (#d0d0d0), about 1.5:1 on the white button, so
// the filter buttons of a header row could hardly be seen.
describe('AutoFilter button glyphs', () => {
  const css = stylesheet('chrome.css');

  it('are drawn in the paper\'s dark grey whatever the app theme', () => {
    const tokens = ['--xl-filter-arrow', '--xl-filter-on'];
    const defining = parseRules(css).filter((r) => tokens.some((t) => r.body.includes(`${t}:`)));
    expect(defining.map((r) => r.selectors.join(', '))).toEqual([':root']);
    for (const t of tokens) expect(declared(css, ':root', false)[t]).toContain("fill='%23505050'");
  });

  it('sit on the paper surface', () => {
    expect(declared(css, '.cell.filter-head::after')['background-color']).toBe('var(--surface)');
    expect(declared(css, '.cell.filter-head::after')['background-image']).toBe('var(--xl-filter-arrow)');
  });
});
