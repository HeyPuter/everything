import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Amt'); wb.setInput(id, 0, 1, 'When'); wb.setInput(id, 0, 2, 'Who');
  [['1.5', 'Jan 15, 2024', 'x'], ['2.5', 'Feb 20, 2024', 'y'], ['1.5', 'Jan 15, 2024', 'x']].forEach((row, i) => row.forEach((t, c) => wb.setInput(id, i + 1, c, t)));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 2 });
  return { wb, id, hidden: () => [...wb.sheet(id).filterHidden].sort() };
}

/** A regional format change re-renders the sheet; the filter is judged again on the next edit or sort. */
function regional(wb, id, locale) {
  setLocale(locale);
  wb._invalidate();
  wb.reapplyFilter(id);
}

// A value filter kept the texts the menu showed, and matched rows by their text alone: switching the
// regional format to one that writes 1,5 for 1.5 hid every row of a numeric or date column on the next pass.
it('keeps the rows a value filter chose when the regional format changes how their numbers read', () => {
  const { wb, id, hidden } = book();
  wb.setFilterCriteria(id, 0, { values: ['1.5'] });
  expect(hidden()).toEqual([2]);
  // The numbers behind the chosen texts travel with them, so a file still carries the texts.
  expect(wb.sheet(id).filter.criteria[0]).toEqual({ values: ['1.5'], keys: ['1.5'] });
  regional(wb, id, 'de-DE');
  expect(wb.filterValues(id, 0).map((v) => v.value)).toEqual(['1,5', '2,5']);
  expect(hidden()).toEqual([2]);
  // A row edited to the chosen number joins the rows in view, one edited away from it leaves them.
  wb.setCells(id, [{ r: 2, c: 0, cell: { v: 1.5, f: null } }, { r: 3, c: 0, cell: { v: 3, f: null } }]);
  wb.reapplyFilter(id);
  expect(hidden()).toEqual([3]);
  regional(wb, id, 'en-US');
  expect(hidden()).toEqual([3]);
});

it('keeps a date filter through a regional format change, and a text filter as it was', () => {
  const { wb, id, hidden } = book();
  wb.setFilterCriteria(id, 1, { values: ['Jan 15, 2024'] });
  // A date's key is the day it names, whatever format shows it (a formatted number's carries its format instead).
  expect(wb.sheet(id).filter.criteria[1]).toEqual({ values: ['Jan 15, 2024'], keys: ['date:45306'] });
  expect(hidden()).toEqual([2]);
  regional(wb, id, 'de-DE');
  expect(wb.filterValues(id, 1).map((v) => v.value)).toEqual(['15.01.2024', '20.02.2024']);
  expect(hidden()).toEqual([2]);
  wb.setFilterCriteria(id, 2, { values: ['x'] });
  expect(wb.sheet(id).filter.criteria[2]).toEqual({ values: ['x'] });
  expect(hidden()).toEqual([2]);
});

it('matches a text that reads as a number by its text alone, and keeps keys given with the criteria', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'V');
  wb.setInput(id, 1, 0, "'2");
  wb.setCells(id, [{ r: 2, c: 0, cell: { v: 2, f: null, s: { fmt: 'number', dec: 2 } } }]);
  wb.setInput(id, 3, 0, '2');
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 0 });
  expect(wb.filterValues(id, 0).map((v) => v.value)).toEqual(['2', '2.00']);
  wb.setFilterCriteria(id, 0, { values: ['2'] });
  // The text "2" and the plain 2 read alike and were chosen together; 2.00 was not.
  expect(wb.sheet(id).filter.criteria[0]).toEqual({ values: ['2'], keys: ['2'] });
  expect([...wb.sheet(id).filterHidden]).toEqual([2]);
  wb.setFilterCriteria(id, 0, { values: ['2.00'], keys: ['2'] });
  expect(wb.sheet(id).filter.criteria[0]).toEqual({ values: ['2.00'], keys: ['2'] });
  expect([...wb.sheet(id).filterHidden]).toEqual([1]);
});
