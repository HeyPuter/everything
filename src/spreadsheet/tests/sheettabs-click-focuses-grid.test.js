// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

let tabs;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { tabs?.destroy(); document.body.replaceChildren(); });

function setup() {
  const wb = new Workbook({ sheets: [{ name: 'First' }, { name: 'Second' }] });
  const panel = Object.assign(document.createElement('div'), { tabIndex: 0, className: 'grid' });
  const grid = { el: panel, focus: () => panel.focus() };
  tabs = createSheetTabs({ wb, grid });
  document.body.append(panel, tabs.el);
  return { wb, panel };
}
// A mouse click: focus lands on what was pressed, then the click arrives with a click count.
const mouseClick = (target) => { target.focus(); target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); };

it('returns the keyboard to the sheet after a mouse click on a tab', () => {
  const { wb, panel } = setup();
  mouseClick(tabs.el.querySelector('#sheet-tab-' + wb.sheets[1].id));
  expect(wb.activeSheet.name).toBe('Second');
  expect(document.activeElement).toBe(panel);
  // Clicking the tab already shown does the same.
  mouseClick(tabs.el.querySelector('.tab.active'));
  expect(document.activeElement).toBe(panel);
});

it('returns the keyboard to the sheet after a mouse click on Add sheet', () => {
  const { wb, panel } = setup();
  mouseClick(tabs.el.querySelector('.tab-add'));
  expect(wb.sheets.length).toBe(3);
  expect(document.activeElement).toBe(panel);
});

it('keeps focus on the tabs for keyboard use', () => {
  const { wb } = setup();
  const first = tabs.el.querySelector('.tab.active');
  first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(wb.activeSheet.name).toBe('Second');
  expect(document.activeElement).toBe(tabs.el.querySelector('.tab.active'));
  // A key's activation of Add sheet (a click with no click count) leaves focus on the button.
  const add = tabs.el.querySelector('.tab-add');
  add.focus();
  add.click();
  expect(document.activeElement).toBe(add);
});
