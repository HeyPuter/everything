// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAll, searchBudget } from '../src/core/search.js';
import { Workbook } from '../src/core/workbook.js';

// A plain-text Find evaluated and formatted every cell of the sheet, on every pause in typing, with no
// time budget: a sheet with a formula column cost hundreds of milliseconds and a twelve-sheet book
// seconds, all of it on the main thread. Typed strings under no number format are now compared as they
// stand, and a plain search stops when its budget runs out, as a regular-expression search already did.
const ROWS = 4000;

/** A clock that moves `step` milliseconds every time it is read. */
const fakeClock = (step) => { let t = 0; return vi.spyOn(performance, 'now').mockImplementation(() => (t += step)); };

function book({ formulas = false } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.ensureSize?.(ROWS + 2, 6);
  for (let r = 0; r < ROWS; r++) {
    wb.setInput(id, r, 0, `name ${r}`);
    if (formulas) wb.setInput(id, r, 1, `=A${r + 1}&" tail"`);
  }
  return { wb, id };
}

describe('a plain-text search', () => {
  afterEach(() => vi.restoreAllMocks());

  it('compares typed strings without evaluating or formatting them', { timeout: 60000 }, () => {
    const { wb, id } = book();
    const values = vi.spyOn(wb, 'getValue');
    const found = findAll(wb, id, 'name 7');
    expect(found.length).toBeGreaterThan(0);
    // Not one of the plain text cells needed evaluating.
    expect(values).not.toHaveBeenCalled();
  });

  it('still reads the cells a format or a formula makes different from their stored value', { timeout: 60000 }, () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1500');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'currency', dec: 2 });
    wb.setInput(id, 1, 0, '=1+1');
    wb.setInput(id, 2, 0, 'plain');
    expect(findAll(wb, id, '$1,500.00')).toEqual([{ r: 0, c: 0 }]);
    expect(findAll(wb, id, '2')).toEqual([{ r: 1, c: 0 }]);
    expect(findAll(wb, id, 'plain')).toEqual([{ r: 2, c: 0 }]);
  });

  it('evaluates a formula column no more than once per cell', { timeout: 60000 }, () => {
    const { wb, id } = book({ formulas: true });
    findAll(wb, id, 'name 7'); // warm the cache as an open panel would
    const values = vi.spyOn(wb, 'getValue');
    findAll(wb, id, 'name 8');
    // Only the formula column is read: the text column no longer costs a call apiece.
    expect(values.mock.calls.length).toBeLessThanOrEqual(ROWS);
  });

  it('stops when its budget is spent, as a regular-expression search does', { timeout: 60000 }, () => {
    const { wb, id } = book();
    fakeClock(600);
    const budget = searchBudget(1000);
    const found = findAll(wb, id, 'name', { budget });
    expect(budget.exceeded).toBe(true);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(ROWS);
  });
});

// The find bar no longer stops at a budget: it searches on in slices (see find-large-workbook.test.js).
