import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// The answers kept for SUMIFS, MAXIFS and the other criteria functions are keyed by the values of every range they
// are given, and the key was built by reading those ranges first to last: the sum or max range before the criteria
// ranges the function itself reads first. Inside a circle of references, which cell is read first settles whether
// the circle is a cycle, so a formula on one showed 0 or #CYCLE! depending on which cell happened to be worked out
// first (the order the sheet was drawn in), where it showed #CYCLE! either way before the answers were kept.
const at = (a) => ({ r: Number(a.slice(1)) - 1, c: a.charCodeAt(0) - 65 });
function book(withLink) {
  const wb = new Workbook(), s = wb.activeSheetId;
  const cells = { A2: '=F5&""', B42: '=F5&""', H1: '=SUMIFS(B1:B55,A1:A55,"",C1:C55,"")', E3: '=MAXIFS($B$1:B3,$C$1:C3,"",$A$1:A3,"a")', F5: '=AVERAGEIFS(B:B,A:A,"")' };
  if (withLink) cells.A10 = '=E3';
  for (const [a, f] of Object.entries(cells)) wb.setInput(s, at(a).r, at(a).c, f);
  return { wb, s };
}
const value = (wb, s, a) => wb.getValue(s, at(a).r, at(a).c);

it('settles a circle through a criteria function the same whichever cell is worked out first', () => {
  const byRows = (wb, s) => { for (let r = 0; r < 55; r++) for (let c = 0; c < 10; c++) wb.getValue(s, r, c); };
  const byColumns = (wb, s) => { for (let c = 0; c < 10; c++) for (let r = 0; r < 55; r++) wb.getValue(s, r, c); };
  for (const order of [byRows, byColumns]) {
    const fresh = book(true);
    order(fresh.wb, fresh.s);
    expect(value(fresh.wb, fresh.s, 'E3'), order.name).toEqual({ error: '#CYCLE!' });
    expect(value(fresh.wb, fresh.s, 'A10'), order.name).toEqual({ error: '#CYCLE!' });
    // Linked into the circle by an edit, as when it is typed.
    const edited = book(false);
    byRows(edited.wb, edited.s);
    edited.wb.setInput(edited.s, 9, 0, '=E3');
    order(edited.wb, edited.s);
    expect(value(edited.wb, edited.s, 'E3'), order.name).toEqual({ error: '#CYCLE!' });
  }
});

it('still answers a column of category totals from the values kept', () => {
  const wb = new Workbook(), s = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < 300; r++) {
    entries.push({ r, c: 0, cell: { v: `c${r % 3}` } }, { r, c: 1, cell: { v: r } });
    entries.push({ r, c: 2, cell: { f: `SUMIFS(B:B,A:A,A${r + 1})` } }, { r, c: 3, cell: { f: `MAXIFS(B:B,A:A,A${r + 1})` } });
  }
  wb.setCells(s, entries);
  const total = (k) => [...Array(300).keys()].filter((r) => r % 3 === k).reduce((a, b) => a + b, 0);
  for (let r = 0; r < 300; r++) {
    expect(wb.getValue(s, r, 2)).toBe(total(r % 3));
    expect(wb.getValue(s, r, 3)).toBe(297 + (r % 3));
  }
  // Pairs of unequal shapes are refused, as before.
  wb.setInput(s, 0, 5, '=SUMIFS(B1:B10,A1:A9,"c1")');
  expect(wb.getValue(s, 0, 5)).toEqual({ error: '#VALUE!' });
});
