// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createFindBar } from '../src/ui/findbar.js';
import { findAll, replaceCells } from '../src/core/search.js';

// A formula marked Hidden (Format Cells ▸ Protection) on a protected sheet shows neither in the formula bar nor
// in Show formulas, but Find searched its text and Find all printed it: a search for the rate a formula used
// pointed out the cell, and the results table spelled out the whole formula. Hidden formulas are now searched,
// shown and replaced by their values alone while the sheet is protected, as everywhere else.
let bar;
beforeEach(() => { vi.useFakeTimers(); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { bar?.destroy(); bar = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function book({ locked = true } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '200');
  wb.setInput(id, 0, 1, '=A1*0.0725');
  wb.setInput(id, 1, 1, '=A1*2');
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { formulaHidden: true, ...(locked ? {} : { locked: false }) });
  wb.setSheetProtected(id, true);
  return { wb, id };
}

describe('Find on a protected sheet with a hidden formula', () => {
  it('does not find text only the hidden formula holds', () => {
    const { wb, id } = book();
    expect(findAll(wb, id, '0.0725', {})).toEqual([]);
    expect(findAll(wb, id, '14.5', {})).toEqual([{ r: 0, c: 1 }]);
    expect(findAll(wb, id, 'A1*', {})).toEqual([{ r: 1, c: 1 }]);
    wb.setSheetProtected(id, false);
    expect(findAll(wb, id, '0.0725', {})).toEqual([{ r: 0, c: 1 }]);
  });

  it('leaves an unlocked hidden formula alone when replacing', () => {
    const { wb, id } = book({ locked: false });
    const skipped = [];
    expect(replaceCells(wb, id, [{ r: 0, c: 1 }], 'A1', 'A2', { skipped })).toBe(0);
    expect(skipped).toEqual([{ r: 0, c: 1, reason: 'formula' }]);
    expect(wb.getCell(id, 0, 1).f).toBe('A1*0.0725');
  });

  it('shows no formula for it in the Find all results', () => {
    const { wb } = book();
    const grid = { active: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, focus: vi.fn(), setHighlights: vi.fn(), setSelection: vi.fn() };
    bar = createFindBar({ wb, grid, sheetId: () => wb.activeSheetId, activeCell: () => null, announce: vi.fn(),
      subscribe: (fn) => { wb.addEventListener('change', fn); return () => wb.removeEventListener('change', fn); } });
    document.body.append(bar.el);
    bar.open();
    const query = bar.el.querySelector('[aria-label="Find"]');
    query.value = '14.5';
    query.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(150);
    [...bar.el.querySelectorAll('button')].find((b) => b.textContent === 'Find all').click();
    const rows = [...bar.el.querySelectorAll('.find-results tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent));
    expect(rows).toEqual([['Sheet1', 'B1', '14.5', '']]);
  });
});
