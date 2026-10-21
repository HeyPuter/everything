// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRibbon } from '../src/ui/ribbon.js';
import { Workbook } from '../src/core/workbook.js';

// Every edit and selection move refreshes the toolbar, and each refresh wrote 0 to the tools' scrollTop, which makes
// the browser lay the page out there and then, after the grid had just redrawn; on the ribbon it was refreshed twice
// a time, once by the ribbon and once on its own. The scroll is reset only when the tools stop scrolling (a narrow
// window's expanded tools closed), and the ribbon alone refreshes its Home tab's toolbar.
let ribbon;
afterEach(() => { ribbon?.destroy(); ribbon = null; vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

it('refreshes the Home tools once per change, without writing their scroll position', () => {
  const wb = new Workbook();
  const listeners = new Set();
  const state = { style: {}, singleCell: true };
  let styleReads = 0;
  const ctx = { wb, flags: () => state, run: vi.fn(), style: () => { styleReads++; return state.style; }, active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId,
    grid: { editing: false, focus() {} }, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  ribbon = createRibbon(ctx);
  document.body.append(ribbon.el);
  const tools = ribbon.el.querySelector('.toolbar-tools');
  let writes = 0;
  Object.defineProperty(tools, 'scrollTop', { configurable: true, get: () => 0, set: () => { writes++; } });
  styleReads = 0;
  for (const fn of listeners) fn();
  expect(styleReads).toBe(1);
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  for (const fn of listeners) fn();
  expect(writes).toBe(0);
  state.style = { bold: true };
  for (const fn of listeners) fn();
  expect(ribbon.el.querySelector('button[aria-label="Bold"]').getAttribute('aria-pressed')).toBe('true');
});
