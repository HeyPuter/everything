// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PropertiesPalette } from '../src/ui/properties.js';
import { patternNames } from '../src/core/hatch/patterns.js';

describe('Properties select fields', () => {
  const select = (...args) => PropertiesPalette.prototype.select.call({}, ...args);

  it('shows a value the list lacks instead of the first entry', () => {
    // a hatch imported with an AutoCAD pattern the library does not have
    const changes = [];
    const sel = select(patternNames(), 'ANSI31', (v) => changes.push(v));
    expect(sel.value).toBe('ANSI31');
    expect(sel.options[0].value).toBe('ANSI31');
    sel.value = 'CROSS';
    sel.dispatchEvent(new Event('change'));
    expect(changes).toEqual(['CROSS']);
  });

  it('keeps known values and Varies as they were', () => {
    expect(select(['A', 'B'], 'B', () => {}).options).toHaveLength(2);
    const varies = select(['A', 'B'], undefined, () => {});
    expect([...varies.options].map((o) => o.textContent)).toEqual(['Varies', 'A', 'B']);
  });
});
