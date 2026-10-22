// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { printSheet } from '../src/ui/print.js';

// Finding the fonts a print uses reads each text's computed style, which needs no layout. Laying the whole print
// out first cost a full layout of every printed cell (seconds for a sheet of 200,000 cells) that nothing read.
let fonts;
beforeEach(() => {
  fonts = { check: vi.fn(() => false), load: vi.fn(() => Promise.resolve([])) };
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  vi.spyOn(window, 'print').mockImplementation(() => {});
  // jsdom does not inherit font longhands; reproduce the browser's inheritance.
  const computed = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((node) => {
    const css = computed(node);
    let family = css.fontFamily, size = css.fontSize;
    for (let p = node.parentElement; p && (!family || !size); p = p.parentElement) {
      const inherited = computed(p);
      family ||= inherited.fontFamily; size ||= inherited.fontSize;
    }
    return new Proxy(css, { get(target, key) { return ({ fontFamily: family, fontSize: size })[key] || target[key]; } });
  });
});
afterEach(() => { document.body.replaceChildren(); document.body.className = ''; delete document.fonts; vi.restoreAllMocks(); });

it('reads the fonts to load without laying the print out', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', cells: { '0,0': { v: 'Hello', s: { font: 'Open Sans', size: 13 } }, '1,0': { v: 2 } } }] });
  const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect');
  const laidOutRoot = () => rects.mock.contexts.some((node) => node.classList?.contains('print-root'));
  const result = printSheet(wb, wb.activeSheetId, 'Book', { fit: 'actual' });
  expect(fonts.load).toHaveBeenCalled();
  expect(laidOutRoot()).toBe(false);
  expect(await result).toBe(true);
  expect(window.print).toHaveBeenCalledTimes(1);
});
