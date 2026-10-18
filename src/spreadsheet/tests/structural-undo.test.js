import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals } from '../src/core/subtotal.js';

describe('undoing a structural edit', () => {
  it('keeps sheet protection and the view switches, which follow only their own steps', () => {
    const wb = new Workbook();
    const a = wb.activeSheetId;
    wb.addSheet('Two');
    const b = wb.sheets[1].id;
    wb.setInput(a, 0, 0, 'top');
    wb.setSheetProtected(b, true);
    wb.setGridlines(a, false);
    wb.setZeros(a, false);
    wb.insertRows(a, 0, 1);
    wb.undo(); // the structural step, which must leave all three where they are
    expect(wb.getValue(a, 0, 0)).toBe('top');
    expect(wb.isProtected(b)).toBe(true);
    expect(wb.sheets[0].gridlines).toBe(false);
    expect(wb.sheets[0].zeros).toBe(false);
    wb.redo();
    expect(wb.getValue(a, 1, 0)).toBe('top');
    expect(wb.isProtected(b)).toBe(true);
    expect(wb.sheets[0].gridlines).toBe(false);
    // Each of the three is a step of its own, so undoing one flips that one back and nothing else.
    wb.setSheetProtected(b, false);
    expect(wb.undoLabel()).toBe('Unprotect sheet');
    wb.undo();
    expect(wb.isProtected(b)).toBe(true);
    expect(wb.getValue(a, 1, 0)).toBe('top');
    wb.redo();
    expect(wb.isProtected(b)).toBe(false);
    // A deleted sheet comes back with the protection it had.
    wb.setSheetProtected(b, true);
    wb.deleteSheet(b);
    wb.undo();
    expect(wb.isProtected(wb.sheets[1].id)).toBe(true);
  });
});

describe('structural steps inside one transaction', () => {
  it('share a single pair of snapshots, so tools that insert a row per group stay linear', () => {
    const rows = 300;
    const cells = {};
    for (let r = 0; r < rows; r++) { cells[`${r},0`] = { v: `G${Math.floor(r / 3)}` }; cells[`${r},1`] = { v: r }; }
    const wb = new Workbook({ sheets: [{ name: 'S', rows: rows + 10, cols: 4, cells }] });
    const id = wb.activeSheetId;
    const before = vi.spyOn(wb, '_capture'); // the state before a structural step is captured (see Workbook._capture)
    const after = vi.spyOn(wb, '_snapshot'); // the state after it is serialized when the step is first undone
    const out = addSubtotals(wb, id, { r1: 0, c1: 0, r2: rows - 1, c2: 1 }, { groupCol: 0, totalCols: [1], header: false, sort: false });
    expect(out).toBeTruthy();
    // 100 group rows and a grand total were inserted one at a time; the history holds one snapshot, not two hundred.
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    expect(wb.getValue(id, 3, 0)).toBe('G0 Total');
    expect(wb.getValue(id, 3, 1)).toBe(3);
    expect(wb.getValue(id, out.r2, 1)).toBe((rows * (rows - 1)) / 2);
    wb.undo();
    expect(after).toHaveBeenCalledTimes(1); // the redo state is captured when first undone
    expect(wb.getValue(id, 3, 0)).toBe('G1');
    expect(wb.sheets[0].cells.size).toBe(rows * 2);
    wb.redo();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(wb.getValue(id, 3, 0)).toBe('G0 Total');
    expect(wb.getValue(id, out.r2, 0)).toBe('Grand Total');
    wb.undo();
    expect(wb.sheets[0].cells.size).toBe(rows * 2);
  });

  it('records a single step for a lone insertion and snapshots its redo state only when undone', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'a');
    const before = vi.spyOn(wb, '_capture');
    const after = vi.spyOn(wb, '_snapshot');
    wb.insertRows(id, 0, 2);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    wb.setInput(id, 5, 0, 'later');
    wb.undo(); // the later edit
    expect(after).not.toHaveBeenCalled();
    wb.undo(); // the insertion
    expect(after).toHaveBeenCalledTimes(1);
    expect(wb.getValue(id, 0, 0)).toBe('a');
    wb.redo();
    expect(wb.getValue(id, 2, 0)).toBe('a');
    expect(wb.getValue(id, 5, 0)).toBeNull();
    wb.redo();
    expect(wb.getValue(id, 5, 0)).toBe('later');
  });
});
