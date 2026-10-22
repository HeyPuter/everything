// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as notifications from '../src/ui/toast.js';

// Editing a table from the Name Manager switched to the table's sheet first. On a very hidden sheet that unhid the
// sheet but left it marked very hidden: shown in the tabs, yet listed nowhere to hide again. On a hidden sheet of a
// workbook whose structure is protected the switch was refused, and the table's dialog opened over the sheet in view,
// where its changes went. Neither sheet can be reached from the user interface, so the table is not opened.
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
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function open({ veryHidden = false, locked = false } = {}) {
  const doc = new Doc({ name: 'Book', path: 'Spreadsheets/Book.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const secret = wb.addSheet('Secret');
  for (const [r, a, b] of [[0, 'Name', 'Qty'], [1, 'a', '1'], [2, 'b', '2']]) { wb.setInput(secret.id, r, 0, a); wb.setInput(secret.id, r, 1, b); }
  const table = wb.addTable(secret.id, { r1: 0, c1: 0, r2: 2, c2: 1 });
  wb.setActiveSheet(home);
  wb.setSheetHidden(secret.id, true);
  if (veryHidden) secret.veryHidden = true;
  if (locked) wb.setStructureProtected(true);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const toast = vi.spyOn(notifications, 'toast');
  view.run('editTableById', { sheetId: secret.id, id: table });
  await vi.advanceTimersByTimeAsync(1);
  return { wb, home, secret, toast, dialog: document.querySelector('[role="dialog"] input[aria-label="Table name"]') };
}

it('leaves a very hidden sheet very hidden and does not open its table', async () => {
  const { wb, home, secret, toast, dialog } = await open({ veryHidden: true });
  expect([secret.hidden, secret.veryHidden]).toEqual([true, true]);
  expect(wb.activeSheetId).toBe(home);
  expect(dialog).toBeNull();
  expect(wb.canUndo()).toBe(false);
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Secret/), expect.anything());
});

it('does not open a table on a hidden sheet that the protected structure keeps hidden', async () => {
  const { wb, home, secret, dialog } = await open({ locked: true });
  expect(secret.hidden).toBe(true);
  expect(wb.activeSheetId).toBe(home);
  expect(dialog).toBeNull();
});

it('still shows a hidden sheet and opens its table otherwise', async () => {
  const { wb, secret, dialog } = await open();
  expect(secret.hidden).toBe(false);
  expect(wb.activeSheetId).toBe(secret.id);
  expect(dialog?.value).toBe(secret.tables[0].name);
});
