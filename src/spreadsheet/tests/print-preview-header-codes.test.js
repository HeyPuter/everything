// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A header or footer from Excel carries formatting codes (&"Arial,Bold", &14, &K colours, &B): the print sets them as
// styles, but the preview drew them as text, "&"Arial,Bold"&14Quarterly report".
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
const drawn = [], fonts = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  drawn.length = 0; fonts.length = 0;
  const g = new Proxy({ fillText(t) { drawn.push(t); fonts.push([t, this.font, this.fillStyle]); } }, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('draws the formatting codes of a header and footer as the styles they name', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'x');
  wb.setPrintSettings(id, { header: '&L&"Arial,Bold"&14Quarterly report&R&KFF0000Draft', footer: '&C&BPage &P&B of &N' });
  const ctx = { wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} }, doc: { name: 'Stock' } };
  openPrintDialog(ctx);
  await vi.advanceTimersByTimeAsync(5);
  expect(drawn.filter((t) => t.includes('&'))).toEqual([]);
  expect(drawn).toEqual(expect.arrayContaining(['Quarterly report', 'Draft', 'Page ', '1', ' of ']));
  const style = (text) => fonts.find(([t]) => t === text);
  expect(style('Quarterly report')[1]).toMatch(/^700 /);
  expect(style('Draft')[2]).toBe('#ff0000');
  expect(style('Page ')[1]).toMatch(/^700 /);
  expect(style(' of ')[1]).toMatch(/^400 /);
});
