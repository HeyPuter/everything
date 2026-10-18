import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { stylesheet } from './helpers/css.js';

// The Equation dialog, Page Layout ▸ Effects and the Forecast Sheet, Scenario Manager, Data Analysis and Solver dialogs named
// colour tokens no stylesheet defines (--hover, --selected, --line, --border, --muted), so they always drew
// their light fallbacks: in dark mode the chosen equation structure was a pale block with its name in white on
// it, the chosen effect's name was white on pale green, hovering a symbol or a tile lit it near-white under
// light text, and the borders were bright lines. They now use the theme's own tokens.
it('names only colour tokens the themes define, never one that falls back to a fixed opaque colour', () => {
  const dir = path.resolve(process.cwd(), 'src/styles');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
  const defined = new Set();
  for (const f of files) for (const m of stylesheet(f).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const offenders = [];
  for (const f of files) {
    for (const m of stylesheet(f).matchAll(/var\((--[\w-]+),\s*(#[0-9a-f]{3,8}|white|black|rgb\([^)]*\))\s*\)/gi)) {
      if (!defined.has(m[1])) offenders.push(`${f}: ${m[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
