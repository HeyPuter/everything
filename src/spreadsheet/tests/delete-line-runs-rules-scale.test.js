import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Every reference a rule rewrite moves goes through these two: counting them measures the work without a clock.
const moves = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/core/refs.js', async (original) => {
  const refs = await original();
  return { ...refs,
    adjustRefForDelete: (...args) => { moves.count++; return refs.adjustRefForDelete(...args); },
    adjustRefForDeletedLines: (...args) => { moves.count++; return refs.adjustRefForDeletedLines(...args); } };
});

// Deleting many separate rows at once (the rows a filter shows, Remove empty rows) rewrote every conditional
// format and validation rule once per stretch of rows deleted: on a sheet from Excel with a rule per row, deleting
// 1,000 scattered rows among 5,000 took over two seconds, and the time grew with the square of the sheet. Each
// rule is now rewritten once for the whole deletion, with the same result as one stretch after another.
function book(count) {
  const cells = {};
  const rules = [];
  const validations = [];
  for (let r = 0; r < count; r++) {
    cells[`${r},0`] = { v: r };
    rules.push({ type: 'gt', value: 5, range: { r1: r, c1: 0, r2: r, c2: 0 }, style: { bold: true } });
    // A rule that reads its own row, and a dropdown whose source runs down a column beside the data.
    rules.push({ type: 'formula', value: `$A${r + 1}>$A$1`, range: { r1: r, c1: 1, r2: r, c2: 1 }, style: { italic: true } });
    validations.push({ type: 'list', source: `=$F$1:$F$${count}`, range: { r1: r, c1: 2, r2: r, c2: 2 } });
  }
  return new Workbook({ sheets: [{ name: 'Data', rows: count + 10, cols: 10, cells, rules, validations }] });
}
const everyFourth = (count) => Array.from({ length: count / 4 }, (_, i) => ({ from: i * 4 + 1, to: i * 4 + 1 }));

it('deletes thousands of scattered rows under per-row rules rewriting each rule once, not once per run', () => {
  const wb = book(2000);
  moves.count = 0;
  expect(wb.deleteLines(wb.activeSheetId, 'row', everyFourth(2000))).toBe(true);
  // 6,000 rules and 500 runs: a handful of references moved per rule (three million, a rule and a run at a time, before).
  expect(moves.count).toBeLessThan(6000 * 10);
  const sheet = wb.activeSheet;
  expect(sheet.rules).toHaveLength(1500 * 2);
  expect(sheet.validations).toHaveLength(1500);
  // Each rule is still on the row of the value it was on, reading that row and the first, and the dropdown's
  // source has lost the deleted rows of its column.
  const row = (value) => [...sheet.cells].find(([, cell]) => cell.v === value)[0].split(',').map(Number)[0];
  const at = (list, r, c) => list.filter((g) => g.range.r1 <= r && g.range.r2 >= r && g.range.c1 <= c && g.range.c2 >= c);
  expect(row(1999)).toBe(1499);
  expect(at(sheet.rules, 1499, 1).map((g) => g.value)).toEqual(['$A1500>$A$1']);
  expect(at(sheet.rules, 1499, 0)).toHaveLength(1);
  expect(at(sheet.validations, 1499, 2).map((g) => g.source)).toEqual(['=$F$1:$F$1500']);
  expect(at(sheet.rules, row(2), 1).map((g) => g.value)).toEqual([`$A${row(2) + 1}>$A$1`]);
  wb.undo();
  expect(wb.activeSheet.rules).toHaveLength(4000);
  expect(wb.activeSheet.rules[3].value).toBe('$A2>$A$1');
});
