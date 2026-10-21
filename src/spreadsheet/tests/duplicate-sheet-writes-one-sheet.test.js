import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

/** Count the entries read out of one sheet's cell store, which is how a sheet is serialized. */
function watchStore(sheet) {
  const map = sheet.cells;
  const entries = map[Symbol.iterator].bind(map);
  let n = 0;
  map[Symbol.iterator] = function walked() {
    const it = entries();
    return { next: () => { const r = it.next(); if (!r.done) n++; return r; }, [Symbol.iterator]() { return this; } };
  };
  return () => n;
}

// Duplicating a sheet, and copying one to another file, serialized the whole workbook to get the one sheet's
// JSON: the same 10,000-cell sheet cost 19 ms in a 30,000-cell book and 1.1 s in a 650,000-cell one, although
// nothing in the copy reads the other sheets.

/** A sheet with something of every kind on it, so the copy can be compared with it whole. */
function furnished(wb, id) {
  for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) wb.setInput(id, r, c, String(r * 4 + c));
  wb.setInput(id, 6, 0, '=SUM(A1:A6)');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 3 }, { bold: true, bg: '#eeeeee' });
  wb.setNote(id, 1, 1, 'a note');
  wb.mergeCells(id, { r1: 3, c1: 2, r2: 4, c2: 3 });
  wb.addRule(id, { type: 'scale', range: { r1: 0, c1: 0, r2: 5, c2: 0 }, min: { color: '#ffffff' }, max: { color: '#ff0000' } });
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 3, r2: 5, c2: 3 }, source: 'a,b,c' });
  wb.addChart(id, { type: 'line', range: { r1: 0, c1: 0, r2: 5, c2: 1 }, anchor: { r: 8, c: 1 }, w: 200, h: 120 });
  wb.setColWidth(id, 2, 140);
  wb.setRowHeight(id, 3, 40);
  wb.setFrozen(id, 1, 1);
  wb.setHidden(id, 'row', [5], true);
}

/** Everything toJSON says about a sheet apart from what must differ between an original and its copy. */
const shapeOf = (wb, id) => {
  const { id: _i, name: _n, hidden: _h, charts, rules, validations, tables, ...rest } = wb.toJSON().sheets.find((s) => s.id === id);
  return { ...rest, charts: charts.map(({ id: _c, ...ch }) => ch), rules: rules.map(({ id: _r, ...r }) => r), validations: validations.map(({ id: _v, ...v }) => v), tables };
};

describe('duplicating a sheet', () => {
  it('copies everything on the sheet, and nothing of the other sheets', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    furnished(wb, id);
    const other = wb.addSheet('Other').id;
    wb.setInput(other, 0, 0, 'elsewhere');
    const copy = wb.duplicateSheet(id);
    expect(copy.name).toBe('Sheet1 (2)');
    expect(shapeOf(wb, copy.id)).toEqual(shapeOf(wb, id));
    expect(wb.getValue(copy.id, 6, 0)).toBe(wb.getValue(id, 6, 0));
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet1 (2)', 'Other']);
    // The other sheet is untouched, and the copy is undone whole.
    wb.undo();
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Other']);
    expect(wb.getValue(other, 0, 0)).toBe('elsewhere');
  });

  it('copies one sheet to a new workbook with the names it uses, and nothing of the rest', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    furnished(wb, id);
    const other = wb.addSheet('Other').id;
    wb.setInput(other, 0, 0, 'elsewhere');
    expect(wb.defineName('Used', 'Sheet1!$A$1', null)).toBe(null);
    expect(wb.defineName('Unused', 'Other!$A$1', null)).toBe(null);
    wb.setInput(id, 7, 0, '=Used');
    const out = wb.sheetToWorkbook(id);
    expect(out.sheets).toHaveLength(1);
    expect(shapeOf(out, out.sheets[0].id)).toEqual(shapeOf(wb, id));
    expect(out.names.map((n) => n.name)).toEqual(['Used']);
    expect(out.getValue(out.sheets[0].id, 7, 0)).toBe(wb.getValue(id, 7, 0));
  });

  it('does not copy the cells of the sheets it is not copying', { timeout: 60000 }, () => {
    const SRC = 2000, OTHERS = 8;
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const fill = (sheetId, n) => {
      const entries = [];
      for (let r = 0; r < n / 5; r++) for (let c = 0; c < 5; c++) entries.push({ r, c, cell: { v: (r * 7 + c) % 100, f: null } });
      wb.setCells(sheetId, entries, 'Fill');
    };
    fill(id, SRC);
    for (let k = 0; k < OTHERS; k++) fill(wb.addSheet(`S${k}`).id, SRC);
    const elsewhere = wb.sheets.slice(1).map(watchStore);
    const read = () => elsewhere.reduce((sum, count) => sum + count(), 0);

    const copy = wb.duplicateSheet(id);
    expect(copy.cells.size).toBe(SRC);
    const afterDuplicate = read();
    const out = wb.sheetToWorkbook(id);
    expect(out.sheets[0].cells.size).toBe(SRC);
    // The eight other sheets hold 16,000 cells between them, and every one used to be serialized for a copy
    // of a sheet that reads none of them. Neither call may now walk so much as one of those sheets.
    expect(afterDuplicate).toBeLessThan(SRC);
    expect(read() - afterDuplicate).toBeLessThan(SRC);
  });
});
