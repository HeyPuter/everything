import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findAll, findAllSheets, replaceCells } from '../src/core/search.js';

// Replace wrote its new text the way typing does, and typing into grouped sheets is written again over the same cells
// of every sheet in the group: replacing "Rent" with "Housing" on Jan, grouped with Feb, put Jan's "Housing 100" over
// Feb's "Rent 200" in the same cell, and Replace all over All sheets did it too after replacing Feb's own. Each
// replacement is worked out from the sheet the match was found on, and is now written there alone.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  wb.setInput(a, 0, 0, 'Rent 100');
  wb.setInput(b, 0, 0, 'Rent 200');
  wb.setInput(b, 1, 0, 'Rent 300');
  wb.groupSheets([b]);
  wb.clearHistory();
  return { wb, a, b, texts: () => [wb.getValue(a, 0, 0), wb.getValue(b, 0, 0), wb.getValue(b, 1, 0)] };
}

describe('Replace with sheets grouped', () => {
  it('changes the matches on the sheet searched and leaves the other sheets’ cells their own', () => {
    const { wb, a, texts } = book();
    expect(replaceCells(wb, a, findAll(wb, a, 'Rent'), 'Rent', 'Housing')).toBe(1);
    expect(texts()).toEqual(['Housing 100', 'Rent 200', 'Rent 300']);
    wb.undo();
    expect(texts()).toEqual(['Rent 100', 'Rent 200', 'Rent 300']);
  });

  it('replaces each sheet’s own text when every sheet is searched', () => {
    const { wb, texts } = book();
    const all = findAllSheets(wb, 'Rent');
    wb.transaction('Replace all', () => {
      for (const sheet of wb.sheets) replaceCells(wb, sheet.id, all.filter((m) => m.sheetId === sheet.id), 'Rent', 'Housing');
    });
    expect(texts()).toEqual(['Housing 100', 'Housing 200', 'Housing 300']);
  });
});
