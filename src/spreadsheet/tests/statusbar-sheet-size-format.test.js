// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createStatusBar } from '../src/ui/statusbar.js';
import { single } from '../src/core/selection.js';
import { closeMenu } from '../src/ui/menu.js';

afterEach(() => { closeMenu(); document.body.replaceChildren(); });

it('writes the sheet size with digit grouping for both rows and columns', () => {
  const wb = new Workbook({ sheets: [{ name: 'S', rows: 1048576, cols: 16384, cells: {} }] });
  const sel = single(0, 0);
  const grid = { selection: sel, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }], zoom: 1, active: sel.active };
  const bar = createStatusBar({ wb, sheetId: () => wb.activeSheetId, grid, subscribe: () => () => {}, activeCell: () => null, run() {} });
  document.body.append(bar.el);
  const rows = (1048576).toLocaleString(), cols = (16384).toLocaleString();
  expect(bar.el.querySelector('.status-size').textContent).toBe(`${rows} rows, ${cols} columns`);
  bar.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const size = [...document.querySelectorAll('.menu [role="menuitemcheckbox"]')].find((b) => b.querySelector('.menu-label').textContent === 'Sheet Size');
  expect(size.querySelector('.menu-detail').textContent).toBe(`${rows} × ${cols}`);
  bar.destroy();
});
