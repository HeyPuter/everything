import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { replayCell } from '../src/core/sheet-group.js';

function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }, { name: 'Mar' }] });
  const [a, b, c] = wb.sheets.map((s) => s.id);
  return { wb, a, b, c };
}

describe('sheet groups', () => {
  it('groups with the active sheet, in tab order, and a group of one is none', () => {
    const { wb, a, b, c } = book();
    expect(wb.sheetGroup).toBeNull();
    expect(wb.groupSheets([c])).toEqual([a, c]);
    expect(wb.isSheetGrouped(c)).toBe(true);
    expect(wb.isSheetGrouped(b)).toBe(false);
    wb.groupSheets([]);
    expect(wb.sheetGroup).toBeNull();
  });

  it('ends the group when another sheet outside it becomes active, and keeps it within', () => {
    const { wb, a, b, c } = book();
    wb.groupSheets([b]);
    wb.setActiveSheet(b);
    expect(wb.sheetGroup).toEqual([a, b]);
    wb.setActiveSheet(c);
    expect(wb.sheetGroup).toBeNull();
  });

  it('announces a change of group', () => {
    const { wb, b } = book();
    const types = [];
    wb.addEventListener('change', (e) => types.push(e.detail.type));
    wb.groupSheets([b]);
    wb.ungroupSheets();
    expect(types).toEqual(['sheet-group', 'sheet-group']);
  });

  it('types into the same cell of every grouped sheet, as one undo step', () => {
    const { wb, a, b, c } = book();
    wb.setInput(b, 0, 0, 'kept');
    wb.applyStyle(b, { r1: 1, c1: 1, r2: 1, c2: 1 }, { italic: true });
    wb.clearHistory();
    wb.groupSheets([b]);
    wb.setInput(a, 0, 0, '=1+1');
    wb.setInput(a, 1, 1, '42');
    expect(wb.getValue(b, 0, 0)).toBe(2);
    expect(wb.getCell(b, 0, 0).f).toBe('1+1');
    // The cell keeps its own formatting: only the contents were typed.
    expect(wb.getValue(b, 1, 1)).toBe(42);
    expect(wb.getCell(b, 1, 1).s.italic).toBe(true);
    expect(wb.getCell(c, 0, 0)).toBeFalsy();
    expect(wb.undoLabels()).toHaveLength(2);
    wb.undo();
    expect(wb.getCell(a, 1, 1)).toBeFalsy();
    expect(wb.getCell(b, 1, 1).v).toBeNull();
    wb.undo();
    expect(wb.getValue(b, 0, 0)).toBe('kept');
    wb.redo();
    expect(wb.getValue(b, 0, 0)).toBe(2);
  });

  it('formats the same range on each sheet, each keeping its other properties', () => {
    const { wb, a, b } = book();
    wb.applyStyle(b, { r1: 0, c1: 0, r2: 0, c2: 0 }, { italic: true });
    wb.clearHistory();
    wb.groupSheets([b]);
    wb.applyStyle(a, { r1: 0, c1: 0, r2: 1, c2: 1 }, { bold: true });
    expect(wb.getCell(b, 0, 0).s).toMatchObject({ bold: true, italic: true });
    expect(wb.getCell(b, 1, 1).s.bold).toBe(true);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(wb.getCell(b, 0, 0).s.bold).toBeFalsy();
    expect(wb.getCell(a, 0, 0)?.s?.bold).toBeFalsy();
  });

  it('carries a style write made through setCells as a change of the properties alone', () => {
    const { wb, a, b } = book();
    wb.setInput(a, 0, 0, 'x');
    wb.setInput(b, 0, 0, 'y');
    wb.groupSheets([b]);
    wb.setCells(a, [{ r: 0, c: 0, cell: { v: 'x', f: null, s: { size: 18 } } }], 'Font size');
    expect(wb.getCell(b, 0, 0)).toMatchObject({ v: 'y', s: { size: 18 } });
  });

  it('clears, inserts and deletes rows and sets column widths on every grouped sheet', () => {
    const { wb, a, b, c } = book();
    for (const id of [a, b, c]) { wb.setInput(id, 0, 0, 'top'); wb.setInput(id, 1, 0, 'below'); }
    wb.clearHistory();
    wb.groupSheets([b, c]);
    wb.insertRows(a, 1, 2);
    for (const id of [a, b, c]) expect(wb.getValue(id, 3, 0)).toBe('below');
    wb.deleteRows(a, 0, 1);
    for (const id of [a, b, c]) expect(wb.getValue(id, 2, 0)).toBe('below');
    wb.clearRange(a, { r1: 2, c1: 0, r2: 2, c2: 0 });
    for (const id of [a, b, c]) expect(wb.getCell(id, 2, 0)?.v ?? null).toBeNull();
    wb.setColWidth(a, 3, 180);
    for (const id of [a, b, c]) expect(wb.colWidth(id, 3)).toBe(180);
    expect(wb.undoLabels(10)).toHaveLength(4);
    wb.undoSteps(4);
    for (const id of [a, b, c]) { expect(wb.getValue(id, 1, 0)).toBe('below'); expect(wb.colWidth(id, 3)).not.toBe(180); }
  });

  it('leaves sheets outside the group, and edits off the active sheet, alone', () => {
    const { wb, a, b, c } = book();
    wb.groupSheets([b]);
    wb.setInput(c, 0, 0, 'only here');
    wb.setInput(b, 0, 1, 'not active');
    expect(wb.getCell(a, 0, 0)).toBeFalsy();
    expect(wb.getCell(a, 0, 1)).toBeFalsy();
    wb.ungroupSheets();
    wb.setInput(a, 4, 4, 'alone');
    expect(wb.getCell(b, 4, 4)).toBeFalsy();
  });

  it('fills across worksheets: everything, contents only, or formats only', () => {
    const { wb, a, b, c } = book();
    wb.setInput(a, 0, 0, '=2*3');
    wb.applyStyle(a, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    wb.setInput(b, 0, 0, 'old');
    wb.applyStyle(b, { r1: 0, c1: 0, r2: 0, c2: 0 }, { italic: true });
    wb.clearHistory();
    const range = [{ r1: 0, c1: 0, r2: 0, c2: 0 }];
    wb.fillAcrossSheets(a, [b], range, 'contents');
    expect(wb.getValue(b, 0, 0)).toBe(6);
    expect(wb.getCell(b, 0, 0).s).toEqual({ italic: true });
    wb.undo();
    wb.fillAcrossSheets(a, [b], range, 'formats');
    expect(wb.getValue(b, 0, 0)).toBe('old');
    expect(wb.getCell(b, 0, 0).s).toEqual({ bold: true });
    wb.undo();
    wb.fillAcrossSheets(a, [b, c], range, 'all');
    for (const id of [b, c]) { expect(wb.getValue(id, 0, 0)).toBe(6); expect(wb.getCell(id, 0, 0).s).toEqual({ bold: true }); }
    expect(wb.undoLabels()).toEqual(['Fill across worksheets']);
  });
});

describe('replayCell', () => {
  it('writes new contents and keeps the target style when only the contents changed', () => {
    expect(replayCell({ v: 1, f: null, s: { bold: true } }, null, { v: 'x', f: null })).toEqual({ v: 'x', f: null, s: { bold: true } });
  });
  it('changes only the style properties that changed', () => {
    expect(replayCell({ v: 1, f: null, s: { italic: true } }, { v: 2, f: null, s: { size: 10 } }, { v: 2, f: null, s: { size: 10, bold: true } }))
      .toEqual({ v: 1, f: null, s: { italic: true, bold: true } });
  });
  it('removes a property the write removed', () => {
    expect(replayCell({ v: 1, f: null, s: { bold: true, italic: true } }, { v: 1, f: null, s: { bold: true } }, { v: 1, f: null })).toEqual({ v: 1, f: null, s: { italic: true } });
  });
  it('returns the target unchanged when nothing changed', () => {
    const t = { v: 1, f: null };
    expect(replayCell(t, { v: 2, f: null }, { v: 2, f: null })).toBe(t);
  });
});
