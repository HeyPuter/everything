// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { heightForLines } from '../src/core/textfit.js';

/** The height a row fitted to one line of 13px text takes (never less than the default row). */
const ONE_LINE = heightForLines(1, 13, DEFAULT_ROW_HEIGHT);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

/** A1 holds twelve wrapped words (six lines, 105px, in the 100px column; two lines, 37px, at 300px), fitted by the grid unless `prepare` sizes it. */
async function mount(prepare) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, Array.from({ length: 12 }, (_, i) => `word${i % 10}`).join(' '));
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { wrap: true });
  prepare?.(wb, id);
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  if (!prepare) { grid.autoFitRows(0, 0); expect(wb.rowHeight(id, 0)).toBe(105); }
  wb.clearHistory();
  const clip = grid.el.querySelector('.grid-colhead-clip');
  const pe = (target, type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, pointerId: 1, button: 0, pointerType: 'mouse' }));
  /** Drag column A's edge from its present width to `to` pixels. */
  const drag = (to) => { const from = 48 + wb.colWidth(id, 0); pe(clip.querySelector('.col-resizer[data-c="0"]'), 'pointerdown', from); pe(clip, 'pointermove', 48 + to); pe(clip, 'pointerup', 48 + to); };
  const setWidth = async (w) => { wb.setColWidth(id, 0, w); await flush(); };
  const type = (r, text) => { grid.setSelection(S.single(r, 0)); grid.beginEdit({ text, mode: 'type' }); grid.commitEdit(); };
  return { wb, id, grid, drag, setWidth, type };
}

// The grid remembered which rows it had fitted by row number and height, and nothing kept that
// memory current: after an undo, or once a row was inserted or deleted above, a fitted row looked
// like one sized by hand, so it was never refitted for a new column width and an entry into it
// could only ever make it taller. An auto-fitted row now stays auto-fitted through both.
describe('a row of wrapped text the grid fitted', () => {
  it('is fitted again for a column width set after the width that fitted it was undone', async () => {
    const { wb, id, drag, setWidth } = await mount();
    drag(300);
    expect(wb.rowHeight(id, 0)).toBe(37);
    wb.undo();
    expect(wb.rowHeight(id, 0)).toBe(105);
    drag(300);
    expect(wb.rowHeight(id, 0)).toBe(37);
    wb.undo();
    await flush();
    await setWidth(300); // from a dialog rather than a drag
    expect(wb.rowHeight(id, 0)).toBe(37);
  });

  it('is fitted again for a new width after a row was inserted or deleted above it', async () => {
    const { wb, id, setWidth } = await mount();
    wb.insertRows(id, 0, 1);
    await flush();
    expect(wb.rowHeight(id, 1)).toBe(105);
    await setWidth(300);
    expect(wb.rowHeight(id, 1)).toBe(37);
    wb.deleteRows(id, 0, 1);
    await flush();
    await setWidth(100);
    expect(wb.rowHeight(id, 0)).toBe(105);
  });

  it('shrinks to a shorter entry typed into it after such a change', async () => {
    const { wb, id, type } = await mount();
    wb.insertRows(id, 0, 1);
    await flush();
    type(1, 'short');
    expect(wb.rowHeight(id, 1)).toBe(ONE_LINE);
  });

  it('while a row someone sized by hand keeps its height through all of that', async () => {
    const { wb, id, drag, setWidth, type } = await mount((wb, id) => { wb.setRowHeight(id, 0, 60); });
    drag(300);
    expect(wb.rowHeight(id, 0)).toBe(60);
    wb.undo();
    drag(300);
    expect(wb.rowHeight(id, 0)).toBe(60);
    wb.insertRows(id, 0, 1);
    await flush();
    await setWidth(100);
    expect(wb.rowHeight(id, 1)).toBe(60);
    type(1, 'short');
    expect(wb.rowHeight(id, 1)).toBe(60);
  });
});
