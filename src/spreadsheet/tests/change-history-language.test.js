// The change history used to tell a sheet-list step and an outline collapse by the English words of their undo
// labels; those labels are now in the interface language, so the steps say what they are themselves.
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { useLanguage } from '../src/i18n/index.js';

afterEach(() => useLanguage('en'));

for (const lang of ['en', 'zh-Hans']) {
  it(`records a sheet step for the book, and leaves out collapsing, in ${lang}`, async () => {
    await useLanguage(lang);
    const wb = new Workbook();
    wb.addSheet();
    const sheetId = wb.activeSheetId;
    const added = wb.changeHistory.at(-1);
    expect(added.kind).toBe('structure');
    expect(added.sheetId).toBe(null);

    expect(wb.groupLines(sheetId, 'row', 1, 3)).not.toBe(false);
    const grouped = wb.changeHistory.at(-1);
    expect(grouped.sheetId).toBe(sheetId);
    const before = wb.changeHistory.length;
    wb.toggleGroup(sheetId, 'row', 1, 3);
    expect(wb.changeHistory.length).toBe(before);
  });
}
