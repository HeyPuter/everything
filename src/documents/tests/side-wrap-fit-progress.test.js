import { it, expect } from 'vitest';
import { paragraph, RUN_FORMAT } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry, DEFAULT_PAGE_SETTINGS } from '../src/engine/page-settings.js';

// A paragraph-relative square-wrapped picture reserves its height on the anchor's page in
// modern compatibility. When a tall header or the paragraph's own borders leave less room than
// that on every page, pagination must still place the paragraph instead of retrying forever.
const page = pageGeometry({ ...DEFAULT_PAGE_SETTINGS, compatibilityMode: 15 });
const measure = text => ({ width: text.length * 7, ascent: 12, descent: 4 });
const run = (text, extra = {}) => ({ ...RUN_FORMAT, text, properties: '', overrides: {}, ...extra });
const picture = inches => ({ id: 'tall', assetId: 'tall', alt: 'Tall picture', width: 914400, height: Math.round(914400 * inches),
  anchor: { horizontal: 'column', vertical: 'paragraph', x: 457200, y: 0, order: 1, wrap: 'square', wrapText: 'bothSides', distances: { T: 0, B: 0, L: 114300, R: 114300 }, behind: false } });
const anchored = (inches, format = {}) => paragraph('', { runs: [run('Text '), run('\ufffc', { image: picture(inches) }), run(' beside')], format });

it('places a tall side-wrapped picture below a header taller than the top margin', () => {
  const header = { paragraphs: Array.from({ length: 8 }, (_, i) => paragraph(`Header line ${i + 1}`)) };
  const stories = { evenAndOdd: false, sections: [{ header: { default: 'header' }, footer: {} }], stories: { header } };
  const after = paragraph('After');
  const result = layoutDocument([anchored(8.9), after], measure, page, undefined, [], stories);
  const first = result.lines.find(line => line.start === 0);
  expect(first.page).toBe(0);
  expect(first.y).toBeGreaterThan(page.top);
  expect(result.lines.some(line => line.paragraphId === after.id)).toBe(true);
});

it('places a tall side-wrapped picture in a paragraph whose borders take part of the page', () => {
  const border = { style: 'single', size: 8, space: 4, color: 'auto' };
  // 8.99 in fits the 9 in writing area, but not once the borders' 13 px are taken from it.
  const result = layoutDocument([anchored(8.99, { paragraphBorders: { top: border, bottom: border } })], measure, page);
  expect(result.pageCount).toBe(1);
  expect(result.lines[0]).toMatchObject({ page: 0, floatingFitHeight: expect.any(Number) });
});
