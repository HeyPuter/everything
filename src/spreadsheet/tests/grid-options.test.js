// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { setAppOptions, resetAppOptions, reloadAppOptions } from '../src/lib/app-options.js';
import { closeAllModals } from '../src/ui/modal.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  reloadAppOptions();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { resetAppOptions(); closeAllModals(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const ROW1_MID = Math.round(DEFAULT_ROW_HEIGHT) / 2;

async function mount(opts = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id, ...opts });
  document.body.replaceChildren(grid.el);
  await flush();
  const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const editor = grid.el.querySelector('.grid-editor');
  /** Type `text` into a cell and press Enter (with Shift when asked). */
  const enter = async (text, extra = {}) => {
    key(grid.viewport, text[0]);
    editor.value = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text.slice(-1), inputType: 'insertText' }));
    key(editor, 'Enter', extra);
    await flush();
  };
  return { wb, id, grid, key, editor, enter };
}

describe('where Enter moves', () => {
  it('goes down by default, and the way the options say', async () => {
    const { grid, key } = await mount();
    grid.setSelection(S.single(2, 2));
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 3, c: 2 });
    setAppOptions({ enterDirection: 'right' });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 3, c: 3 });
    key(grid.viewport, 'Enter', { shiftKey: true });
    expect(grid.active).toEqual({ r: 3, c: 2 });
    setAppOptions({ enterDirection: 'up' });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 2, c: 2 });
    setAppOptions({ enterDirection: 'left' });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 2, c: 1 });
    grid.destroy();
  });

  it('stays put when the options say not to move, while a range still walks its cells', async () => {
    const { wb, id, grid, enter } = await mount();
    setAppOptions({ enterMove: false });
    grid.setSelection(S.single(0, 0));
    await enter('hello');
    expect(wb.getValue(id, 0, 0)).toBe('hello');
    expect(grid.active).toEqual({ r: 0, c: 0 });
    grid.setSelection(S.fromRange({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r: 0, c: 0 }));
    grid.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(grid.active).toEqual({ r: 1, c: 0 });
    grid.destroy();
  });
});

describe('typing', () => {
  it('puts a fixed decimal point into whole numbers', async () => {
    const { wb, id, grid, enter } = await mount();
    setAppOptions({ fixedDecimal: true, fixedDecimalPlaces: 2 });
    grid.setSelection(S.single(0, 0));
    await enter('1234');
    expect(wb.getValue(id, 0, 0)).toBe(12.34);
    await enter('7.5');
    expect(wb.getValue(id, 1, 0)).toBe(7.5);
    setAppOptions({ fixedDecimalPlaces: -2 });
    await enter('3');
    expect(wb.getValue(id, 2, 0)).toBe(300);
    grid.destroy();
  });

  it('suggests from the column only while AutoComplete is on', async () => {
    const { wb, id, grid, key, editor } = await mount();
    wb.setInput(id, 0, 0, 'Banana');
    grid.setSelection(S.single(1, 0));
    key(grid.viewport, 'B');
    expect(editor.value).toBe('Banana');
    key(editor, 'Escape');
    setAppOptions({ autoComplete: false });
    key(grid.viewport, 'B');
    expect(editor.value).toBe('B');
    key(editor, 'Escape');
    grid.destroy();
  });

  it('edits in the formula bar with F2 and a double-click when editing in cells is off', async () => {
    const onEditInBar = vi.fn(() => true);
    const { grid, key } = await mount({ onEditInBar });
    setAppOptions({ editInCell: false });
    grid.setSelection(S.single(0, 0));
    key(grid.viewport, 'F2');
    expect(onEditInBar).toHaveBeenCalledTimes(1);
    expect(grid.editing).toBeFalsy();
    setAppOptions({ editInCell: true });
    key(grid.viewport, 'F2');
    expect(grid.editing).toBeTruthy();
    grid.destroy();
  });

  it('carries a list’s format and formula onto the new row in the same step', async () => {
    const extendEntry = vi.fn();
    const { wb, id, grid, enter } = await mount({ extendEntry });
    grid.setSelection(S.single(0, 0));
    await enter('x');
    expect(extendEntry).toHaveBeenCalledWith(expect.objectContaining({ sheetId: id, r: 0, c: 0, text: 'x' }));
    expect(wb.undoLabels(1)).toEqual(['Edit cell']);
    grid.destroy();
  });
});

describe('the fill handle and dragging cells', () => {
  const drag = (grid, from, to, extra = {}) => {
    const pe = (type, x) => grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: ROW1_MID, pointerId: 1, button: 0, pointerType: 'mouse', ...extra }));
    pe('pointerdown', from); pe('pointermove', to); pe('pointerup', to);
  };

  it('hides the handle and moves nothing by its border when turned off', async () => {
    const { wb, id, grid } = await mount();
    wb.setInput(id, 0, 0, 'x');
    grid.setSelection(S.single(0, 0));
    setAppOptions({ fillHandle: false });
    grid.refresh();
    await flush();
    expect(grid.el.querySelector('.fill-handle').hidden).toBe(true);
    drag(grid, 100, 300);
    await flush();
    expect(wb.getValue(id, 0, 2)).toBeNull();
    expect(wb.getValue(id, 0, 0)).toBe('x');
    grid.destroy();
  });

  it('asks before a drag replaces cells holding data, and only when the options say to', async () => {
    const { wb, id, grid } = await mount();
    wb.setInput(id, 0, 0, 'x');
    wb.setInput(id, 0, 2, 'keep');
    grid.setSelection(S.single(0, 0));
    drag(grid, 100, 300);
    await flush();
    const dialog = document.querySelector('.modal-panel');
    expect(dialog?.textContent).toMatch(/already holds data/);
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await flush();
    expect(wb.getValue(id, 0, 2)).toBe('keep');
    expect(wb.getValue(id, 0, 0)).toBe('x');
    drag(grid, 100, 300);
    await flush();
    [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel button')].find((b) => b.textContent === 'Replace').click();
    await flush();
    expect(wb.getValue(id, 0, 2)).toBe('x');
    wb.undo();
    grid.setSelection(S.single(0, 0));
    setAppOptions({ overwriteAlert: false });
    drag(grid, 100, 300);
    await flush();
    expect(document.querySelector('.modal-root:not(.closing)')).toBeNull();
    expect(wb.getValue(id, 0, 2)).toBe('x');
    grid.destroy();
  });
});

describe('comment and note indicators', () => {
  it('show the mark and the hover text, the mark alone, or nothing', async () => {
    const { wb, id, grid } = await mount();
    wb.setNote(id, 0, 0, 'A note');
    grid.refresh();
    await flush();
    const cell = () => grid.el.querySelector('#gc-0-0');
    expect(cell().classList.contains('has-note')).toBe(true);
    expect(cell().title).toBe('A note');
    setAppOptions({ commentIndicators: 'indicator' });
    grid.refresh();
    await flush();
    expect(cell().classList.contains('has-note')).toBe(true);
    expect(cell().title).toBe('');
    setAppOptions({ commentIndicators: 'none' });
    grid.refresh();
    grid.setSelection(S.single(0, 0));
    await flush();
    expect(cell().classList.contains('has-note')).toBe(false);
    expect(grid.el.querySelector('.note-pop').hidden).toBe(true);
    grid.destroy();
  });
});
