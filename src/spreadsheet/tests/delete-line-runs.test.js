import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { adjustFormula, deleteMap } from '../src/core/refs.js';

// Deleting the shown rows of a filtered list deleted each run of rows on its
// own, renumbering every cell and formula of the workbook once per run: 2,000
// runs took seconds, 20,000 minutes. The workbook now deletes any number of
// runs in one pass and one undo step, with the same outcome as the runs deleted
// one after another.
const grid = (rows, r0 = 0, c0 = 0) => rows.flatMap((row, r) => row.map((v, c) => (v == null ? null : { r: r + r0, c: c + c0, cell: typeof v === 'string' && v.startsWith('=') ? { v: null, f: v.slice(1) } : { v } }))).filter(Boolean);

/** A sheet with a little of everything that a deletion renumbers. */
function rich() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [];
  for (let r = 0; r < 12; r++) rows.push([`n${r}`, r * 10, `=B${r + 1}*2`, r === 0 ? '=SUM(B2:B12)' : r === 2 ? '=B5+B7' : null]);
  wb.setCells(id, grid(rows));
  wb.setCells(id, grid([['X', 'Y'], [1, null], [2, null], [3, null], [4, null]], 0, 5));
  const tid = wb.addTable(id, parseRange('F1:G5'), { name: 'T', totalsRow: true });
  wb.setInput(id, 1, 6, '=[@X]*2');
  const other = wb.addSheet('Other');
  wb.setInput(other.id, 0, 0, '=Sheet1!B4+SUM(Sheet1!B2:B12)+SUM(T[Y])');
  wb.setNote(id, 2, 0, 'two');
  wb.setNote(id, 5, 0, 'five');
  wb.mergeCells(id, parseRange('B8:C8'));
  wb.mergeCells(id, parseRange('A10:A11'));
  wb.setRowHeight(id, 3, 40);
  wb.setRowHeight(id, 6, 50);
  wb.setHidden(id, 'row', [7], true);
  wb.protectRange(id, parseRange('A12'), 'keep');
  wb.groupLines(id, 'row', 2, 6);
  wb.setFrozen(id, 2, 0);
  wb.defineName('Tot', 'Sheet1!$B$2:$B$12');
  wb.addRule(id, { type: 'formula', range: parseRange('B1:B12'), value: 'B1>30', style: { bold: true } });
  wb.addChart(id, { type: 'column', range: parseRange('B1:B12'), anchor: { r: 4, c: 8 } });
  wb.setFilterRange(id, parseRange('A1:D12'));
  wb.setFilterCriteria(id, 0, { text: 'n' });
  wb.clearHistory();
  return { wb, id, tid };
}
const runs = [{ from: 1, to: 1 }, { from: 3, to: 3 }, { from: 5, to: 5 }, { from: 8, to: 9 }];

describe('deleting several runs of lines at once', () => {
  it('renumbers references for every run in one rewrite', () => {
    const lines = deleteMap([{ from: 3, to: 3 }, { from: 1, to: 1 }]);
    expect(lines.runs).toEqual([{ from: 1, to: 1 }, { from: 3, to: 3 }]);
    expect([0, 1, 2, 3, 4, 10].map((i) => lines.move(i))).toEqual([0, null, 1, null, 2, 8]);
    expect(lines.next(3)).toBe(4);
    const on = { ownerSheet: 'Sheet1', sheetName: 'Sheet1', axis: 'row', remove: true, lines };
    expect(adjustFormula('SUM(A1:A10)+A3+A5+A2+A2:A4', on)).toBe('SUM(A1:A8)+A2+A3+#REF!+A2:A2');
    expect(deleteMap([{ from: 2, to: 4 }, { from: 5, to: 6 }, { from: 0, to: 3 }]).runs).toEqual([{ from: 0, to: 6 }]);
  });

  it('leaves the workbook exactly as deleting the runs one after another would, in one undo step', () => {
    const { wb, id } = rich();
    const before = new Workbook(wb.toJSON()).toJSON();
    const oneByOne = new Workbook(wb.toJSON());
    oneByOne.transaction('Delete rows', () => { for (const { from, to } of [...runs].reverse()) oneByOne.deleteRows(oneByOne.sheets[0].id, from, to - from + 1); });
    expect(wb.deleteLines(id, 'row', [...runs].reverse())).toBe(true);
    expect(wb.toJSON()).toEqual(oneByOne.toJSON());
    expect(wb.sheet(id).rows).toBe(before.sheets[0].rows - 5);
    expect(wb.getCell(id, 0, 3)?.f).toBe('SUM(B2:B7)');
    expect(wb.getCell(id, 1, 3)?.f).toBe('B3+B4');
    expect(wb.getCell(id, 1, 2)?.f).toBe('B2*2');
    expect(wb.getCell(wb.sheets[1].id, 0, 0)?.f).toBe('#REF!+SUM(Sheet1!B2:B7)+SUM(T[Y])');
    expect(wb.sheet(id).tables[0].range).toEqual(parseRange('F1:G3'));
    expect(wb.undoLabel()).toBe('Delete rows');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    expect(wb.canUndo()).toBe(false);
  });

  it('renumbers a defined name between two runs as the cells around it are renumbered', () => {
    // Names were renumbered as if the runs were one band from the first: a name on the row between two
    // deleted rows moved up by both and pointed one row too high (Remove All subtotals did this).
    const { wb, id } = rich();
    wb.defineName('Mid', 'Sheet1!$B$8');
    wb.defineName('Span', 'Sheet1!$B$3:$B$8');
    wb.setInput(id, 0, 9, '=Mid');
    const oneByOne = new Workbook(wb.toJSON());
    oneByOne.transaction('Delete rows', () => { for (const { from, to } of [...runs].reverse()) oneByOne.deleteRows(oneByOne.sheets[0].id, from, to - from + 1); });
    expect(wb.deleteLines(id, 'row', runs)).toBe(true);
    expect(wb.names.find((n) => n.name === 'Mid').ref).toBe('Sheet1!$B$5');
    expect(wb.names.find((n) => n.name === 'Span').ref).toBe('Sheet1!$B$2:$B$5');
    expect(wb.names).toEqual(oneByOne.names);
    expect(wb.getValue(id, 0, 9)).toBe(70);
  });

  it('does the same for columns', () => {
    const { wb, id } = rich();
    const oneByOne = new Workbook(wb.toJSON());
    const colRuns = [{ from: 1, to: 1 }, { from: 3, to: 3 }, { from: 5, to: 5 }];
    oneByOne.transaction('Delete columns', () => { for (const { from, to } of [...colRuns].reverse()) oneByOne.deleteCols(oneByOne.sheets[0].id, from, to - from + 1); });
    expect(wb.deleteLines(id, 'col', colRuns)).toBe(true);
    expect(wb.toJSON()).toEqual(oneByOne.toJSON());
    expect(wb.getCell(id, 1, 1)?.f).toBe('#REF!*2');
    expect(wb.sheet(id).tables[0].range).toEqual(parseRange('D1:D6'));
  });

  it('refuses the whole deletion when one run holds a protected cell, and clips runs to the sheet', () => {
    const { wb, id } = rich();
    const before = wb.toJSON();
    expect(wb.deleteLines(id, 'row', [{ from: 1, to: 1 }, { from: 11, to: 11 }])).toBe(false);
    expect(wb.toJSON()).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    expect(wb.deleteLines(id, 'row', [{ from: 5000, to: 6000 }])).toBe(false);
    const rows = wb.sheet(id).rows;
    expect(wb.deleteLines(id, 'row', [{ from: rows - 2, to: 6000 }])).toBe(true);
    expect(wb.sheet(id).rows).toBe(rows - 2);
  });

  it('takes about as long for two thousand runs as for one', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const entries = [];
    for (let r = 0; r <= 4000; r++) for (let c = 0; c < 3; c++) entries.push({ r, c, cell: { v: r === 0 ? `H${c}` : r % 2 ? 'odd' : 'even' } });
    wb.setCells(id, entries);
    wb.setInput(id, 0, 5, '=SUM(B2:B4001)');
    const many = [];
    for (let r = 1; r <= 4000; r += 2) many.push({ from: r, to: r });
    const t0 = performance.now();
    expect(wb.deleteLines(id, 'row', many)).toBe(true);
    const took = performance.now() - t0;
    expect(wb.sheet(id).rows).toBe(2001);
    expect(wb.getCell(id, 0, 5).f).toBe('SUM(B2:B2001)');
    expect([1, 2, 2000].map((r) => wb.getValue(id, r, 0))).toEqual(['even', 'even', 'even']);
    // Run by run this took about five seconds; a generous ceiling keeps a loaded machine from failing it.
    expect(took).toBeLessThan(2000);
  });
});
