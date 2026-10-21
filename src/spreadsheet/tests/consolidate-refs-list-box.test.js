import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Consolidate's All references list (a <select size="5">) took the drop-down arrow every .select draws, so a
// list box that opens nothing showed a chevron as if it did. It now drops the arrow, as the Scenario Manager's
// and Data Analysis's lists do. jsdom applies no stylesheet, so the rule is checked as text.
const css = readFileSync(new URL('../src/styles/chrome.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector) => {
  for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.split(',').some((s) => s.trim() === selector)) return declarations;
  }
  return null;
};

it('draws no drop-down arrow on the list of references', () => {
  expect(rule('.consolidate-dialog .consolidate-refs')).toMatch(/background-image:\s*none/);
});
