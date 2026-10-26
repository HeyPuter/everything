import { it, expect } from 'vitest';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { paragraph } from '../src/engine/model.js';
import { DEFAULT_PAGE_SETTINGS, pageGeometry } from '../src/engine/page-settings.js';
import { sectionStoryBounds } from '../src/engine/story-clearance.js';
import { measurePageStory } from '../src/engine/page-story-measure.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';

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

it('measures each page\'s footer once across the passes of one layout', () => {
  // Footnote reservations and wrapped pictures paginate the body again with the same footers.
  const folio = { kind: 'footer', paragraphs: [paragraph('', { runs: [{ text: 'Folio ' }, { text: '￼', field: { type: 'PAGE', cachedText: '1' } }] })] };
  const folios = { evenAndOdd: false, sections: [{ header: {}, footer: { default: 'folio' } }], stories: { folio } };
  const footers = [];
  const measure = text => { if (text.startsWith('Folio')) footers.push(text); return { width: text.length * 8, ascent: 12, descent: 4 }; };
  const page = pageGeometry(DEFAULT_PAGE_SETTINGS), options = { storyHeightCache: new Map() };
  const pass = (firstNumber, shared = options) => [0, 1, 2].map(sectionStoryBounds(page, folios, 0, { firstNumber }, measure, undefined, shared));
  const bounds = pass(1);
  expect(footers).toEqual(expect.arrayContaining(['Folio 1', 'Folio 2', 'Folio 3']));
  const measured = footers.length;
  expect(pass(1)).toEqual(bounds);
  expect(footers).toHaveLength(measured);
  // Other page numbers are other footers; without the shared heights each pass measures its own.
  pass(4);
  expect(footers.slice(measured)).toContain('Folio 6');
  const before = footers.length;
  expect(pass(1, {})).toEqual(bounds);
  expect(footers.length).toBeGreaterThan(before);
});

it('reuses page stories measured alike by an earlier layout, reporting their unsupported fields again', () => {
  const cache = new ParagraphMeasureCache(), footers = [];
  const measure = text => { if (text.startsWith('Page')) footers.push(text); return { width: text.length * 8, ascent: 12, descent: 4 }; };
  measure.paragraphCache = () => cache;
  const paragraphs = body(120), page = pageGeometry(DEFAULT_PAGE_SETTINGS);
  const lay = () => { cache.nextGeneration(); return layoutDocument(paragraphs, measure, page, undefined, [], stories); };
  const first = lay(), measured = footers.length;
  expect(measured).toBeGreaterThan(0);
  expect(lay()).toEqual(first);
  expect(footers).toHaveLength(measured);
  const fresh = layoutDocument(paragraphs, text => ({ width: text.length * 8, ascent: 12, descent: 4 }), page, undefined, [], stories);
  expect(first.lines.map(l => [l.page, l.y])).toEqual(fresh.lines.map(l => [l.page, l.y]));
  const chapter = { ...footer, paragraphs: [paragraph('', { runs: [{ text: 'Page ' }, { text: '￼', field: { type: 'PAGE', cachedText: '1' } }] })] };
  const unsupported = [], options = { onUnsupported: error => unsupported.push(error.message) };
  const context = { pageNumber: 2, pageCount: 3, sectionPageCount: 3, pageNumbering: { chapterStyle: 1 } };
  const once = measurePageStory(chapter, { ...page, storyKind: 'footer' }, measure, undefined, context, options);
  const again = measurePageStory(chapter, { ...page, storyKind: 'footer' }, measure, undefined, context, options);
  expect(again).toBe(once);
  expect(unsupported).toEqual(['Chapter-prefixed page numbers are not supported yet.', 'Chapter-prefixed page numbers are not supported yet.']);
});

it('settles a page count whose footer is shorter than a smaller count\'s, with the footer clear of the body', () => {
  // "Pages: VIII" wraps onto a second line of this 80 px footer, "Pages: IX" does not: with a two-line
  // footer the body takes nine pages, with a one-line footer eight. Each count gives the other.
  const roman = { kind: 'footer', paragraphs: [paragraph('', { runs: [{ text: 'Pages: ' }, { text: '￼', field: { type: 'NUMPAGES', cachedText: '1', generalFormat: 'upperRoman' } }], format: { spaceAfter: 0 } })] };
  const definition = { evenAndOdd: false, sections: [{ header: {}, footer: { default: 'roman' } }], stories: { roman } };
  const settings = { ...DEFAULT_PAGE_SETTINGS, width: 4080, left: 1440, right: 1440, height: 5880, top: 1440, bottom: 300, footer: 0 };
  const measure = text => ({ width: text.length * 8, ascent: 15, descent: 5 });
  let laidOut = 0;
  for (let count = 97; count <= 104; count++) {
    const paragraphs = Array.from({ length: count }, (_, i) => paragraph(`L${i}`, { format: { spaceAfter: 0 } }));
    const counting = (text, style) => { if (text === 'L0') laidOut++; return measure(text, style); };
    laidOut = 0;
    const result = layoutDocument(paragraphs, counting, pageGeometry(settings), undefined, [], definition);
    // Laid out a handful of times, not once per page the preview allows.
    expect(laidOut).toBeLessThan(10);
    const placed = layoutPageStories(result, definition, [settings], measure);
    for (let index = 0; index < result.pageCount; index++) {
      const footerTop = Math.min(...placed.lines.filter(line => line.page === index).map(line => line.y));
      const bodyBottom = Math.max(...result.lines.filter(line => line.page === index).map(line => line.y + line.height));
      expect(bodyBottom).toBeLessThanOrEqual(footerTop);
    }
    expect(placed.lines.at(-1).fragments.map(f => f.text).join('')).toContain(['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][result.pageCount]);
  }
});
