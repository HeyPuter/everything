// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// Inserting a slicer said "Ctrl-click to choose several". On a Mac a Control-click is a right-click and chose
// nothing; the slicer takes ⌘-click there, and the notice now says so.
vi.mock('../src/ui/dom.js', async (importOriginal) => ({ ...(await importOriginal()), IS_MAC: true, MOD_KEY: '⌘' }));
const toasts = [];
vi.mock('../src/ui/toast.js', async (importOriginal) => ({ ...(await importOriginal()), toast: (text) => { toasts.push(text); return { dismiss() {} }; } }));

const { Workbook } = await import('../src/core/workbook.js');
const { openInsertSlicersDialog } = await import('../src/ui/insertslicers.js');
const { closeAllModals } = await import('../src/ui/modal.js');

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

it('tells a Mac user to ⌘-click to choose several items', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'V'], ['East', '1'], ['West', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 });
  const table = wb.sheet(id).tables[0];
  openInsertSlicersDialog({ wb, sheetId: () => id, grid: { focus() {}, selectChart() {} } }, { table });
  const panel = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  panel.querySelector('input[type="checkbox"]').click();
  panel.querySelector('form').requestSubmit();
  expect(toasts.at(-1)).toMatch(/⌘-click to choose several/);
});
