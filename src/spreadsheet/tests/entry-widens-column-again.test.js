// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  prepare?.(wb, id);
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  return { wb, id, grid };
}

function type(grid, r, c, text) {
  grid.setSelection(S.single(r, c));
  grid.beginEdit({ text, mode: 'inplace' });
  grid.commitEdit();
  vi.runOnlyPendingTimers();
}

// Seven pixels per character in this harness. A column widened for one entry was taken for one sized by hand,
// so a longer amount typed below a date showed ### in the column the app itself had just widened.
describe('a column widened for an earlier entry', () => {
  it('widens again for a longer date or formatted number, and never narrows', () => {
    const { wb, id, grid } = mount();
    type(grid, 0, 0, '2024-03-10 12:30');
    expect(wb.sheet(id).colWidths.get(0)).toBe(126);
    type(grid, 1, 0, '$12,345,678,901.00');
    expect(wb.sheet(id).colWidths.get(0)).toBe(140);
    expect(document.querySelector('#gc-1-0').textContent).toBe('$12,345,678,901.00');
    type(grid, 2, 0, '2024-03-10');
    expect(wb.sheet(id).colWidths.get(0)).toBe(140);
    wb.undo();
    wb.undo();
    expect(wb.sheet(id).colWidths.get(0)).toBe(126);
    grid.destroy();
  });

  it('stays as it is once someone sizes it', () => {
    const { wb, id, grid } = mount();
    type(grid, 0, 0, '2024-03-10 12:30');
    wb.setColWidth(id, 0, 110);
    type(grid, 1, 0, '$12,345,678,901.00');
    expect(wb.sheet(id).colWidths.get(0)).toBe(110);
    expect(document.querySelector('#gc-1-0').textContent).toBe('###');
    grid.destroy();
  });
});
