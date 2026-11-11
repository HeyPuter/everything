// Small controls get finger-sized hit areas on touch screens without changing their look.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = (f) => fs.readFileSync(`${import.meta.dirname}/../src/styles/${f}`, 'utf8');

describe('touch targets', () => {
  it('gives the 10 px clip indicators a 24 px transparent hit area on coarse pointers', () => {
    const panels = css('panels.css');
    const block = panels.slice(panels.indexOf('@media (pointer: coarse) {\n  .clip-led {'));
    expect(block).toMatch(
      /\.clip-led::before \{\s*content: '';\s*position: absolute;\s*inset: -7px;/,
    );
    // 10 px LED + 13 px outward + 1 px toward the neighbour (2 px apart) = 24 px.
    expect(block).toMatch(/\.clip-led:first-child::before \{\s*top: -13px;\s*bottom: -1px;/);
    expect(block).toMatch(/\.clip-led:last-child::before \{\s*top: -1px;\s*bottom: -13px;/);
  });
});
