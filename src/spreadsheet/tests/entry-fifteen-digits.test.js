// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, typedDigits } from '../src/core/workbook.js';
import { parseInput, setLocale } from '../src/core/format.js';
import * as S from '../src/core/selection.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { setLocale('en-US'); vi.useRealTimers(); document.body.replaceChildren(); });

// A number typed into a cell kept every digit binary conversion could, so 12345678901234567890 stored
// 12345678901234567000 and a 16-digit card number kept its last digit, while Excel, and this app inside a
// formula, keep 15 significant digits and drop the rest. Typed numbers now keep the same 15 digits.
it.each([
  ['12345678901234567890', 12345678901234500000],
  ['4111111111111111', 4111111111111110],
  ['0.12345678901234567', 0.123456789012345],
  ['1,234,567,890,123,456', 1234567890123450],
  ['$1234567890123456.78', 1234567890123450],
  ['(1234567890123456789)', -1234567890123450000],
  ['1.23456789012345678e20', 123456789012345000000],
  ['0.1', 0.1], ['12:30', 12.5 / 24], ['1 1/3', 4 / 3], ['1e308', 1e308],
])('keeps %s as %d', (text, value) => {
  expect(typedDigits(parseInput(text), text).v).toBe(value);
});

it('cuts numbers typed into the grid, as a formula reads the same digits', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  const type = (r, c, text) => { grid.setSelection(S.single(r, c)); grid.beginEdit({ text, mode: 'inplace' }); grid.commitEdit(); vi.runOnlyPendingTimers(); };
  type(0, 0, '12345678901234567890');
  wb.setInput(id, 0, 1, '=12345678901234567890');
  expect(wb.getValue(id, 0, 0)).toBe(12345678901234500000);
  expect(wb.getValue(id, 0, 0)).toBe(wb.getValue(id, 0, 1));
  setLocale('de-DE');
  type(1, 0, '1.234.567.890.123.456,7');
  expect(wb.getValue(id, 1, 0)).toBe(1234567890123450);
  grid.destroy();
});
