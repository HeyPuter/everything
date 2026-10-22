import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseFormula } from '../src/core/formula/parser.js';
import { astToText } from '../src/core/formula/print.js';
import { xlsxScalarFormula } from '../src/core/xlsx-scalar-formula.js';

// @ bound looser than the percent sign, so @A1:A3% in B2 intersected the computed array A1:A3%, which has no
// address and gave its first value, A1%. A file spells it SINGLE(A1:A3)%, and Excel answers A2% there; so does
// =A1:A3% in an ordinary cell of a legacy file, which opens as @A1:A3%.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (const [r, v] of [[0, '10'], [1, '20'], [2, '30']]) wb.setInput(id, r, 0, v);
  return { wb, id };
}

it('intersects the reference before the percent sign applies', () => {
  const { wb, id } = book();
  wb.setInput(id, 1, 1, '=@A1:A3%');
  wb.setInput(id, 2, 1, `=${xlsxScalarFormula('A1:A3%')}`);
  wb.setInput(id, 1, 2, '=-@A1:A3%');
  wb.setInput(id, 1, 3, '=@(A1:A3%)');
  expect(wb.getValue(id, 1, 1)).toBe(0.2);
  expect(wb.getValue(id, 2, 1)).toBe(0.3);
  expect(wb.getValue(id, 1, 2)).toBe(-0.2);
  expect(wb.getValue(id, 1, 3)).toBe(0.1); // an array has no row to intersect: its first value
});

it('prints the two groupings so that they read back as written', () => {
  for (const text of ['@A1:A3%', '@(A1:A3%)', '-@A1:A3%', '@A1:A3%%']) {
    const ast = parseFormula(text);
    expect(parseFormula(astToText(ast))).toEqual(ast);
  }
  expect(parseFormula('@A1:A3%')).toEqual(parseFormula('(@A1:A3)%'));
  expect(astToText(parseFormula('@(A1:A3%)'))).toBe('@(A1:A3%)');
});
