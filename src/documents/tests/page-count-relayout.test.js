import { it, expect } from 'vitest';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { paragraph } from '../src/engine/model.js';
import { DEFAULT_PAGE_SETTINGS, pageGeometry } from '../src/engine/page-settings.js';

// "Page X of Y" footers hold the page count, which is known only after layout. The body is laid out
// again with the real count only when that count changes a header or footer's height.
const footer = { kind: 'footer', paragraphs: [paragraph('', { runs: [{ text: 'Page ' }, { text: '￼', field: { type: 'PAGE', cachedText: '1' } }, { text: ' of ' }, { text: '￼', field: { type: 'NUMPAGES', cachedText: '1' } }] })] };
const stories = { evenAndOdd: false, sections: [{ header: {}, footer: { default: 'footer' } }], stories: { footer } };
const body = count => Array.from({ length: count }, (_, i) => paragraph(`Body ${i}`, { format: { spaceAfter: 0 } }));
const counting = () => {
  const measure = text => { if (text.startsWith('Body')) measure.body++; return { width: text.length * 8, ascent: 12, descent: 4 }; };
  measure.body = 0;
  return measure;
};

it('lays the body out once when the page count leaves the footer the same height', () => {
  const paragraphs = body(200), once = counting(), measure = counting();
  layoutDocument(paragraphs, once, pageGeometry(DEFAULT_PAGE_SETTINGS));
  const result = layoutDocument(paragraphs, measure, pageGeometry(DEFAULT_PAGE_SETTINGS), undefined, [], stories);
  expect(result.pageCount).toBeGreaterThan(1);
  expect(measure.body).toBe(once.body);
  const placed = layoutPageStories(result, stories, [DEFAULT_PAGE_SETTINGS], measure);
  expect(placed.lines.at(-1).fragments.map(f => f.text).join('')).toBe(`Page ${result.pageCount} of ${result.pageCount}`);
});

it('lays the body out again when the page count makes the footer taller', () => {
  // "Page 10 of 1" fits the narrow writing width, but "Page 10 of 12" wraps onto a second line.
  const settings = { ...DEFAULT_PAGE_SETTINGS, width: 2940, left: 720, right: 720, height: 4320, top: 720, bottom: 720, header: 360, footer: 360 };
  const page = pageGeometry(settings), paragraphs = body(150);
  const result = layoutDocument(paragraphs, counting(), page, undefined, [], stories);
  const placed = layoutPageStories(result, stories, [settings], counting());
  expect(result.pageCount).toBeGreaterThanOrEqual(10);
  for (let index = 0; index < result.pageCount; index++) {
    const footerTop = Math.min(...placed.lines.filter(line => line.page === index).map(line => line.y));
    const bodyBottom = Math.max(...result.lines.filter(line => line.page === index).map(line => line.y + line.height));
    expect(bodyBottom).toBeLessThanOrEqual(footerTop);
  }
  expect(placed.lines.filter(line => line.page === 9)).toHaveLength(2);
});
