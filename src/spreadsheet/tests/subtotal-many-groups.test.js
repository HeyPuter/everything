import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { colName, normalizeRange, parseRange } from '../src/core/cell.js';
import { addSubtotals, removeSubtotals } from '../src/core/subtotal.js';
import { addComment } from '../src/core/comments.js';
import { MAX_COL } from '../src/core/refs.js';

// Data > Subtotal inserted its total rows one at a time, and every insertion renumbered the whole sheet and
// every formula of the book: 20,000 rows in 2,000 groups took minutes. The rows now go in at once
// (insertRowsAt), with what inserting them one after another gave.

const identity = (v) => (v == null || v === '' ? 'string:' : typeof v === 'string' ? `string:${v.trim().toLowerCase()}`
  : typeof v === 'object' ? `error:${v.error ?? ''}` : `${typeof v}:${v}`);
const formatOf = (style) => {
  const out = {};
  for (const k of ['fmt', 'dec', 'cur', 'dateStyle', 'sec', 'group', 'code']) if (style?.[k] != null) out[k] = style[k];
  return out;
};

/** What addSubtotals did before: a row inserted under each group in turn, from the bottom up. */
function addSubtotalsOneByOne(wb, sheetId, range, { groupCol, code = 9, totalCols, header = true, sort = true, group = true }) {
  const n = normalizeRange(range);
  const r0 = header ? n.r1 + 1 : n.r1;
  const cols = totalCols.filter((c) => c >= n.c1 && c <= n.c2 && c !== groupCol);
  return wb.transaction('Add subtotals', () => {
    const end = n.r2 - removeSubtotals(wb, sheetId, n);
    if (sort) wb.sortRangeBy(sheetId, { ...n, r1: r0, r2: end }, [{ col: groupCol, ascending: true }]);
    const groups = [];
    let start = r0;
    let key = identity(wb.getValue(sheetId, r0, groupCol));
    for (let r = r0 + 1; r <= end; r++) {
      const k = identity(wb.getValue(sheetId, r, groupCol));
      if (k !== key) { groups.push({ from: start, to: r - 1 }); start = r; key = k; }
    }
    groups.push({ from: start, to: end });
    const totalRow = (r, label, from, to, extra) => {
      const entries = [{ r, c: groupCol, cell: { v: label, f: null, s: { bold: true, ...extra } } }];
      for (const c of cols) {
        const fmt = formatOf(wb.getCell(sheetId, to, c)?.s);
        entries.push({ r, c, cell: { v: null, f: `SUBTOTAL(${code},${colName(c)}${from + 1}:${colName(c)}${to + 1})`, s: { ...fmt, bold: true, ...extra } } });
      }
      wb.setCells(sheetId, entries, 'Add subtotals');
    };
    if (!wb.insertRows(sheetId, end + 1, 1)) throw new Error('refused');
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const label = wb.getDisplay(sheetId, g.from, groupCol) || '(blank)';
      if (!wb.insertRows(sheetId, g.to + 1, 1)) throw new Error('refused');
      totalRow(g.to + 1, `${label} Total`, g.from, g.to, {});
    }
    const last = end + groups.length + 1;
    totalRow(last, 'Grand Total', r0, last - 1, { bt: true, bs: 'thin' });
    if (group) {
      wb.groupLines(sheetId, 'row', r0, last - 1);
      groups.forEach((g, i) => wb.groupLines(sheetId, 'row', g.from + i, g.to + i));
    }
    wb.extendFilterOverRows(sheetId, n.r1, last, [...groups.map((g, i) => g.to + i + 1), last], n);
    return { ...n, r2: last };
  });
}

const REGIONS = ['West', 'East', 'North', 'South', 'Central'];

/** A list of 40 rows in A1:D41 with a little of everything an insertion renumbers around it. */
function rich() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const entries = [['Region', 'Item', 'Qty', 'Price'].map((v, c) => ({ r: 0, c, cell: { v } }))].flat();
  for (let r = 1; r <= 40; r++) {
    entries.push({ r, c: 0, cell: { v: REGIONS[(r * 7) % 5] } });
    entries.push({ r, c: 1, cell: { v: `item ${r}` } });
    entries.push({ r, c: 2, cell: { v: (r * 13) % 17 } });
    entries.push({ r, c: 3, cell: { v: null, f: `C${r + 1}*2` } });
    if (r % 6 === 0) entries.push({ r, c: 9, cell: { v: null, f: `C${r}+C${r + 1}+SUM($C$2:$C$41)` } });
  }
  entries.push({ r: 44, c: 2, cell: { v: null, f: 'SUM(C2:C41)+Cell' } });
  wb.setCells(id, entries);
  wb.applyStyle(id, parseRange('C2:C41'), { fmt: 'currency', dec: 2 });
  wb.applyStyle(id, { r1: 9, c1: 0, r2: 9, c2: MAX_COL }, { fill: '#ffeeaa' });
  wb.defineName('Cell', 'Sheet1!$C$5');
  wb.defineName('Qtys', 'Sheet1!$C$2:$C$41');
  wb.setNote(id, 6, 1, 'a note');
  addComment(wb, id, 12, 1, 'a comment', 'Ana');
  wb.setRowHeight(id, 8, 40);
  wb.setHidden(id, 'row', [15], true);
  wb.mergeCells(id, parseRange('H5:H9'));
  wb.mergeCells(id, parseRange('A50:B51'));
  wb.addRule(id, { type: 'formula', range: parseRange('C2:C41'), value: 'C2>8', style: { bold: true } });
  wb.addRule(id, { type: 'formula', range: parseRange('A2:D41'), value: '$C2>AVERAGE($C$2:$C$41)', style: { italic: true } });
  wb.addValidation(id, { type: 'number', min: 0, range: parseRange('C2:C41') });
  wb.addChart(id, { type: 'column', range: parseRange('C1:C41'), anchor: { r: 20, c: 11 } });
  const tableRows = [['X', 'Y'], [1, null], [2, null], [3, null]];
  wb.setCells(id, tableRows.flatMap((row, r) => row.map((v, c) => ({ r: 54 + r, c: c + 5, cell: { v } }))));
  wb.addTable(id, parseRange('F55:G58'), { name: 'Below' });
  wb.setInput(id, 55, 6, '=[@X]*2');
  wb.protectRange(id, parseRange('A60:B61'), 'keep');
  wb.groupLines(id, 'row', 62, 65);
  wb.setFrozen(id, 1, 0);
  wb.addWatches(id, [{ r: 20, c: 2 }]);
  wb.setFilterRange(id, parseRange('A1:D41'));
  wb.setFilterCriteria(id, 1, { op: 'contains', value: 'item' });
  const other = wb.addSheet('Other');
  wb.setInput(other.id, 0, 0, '=Sheet1!C5+SUM(Sheet1!C2:C41)+Sheet1!D41+SUM(Qtys)');
  wb.addCustomView('Everything');
  wb.clearHistory();
  return { wb, id };
}

describe('Subtotal over many groups', () => {
  it('writes what inserting the total rows one at a time wrote, in one undo step', () => {
    const { wb, id } = rich();
    const before = wb.toJSON();
    const oneByOne = new Workbook(before);
    const opts = { groupCol: 0, code: 9, totalCols: [2, 3] };
    const expected = addSubtotalsOneByOne(oneByOne, oneByOne.sheets[0].id, parseRange('A1:D41'), opts);
    const out = addSubtotals(wb, id, parseRange('A1:D41'), opts);
    expect(out).toEqual(expected);
    expect(out.r2).toBeGreaterThan(45);
    expect(wb.toJSON()).toEqual(oneByOne.toJSON());
    const values = (book) => book.sheets.map((s) => [...s.cells.keys()].sort().map((key) => [key, book.getDisplay(s.id, ...key.split(',').map(Number))]));
    expect(values(wb)).toEqual(values(oneByOne));
    expect([...wb.sheet(id).filterHidden]).toEqual([...oneByOne.sheet(oneByOne.sheets[0].id).filterHidden]);
    expect(wb.watches.map(({ r, c }) => [r, c])).toEqual(oneByOne.watches.map(({ r, c }) => [r, c]));
    expect(wb.getCell(id, out.r2, 0).v).toBe('Grand Total');
    expect(wb.undoLabel()).toBe('Add subtotals');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    wb.redo();
    expect(wb.toJSON()).toEqual(oneByOne.toJSON());
  });

  it('replaces totals already there as inserting them one at a time did', () => {
    const { wb, id } = rich();
    addSubtotals(wb, id, parseRange('A1:D41'), { groupCol: 0, totalCols: [2] });
    wb.clearHistory();
    const oneByOne = new Workbook(wb.toJSON());
    const opts = { groupCol: 0, code: 1, totalCols: [2, 3], sort: false };
    addSubtotalsOneByOne(oneByOne, oneByOne.sheets[0].id, parseRange('A1:D47'), opts);
    addSubtotals(wb, id, parseRange('A1:D47'), opts);
    expect(wb.toJSON()).toEqual(oneByOne.toJSON());
  });

  it('inserts rows at many places as inserting them from the bottom up does, a table among them', () => {
    const { wb, id } = rich();
    const ats = [3, 3, 9, 20, 41, 56, 70];
    const oneByOne = new Workbook(wb.toJSON());
    oneByOne.transaction('Insert rows', () => { for (const at of [...ats].reverse()) oneByOne.insertRows(oneByOne.sheets[0].id, at, 1); });
    expect(wb.insertRowsAt(id, ats)).toBe(true);
    expect(wb.toJSON()).toEqual(oneByOne.toJSON());
    const outside = ats.filter((at) => at !== 56);
    const fast = rich();
    const before = fast.wb.toJSON();
    const slow = new Workbook(before);
    slow.transaction('Insert rows', () => { for (const at of [...outside].reverse()) slow.insertRows(slow.sheets[0].id, at, 1); });
    expect(fast.wb.insertRowsAt(fast.id, outside)).toBe(true);
    // Every new row inside the filtered list stays in view until the filter is applied again. One at a time,
    // each insertion applied the filter and hid the blank rows the ones before it had added.
    const view = (book) => ({ ...book.toJSON(), sheets: book.toJSON().sheets.map(({ filterHidden, ...s }) => s) });
    expect(view(fast.wb)).toEqual(view(slow));
    expect(fast.wb.sheet(fast.id).filterHidden.size).toBe(0);
    const firstSlow = slow.sheet(slow.sheets[0].id).filterHidden;
    expect([...firstSlow].every((r) => fast.wb.getCell(fast.id, r, 0) == null)).toBe(true);
    expect(fast.wb.undoLabel()).toBe('Insert rows');
    fast.wb.undo();
    expect(fast.wb.toJSON()).toEqual(before);
  });

  it('refuses the whole insertion, changing nothing, when one row would split a protected range', () => {
    const { wb, id } = rich();
    const before = wb.toJSON();
    expect(wb.insertRowsAt(id, [3, 60])).toBe(false);
    expect(wb.toJSON()).toEqual(before);
    expect(wb.canUndo()).toBe(false);
  });

  it('adds and removes 2,000 groups over 20,000 rows in a second or two', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const N = 20000, G = 2000;
    const entries = [{ r: 0, c: 0, cell: { v: 'Key' } }, { r: 0, c: 1, cell: { v: 'Amount' } }];
    for (let r = 1; r <= N; r++) {
      entries.push({ r, c: 0, cell: { v: `G${String(Math.floor(((r - 1) * G) / N)).padStart(5, '0')}` } });
      entries.push({ r, c: 1, cell: { v: r } });
    }
    wb.setCells(id, entries);
    let t = performance.now();
    const out = addSubtotals(wb, id, { r1: 0, c1: 0, r2: N, c2: 1 }, { groupCol: 0, totalCols: [1] });
    const added = performance.now() - t;
    expect(out.r2).toBe(N + G + 1);
    expect(wb.getValue(id, N + G + 1, 1)).toBe((N * (N + 1)) / 2);
    expect(wb.getCell(id, 11, 1).f).toBe('SUBTOTAL(9,B2:B11)');
    expect(wb.getCell(id, N + G, 1).f).toBe(`SUBTOTAL(9,B${N + G - 9}:B${N + G})`);
    t = performance.now();
    expect(removeSubtotals(wb, id, out)).toBe(G + 1);
    const removed = performance.now() - t;
    // One at a time, adding them took a minute or more.
    expect(added).toBeLessThan(5000);
    expect(removed).toBeLessThan(5000);
  }, 60000);
});
