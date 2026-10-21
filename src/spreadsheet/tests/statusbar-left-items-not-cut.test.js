import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// With a filter on, the status bar's left reads "1,028 of 1,199 rows shown"; where the bar was narrow (an upright
// tablet with a range selected) that was cut off mid-number at the edge of its area, "1,028 of '". As the statistics
// on the right are, the items on the left are now left out whole when they do not fit, from the last one, and one
// with a line to itself that still does not fit ends in an ellipsis ("1,028 o…") rather than a cut-off figure.
it('drops the left items whole, and ends a lone one in an ellipsis', () => {
  const css = stylesheet('editor.css');
  const left = declared(css, '.status-left');
  expect(left['flex-wrap']).toBe('wrap');
  expect(left['max-height']).toBe('1lh');
  expect(left.overflow).toBe('hidden');
  for (const side of ['.status-left', '.status-right']) {
    const item = declared(css, `${side} > .status-item`);
    expect(item['min-width']).toBe('0');
    expect(item.overflow).toBe('hidden');
    expect(item['text-overflow']).toBe('ellipsis');
  }
});
