import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// The app's own settings sheet, which Excel keeps when it saves, listed the hidden rows and columns, and every
// one of them came back hidden on reopening: rows or columns unhidden in Excel were hidden again here. A part
// whose hidden lines are no longer the ones this app's save wrote was changed in Excel, and its lines now win.
async function saved() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  for (let r = 0; r < 6; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.setHidden(id, 'row', [2, 40], true);
  wb.setHidden(id, 'col', [3], true);
  return workbookToXlsx(wb);
}
const sheet1 = (edit) => ({ '/xl/worksheets/sheet1.xml': edit });
const hidden = (wb) => ({ rows: [...wb.sheets[0].hiddenRows].sort((a, b) => a - b), cols: [...wb.sheets[0].hiddenCols].sort((a, b) => a - b) });

it('keeps rows and columns unhidden in Excel on show', async () => {
  const rowShown = sheet1((xml) => xml.replace(/(<row r="3"[^>]*?) hidden="1"/, '$1'));
  expect(hidden(await workbookFromFile(await editedXlsx(await saved(), rowShown), 'mine.xlsx'))).toEqual({ rows: [40], cols: [3] });
  const colShown = sheet1((xml) => xml.replace(/(<col min="4"[^>]*?) hidden="1"/, '$1'));
  expect(hidden(await workbookFromFile(await editedXlsx(await saved(), colShown), 'mine.xlsx'))).toEqual({ rows: [2, 40], cols: [] });
});

it('keeps the hidden lines this app saved while Excel left them alone', async () => {
  // Excel spells the same lines its own way: columns as runs, attributes in another order.
  const respelled = sheet1((xml) => xml.replace(/<row r="3"([^>]*?) hidden="1"([^>]*)>/, '<row hidden="true" r="3"$1$2>'));
  expect(hidden(await workbookFromFile(await editedXlsx(await saved(), respelled), 'mine.xlsx'))).toEqual({ rows: [2, 40], cols: [3] });
});
