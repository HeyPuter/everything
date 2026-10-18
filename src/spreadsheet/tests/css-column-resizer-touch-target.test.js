import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// A column's resize strip is 9px across its edge. A fingertip lands a few pixels either side of where it
// aims, so 6px off the edge the press selected columns instead of resizing one. Under a coarse pointer the
// strip is wider; the heading keeps most of its width for the tap that selects the column.
it('widens the column resize strip under a coarse pointer, centred on the edge', () => {
  const css = stylesheet('grid.css');
  expect(declared(css, '.col-resizer', false)).toMatchObject({ width: '9px', right: '-4px' });
  const touch = declared(css, '.col-resizer', 'pointer: coarse');
  expect(touch).toMatchObject({ width: '17px', right: '-8px' });
});
