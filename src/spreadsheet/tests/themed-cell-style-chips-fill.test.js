import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// Home ▸ Cell Styles: each Themed Cell Style sample was only as wide as its label, so the last row (Accent1 …
// Accent6, the shortest names) drew short chips that did not line up with the rows above, unlike the
// Built-in samples, which fill their cells. The samples now fill their grid cells, a label too long for a
// narrow one ending in an ellipsis.
it('draws every themed cell style sample the width of its cell', () => {
  const sample = declared(stylesheet('themes.css'), '.themed-cell-styles .cell-style-sample', false);
  expect(sample.width).toBe('100%');
  expect(sample['box-sizing']).toBe('border-box');
  expect(sample['text-overflow']).toBe('ellipsis');
});
