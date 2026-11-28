// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAll, findAllSheets, searchBudget } from '../src/core/search.js';
import { createFindBar } from '../src/ui/findbar.js';
import { Workbook } from '../src/core/workbook.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

/** A clock that moves `step` milliseconds every time it is read. */
const fakeClock = (step) => { let t = 0; return vi.spyOn(performance, 'now').mockImplementation(() => (t += step)); };

function book(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < rows; r++) wb.setInput(id, r, 0, 'a');
  return { wb, id };
}

// A regular expression that backtracks badly, such as a+a+a+b, takes seconds on one long cell, and a
// search ran it against every cell of the sheet on each keystroke with no way to stop.
describe('a regular-expression search with a time budget', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stops when the budget is spent, keeping the matches found so far and saying so', () => {
    const { wb, id } = book(300);
    fakeClock(600);
    const budget = searchBudget(1000);
    const found = findAll(wb, id, 'a', { regex: true, budget });
    expect(budget.exceeded).toBe(true);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(300);
    // A spent budget ends the search of the sheets that follow before it starts.
    expect(findAll(wb, id, 'a', { regex: true, budget })).toEqual([]);
    const other = wb.addSheet('Other');
    wb.setInput(other.id, 0, 0, 'a');
    const second = searchBudget(1000);
    expect(findAllSheets(wb, 'a', { regex: true, budget: second }, id).some((m) => m.sheetId === other.id)).toBe(false);
    expect(second.exceeded).toBe(true);
  });

  it('searches every cell while the budget holds, and without a budget', () => {
    const { wb, id } = book(300);
    fakeClock(1);
    const budget = searchBudget(1000);
    expect(findAll(wb, id, 'a', { regex: true, budget })).toHaveLength(300);
    expect(budget.exceeded).toBe(false);
    fakeClock(600);
    expect(findAll(wb, id, 'a', { regex: true })).toHaveLength(300);
  });
});

describe('the find bar', () => {
  let bar;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { bar?.destroy(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); document.body.replaceChildren(); });

  it('searches on to the end with a regular expression too, and Replace all replaces every match', () => {
    const { wb, id } = book(300);
    const grid = { active: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, setHighlights: vi.fn(), setSelection: vi.fn((s) => { grid.active = s.active; }), focus: vi.fn() };
    bar = createFindBar({ wb, grid, sheetId: () => id, activeCell: () => null, announce: vi.fn(), subscribe: () => vi.fn() });
    document.body.append(bar.el);
    bar.open({ replace: true });
    const regex = [...bar.el.querySelectorAll('label')].find((l) => l.textContent === 'Regular expression').querySelector('input');
    regex.checked = true; regex.dispatchEvent(new Event('change'));
    const query = bar.el.querySelector('[aria-label="Find"]');
    const count = bar.el.querySelector('.find-count');
    fakeClock(600);
    query.value = 'a'; query.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(120);
    // A slow search shows what it has found so far, and goes on between frames instead of stopping.
    expect(count.textContent).toMatch(/^1 of \d+ \(still searching\)$/);
    expect(Number(/of (\d+)/.exec(count.textContent)[1])).toBeLessThan(300);
    vi.runAllTimers();
    expect(count.textContent).toBe('1 of 300');
    bar.el.querySelector('[aria-label="Replace with"]').value = 'b';
    [...bar.el.querySelectorAll('button')].find((b) => b.textContent === 'Replace all').click();
    vi.runAllTimers();
    expect(toast).toHaveBeenLastCalledWith('Replaced 300 cells', expect.objectContaining({ icon: 'check' }));
    expect(wb.getValue(id, 0, 0)).toBe('b');
    expect(wb.getValue(id, 299, 0)).toBe('b');
  });
});
