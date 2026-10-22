// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

/** A1 holds twelve wrapped words fitted to six lines in the 100px column A; A5 is formatted as currency. */
async function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, Array.from({ length: 12 }, (_, i) => `word${i % 10}`).join(' '));
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  wb.applyStyle(id, { r1: 4, c1: 0, r2: 4, c2: 0 }, { fmt: 'currency' });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  grid.autoFitRows(0, 0);
  expect(wb.rowHeight(id, 0)).toBe(105);
  wb.clearHistory();
  return { wb, id, grid };
}

// The column widened for a typed currency number had its wrapped rows fitted by the layout event
// that followed, as a step of its own: the first Ctrl+Z after typing undid a row height, and the
// entry and the wider column stayed. A dragged column fits its rows within its own step.
describe('a column widened for a typed number', () => {
  it('fits its rows of wrapped text within the entry\'s own undo step', async () => {
    const { wb, id, grid } = await mount();
    grid.setSelection(S.single(4, 0));
    grid.beginEdit({ text: '1234567890123', mode: 'type' });
    grid.commitEdit();
    await flush();
    expect(wb.getValue(id, 4, 0)).toBe(1234567890123);
    expect(wb.sheet(id).colWidths.get(0)).toBe(161); // $1,234,567,890,123.00 and its padding
    expect(wb.rowHeight(id, 0)).toBe(71); // three words a line: four lines
    expect(wb.undoLabels()).toEqual(['Edit cell']);
    wb.undo();
    expect(wb.getValue(id, 4, 0)).toBeNull();
    expect(wb.sheet(id).colWidths.has(0)).toBe(false);
    expect(wb.rowHeight(id, 0)).toBe(105);
    expect(wb.undoLabels()).toEqual([]);
    wb.redo();
    expect(wb.getValue(id, 4, 0)).toBe(1234567890123);
    expect(wb.rowHeight(id, 0)).toBe(71);
    await flush();
    expect(wb.undoLabels()).toEqual(['Edit cell']); // the layout event after the step fits nothing again
    grid.destroy();
  });
});
