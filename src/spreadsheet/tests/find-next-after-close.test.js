// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFindBar } from '../src/ui/findbar.js';
import { Workbook } from '../src/core/workbook.js';

const toasts = vi.hoisted(() => []);
vi.mock('../src/ui/toast.js', () => ({ toast: (message) => toasts.push(message) }));

let bar;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  bar?.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function setup() {
  const wb = new Workbook();
  const sheetId = wb.activeSheetId;
  wb.setInput(sheetId, 2, 0, 'Target');
  wb.setInput(sheetId, 6, 1, 'Target');
  const grid = {
    active: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 },
    setHighlights: vi.fn(), setSelection: vi.fn((selection) => { grid.active = selection.active; }), focus: vi.fn(),
  };
  const announce = vi.fn();
  bar = createFindBar({ wb, grid, sheetId: () => wb.activeSheetId, activeCell: () => null, announce, subscribe: () => () => {} });
  document.body.append(bar.el);
  return { wb, grid, announce };
}

describe('Shift+F4 after the Find panel is closed', () => {
  it('goes on to the next match of the last search, without the panel', () => {
    const { grid, announce } = setup();
    bar.open();
    const query = bar.el.querySelector('[aria-label="Find"]');
    query.value = 'Target';
    query.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(150);
    expect(grid.active).toEqual({ r: 2, c: 0 });
    bar.close();
    grid.setHighlights.mockClear();
    bar.findNext();
    expect(grid.active).toEqual({ r: 6, c: 1 });
    expect(announce).toHaveBeenLastCalledWith('Match 2 of 2, B7');
    // The panel stays closed and leaves no highlights behind that only closing it would clear.
    expect(bar.isOpen).toBe(false);
    expect(bar.el.hidden).toBe(true);
    expect(grid.setHighlights.mock.calls.every(([cells]) => cells.length === 0)).toBe(true);
    bar.findNext();
    expect(grid.active).toEqual({ r: 2, c: 0 });
  });

  it('carries on across the sheets when All sheets is ticked', () => {
    const { wb, grid } = setup();
    const second = wb.addSheet('Second');
    wb.setInput(second.id, 0, 3, 'Target');
    wb.setActiveSheet(wb.sheets[0].id);
    bar.open();
    [...bar.el.querySelectorAll('.find-option')].find((label) => label.textContent === 'All sheets').querySelector('input').click();
    const query = bar.el.querySelector('[aria-label="Find"]');
    query.value = 'Target';
    query.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(150);
    bar.close();
    grid.active = { r: 6, c: 1 };
    bar.findNext();
    expect(wb.activeSheetId).toBe(second.id);
    expect(grid.active).toEqual({ r: 0, c: 3 });
  });

  it('says so when the last search no longer matches anything', () => {
    const { wb, grid } = setup();
    bar.open();
    const query = bar.el.querySelector('[aria-label="Find"]');
    query.value = 'Target';
    query.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(150);
    bar.close();
    wb.setInput(wb.activeSheetId, 2, 0, '');
    wb.setInput(wb.activeSheetId, 6, 1, '');
    grid.active = { r: 0, c: 0 };
    bar.findNext();
    expect(grid.active).toEqual({ r: 0, c: 0 });
    expect(toasts.at(-1)).toBe('No matches for “Target”');
  });
});
