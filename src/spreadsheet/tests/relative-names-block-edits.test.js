import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A relative defined name stores its relative coordinates as offsets from A1 (Sheet1!A1048576 is "the cell
// above"). Insert/Delete rows left them alone, but Insert/Delete cells, Move rows/columns and cut-paste
// renumbered the offset as if it were a fixed address, so every formula using the name broke.
const book = () => new Workbook({ sheets: [{ id: 's1', name: 'Sheet1', cells: {
  '0,1': { v: 5 }, '1,1': { v: null, f: 'Above*2' }, '4,3': { v: 7 }, '5,3': { v: null, f: 'Above*2' },
  '0,5': { v: 1 }, '1,5': { v: null, f: 'Fixed' } } }],
names: [{ name: 'Above', ref: 'Sheet1!A1048576', relative: true }, { name: 'Fixed', ref: 'Sheet1!$F$1', relative: true }] });
const ref = (wb, name) => wb.names.find(n => n.name === name).ref;

describe('relative defined names under block edits', () => {
  it('keeps the offset through Insert cells, Delete cells and Move columns', () => {
    for (const edit of [
      wb => wb.insertCells('s1', { r1: 0, c1: 0, r2: 0, c2: 0 }, 'down'),
      wb => wb.deleteCells('s1', { r1: 9, c1: 0, r2: 9, c2: 0 }, 'up'),
      wb => wb.insertCells('s1', { r1: 0, c1: 7, r2: 9, c2: 7 }, 'right'),
    ]) {
      const wb = book();
      edit(wb);
      expect(ref(wb, 'Above')).toBe('Sheet1!A1048576');
      expect(wb.getValue('s1', 1, 1)).toBe(10);
      expect(wb.getValue('s1', 5, 3)).toBe(14);
    }
    const wb = book();
    const before = JSON.stringify(wb.toJSON());
    wb.moveCols('s1', 0, 1, 8);
    expect(ref(wb, 'Above')).toBe('Sheet1!A1048576');
    expect(wb.getValue('s1', 1, 0)).toBe(10);
    expect(wb.getValue('s1', 5, 2)).toBe(14);
    wb.undo();
    expect(JSON.stringify(wb.toJSON())).toBe(before);
  });

  it('keeps the offset when a cut block holds the cell it reads as an address', () => {
    const wb = book();
    wb.moveRange('s1', { r1: 1048575, c1: 0, r2: 1048575, c2: 0 }, 1048575, 1);
    expect(ref(wb, 'Above')).toBe('Sheet1!A1048576');
    expect(wb.getValue('s1', 1, 1)).toBe(10);
  });

  it('still moves a wholly absolute reference in a relative name', () => {
    const wb = book();
    wb.insertCells('s1', { r1: 0, c1: 5, r2: 0, c2: 5 }, 'down');
    expect(ref(wb, 'Fixed')).toBe('Sheet1!$F$2');
    wb.moveRows('s1', 1, 1, 0);
    expect(ref(wb, 'Fixed')).toBe('Sheet1!$F$1');
  });
});
