// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid, COL_HEADER_H } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

const ROW = Math.round(DEFAULT_ROW_HEIGHT); // a default row on screen at 100%
// The middle of 0-based row r on the screen: the viewport starts below the column header.
const rowMidY = (r) => COL_HEADER_H + r * ROW + ROW / 2;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollBy = function scrollBy() {};
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 1, '4');
  wb.setInput(id, 1, 1, '5');
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  const viewport = grid.el.querySelector('.grid-viewport');
  viewport.getBoundingClientRect = () => ({ left: 48, top: COL_HEADER_H, right: 848, bottom: COL_HEADER_H + 400, width: 800, height: 400 });
  const colClip = grid.el.querySelector('.grid-colhead-clip');
  const rowClip = grid.el.querySelector('.grid-rowhead-clip');
  const pointer = (target, type, init) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'mouse', ...init }));
  const editor = grid.el.querySelector('.grid-editor');
  const typeFormula = (text) => { grid.beginEdit({ text, mode: 'type' }); editor.focus(); editor.setSelectionRange(text.length, text.length); };
  return { wb, id, grid, colClip, rowClip, pointer, editor, typeFormula };
}

const colMidX = (c) => 48 + c * 100 + 50;
const click = (pointer, target, x, y, init = {}) => { pointer(target, 'pointerdown', { clientX: x, clientY: y, ...init }); pointer(target, 'pointerup', { clientX: x, clientY: y, ...init }); };

// Ctrl/Cmd+click while pointing replaced the reference just picked; in Excel it adds another, after a comma.
describe('Ctrl/Cmd+click while a formula expects a reference', () => {
  it('adds the cell after the reference just picked, a comma between them', () => {
    const { wb, id, grid, colClip, pointer, editor, typeFormula } = mount();
    const viewport = grid.el.querySelector('.grid-viewport');
    typeFormula('=SUM(');
    click(pointer, viewport, colMidX(1), rowMidY(0));
    expect(editor.value).toBe('=SUM(B1');
    click(pointer, viewport, colMidX(1), rowMidY(1), { ctrlKey: true, metaKey: true });
    expect(editor.value).toBe('=SUM(B1,B2');
    // Shift+click still stretches the reference just added; a header adds a whole line the same way.
    click(pointer, viewport, colMidX(2), rowMidY(2), { shiftKey: true });
    expect(editor.value).toBe('=SUM(B1,B2:C3');
    click(pointer, colClip.querySelector('.hcell[data-c="3"]'), colMidX(3), 13, { ctrlKey: true, metaKey: true });
    expect(editor.value).toBe('=SUM(B1,B2:C3,D:D');
    // A plain click puts the cell in place of the one just picked, as before.
    click(pointer, viewport, colMidX(1), rowMidY(1));
    expect(editor.value).toBe('=SUM(B1,B2:C3,B2');
    expect(grid.editing).toBe(true);
    editor.value = '=SUM(B1,B2)'; editor.dispatchEvent(new Event('input'));
    grid.commitEdit();
    expect(wb.getValue(id, 0, 0)).toBe(9);
  });
});
