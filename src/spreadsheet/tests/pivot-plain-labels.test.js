import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot } from '../src/core/pivot.js';

function source(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v, f: null } }))));
  return { wb, id, range: { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 } };
}

function place(wb, id, spec) {
  const built = buildPivot(wb, id, spec);
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells);
  return { built, sheet, at: (r, c) => wb.getValue(sheet.id, r, c), f: (r, c) => wb.getCell(sheet.id, r, c)?.f };
}

// Every text label was matched through a pair of wildcard criteria, which the IFS functions test
// row by row; a plain label is now the criterion itself, which they look up in the column's index.
describe('pivot label criteria', () => {
  it('pass a plain text label bare and keep the literal pair for labels that need it', () => {
    const labels = ['East', 'Key 5', ' spaced ', '05', 'TRUE', '2026-01-05', 'A*', 'a?b', 'a~b', '>5', '=x', '<>y', '#N/A', 5];
    const { wb, id, range } = source([['Category', 'Amount'], ...labels.map((label, i) => [label, i + 1])]);
    const { built, at, f } = place(wb, id, { range, rowField: 0, colField: null, valueField: 1, agg: 'sum' });
    expect(built.rowCount).toBe(labels.length);
    // A tilde without * or ? is a literal criterion.
    const plain = ['east', 'key 5', ' spaced ', 'a~b'];
    for (let r = 1; r <= built.rowCount; r++) {
      const label = at(r, 0);
      expect(at(r, 1), `Category ${JSON.stringify(label)}`).toBe(labels.indexOf(label) + 1);
      if (typeof label === 'string' && plain.includes(label.toLowerCase())) expect(f(r, 1), label).toBe(`SUMIFS(Sheet1!$B$2:$B$15,Sheet1!$A$2:$A$15,$A${r + 1})`);
      else expect(f(r, 1), label).toContain(`IF(ISTEXT($A${r + 1}),"="&SUBSTITUTE(`);
    }
  });

  it('pass a plain column label bare too, and keep the pair for a filter cell', () => {
    const { wb, id, range } = source([['Region', 'Quarter', 'Product', 'Amount'], ['West', 'Q1', 'Pen', 1], ['West', 'Q2', 'Ink', 2], ['East', 'Q1', 'Pen', 4]]);
    const { at, f, sheet } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 3, agg: 'sum', filters: [{ field: 2, value: 'Pen' }] });
    // The filter sits in row 1 (label in A, value in B), then a blank row, then the header in row 3.
    expect(at(2, 0)).toBe('Region');
    expect(at(3, 0)).toBe('East');
    expect(f(3, 1)).toMatch(/,SUMIFS\(Sheet1!\$D\$2:\$D\$4,Sheet1!\$A\$2:\$A\$4,\$A4,Sheet1!\$B\$2:\$B\$4,B\$3,CHOOSE\(IF\(\$B\$1="\(All\)",1,2\),Sheet1!\$D\$2:\$D\$4,Sheet1!\$C\$2:\$C\$4\),IF\(\$B\$1="\(All\)","<>",IF\(ISTEXT\(\$B\$1\),/);
    expect([at(3, 1), at(3, 2), at(3, 3)]).toEqual([4, '', 4]); // East's pens
    expect([at(4, 1), at(4, 2), at(4, 3)]).toEqual([1, '', 1]); // West's pens
    wb.setInput(sheet.id, 0, 1, 'Ink');
    expect([at(3, 1), at(3, 2), at(3, 3)]).toEqual(['', '', '']);
    expect([at(4, 1), at(4, 2), at(4, 3)]).toEqual(['', 2, 2]);
    wb.setInput(sheet.id, 0, 1, '(All)');
    expect([at(4, 1), at(4, 2), at(4, 3)]).toEqual([1, 2, 3]);
  });

  it('sum a thousand labels over 20000 rows, and again after an edit, in a fraction of the time the pair took', () => {
    // Row i is Key (i mod 1000) with the amount i, so Key 0 sums 1000 + 2000 + ... + 19000 = 190000 and
    // Key 1 sums 1 + 1001 + ... + 19001 = 190020; the total is the sum of 1..19999.
    const rows = [['Key', 'Amount'], ...Array.from({ length: 19999 }, (_, k) => [`Key ${(k + 1) % 1000}`, k + 1])];
    const { wb, id, range } = source(rows);
    const { built, at } = place(wb, id, { range, rowField: 0, colField: null, valueField: 1, agg: 'sum' });
    expect(built.rowCount).toBe(1000);
    const start = performance.now();
    for (let r = 1; r <= built.rowCount + 1; r++) at(r, 1);
    wb.setInput(id, 1, 1, '5'); // row 1 is Key 1 with the amount 1, made 5
    for (let r = 1; r <= built.rowCount + 1; r++) at(r, 1);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(at(1, 0)).toBe('Key 0');
    expect(at(1, 1)).toBe(190000);
    expect(at(2, 0)).toBe('Key 1');
    expect(at(2, 1)).toBe(190024);
    expect(at(1001, 1)).toBe(199990004);
  });
});
