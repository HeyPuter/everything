// @vitest-environment jsdom
// Sheet View Options, Scenario Manager and Edit Links set their buttons after the dialog opened: on an empty
// list the button the dialog had just focused was turned off, and the focus fell to the page. Deleting the
// last entry did the same. The focus now starts, and stays, on a control that is shown and on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { saveScenario } from '../src/core/scenarios.js';
import { openSheetViewOptions } from '../src/ui/sheetviews.js';
import { openScenarioManager } from '../src/ui/scenario-manager.js';
import { openEditLinks } from '../src/ui/editlinks.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  Element.prototype.scrollIntoView = () => {};
  // A desktop-sized window: the dialog focuses a control (on a phone it focuses its panel).
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { closeAllModals(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const panel = () => [...document.querySelectorAll('.modal-panel')].at(-1);
const button = (label) => [...panel().querySelectorAll('button')].find((b) => b.textContent === label);
/** The focus is on a control of the dialog that a person can see and use. */
function expectUsableFocus() {
  const a = document.activeElement;
  expect(panel().contains(a)).toBe(true);
  expect(a.disabled).toBeFalsy();
  expect(a.closest('[hidden]')).toBe(null);
}

describe('dialogs keep the focus on a shown, usable control', () => {
  it('Sheet View Options with no views starts on Close', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    openSheetViewOptions({ wb, sheetId: () => wb.activeSheetId, run: vi.fn(), grid: { focus() {} } });
    expect(button('Switch To').disabled).toBe(true);
    expectUsableFocus();
    expect(document.activeElement).toBe(button('Close'));
  });

  it('Sheet View Options with views starts on the list', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    wb.sheet(wb.activeSheetId).sheetViews = [{ id: 'v1', name: 'Mine' }];
    openSheetViewOptions({ wb, sheetId: () => wb.activeSheetId, run: vi.fn(), grid: { focus() {} } });
    expect(document.activeElement.getAttribute('role')).toBe('listbox');
  });

  it('Scenario Manager with no scenarios starts on Add', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    openScenarioManager({ wb, sheetId: () => wb.activeSheetId, grid: { focus() {} } });
    expectUsableFocus();
    expect(document.activeElement).toBe(button('Add…'));
  });

  it('Scenario Manager moves on to Add when the last scenario is deleted', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }] });
    const id = wb.activeSheetId;
    expect(saveScenario(wb, id, { name: 'Best', cells: [{ r: 0, c: 0 }], values: ['1'] })).toBe(null);
    openScenarioManager({ wb, sheetId: () => id, grid: { focus() {} } });
    expect(document.activeElement.tagName).toBe('SELECT');
    button('Delete').focus();
    button('Delete').click();
    expect(wb.sheet(id).scenarios?.list ?? []).toEqual([]);
    expectUsableFocus();
    expect(document.activeElement).toBe(button('Add…'));
  });

  it('Edit Links with no links starts on Close', () => {
    const wb = new Workbook({ sheets: [{ name: 'Main' }] });
    openEditLinks({ wb, grid: { focus() {} } }, { docPath: () => '/me/Book.xlsx', read: vi.fn(), open: vi.fn(), pick: vi.fn(), allow: vi.fn() });
    expect(button('Update Values').disabled).toBe(true);
    expectUsableFocus();
    expect(document.activeElement).toBe(button('Close'));
  });
});
