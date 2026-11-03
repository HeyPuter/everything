import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { tokenize } from '../src/core/formula/tokenizer.js';

// An error value typed in lower case, =#n/a or =IFERROR(#div/0!,1), was refused as an unknown error
// literal and the cell showed #ERROR!. Excel reads error values in any case.
it.each([
  ['=#n/a', { error: '#N/A' }],
  ['=ISNA(#n/a)', true],
  ['=IFERROR(#div/0!,1)', 1],
  ['=ERROR.TYPE(#Value!)', 3],
  ['=#ref!', { error: '#REF!' }],
])('reads %s', (formula, value) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, formula);
  expect(wb.getValue(id, 0, 0)).toEqual(value);
});

it('gives the token the error value Excel names', () => {
  expect(tokenize('#null!')[0]).toMatchObject({ type: 'error', value: '#NULL!' });
});
