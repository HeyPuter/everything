// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as IO from '../src/core/io.js';
import * as P from '../src/lib/puter.js';
import { openCopySheetDialog } from '../src/ui/copysheet.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// Copying a sheet into an existing spreadsheet whose workbook structure is protected (Protect Workbook, kept in
// the .xlsx) added nothing, yet the file was written back unchanged and the toast said the sheet was copied.
beforeEach(() => {
  vi.useFakeTimers();
  toast.mockClear();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('says the destination is protected and leaves its file alone', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Source' }] });
  const other = new Workbook({ sheets: [{ name: 'Destination' }], structureProtected: true });
  const path = 'Spreadsheets/Destination.xlsx';
  const revision = { uid: 'file-1', modified: 100, size: 50 };
  vi.spyOn(P, 'listFiles').mockResolvedValue([{ path, name: 'Destination.xlsx' }]);
  vi.spyOn(P, 'readFile').mockResolvedValue(new ArrayBuffer(0));
  vi.spyOn(IO, 'workbookFromFile').mockResolvedValue(other);
  vi.spyOn(IO, 'workbookToXlsx').mockResolvedValue(new Blob(['copy']));
  vi.spyOn(P, 'statFile').mockResolvedValue(revision);
  const write = vi.spyOn(P, 'writeFile').mockResolvedValue({ path });
  const { panel } = openCopySheetDialog({ wb, grid: { focus() {} }, run() {} }, wb.activeSheetId);
  await vi.advanceTimersByTimeAsync(0);
  panel.querySelector('[value="existing"]').click();
  panel.querySelector('form').requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(other.sheets.map((s) => s.name)).toEqual(['Destination']);
  expect(write).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  const error = panel.querySelector('.field-error');
  expect(error.hidden).toBe(false);
  expect(error.textContent).toContain('Destination has its workbook structure protected');
  expect(panel.isConnected).toBe(true);
});
