// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createGrid } from '../src/ui/grid.js';
import { buildPrintTable } from '../src/ui/print.js';
import { numberFormatParts, wrappedRichFormatLines } from '../src/core/format-layout.js';
import { richTextMeasure } from '../src/core/rich-text-font.js';
import { measureRows } from '../src/core/row-height.js';
import { wrapLines } from '../src/core/textfit.js';

let grids;
const width = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)[1]) * (font.startsWith('600') ? 1 : 0.5);
beforeEach(() => {
  grids = [];
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ font: '13px Arial', measureText(text) { return { width: width(text, this.font) }; } });
  Element.prototype.scrollTo = function () {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { grids.forEach(grid => grid.destroy()); document.body.replaceChildren(); });

const value = 'ab cd';
const runs = [{ text: 'ab', s: { bold: true, size: 24, color: '#113355' } }, { text: ' cd', s: { bold: false, underline: false, size: 12 } }];
const book = (s = {}) => new Workbook({ sheets: [{ defaultColWidth: 50, cells: {
  '0,0': { v: value, s: { size: 12, underline: true, ...s }, richText: runs },
} }] });
async function mount(wb) {
  const grid = createGrid({ wb, sheetId: wb.activeSheetId }); grids.push(grid); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 15)); return grid;
}
const printed = wb => buildPrintTable(wb, wb.activeSheetId, { range: { r1: 0, c1: 0, r2: 0, c2: 2 }, fit: 'actual' }).querySelector('td');

it('renders the same mixed fonts in the grid and print and reserves their actual spill width', async () => {
  const wb = book(), grid = await mount(wb), cell = grid.el.querySelector('#gc-0-0');
  for (const node of [cell, printed(wb)]) {
    const spans = [...node.querySelectorAll('.rich-text-run')];
    expect(spans.map(span => span.textContent)).toEqual(['ab', ' cd']);
    expect(spans.map(span => span.style.fontWeight)).toEqual(['600', '400']);
    expect(spans.map(span => span.style.fontSize)).toEqual(['24px', '12px']);
    expect(spans.map(span => span.style.textDecorationLine)).toEqual(['underline', 'none']);
    expect(node.style.textDecoration).toBe('none');
  }
  expect(cell.classList.contains('spill')).toBe(true);
});

it('retains run identity through literal text, repeated substitutions, padding and rotated layout', async () => {
  const wb = book({ fmt: 'custom', code: '"ab cd:"@"/"@_W', rot: 25 }), grid = await mount(wb);
  for (const node of [grid.el.querySelector('#gc-0-0'), printed(wb)]) {
    const spans = [...node.querySelectorAll('.rich-text-run')].filter(span => span.textContent);
    expect(spans.map(span => [span.textContent, span.style.fontWeight])).toEqual([
      ['ab cd:', '400'], ['ab', '600'], [' cd', '400'], ['/', '400'], ['ab', '600'], [' cd', '400'],
    ]);
    expect(node.querySelector('[aria-hidden]').style.inlineSize).toBe('6px');
  }
});

it('measures each wrapped line with the fonts of its own characters', () => {
  const wb = book({ wrap: true }), id = wb.activeSheetId;
  const parts = numberFormatParts(value, { wrap: true }, runs);
  const lines = wrappedRichFormatLines(parts, 48, richTextMeasure('12px Arial', width), 12);
  expect(lines.map(line => [line.text, line.size])).toEqual([['ab', 24], ['cd', 12]]);
  expect(measureRows(wb, id, 0, 0, { textWidth: width, baseFontSize: 12, widthOf: () => 53 }).get(0)).toBe(32 + 16 + 3.5); // 1.3 lines of 24 and of 12px, and the 19.5px default row's room over a 12px line
});

it('reports UTF-16 positions after whitespace, line breaks and grapheme splits', () => {
  const text = 'ab  cd\n😀😀xy', seen = [];
  wrapLines(text, 2, value => [...value].length, (value, start) => seen.push([value, start]));
  expect(seen).toEqual([['ab', 0], ['cd', 4], ['😀😀', 7], ['xy', 11]]);
  for (const [value, start] of seen) expect(text.slice(start, start + value.length)).toBe(value);
});

it('does not apply stale rich text to a formula whose result changed', async () => {
  const wb = book();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { f: '"different"', richText: runs } }]);
  const grid = await mount(wb);
  expect(grid.el.querySelector('#gc-0-0').textContent).toBe('different');
  expect(grid.el.querySelector('#gc-0-0 .rich-text-run')).toBeNull();
});
