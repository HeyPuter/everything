// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { closeMenu } from '../src/ui/menu.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

let tabs;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // Each tab is 100px wide, side by side from x = 0.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    if (!this.classList?.contains('tab')) return { left: 0, right: 1000, top: 0, bottom: 30, width: 1000, height: 30 };
    const i = [...this.parentElement.closest('.tab-strip').querySelectorAll('.tab')].indexOf(this);
    return { left: i * 100, right: i * 100 + 100, top: 0, bottom: 30, width: 100, height: 30 };
  });
});
afterEach(() => { closeMenu(); tabs?.destroy(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function setup() {
  const wb = new Workbook({ sheets: [{ name: 'First' }, { name: 'Second' }, { name: 'Third' }] });
  tabs = createSheetTabs({ wb }, { excelLayout: true });
  document.body.append(tabs.el);
  return wb;
}
const tab = name => [...tabs.el.querySelectorAll('.tab')].find(t => t.textContent.includes(name));
const pointer = (target, type, x, extra = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, ...extra }));
const names = wb => wb.sheets.map(s => s.name);

it('moves a sheet to where its tab is dropped, as one undo step', () => {
  const wb = setup();
  pointer(tab('First'), 'pointerdown', 50);
  pointer(tab('First'), 'pointermove', 120);
  expect(tabs.el.querySelector('.tab-drop-marker').hidden).toBe(false);
  pointer(tab('First'), 'pointermove', 260);
  pointer(tab('First'), 'pointerup', 260);
  expect(names(wb)).toEqual(['Second', 'Third', 'First']);
  expect(tabs.el.querySelector('.tab-drop-marker').hidden).toBe(true);
  wb.undo();
  expect(names(wb)).toEqual(['First', 'Second', 'Third']);
});

it('copies the sheet when Ctrl is held at the drop, and leaves a short press as a click', () => {
  const wb = setup();
  pointer(tab('Second'), 'pointerdown', 150);
  pointer(tab('Second'), 'pointermove', 20, { ctrlKey: true });
  pointer(tab('Second'), 'pointerup', 20, { ctrlKey: true });
  expect(names(wb)).toEqual(['Second (2)', 'First', 'Second', 'Third']);
  pointer(tab('Third'), 'pointerdown', 250);
  pointer(tab('Third'), 'pointerup', 252);
  expect(names(wb)).toEqual(['Second (2)', 'First', 'Second', 'Third']);
});

it('drops a tab back where it was without moving anything', () => {
  const wb = setup();
  const before = wb.undoLabel?.();
  pointer(tab('Second'), 'pointerdown', 150);
  pointer(tab('Second'), 'pointermove', 170);
  pointer(tab('Second'), 'pointerup', 170);
  expect(names(wb)).toEqual(['First', 'Second', 'Third']);
  expect(wb.undoLabel?.()).toBe(before);
});

it('offers Insert sheet and Unhide in the tab menu', () => {
  const wb = setup();
  wb.setSheetHidden(wb.sheets[2].id, true);
  tab('First').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const item = label => [...document.querySelectorAll('.menu [role="menuitem"]')].find(b => b.textContent.trim() === label);
  item('Insert Sheet').click();
  expect(wb.sheets).toHaveLength(4);
  tab('First').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  item('Unhide').click();
  item('Third').click();
  expect(wb.sheets.find(s => s.name === 'Third').hidden).toBe(false);
});
