import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument, selectionRects, selectionRectFinder } from '../src/engine/layout.js';
import { squareWrapDocx, align } from './helpers/square-wrap-docx.js';

// Spelling marks, comment and change tints and suggestion underlines find the rectangles of
// thousands of ranges in one layout. selectionRectFinder reads only the lines each range reaches,
// and must give exactly what selectionRects gives, in its order.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const measure = (text, style) => ({ width: text.length * style.fontSize * .5, ascent: style.fontSize, descent: style.fontSize / 3 });
async function laidOut(bytes) {
  const pkg = await DocxPackage.open(bytes);
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  return { layout: layoutDocument(model.paragraphs, measure, pageGeometry(model.pageSettings), model.numbering, model.tables, pkg.pageStories, { styles: model.styles }), length: model.text.length };
}
function expectSame(layout, length) {
  const find = selectionRectFinder(layout);
  expect(selectionRectFinder(layout)).toBe(find);
  const points = [...new Set([0, 1, 2, length - 1, length, length + 1, ...Array.from({ length: 40 }, (_, i) => Math.round(i * length / 39))])].filter(n => n >= 0).sort((a, b) => a - b);
  let compared = 0;
  for (const start of points) for (const end of points) if (end >= start) {
    expect(find(start, end)).toEqual(selectionRects(layout, start, end));
    compared++;
  }
  // Word-sized ranges along the whole document.
  for (let start = 0; start < length; start += 7) expect(find(start, start + 5)).toEqual(selectionRects(layout, start, start + 5));
  return compared;
}

it('finds the rectangles of body text, as selectionRects does', () => {
  const words = 'Typing in a long document marks every misspelled word on every page. ';
  const ps = Array.from({ length: 60 }, (_, i) => paragraph(words.repeat(1 + i % 4)));
  const layout = layoutDocument(ps, measure, pageGeometry({ width: 12240, height: 15840, top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720, gutter: 0 }));
  expect(layout.pageCount).toBeGreaterThan(2);
  expect(expectSame(layout, ps.reduce((n, p) => n + p.runs[0].text.length + 1, 0) - 1)).toBeGreaterThan(500);
});

it.each(['table-headers', 'vertical-cells', 'vertical-pages', 'merged-cells'])('finds the rectangles of %s, as selectionRects does', async name => {
  const { layout, length } = await laidOut(readFileSync(`public/fixtures/${name}.docx`));
  if (name === 'table-headers') expect(layout.repeatedLines?.length).toBeGreaterThan(0);
  expectSame(layout, length);
});

it('finds the rectangles of lines wrapped around a picture, as selectionRects does', async () => {
  const { layout, length } = await laidOut(squareWrapDocx(['margin', align('center')], ['margin', align('center')]));
  expect(layout.lines.some(line => line.wrapSegments)).toBe(true);
  expect(layout.floatingObjects.length).toBeGreaterThan(0);
  expectSame(layout, length);
});

it('finds the rectangles of rotated cell text among other lines, as selectionRects does', () => {
  const local = { start: 4, end: 8, y: 10, height: 12, baseline: 18, wrapSegments: [
    { start: 4, end: 6, stops: [{ offset: 4, x: 0 }, { offset: 6, x: 10 }], fragments: [] },
    { start: 6, end: 8, stops: [{ offset: 6, x: 20 }, { offset: 8, x: 30 }], fragments: [] }] };
  const plain = (start, end, y) => ({ start, end, page: 0, x: 0, y, height: 12, baseline: y + 9, fragments: [], paragraphEnd: true,
    stops: Array.from({ length: end - start + 1 }, (_, i) => ({ offset: start + i, x: i * 6 })) });
  const rotated = { ...local, page: 0, fragments: [], cellText: { line: local, matrix: [0, -1, 1, 0, 100, 200] }, cellClip: { left: 90, right: 130, top: 150, bottom: 210 } };
  // Out of document order, as cells and repeated rows can be.
  const layout = { page: { width: 400, height: 600 }, lines: [plain(9, 14, 300), rotated, plain(0, 3, 0)], repeatedLines: [{ ...rotated, page: 1 }] };
  expect(expectSame(layout, 15)).toBeGreaterThan(100);
});

it('works out a layout once, and again when its lines change', () => {
  const layout = layoutDocument([paragraph('One two three')], measure, pageGeometry({ width: 12240, height: 15840, top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720, gutter: 0 }));
  const find = selectionRectFinder(layout);
  expect(selectionRectFinder(layout)).toBe(find);
  const copy = { ...layout, lines: [...layout.lines] };
  expect(selectionRectFinder(copy)).not.toBe(find);
  expect(selectionRectFinder(copy)(0, 3)).toEqual(find(0, 3));
});
