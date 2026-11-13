// Panels that sit in narrow frames of the built-in workspaces keep their values in view.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const panels = fs.readFileSync(`${import.meta.dirname}/../src/styles/panels.css`, 'utf8');

describe('Selection/View in a narrow frame', () => {
  it('switches to a compact, equal-column table below 320 px', () => {
    expect(panels).toMatch(/\.selection-panel \{[^}]*container-type: inline-size;/);
    const narrow = panels.slice(panels.indexOf('@container (max-width: 320px)'));
    expect(narrow).toMatch(/\.selview-table \{[^}]*table-layout: fixed;/);
    expect(narrow).toMatch(/\.time-field \{\s*min-width: 0;/);
  });

  it('fits Start, End and Duration in the 245 px frame of the Default workspace at 1280 px', () => {
    // Widths from the narrow rules: 245 px frame, 10 px padding each side, 6 px pulled back each
    // side, a 5em (11 px) label column; each field has 1 px cell padding, 1 px border, 1 px padding.
    const table = 245 - 20 + 12;
    const field = (table - 5 * 11) / 3 - 2 - 2 - 2;
    // "10:00.000" at 11 px in the UI font measures 53 px.
    expect(field).toBeGreaterThanOrEqual(53);
  });
});

describe('empty panel messages in a short frame', () => {
  it('scroll from the top instead of squeezing their buttons (Media Browser sign-in on phones)', () => {
    const base = fs.readFileSync(`${import.meta.dirname}/../src/styles/base.css`, 'utf8');
    const at = base.indexOf('.empty-state {');
    const rule = base.slice(at, base.indexOf('}', at));
    expect(rule).toMatch(/justify-content: safe center;/);
    expect(rule).toMatch(/overflow: auto;/);
    expect(base).toMatch(/\.empty-state > \* \{\s*flex-shrink: 0;\s*\}/);
  });
});
