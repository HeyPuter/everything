import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// Under Review ▸ Protect Workbook the assistant's manage_sheet was refused by the workbook without a reason: adding a
// sheet was reported as done (a tick in the chat, with only a note that nothing changed), deleting one blamed "a
// workbook keeps at least one visible sheet" with three sheets left, and renaming or duplicating said only that it
// could not be done. Each now says the structure is protected and how the user can lift it, and changes nothing.
describe('the assistant changing sheets under Protect Workbook', () => {
  const book = () => {
    const wb = new Workbook();
    wb.addSheet('Data');
    wb.addSheet('Notes');
    wb.setStructureProtected(true);
    return wb;
  };

  it.each([
    [{ action: 'add', sheet: 'Summary' }],
    [{ action: 'delete', sheet: 'Notes' }],
    [{ action: 'rename', sheet: 'Notes', new_name: 'Ideas' }],
    [{ action: 'duplicate', sheet: 'Data' }],
  ])('refuses %o and says why', (args) => {
    const wb = book();
    const names = wb.sheets.map((s) => s.name);
    const res = runTool(wb, 'manage_sheet', args, { sheetId: () => wb.activeSheetId });
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(false);
    expect(res.content).toMatch(/structure is protected/);
    expect(res.content).not.toMatch(/at least one visible sheet/);
    expect(wb.sheets.map((s) => s.name)).toEqual(names);
  });

  it('still shows a sheet, which changes only the view', () => {
    const wb = book();
    let shown = null;
    const res = runTool(wb, 'manage_sheet', { action: 'activate', sheet: 'Data' }, { sheetId: () => wb.activeSheetId, showSheet: (id) => { shown = id; } });
    expect(res.ok).toBe(true);
    expect(shown).toBe(wb.sheetByName('Data').id);
  });
});
