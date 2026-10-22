import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange, rangeName } from '../src/core/cell.js';

// Rows moved through a rule, or cells inserted or deleted beside part of it, split it into pieces. Each piece
// ranked only its own values (a Top 3 marked 10 and 20 in a piece of two cells) and a piece of alternating colours
// started over with a header row. The pieces are still one rule, as Excel keeps one rule over several areas.
function sheet(rule) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addRule(id, { range: parseRange('C1:C10'), style: { bold: true }, ...rule });
  for (let i = 0; i < 10; i++) wb.setInput(id, i, 2, String((i + 1) * 10));
  return { wb, id };
}
const marked = (wb, id, key = 'bold') => {
  const out = [];
  for (let r = 0; r < 12; r++) for (let c = 1; c < 5; c++) {
    const v = wb.getValue(id, r, c);
    if (v != null && wb.conditionalStyle(id, r, c, v)?.[key]) out.push(`${rangeName({ r1: r, c1: c, r2: r, c2: c })}=${v}`);
  }
  return out;
};

it.each([
  ['cells inserted to the right', (wb, id) => wb.insertCells(id, parseRange('C3'), 'right')],
  ['cells deleted to the left', (wb, id) => wb.deleteCells(id, parseRange('C3'), 'left')],
  ['rows moved out of the rule', (wb, id) => wb.moveRows(id, 2, 2, 12)],
])('ranks the values of every piece together after %s', (_, edit) => {
  const { wb, id } = sheet({ type: 'top', value: 3 });
  edit(wb, id);
  expect(wb.sheet(id).rules.length).toBeGreaterThan(1);
  expect(marked(wb, id).map(text => text.split('=')[1])).toEqual(['80', '90', '100']);
});

it('keeps a colour scale\'s lowest and highest over all the pieces', () => {
  const { wb, id } = sheet({ type: 'scale', from: '#ffffff', to: '#000000' });
  wb.insertCells(id, parseRange('C5'), 'right');
  expect(wb.conditionalStyle(id, 0, 2, 10).bg).toBe('#ffffff');
  expect(wb.conditionalStyle(id, 9, 2, 100).bg).toBe('#000000');
  expect(wb.conditionalStyle(id, 3, 2, 40).bg).not.toBe('#000000'); // the highest of its own piece, not of the rule
});

it('keeps alternating colours counting from the rule\'s first row', () => {
  const { wb, id } = sheet({ type: 'bands', color1: '#111111', color2: '#222222', headerColor: '#999999', header: true, style: {} });
  const before = Array.from({ length: 10 }, (_, r) => wb.conditionalStyle(id, r, 2, wb.getValue(id, r, 2)).bg);
  wb.insertCells(id, parseRange('C3'), 'right');
  const after = Array.from({ length: 10 }, (_, r) => wb.conditionalStyle(id, r, r === 2 ? 3 : 2, wb.getValue(id, r, r === 2 ? 3 : 2)).bg);
  expect(after).toEqual(before);
});
