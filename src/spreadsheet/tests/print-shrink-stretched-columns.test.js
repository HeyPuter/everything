// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintRoot, preparePrintRoot, printableWidth } from '../src/ui/print.js';

// A Shrink to fit label prints as small as the printed column needs, not as small as the sheet's column
// width needs. Fitted to the page's width, a narrow table is stretched across the page, so its columns
// print wider than they are on the sheet: a 100px column holding "A long label shrunk to fit" printed at
// about two-thirds of its printed width, the text shrunk for 100px and then never grown back.
const SIZE = 9.5 * 4 / 3, TEXT = 'A label long enough to need shrinking in any column';
const widthAt = size => TEXT.length * 7 * size / 13;
let printedWidth, hiddenWidth;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText(text) {
    return { width: [...text].length * 7 * Number(/([\d.]+)px/.exec(this.font)?.[1] || 13) / 13 };
  } });
  // jsdom lays nothing out. The label's content box is as wide as its printed column: the page's width
  // shares it out once the section is set to that width; before then it is whatever the hidden layout gave.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!this.classList.contains('number-format-layout') || this.style.inlineSize !== '100%') return new DOMRect();
    const atPage = this.closest('.print-section')?.style.width === `${printableWidth()}px`;
    return new DOMRect(0, 0, atPage ? printedWidth : hiddenWidth, 15);
  });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function print(fit = 'width') {
  const wb = new Workbook({ sheets: [{ colWidths: { 0: 100 }, cells: { '0,0': { v: TEXT, s: { shrink: true } } } }] });
  const root = buildPrintRoot(wb, wb.activeSheetId, 'Shrunk', { fit, title: false, marginBoxes: false });
  document.body.append(root);
  preparePrintRoot(root);
  return parseFloat(root.querySelector('td').style.fontSize);
}

beforeEach(() => { hiddenWidth = 1300; });

it('shrinks a label only as far as its column stretched across the page needs', () => {
  printedWidth = 240;
  const size = print();
  expect(widthAt(size)).toBeLessThanOrEqual(240);
  expect(widthAt(size)).toBeGreaterThan(238);
});

it('prints a label at its own size when the stretched column holds it', () => {
  printedWidth = widthAt(SIZE) + 20;
  expect(print()).toBeCloseTo(SIZE, 3);
});

it('still shrinks a label to its column at actual size', () => {
  // At actual size the table keeps the sheet's widths, so the hidden layout's width is what prints.
  hiddenWidth = 100;
  const size = print('actual');
  expect(widthAt(size)).toBeLessThanOrEqual(100);
  expect(widthAt(size)).toBeGreaterThan(98);
});
