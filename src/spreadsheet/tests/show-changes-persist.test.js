import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';
import { changeEntries, entryPlace, normalizeChangeHistory } from '../src/core/change-history.js';
import { saveDraft, loadDraft, sameBook } from '../src/lib/drafts.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

function edited() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Notes' }] });
  wb.changeAuthor = 'grace';
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Revenue');
  wb.setInput(id, 1, 0, '=SUM(B1:B3)');
  wb.renameSheet(id, 'Sales');
  return wb;
}

describe('change history persistence', () => {
  it('stays out of toJSON, so undo still restores the book exactly', () => {
    const wb = edited();
    expect(wb.toJSON().changeHistory).toBeUndefined();
    const before = wb.toJSON();
    wb.setInput(wb.activeSheetId, 5, 5, 'x');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    expect(wb.changeHistory.length).toBe(5); // three edits, the write and its undo
  });

  it('survives a draft round trip, and does not count as a difference from the book', () => {
    const wb = edited();
    expect(saveDraft('draft:test', wb, 'Book')).toBe(true);
    const draft = loadDraft('draft:test');
    expect(draft.workbook.changeHistory).toHaveLength(3);
    expect(sameBook(draft.workbook, wb.toJSON())).toBe(true);
    const copy = new Workbook();
    copy.replaceWith(draft.workbook);
    expect(changeEntries(copy).entries.map((e) => entryPlace(copy, e))).toEqual(['', 'Sales!A2', 'Sales!A1']);
  });

  it.each([['xlsx', workbookToXlsx], ['ods', workbookToOds]])('survives saving as .%s and opening again, by sheet name', async (ext, write) => {
    const wb = edited();
    const blob = await write(wb);
    const reopened = await workbookFromFile(new Uint8Array(await blob.arrayBuffer()), `book.${ext}`);
    const { entries } = changeEntries(reopened);
    expect(entries.map((e) => `${e.label}|${e.author}|${entryPlace(reopened, e)}`)).toEqual(['Rename sheet|grace|', 'Edit cell|grace|Sales!A2', 'Edit cell|grace|Sales!A1']);
    expect(entries[1].cells[0]).toEqual({ r: 1, c: 0, from: null, to: '=SUM(B1:B3)' });
    // Filtering by the reopened sheet's own id finds its edits through the name (the rename was to the book's sheets).
    expect(changeEntries(reopened, { sheetId: reopened.sheetByName('Sales').id }).entries).toHaveLength(2);
  });

  it.each([['xlsx', workbookToXlsx], ['ods', workbookToOds]])('leaves the record out of a downloaded .%s copy', async (ext, write) => {
    const wb = edited();
    const blob = await write(wb, { history: false });
    const reopened = await workbookFromFile(new Uint8Array(await blob.arrayBuffer()), `book.${ext}`);
    expect(changeEntries(reopened).entries).toEqual([]);
    expect(reopened.getCell(reopened.sheetByName('Sales').id, 0, 0)?.v).toBe('Revenue');
  });

  it('drops malformed records from a file', () => {
    const list = normalizeChangeHistory([null, { kind: 'bogus', at: 1 }, { kind: 'cells', at: 5, label: 'x', cells: [{ r: -1, c: 0 }, { r: 2, c: 3, from: 7, to: 'y' }], box: { r1: 0, c1: 0, r2: 'z', c2: 1 } }]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'cells', at: 5, box: null, cells: [{ r: 2, c: 3, from: null, to: 'y' }], count: 1 });
  });
});
