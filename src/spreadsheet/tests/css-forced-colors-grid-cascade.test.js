import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { stylesheet, parseRules, declarations } from './helpers/css.js';

const MODE = 'forced-colors: active';
// The stylesheets in the order index.css loads them: a later one wins a tie of specificity.
const order = [...fs.readFileSync(path.resolve(process.cwd(), 'src/styles/index.css'), 'utf8').matchAll(/@import '\.\/(.+?)'/g)].map((m) => m[1]);
const family = (p) => (p.startsWith('border') ? 'border' : p.startsWith('background') ? 'background' : p.startsWith('outline') ? 'outline' : p);

// grid.css draws the selection, its fill handle, the selected headers and the freeze bars in system colours under forced
// colours (Windows High Contrast). chrome.css, loaded after it, restyles the same selectors for its Excel look and so
// took the colours back: the selection was outlined in the text colour of every cell border, the fill handle lost its
// fill and the freeze bars went the colour of the canvas. Whatever a later sheet sets on one of those selectors, for a
// property the forced-colours block sets, it sets again under forced colours.
it('keeps the forced-colours look of the grid against the stylesheets loaded after grid.css', () => {
  const forced = parseRules(stylesheet('grid.css')).filter((r) => r.media.some((m) => m.includes(MODE)));
  const later = order.slice(order.indexOf('grid.css') + 1).map((name) => [name, parseRules(stylesheet(name))]);
  let checked = 0;
  for (const rule of forced) {
    for (const selector of rule.selectors) {
      const props = new Set(Object.keys(declarations(rule.body)).map(family));
      for (const [name, rules] of later) {
        // The last rule of this sheet for the selector, per property family: plain, or under forced colours.
        const last = new Map();
        for (const r of rules) {
          if (!r.selectors.includes(selector)) continue;
          const inMode = r.media.some((m) => m.includes(MODE));
          if (r.media.length && !inMode) continue;
          for (const p of Object.keys(declarations(r.body))) if (props.has(family(p))) last.set(family(p), inMode);
        }
        for (const [prop, inMode] of last) { checked++; expect(inMode, `${name}: ${selector} { ${prop} }`).toBe(true); }
      }
    }
  }
  expect(checked).toBeGreaterThanOrEqual(8);
});
