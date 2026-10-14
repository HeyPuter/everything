import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { changeEntries, clearChangeHistory, CHANGE_LIMIT, CELL_DETAIL_LIMIT, TEXT_LIMIT, entryPlace } from '../src/core/change-history.js';

const book = () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Other' }] });
  wb.changeAuthor = 'ada';
  return wb;
};

describe('change history recording', () => {
  it('records a typed value with its old and new contents, author and place', () => {
    const wb = book();
    const id = wb.activeSheetId;
    wb.setInput(id, 1, 1, '5');
    wb.setInput(id, 1, 1, '=1+2');
    const [latest, first] = changeEntries(wb).entries;
    expect(first).toMatchObject({ kind: 'cells', author: 'ada', count: 1, cells: [{ r: 1, c: 1, from: null, to: '5' }] });
    expect(latest.cells[0]).toEqual({ r: 1, c: 1, from: '5', to: '=1+2' });
    expect(entryPlace(wb, latest)).toBe('Data!B2');
    expect(latest.at).toBeGreaterThan(0);
  });

  it('leaves a change of format alone out', () => {
    const wb = book();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'x');
    const n = wb.changeHistory.length;
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    expect(wb.changeHistory.length).toBe(n);
  });

  it('keeps a many-cell write as one entry listing a bounded number of cells', () => {
    const wb = book();
    const id = wb.activeSheetId;
    const entries = [];
    for (let r = 0; r < 500; r++) entries.push({ r, c: 0, cell: { v: r, f: null } });
    wb.setCells(id, entries, 'Paste');
    const [e] = changeEntries(wb).entries;
    expect(e.label).toBe('Paste');
    expect(e.count).toBe(500);
    expect(e.cells.length).toBe(CELL_DETAIL_LIMIT);
    expect(e.box).toEqual({ r1: 0, c1: 0, r2: 499, c2: 0 });
  });

  it('joins the writes of one transaction on one sheet', () => {
    const wb = book();
    const id = wb.activeSheetId;
    wb.transaction('Fill', () => { wb.setInput(id, 0, 0, 'a'); wb.setInput(id, 1, 0, 'b'); wb.setInput(id, 0, 0, 'c'); });
    expect(wb.changeHistory).toHaveLength(1);
    const [e] = wb.changeHistory;
    expect(e.count).toBe(2);
    expect(e.cells).toEqual([{ r: 0, c: 0, from: null, to: 'c' }, { r: 1, c: 0, from: null, to: 'b' }]);
  });

  it('records rows inserted, and undo and redo, by name; is not itself undone', () => {
    const wb = book();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1');
    wb.insertRows(id, 0, 2);
    wb.undo();
    wb.redo();
    expect(changeEntries(wb).entries.map((e) => `${e.kind}:${e.label}`)).toEqual(['redo:Insert rows', 'undo:Insert rows', 'structure:Insert rows', 'cells:Edit cell']);
  });

  it('keeps only the newest entries and cuts long values', () => {
    const wb = book();
    const id = wb.activeSheetId;
    for (let i = 0; i < CHANGE_LIMIT + 20; i++) wb.setInput(id, 0, 0, String(i));
    expect(wb.changeHistory).toHaveLength(CHANGE_LIMIT);
    expect(wb.changeHistory.at(-1).cells[0].to).toBe(String(CHANGE_LIMIT + 19));
    wb.setInput(id, 0, 1, 'x'.repeat(5000));
    expect(wb.changeHistory.at(-1).cells[0].to.length).toBe(TEXT_LIMIT);
  });

  it('filters by sheet and by range, cutting an entry to the cells in the range', () => {
    const wb = book();
    const [a, b] = wb.sheets.map((s) => s.id);
    wb.setCells(a, [{ r: 0, c: 0, cell: { v: 1 } }, { r: 5, c: 5, cell: { v: 2 } }], 'Paste');
    wb.setInput(b, 0, 0, 'other');
    expect(changeEntries(wb, { sheetId: b }).entries).toHaveLength(1);
    const { entries } = changeEntries(wb, { sheetId: a, range: { r1: 5, c1: 5, r2: 5, c2: 5 } });
    expect(entries).toHaveLength(1);
    expect(entries[0].cells).toEqual([{ r: 5, c: 5, from: null, to: '2' }]);
    expect(changeEntries(wb, { sheetId: a, range: { r1: 2, c1: 2, r2: 3, c2: 3 } }).entries).toHaveLength(0);
    const page = changeEntries(wb, { limit: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.more).toBe(true);
  });

  it('clears, marking the book changed', () => {
    const wb = book();
    wb.setInput(wb.activeSheetId, 0, 0, '1');
    wb.dirty = false;
    let heard = null;
    wb.addEventListener('change', (e) => { heard = e.detail.type; });
    expect(clearChangeHistory(wb)).toBe(true);
    expect(wb.changeHistory).toEqual([]);
    expect(wb.dirty).toBe(true);
    expect(heard).toBe('change-history');
  });
});
