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

  it('gives dock splitters a 20 px grab area that does not pan the page on coarse pointers', () => {
    const shell = css('shell.css');
    const block = shell.slice(shell.indexOf('@media (pointer: coarse) {\n  .dock-split {'));
    expect(block).toMatch(
      /\.dock-split::before \{\s*content: '';\s*position: absolute;\s*touch-action: none;/,
    );
    expect(block).toMatch(/\.dock-row > \.dock-split::before \{\s*inset: 0 -8px;/);
    expect(block).toMatch(/\.dock-col > \.dock-split::before \{\s*inset: -8px 0;/);
  });

  it('gives the waveform ruler corner buttons half the corner each, full height, on coarse pointers', () => {
    const editor = css('editor.css');
    const block = editor.slice(editor.indexOf('@media (pointer: coarse) {\n  .wf-ruler-corner {'));
    expect(block).toMatch(/\.wf-ruler-corner \{\s*position: relative;/);
    expect(block).toMatch(
      /\.wf-ruler-corner > \.icon-btn::before \{\s*content: '';\s*position: absolute;\s*top: 0;\s*bottom: 0;/,
    );
    expect(block).toMatch(/:first-child::before \{\s*left: 0;\s*right: 50%;/);
    expect(block).toMatch(/:last-child::before \{\s*left: 50%;\s*right: 0;/);
  });
});
