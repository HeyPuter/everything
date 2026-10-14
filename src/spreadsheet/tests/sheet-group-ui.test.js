// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createSheetTabs } from '../src/ui/sheettabs.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { paletteCommands } from '../src/ui/palette.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';
import { GROUP_BLOCKED_REASON, GROUP_BLOCKED_HINT } from '../src/core/sheet-group.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

describe('sheet tabs', () => {
  let tabs;
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => { closeMenu(); closeAllModals(); tabs?.destroy(); document.body.replaceChildren(); });

  function setup() {
    const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }, { name: 'Mar' }, { name: 'Apr' }] });
    tabs = createSheetTabs({ wb });
    document.body.append(tabs.el);
    const tab = (name) => [...tabs.el.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name);
    return { wb, tab };
  }

  it('Shift-click groups the run of sheets from the active one, and shows them selected', () => {
    const { wb, tab } = setup();
    tab('Mar').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(wb.sheetGroup.map((id) => wb.sheet(id).name)).toEqual(['Jan', 'Feb', 'Mar']);
    expect(wb.activeSheet.name).toBe('Jan');
    expect(tab('Feb').getAttribute('aria-selected')).toBe('true');
    expect(tab('Feb').classList.contains('grouped')).toBe(true);
    expect(tab('Apr').getAttribute('aria-selected')).toBe('false');
    expect(tabs.el.querySelector('[role="tablist"]').getAttribute('aria-multiselectable')).toBe('true');
  });

  it('Ctrl- or Cmd-click adds and removes single sheets', () => {
    const { wb, tab } = setup();
    tab('Mar').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    tab('Apr').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(wb.sheetGroup.map((id) => wb.sheet(id).name)).toEqual(['Jan', 'Mar', 'Apr']);
    tab('Mar').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(wb.sheetGroup.map((id) => wb.sheet(id).name)).toEqual(['Jan', 'Apr']);
    // Taking the active sheet out hands the view to the rest of the group.
    tab('Jan').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(wb.sheetGroup).toBeNull();
    expect(wb.activeSheet.name).toBe('Apr');
  });

  it('a plain click inside the group moves within it; outside it ungroups', () => {
    const { wb, tab } = setup();
    tab('Feb').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    tab('Feb').click();
    expect(wb.activeSheet.name).toBe('Feb');
    expect(wb.sheetGroup).toHaveLength(2);
    tab('Apr').click();
    expect(wb.sheetGroup).toBeNull();
    expect(wb.activeSheet.name).toBe('Apr');
  });

  it('the tab menu selects all sheets and ungroups them', () => {
    const { wb, tab } = setup();
    tab('Jan').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
    expect(item('Ungroup Sheets')).toBeUndefined();
    item('Select All Sheets').click();
    expect(wb.sheetGroup).toHaveLength(4);
    // With every sheet grouped, any plain click ends the group.
    tab('Mar').click();
    expect(wb.sheetGroup).toBeNull();
    expect(wb.activeSheet.name).toBe('Mar');
    tab('Mar').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    tab('Apr').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    tab('Apr').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    item('Ungroup Sheets').click();
    expect(wb.sheetGroup).toBeNull();
  });
});

describe('menus while sheets are grouped', () => {
  const leaves = (f) => menubarMenus(f).flatMap((m) => menuLeaves(m.items));
  it('greys the commands for one sheet’s objects, saying why', () => {
    const sort = leaves({ grouped: true }).find((it) => it.cmd === 'sortDialog');
    expect(sort.disabled).toBe(true);
    expect(sort.hint).toBe(GROUP_BLOCKED_HINT);
    expect(leaves({ grouped: true }).find((it) => it.cmd === 'bold').disabled).toBeFalsy();
    expect(leaves({}).find((it) => it.cmd === 'sortDialog').disabled).toBeFalsy();
  });
  it('offers Fill Across Worksheets only to a group, and Ungroup in place of Select All', () => {
    expect(leaves({}).find((it) => it.cmd === 'fillAcrossSheets').disabled).toBe(true);
    expect(leaves({ grouped: true }).find((it) => it.cmd === 'fillAcrossSheets').disabled).toBeFalsy();
    expect(leaves({ grouped: true }).some((it) => it.cmd === 'ungroupSheets')).toBe(true);
    expect(leaves({}).some((it) => it.cmd === 'selectAllSheets')).toBe(true);
  });
  it('leaves the blocked commands out of the palette', () => {
    expect(paletteCommands({ grouped: true }).some((c) => c.cmd === 'sortDialog')).toBe(false);
    expect(paletteCommands({ grouped: true }).some((c) => c.cmd === 'fillAcrossSheets')).toBe(true);
    expect(paletteCommands({}).some((c) => c.cmd === 'fillAcrossSheets')).toBe(false);
  });
});

describe('editor with grouped sheets', () => {
  function memoryStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
  }
  let view;
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.scrollTo = () => {};
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
    document.body.innerHTML = '<div id="app"></div>';
  });
  afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  async function mount() {
    const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
    const wb = doc.wb;
    wb.addSheet('Feb');
    wb.addSheet('Mar');
    wb.setActiveSheet(wb.sheets[0].id);
    wb.clearHistory();
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.querySelector('#app').append(view.el);
    await vi.advanceTimersByTimeAsync(1);
    const [a, b, c] = wb.sheets.map((s) => s.id);
    return { wb, a, b, c };
  }

  it('marks the title [Group] and makes formatting reach every grouped sheet as one step', async () => {
    const { wb, a, b, c } = await mount();
    wb.groupSheets([b]);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.doc-group-badge').hidden).toBe(false);
    expect(document.title).toContain('[Group]');
    await view.run('bold');
    expect(wb.getCell(a, 0, 0).s.bold).toBe(true);
    expect(wb.getCell(b, 0, 0).s.bold).toBe(true);
    expect(wb.getCell(c, 0, 0)).toBeFalsy();
    expect(wb.undoLabels()).toHaveLength(1);
    wb.ungroupSheets();
    await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.doc-group-badge').hidden).toBe(true);
  });

  it('refuses a one-sheet command with the reason', async () => {
    const { wb, b } = await mount();
    const toast = vi.spyOn(notifications, 'toast');
    wb.groupSheets([b]);
    await view.run('insertTable');
    expect(toast).toHaveBeenCalledWith(GROUP_BLOCKED_REASON, expect.anything());
    expect(document.querySelector('.modal-root')).toBeNull();
  });

  it('fills across worksheets from the dialog', async () => {
    const { wb, a, b, c } = await mount();
    wb.setInput(a, 0, 0, 'header');
    wb.groupSheets([b, c]);
    await view.run('fillAcrossSheets');
    const dialog = document.querySelector('.modal-panel');
    expect(dialog.getAttribute('aria-label')).toBe('Fill across worksheets');
    dialog.querySelector('input[value="contents"]').checked = true;
    dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(wb.getValue(b, 0, 0)).toBe('header');
    expect(wb.getValue(c, 0, 0)).toBe('header');
  });

  it('deletes and hides the whole group, keeping a sheet on show', async () => {
    const { wb, a, b, c } = await mount();
    wb.groupSheets([b]);
    await view.run('hideSheet');
    expect(wb.sheet(a).hidden).toBe(true);
    expect(wb.sheet(b).hidden).toBe(true);
    expect(wb.undoLabels()).toEqual(['Hide sheets']);
    wb.undo();
    wb.setActiveSheet(a);
    wb.groupSheets([a, b, c]);
    const toast = vi.spyOn(notifications, 'toast');
    await view.run('hideSheet');
    expect(toast).toHaveBeenCalled();
    expect(wb.visibleSheets).toHaveLength(3);
  });
});
