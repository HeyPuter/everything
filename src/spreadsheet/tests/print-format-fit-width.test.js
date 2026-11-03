// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintRoot, preparePrintRoot, printableWidth } from '../src/ui/print.js';

// A number format that fills its cell (Accounting's "$ * #,##0", or "*-0") is laid out across the room its cell
// prints with. Fitted to the page's width, a table narrower than the page is stretched across it, and that room was
// measured before the table was set to the page's width, at the width of the hidden layout (the window's): in a
// four-column sheet, $56 in Accounting format printed as a lone "$", its figures laid out past the cell's edge.
let hidden;
beforeEach(() => {
  hidden = 344;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText(text) {
    return { width: [...text].length * 7 * Number(/([\d.]+)px/.exec(this.font)?.[1] || 13) / 13 };
  } });
  // jsdom lays nothing out: the cell's content box is a quarter of the page once the section is the page's width.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!this.classList.contains('number-format-layout') || this.style.inlineSize !== '100%') return new DOMRect();
    const atPage = this.closest('.print-section')?.style.width === `${printableWidth()}px`;
    return new DOMRect(0, 0, atPage ? 176 : hidden, 15);
  });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function print(code, fit = 'width') {
  const wb = new Workbook({ sheets: [{ colWidths: { 0: 100, 1: 100, 2: 100, 3: 100 }, cells: {
    '0,0': { v: 56, s: { fmt: 'custom', code, font: 'arial', size: 13 } }, '0,3': { v: 'x' },
  } }] });
  const root = buildPrintRoot(wb, wb.activeSheetId, 'Fill', { fit, title: false, marginBoxes: false });
  document.body.append(root);
  preparePrintRoot(root);
  return root.querySelector('.number-format-layout');
}

it.each(['$* #,##0', '*-0'])('lays %s out across the cell as it prints, fitted to the page width', code => {
  const formatted = print(code);
  expect(parseFloat(formatted.style.inlineSize)).toBeCloseTo(176, 5);
  expect(formatted.textContent).toMatch(/56$/);
});

it('lays a fill out across the cell as the hidden layout has it at actual size', () => {
  hidden = 95;
  expect(parseFloat(print('*-0', 'actual').style.inlineSize)).toBeCloseTo(95, 5);
});
