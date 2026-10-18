// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToolbar } from '../src/ui/toolbar.js';
import { closeMenu } from '../src/ui/menu.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => { vi.useFakeTimers(); globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); });
afterEach(() => { closeMenu(); vi.useRealTimers(); document.body.replaceChildren(); });

const menus = () => document.querySelectorAll('.menu').length;
const touch = (t, type) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch' }));
const touchEnd = (t) => { const ev = new Event('touchend', { bubbles: true, cancelable: true }); t.dispatchEvent(ev); return ev.defaultPrevented; };

function setup() {
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, 'x');
  const toolbar = createToolbar({
    wb, run() {}, activeCell: () => null, style: () => ({}), active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId, grid: { editing: false, focus() {} }, subscribe: () => () => {},
  });
  document.body.append(toolbar.el);
  return toolbar.el.querySelector('[aria-label="Undo"]');
}

// The history opens while the finger is still on Undo. Lifting it must not be a tap on the button as
// well: the click the browser sends for the release undid the last step behind the list just opened.
it('lifting the finger after a long press on Undo does not also press the button', () => {
  const undo = setup();
  touch(undo, 'pointerdown');
  vi.advanceTimersByTime(600);
  expect(menus()).toBe(1);
  touch(undo, 'pointerup');
  expect(touchEnd(undo)).toBe(true);
  expect(menus()).toBe(1);
});

it('a short tap on Undo still ends as a tap', () => {
  const undo = setup();
  touch(undo, 'pointerdown');
  vi.advanceTimersByTime(100);
  touch(undo, 'pointerup');
  expect(touchEnd(undo)).toBe(false);
  expect(menus()).toBe(0);
});
