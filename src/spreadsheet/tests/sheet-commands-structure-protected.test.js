// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { paletteCommands } from '../src/ui/palette.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

// Under Protect Workbook the sheet tab's menu, the Insert menu's Sheet submenu and the palette still offered
// Insert, Rename, Move or Copy, Tab Color, Hide, Unhide, Duplicate, Move left and right, and Delete: each was
// refused only once chosen, and Rename (or a double-click on the tab) first asked for a new name and then threw
// it away. They are greyed (left out of the palette), as Excel greys them, and Rename says why at once.
let tabs;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { closeMenu(); closeAllModals(); tabs?.destroy(); tabs = null; vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup() {
  const wb = new Workbook({ sheets: [{ name: 'First' }, { name: 'Second' }, { name: 'Third', hidden: true }] });
  wb.setStructureProtected(true);
  tabs = createSheetTabs({ wb });
  document.body.append(tabs.el);
  return wb;
}
const tabMenuItems = () => Object.fromEntries([...document.querySelectorAll('.menu .menu-item')].map((n) => [n.querySelector('.menu-label')?.textContent, n.disabled || n.getAttribute('aria-disabled') === 'true']));

describe('the sheet tabs under Protect Workbook', () => {
  it('grey what would change the sheets, and keep the rest', () => {
    setup();
    tabs.el.querySelector('.tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    const items = tabMenuItems();
    for (const label of ['Insert Sheet', 'Delete', 'Rename…', 'Move or Copy…', 'Tab Color', 'Hide', 'Unhide', 'Duplicate', 'Move right']) expect(items[label], label).toBe(true);
    for (const label of ['Protect Sheet', 'Select All Sheets']) expect(items[label], label).toBe(false);
  });

  it('offer them again once the workbook is unprotected', () => {
    const wb = setup();
    wb.setStructureProtected(false);
    tabs.el.querySelector('.tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    const items = tabMenuItems();
    for (const label of ['Insert Sheet', 'Rename…', 'Move or Copy…', 'Tab Color', 'Hide', 'Unhide', 'Duplicate', 'Move right']) expect(items[label], label).toBe(false);
    expect(tabs.el.querySelector('.tab-add').getAttribute('aria-disabled')).toBe('false');
  });

  it('grey the add button, which still answers with the reason', () => {
    const wb = setup();
    const notices = [];
    wb.addEventListener('change', (e) => { if (e.detail?.type === 'protected' && e.detail.structure) notices.push(e.detail); });
    const add = tabs.el.querySelector('.tab-add');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    add.click();
    expect(wb.sheets.length).toBe(3);
    expect(notices.length).toBe(1);
  });

  it('say the name cannot change before asking for one', async () => {
    const wb = setup();
    const notices = [];
    wb.addEventListener('change', (e) => { if (e.detail?.type === 'protected' && e.detail.structure) notices.push(e.detail); });
    tabs.el.querySelector('.tab.active').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await Promise.resolve();
    expect(document.querySelector('.modal-root')).toBeNull();
    expect(notices.length).toBe(1);
    expect(wb.sheets[0].name).toBe('First');
  });
});

describe('the Sheet submenu and the palette under Protect Workbook', () => {
  const sheet = { only: false, first: false, last: false, protected: false, holdsWork: true, locked: true };
  it('grey what would change the sheets', () => {
    const leaves = menuLeaves(menubarMenus({ sheet }).find((m) => m.id === 'insert').items.find((it) => it.label === 'Sheet').submenu);
    const disabled = Object.fromEntries(leaves.map((it) => [it.label, !!it.disabled]));
    for (const label of ['New sheet', 'Duplicate sheet', 'Move or Copy sheet…', 'Rename sheet…', 'Sheet color…', 'Move sheet left', 'Move sheet right', 'Hide sheet', 'Delete sheet…']) expect(disabled[label], label).toBe(true);
    for (const label of ['Copy sheet to another spreadsheet…', 'Protect sheet', 'Select all sheets']) expect(disabled[label], label).toBe(false);
  });
  it('leave them out of the palette', () => {
    const labels = paletteCommands({ sheet }).filter((c) => /sheet/i.test(c.label) && c.section === 'Insert').map((c) => c.label);
    expect(labels).toEqual(['Copy sheet to another spreadsheet…', 'Protect sheet', 'Select all sheets']);
  });
});
