import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Hidden names (a pivot table's definition kept here, Excel's _xlnm._FilterDatabase, Solver's model) are left out of
// the Name Manager and the Name Box, but the help for a #NAME? error offered them: "Did you mean Secret_Rate?".
const book = () => new Workbook({ sheets: [{ name: 'Sheet1' }], names: [
  { name: 'Total', ref: 'Sheet1!$A$1' },
  { name: '_FilterDatabase', ref: 'Sheet1!$A$1:$B$9', hidden: true, sheet: 'Sheet1' },
  { name: 'Secret_Rate', ref: '0.2', hidden: true },
] });

it('offers no hidden name for a mistyped one, yet knows a hidden name used in a formula', () => {
  const wb = book(), id = wb.activeSheetId;
  wb.setInput(id, 0, 3, '=Secret_Rat*2');
  expect(wb.errorHelpAt(id, 0, 3)).not.toMatch(/Secret_Rate/);
  wb.setInput(id, 0, 4, '=Secret_Rate+Totl');
  expect(wb.errorHelpAt(id, 0, 4)).toMatch(/Totl is not a named range.*Did you mean Total\?/);
});
