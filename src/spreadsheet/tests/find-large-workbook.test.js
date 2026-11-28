// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearch, findAll, findAllSheets, searchOrder } from '../src/core/search.js';
import { createFindBar } from '../src/ui/findbar.js';
import { Workbook } from '../src/core/workbook.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// Find stopped a search of a large workbook after three seconds, with the page held all that time, and said "too
// much to search": the cells it had not reached could not be found at all, and Replace all left them alone. A
// search now runs a slice at a time between frames, adding matches as it finds them, until every cell is searched.
const ROWS = 4000;

/** A clock that moves `step` milliseconds every time it is read. */
const fakeClock = (step) => { let t = 0; return vi.spyOn(performance, 'now').mockImplementation(() => (t += step)); };

function book(rows = ROWS) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.ensureSize?.(rows + 2, 4);
  for (let r = 0; r < rows; r++) wb.setInput(id, r, 0, `name ${r}`);
  return { wb, id };
}

describe('a search run a slice at a time', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds what findAll finds, sheet by sheet in reading order', { timeout: 60000 }, () => {
    const { wb, id } = book(500);
    const other = wb.addSheet('Other');
    wb.setInput(other.id, 3, 1, 'name x');
    wb.setInput(other.id, 0, 2, '=A1&"name"');
    wb.setInput(id, 2, 3, 'name late'); // written last, so walked last, but in reading order it comes early
    const search = createSearch(wb, searchOrder(wb, id), 'name');
    fakeClock(5);
    let slices = 0;
    while (!search.run(10)) slices++;
    expect(slices).toBeGreaterThan(1);
    expect(search.done).toBe(true);
    expect(search.matches()).toEqual(findAllSheets(wb, 'name', {}, id));
    expect(search.matches()[3]).toEqual({ r: 2, c: 3, sheetId: id });
    expect(search.count).toBe(findAll(wb, id, 'name').length + 2);
  });

  it('keeps the same match objects from one slice to the next', { timeout: 60000 }, () => {
    const { wb, id } = book(500);
    const search = createSearch(wb, [id], 'name');
    fakeClock(5);
    search.run(10);
    const first = search.matches();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(500);
    while (!search.run(10));
    expect(search.matches()[0]).toBe(first[0]);
  });

  it('finds nothing more once stopped', () => {
    const { wb, id } = book(500);
    const search = createSearch(wb, [id], 'name');
    fakeClock(5);
    search.run(10);
    const found = search.count;
    search.stop();
    expect(search.done).toBe(true);
    expect(search.run(1000)).toBe(true);
    expect(search.count).toBe(found);
  });
});

describe('the find bar on a large workbook', () => {
  let bar, grid, wb, id;
  beforeEach(() => {
    vi.useFakeTimers();
    ({ wb, id } = book());
    grid = { active: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, setHighlights: vi.fn(), setSelection: vi.fn((s) => { grid.active = s.active; }), focus: vi.fn() };
    bar = createFindBar({ wb, grid, sheetId: () => id, activeCell: () => null, announce: vi.fn(), subscribe: () => vi.fn() });
    document.body.append(bar.el);
  });
  afterEach(() => { bar?.destroy(); bar = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); document.body.replaceChildren(); });

  const count = () => bar.el.querySelector('.find-count').textContent;
  function type(text) {
    const query = bar.el.querySelector('[aria-label="Find"]');
    query.value = text;
    query.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(120);
  }

  it('searches every cell, saying it is still searching until it has', { timeout: 60000 }, () => {
    bar.open();
    fakeClock(5);
    type('name');
    expect(count()).toMatch(/^1 of \d+ \(still searching\)$/);
    expect(Number(/of (\d+)/.exec(count())[1])).toBeLessThan(ROWS);
    vi.runAllTimers();
    expect(count()).toBe(`1 of ${ROWS}`);
    expect(grid.setHighlights).toHaveBeenLastCalledWith(expect.objectContaining({ length: ROWS }), 0);
  });

  it('moves to the first match after the active cell once the search reaches it', { timeout: 60000 }, () => {
    grid.active = { r: 3500, c: 0 };
    bar.open();
    fakeClock(5);
    type('name');
    vi.runAllTimers();
    expect(grid.active).toEqual({ r: 3500, c: 0 });
    expect(count()).toBe(`3501 of ${ROWS}`);
  });

  it('leaves the place alone once the user has stepped to another match', { timeout: 60000 }, () => {
    grid.active = { r: 3500, c: 0 };
    bar.open();
    fakeClock(5);
    type('name');
    bar.el.querySelector('[aria-label="Next match"]').click();
    const at = { ...grid.active };
    vi.runAllTimers();
    expect(grid.active).toEqual(at);
    expect(count()).toBe(`${at.r + 1} of ${ROWS}`);
  });

  it('starts again when the workbook changes under the search', { timeout: 60000 }, () => {
    bar.open();
    fakeClock(5);
    type('name');
    wb.setInput(id, ROWS - 1, 0, 'gone');
    vi.runAllTimers();
    expect(count()).toBe(`1 of ${ROWS - 1}`);
  });

  it('replaces every match once the search has reached the end', { timeout: 60000 }, () => {
    bar.open({ replace: true });
    fakeClock(5);
    type('name');
    bar.el.querySelector('[aria-label="Replace with"]').value = 'item';
    [...bar.el.querySelectorAll('button')].find((b) => b.textContent === 'Replace all').click();
    expect(toast).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(toast).toHaveBeenLastCalledWith(`Replaced ${ROWS} cells`, expect.objectContaining({ icon: 'check' }));
    expect(wb.getValue(id, ROWS - 1, 0)).toBe(`item ${ROWS - 1}`);
  });

  it('finds the next match with the panel closed past the first slice', { timeout: 60000 }, () => {
    bar.open();
    fakeClock(5);
    type('name 3999');
    vi.runAllTimers();
    bar.close();
    grid.active = { r: 0, c: 0 };
    grid.setHighlights.mockClear();
    bar.findNext();
    vi.runAllTimers();
    expect(grid.active).toEqual({ r: 3999, c: 0 });
    expect(grid.setHighlights).not.toHaveBeenCalled();
  });

  it('stops after a minute of searching and says so', { timeout: 60000 }, () => {
    bar.open();
    fakeClock(600);
    type('name');
    vi.runAllTimers();
    expect(count()).toMatch(/^1 of \d+ \(search stopped: too much to search\)$/);
    expect(Number(/of (\d+)/.exec(count())[1])).toBeLessThan(ROWS);
  });

  it('stops searching when the panel closes', { timeout: 60000 }, () => {
    bar.open();
    fakeClock(5);
    type('name');
    bar.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
