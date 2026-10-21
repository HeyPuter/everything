import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { toggleDetail } from '../src/core/outline-detail.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// Grouping rows that are already a group was refused, where Excel nests them a level deeper; and that refusal, like
// the one past the eighth outline level, was explained as a group crossing another. A file whose rows sit two levels
// deep over the same lines (which Excel writes for rows grouped twice) opened as two groups both drawn at level 2,
// whose buttons both worked the first of them.
const book = () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  for (let r = 0; r < 8; r++) wb.setInput(id, r, 0, String(r));
  return { wb, id, levels: () => wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level, g.collapsed]) };
};

it('nests rows grouped a second time one level deeper, each level with a button of its own', () => {
  const { wb, id, levels } = book();
  expect(wb.groupLines(id, 'row', 1, 4)).toBe(true);
  expect(wb.groupRefusal(id, 'row', 1, 4)).toBe(null);
  expect(wb.groupLines(id, 'row', 1, 4)).toBe(true);
  expect(levels()).toEqual([[1, 4, 1, false], [1, 4, 2, false]]);
  expect(wb.outlineDepth(id, 'row')).toBe(2);
  // The inner level's button collapses the inner group, the outer's the outer.
  wb.toggleGroup(id, 'row', 1, 4, 2);
  expect(levels()).toEqual([[1, 4, 1, false], [1, 4, 2, true]]);
  expect([...wb.sheet(id).hiddenRows].sort()).toEqual([1, 2, 3, 4]);
  wb.toggleGroup(id, 'row', 1, 4, 1);
  expect(levels()).toEqual([[1, 4, 1, true], [1, 4, 2, true]]);
  // Show Detail opens the outer level first, as the buttons do one level at a time.
  expect(toggleDetail(wb, id, { active: { r: 5, c: 0 } }, true)).toBe(true);
  expect(levels()).toEqual([[1, 4, 1, false], [1, 4, 2, true]]);
  // Ungroup takes one level off.
  wb.toggleGroup(id, 'row', 1, 4, 2);
  expect(wb.ungroupLines(id, 'row', 1, 4)).toBe(1);
  expect(levels()).toEqual([[1, 4, 1, false]]);
  expect(wb.sheet(id).hiddenRows.size).toBe(0);
});

it('says why a group is refused: across another, or past the eighth level', () => {
  const { wb, id } = book();
  wb.groupLines(id, 'row', 1, 4);
  expect(wb.groupRefusal(id, 'row', 3, 6)).toBe('across');
  expect(wb.groupLines(id, 'row', 3, 6)).toBe(false);
  for (let i = 0; i < 6; i++) expect(wb.groupLines(id, 'row', 1, 4)).toBe(true);
  expect(wb.outlineDepth(id, 'row')).toBe(7);
  expect(wb.groupRefusal(id, 'row', 1, 4)).toBe('depth');
  expect(wb.groupLines(id, 'row', 1, 4)).toBe(false);
  expect(wb.groupRefusal(id, 'row', 2, 3)).toBe('depth');
});

it('keeps rows grouped twice two levels deep through an .xlsx', async () => {
  const { wb, id, levels } = book();
  wb.groupLines(id, 'row', 1, 4);
  wb.groupLines(id, 'row', 1, 4);
  wb.toggleGroup(id, 'row', 1, 4, 2);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'twice.xlsx');
  const bid = back.sheets[0].id;
  expect(back.outlineGroups(bid, 'row').map((g) => [g.from, g.to, g.level])).toEqual(levels().map(([from, to, level]) => [from, to, level]));
});

it('opens rows another program put two levels deep over the same lines as two levels', async () => {
  const row = (r, level) => `<row r="${r}"${level ? ` outlineLevel="${level}"` : ''}><c r="A${r}"><v>${r}</v></c></row>`;
  const bytes = otherProgramsXlsx({ sheetXml: { Data: {
    head: '<dimension ref="A1:A6"/><sheetFormatPr defaultRowHeight="15" outlineLevelRow="2"/>',
    rows: row(1) + row(2, 2) + row(3, 2) + row(4, 2) + row(5, 2) + row(6),
  } } });
  const wb = await workbookFromFile(bytes, 'levels.xlsx');
  const id = wb.sheets[0].id;
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level])).toEqual([[1, 4, 1], [1, 4, 2]]);
  wb.toggleGroup(id, 'row', 1, 4, 2);
  expect(wb.outlineGroups(id, 'row').map((g) => g.collapsed)).toEqual([false, true]);
});
