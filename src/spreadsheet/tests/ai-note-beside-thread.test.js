import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread } from '../src/core/comments.js';
import { runTool } from '../src/core/aitools.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';

// A cell holds a note or a comment thread, not both (the editor turns New Note on a thread into a reply). The
// assistant's add_note put a note beside a thread anyway and reported it added; saving wrote the thread's own
// note in the cell's one place, so the assistant's note was gone when the file was opened again.
it('refuses a note on a cell that holds a comment thread, and leaves the thread as it was', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  addComment(wb, id, 0, 0, 'Is this final?', 'Ana');
  const res = runTool(wb, 'add_note', { cell: 'A1', text: 'Checked by the assistant' }, { sheetId: () => id });
  expect(res.ok).toBe(false);
  expect(res.changed).toBe(false);
  expect(res.content).toMatch(/Sheet1!A1 holds a comment thread/);
  expect(wb.getNote(id, 0, 0)).toBeNull();
  expect(getThread(wb, id, 0, 0).items.map((i) => i.text)).toEqual(['Is this final?']);
});

it('still adds a note beside a thread on another cell, and keeps both through a save', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  addComment(wb, id, 0, 0, 'Is this final?', 'Ana');
  expect(runTool(wb, 'add_note', { cell: 'B1', text: 'Checked' }, { sheetId: () => id }).ok).toBe(true);
  const back = await workbookFromFile(await (await workbookToXlsx(wb)).arrayBuffer(), 'book.xlsx');
  expect(back.getNote(back.activeSheetId, 0, 1)).toBe('Checked');
  expect(getThread(back, back.activeSheetId, 0, 0).items.map((i) => i.text)).toEqual(['Is this final?']);
});
