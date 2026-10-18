import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// Tools ▸ Automate ▸ All scripts: the In This Workbook heading keeps New Script and Record Actions on its
// line. On a phone the two buttons did not fit beside the heading, so the list scrolled sideways and
// Record Actions was cut off at the edge. They now go under the heading when there is no room beside it.
it('lets the workbook section\'s buttons go under its heading on a narrow screen', () => {
  const head = declared(stylesheet('automate.css'), '.sg-section-head', false);
  expect(head.display).toBe('flex');
  expect(head['flex-wrap']).toBe('wrap');
});
