// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A cell that wraps its text prints every line of it, and a line break in a cell that does not wrap prints as no break
// at all. The print preview drew only the text before the first line break, on one line at the foot of the cell, so a
// wrapped note previewed as its first few words and "Line one⏎line two" as "Line one".
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let ops;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  ops = [];
  const state = { measureText: (t) => ({ width: String(t).length * 6 }) };
  const g = new Proxy(state, {
    get: (o, k) => (k in o ? o[k] : (...args) => ops.push({ op: k, args })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

async function preview(wb, id) {
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  return ops.filter((o) => o.op === 'fillText').map((o) => ({ text: o.args[0], y: o.args[2] }));
}

it('draws every line of wrapped text, one under another', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Call the venue\nthen book the room for the whole team');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  wb.setRowHeight(id, 0, 120);
  wb.setInput(id, 1, 3, 'x');
  const texts = await preview(wb, id);
  const lines = texts.filter((t) => t.text !== 'x' && !/Page|Spreadsheet/.test(t.text));
  expect(lines.length).toBeGreaterThan(2);
  expect(lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ')).toBe('Call the venue then book the room for the whole team');
  for (let i = 1; i < lines.length; i++) expect(lines[i].y).toBeGreaterThan(lines[i - 1].y);
});

it('prints a line break in a cell that does not wrap as no break, as the print does', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Line one\nline two' } }]);
  const texts = (await preview(wb, id)).map((t) => t.text);
  expect(texts).toContain('Line oneline two');
});
