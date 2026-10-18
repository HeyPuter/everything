import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// The grid asks for each cell it draws which merge, validation rule and conditional formats cover it, and each
// question walked the sheet's whole list. A file bringing thousands of them (conditional formats multiplied by
// copying, a merge on every row of a report) made every scroll step cost a quarter of a second for one screen.
// Long lists are now filed by bands of rows; the answers are the ones the walk gave.

function book(n) {
  const cells = {};
  for (let r = 0; r < 2000; r++) for (let c = 0; c < 10; c++) cells[`${r},${c}`] = { v: r + c };
  const rules = [], validations = [], merges = [];
  for (let i = 0; i < n; i++) {
    rules.push({ id: `r${i}`, range: { r1: i % 2000, c1: i % 10, r2: i % 2000, c2: i % 10 }, type: 'gt', value: String(i % 50), style: { bg: `#${(i % 4096).toString(16).padStart(3, '0')}` } });
    validations.push({ id: `v${i}`, range: { r1: i % 2000, c1: (i + 3) % 10, r2: i % 2000, c2: (i + 3) % 10 }, type: 'list', source: `a${i},b` });
    merges.push({ r1: 3000 + i * 2, c1: 0, r2: 3001 + i * 2, c2: 1 });
  }
  // Whole-column and overlapping rules are kept in order with the rest.
  rules.push({ id: 'col', range: { r1: 0, c1: 4, r2: 1048575, c2: 4 }, type: 'gt', value: '100', style: { bold: true } });
  rules.push({ id: 'wide', range: { r1: 10, c1: 0, r2: 1500, c2: 9 }, type: 'lt', value: '20', style: { italic: true } });
  validations.push({ id: 'all', range: { r1: 0, c1: 9, r2: 1048575, c2: 9 }, type: 'whole' });
  return new Workbook({ sheets: [{ name: 'S', rows: 50000, cols: 12, cells, rules, validations, merges }] });
}

/** The answers by walking every item, as before. */
function walked(wb, id, r, c) {
  const sheet = wb.sheet(id);
  const merge = sheet.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) || null;
  let validation = null;
  for (let i = sheet.validations.length - 1; i >= 0; i--) {
    const g = sheet.validations[i].range;
    if (r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2) { validation = sheet.validations[i]; break; }
  }
  const saved = sheet.rules;
  sheet.rules = saved.filter((rule) => { const g = rule.range; return r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2; });
  const style = wb.conditionalStyle(id, r, c, wb.getValue(id, r, c));
  sheet.rules = saved;
  return { merge, validation, style };
}

it('answers as walking every merge, validation and rule did', () => {
  const wb = book(3000);
  const id = wb.activeSheetId;
  for (const [r, c] of [[0, 0], [5, 4], [10, 0], [63, 3], [64, 3], [127, 9], [999, 4], [1500, 2], [1999, 9], [3000, 0], [3001, 1], [4321, 0], [8999, 1], [9000, 0], [20000, 4]]) {
    const want = walked(wb, id, r, c);
    expect(wb.mergeAt(id, r, c)).toEqual(want.merge);
    expect(wb.validationAt(id, r, c)).toEqual(want.validation);
    expect(wb.conditionalStyle(id, r, c, wb.getValue(id, r, c))).toEqual(want.style);
  }
});

it('follows the lists as they change', () => {
  const wb = book(3000);
  const id = wb.activeSheetId;
  expect(wb.mergeAt(id, 3000, 0)).toEqual({ r1: 3000, c1: 0, r2: 3001, c2: 1 });
  wb.insertRows(id, 0, 1);
  expect(wb.mergeAt(id, 3000, 0)).toBe(null);
  expect(wb.mergeAt(id, 3001, 0)).toEqual({ r1: 3001, c1: 0, r2: 3002, c2: 1 });
  wb.unmergeCells(id, { r1: 3001, c1: 0, r2: 3002, c2: 1 });
  expect(wb.mergeAt(id, 3001, 0)).toBe(null);
  const ruleId = wb.addValidation(id, { range: { r1: 40, c1: 2, r2: 40, c2: 2 }, type: 'text', max: 3 });
  expect(wb.validationAt(id, 40, 2).id).toBe(ruleId);
  wb.undo();
  expect(wb.validationAt(id, 40, 2)?.id).not.toBe(ruleId);
});

it('draws a screen of a sheet with thousands of each quickly', () => {
  const wb = book(20000);
  const id = wb.activeSheetId;
  const screen = () => {
    const t = performance.now();
    for (let r = 1000; r < 1050; r++) for (let c = 0; c < 10; c++) {
      wb.conditionalStyle(id, r, c, wb.getValue(id, r, c));
      wb.validationAt(id, r, c);
      wb.mergeAt(id, r, c);
    }
    return performance.now() - t;
  };
  screen();
  // Walking twenty thousand of each for every cell took a quarter of a second a screen.
  expect(Math.min(screen(), screen())).toBeLessThan(60);
});
