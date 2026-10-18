import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// The title row centred the spreadsheet's name and its save status as one group, so the name moved each time
// the status changed width: with AutoSave on, every edit took it from Saved to Unsaved changes to Saving… and
// back, and the name jumped about 30px left and back with it. The name is now centred by itself in its own
// column, the status in the column at its right, so a change of status leaves the name where it is while the
// row has room for both (and, as before, the name gives way only when it has not).
it('centres the name in a column of its own, with the save status in the next', () => {
  const css = stylesheet('chrome.css');
  const media = 'min-width: 901px';
  const wrap = declared(css, '.topbar-title-wrap', media);
  expect(wrap.display).toBe('grid');
  // Equal side columns centre the name; the status's column never takes less than the status needs.
  expect(wrap['grid-template-columns']).toBe('minmax(0, 1fr) auto auto minmax(max-content, 1fr)');
  expect(declared(css, '.topbar-title-wrap > .doc-title', media)['grid-column']).toBe('2');
  expect(declared(css, '.topbar-title-wrap > .doc-group-badge', media)['grid-column']).toBe('3');
  const status = declared(css, '.topbar-title-wrap > .save-status', media);
  expect(status['grid-column']).toBe('4');
  expect(status['justify-self']).toBe('start');
  // Narrow windows keep the name at the start of its row (the menus take a row of their own there).
  expect(declared(css, '.topbar-title-wrap', 'max-width: 900px')['justify-content']).toBe('flex-start');
});
