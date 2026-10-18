// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { stepCodeDecimals } from '../src/core/numfmt.js';
import { hasDecimalPlaces } from '../src/core/format.js';
import { paletteCommands } from '../src/ui/palette.js';
import { ACCOUNTING_CODE } from '../src/ui/toolbar.js';

// More and Fewer decimal places were greyed out on every custom code, so a cell in Accounting (one click on
// the ribbon), with a Negative numbers style from Format Cells, or with the #,##0.00_);(#,##0.00) of a sheet
// from Excel could not be shown with fewer places, the usual next step in Excel. They now add or take away a
// place in each section of the code that shows a number.
describe('stepping the decimal places of a custom code', () => {
  it.each([
    ['#,##0.00_);(#,##0.00)', 1, '#,##0.000_);(#,##0.000)'],
    ['#,##0.00_);(#,##0.00)', -1, '#,##0.0_);(#,##0.0)'],
    ['#,##0.0;[Red](#,##0.0)', -1, '#,##0;[Red](#,##0)'],
    ['0%', 1, '0.0%'],
    ['0.00E+00', -1, '0.0E+00'],
    ['#,##0,"K"', 1, '#,##0.0,"K"'],
    ['0.00 "kg"', 1, '0.000 "kg"'],
    ['[>=1000000]0.0,,"M";0', 1, '[>=1000000]0.00,,"M";0.0'],
    ['0;-0;;@', 1, '0.0;-0.0;;@'],
    [ACCOUNTING_CODE, -1, '_($* #,##0.0_);_($* (#,##0.0);_($* "-"?_);_(@_)'],
    [ACCOUNTING_CODE, 1, '_($* #,##0.000_);_($* (#,##0.000);_($* "-"???_);_(@_)'],
  ])('%s by %i is %s', (code, step, stepped) => {
    expect(stepCodeDecimals(code, step)).toBe(stepped);
  });

  it('has nothing to step in dates, times, fractions, text or General, or below no places', () => {
    for (const code of ['yyyy-mm-dd', '[h]:mm:ss', 'h:mm AM/PM', '# ?/?', '@', 'General', '[Red]General']) {
      expect(stepCodeDecimals(code, 1), code).toBeNull();
      expect(hasDecimalPlaces({ fmt: 'custom', code }), code).toBe(false);
    }
    expect(stepCodeDecimals('#,##0_);(#,##0)', -1)).toBeNull();
    expect(hasDecimalPlaces({ fmt: 'custom', code: '#,##0_);(#,##0)' })).toBe(true);
    expect(paletteCommands({ style: { fmt: 'custom', code: ACCOUNTING_CODE } }).some((c) => c.cmd === 'dec')).toBe(true);
  });
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = () => vi.advanceTimersByTimeAsync(1);

it('Fewer decimal places shows an Accounting column in whole numbers, each cell keeping its own code', async () => {
  const doc = new Doc({ name: 'Decimals', path: 'Spreadsheets/Decimals.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1234.5');
  wb.setInput(id, 1, 0, '-0.25');
  wb.setInput(id, 2, 0, '2024-01-15');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'custom', code: ACCOUNTING_CODE });
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { fmt: 'custom', code: '0.0%;[Red]-0.0%' });
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await flush();
  view.goTo('Sheet1!A1:A3');
  await flush();
  await view.run('dec', -1);
  await view.run('dec', -1);
  expect(wb.getCell(id, 0, 0).s.code).toBe('_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)');
  expect(wb.getDisplay(id, 0, 0).trim()).toMatch(/^\$\s*1,235$/);
  expect(wb.getCell(id, 1, 0).s.code).toBe('0%;[Red]-0%');
  expect(wb.getDisplay(id, 1, 0)).toBe('-25%');
  expect(wb.getCell(id, 2, 0).s).toMatchObject({ fmt: 'date' });
  await view.run('dec', 1);
  expect(wb.getCell(id, 1, 0).s.code).toBe('0.0%;[Red]-0.0%');
});
