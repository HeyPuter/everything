// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { quickAccessStore, ribbonLayoutStore, keymapStore, DEFAULT_QUICK_ACCESS, commandId, parseCommandId } from '../src/lib/customize.js';
import { EMPTY_LAYOUT } from '../src/core/ribbon-layout.js';
import { effectiveShortcut, withCustomShortcuts } from '../src/ui/custom-shortcuts.js';
import { reloadAppOptions } from '../src/lib/app-options.js';

// The Quick Access Toolbar, the ribbon's arrangement and keyboard shortcuts of one's own.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  reloadAppOptions();
  for (const store of [quickAccessStore, ribbonLayoutStore, keymapStore]) store.reload();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeMenu(); closeAllModals(); view?.destroy(); view = null;
  quickAccessStore.set({ ...DEFAULT_QUICK_ACCESS }); ribbonLayoutStore.set(EMPTY_LAYOUT); keymapStore.set({});
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

async function mount() {
  const doc = new Doc({ name: 'Book', path: 'Spreadsheets/Book.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  return { wb: doc.wb, id: doc.wb.activeSheetId, viewport };
}
const tick = () => vi.advanceTimersByTimeAsync(5);
const menuItem = (label) => [...document.querySelectorAll('.menu [role^="menuitem"]')].find((b) => b.querySelector('.menu-label')?.firstChild?.textContent === label);
const tab = (name) => [...view.el.querySelectorAll('.ribbon-tab')].find((t) => t.textContent === name);
const qat = () => view.el.querySelector('.quick-access');
const qatLabels = () => [...qat().querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));

describe('command ids', () => {
  it('carry the argument as JSON', () => {
    expect(commandId('bold')).toBe('bold');
    expect(commandId('sort', 'asc')).toBe('sort:"asc"');
    expect(parseCommandId('sort:"asc"')).toEqual({ cmd: 'sort', arg: 'asc' });
    expect(parseCommandId('fmt:{"fmt":"percent"}')).toEqual({ cmd: 'fmt', arg: { fmt: 'percent' } });
    expect(parseCommandId('bold')).toEqual({ cmd: 'bold', arg: null });
  });
});

describe('the Quick Access Toolbar', () => {
  it('takes a ribbon command from its right-click menu, and runs it from there', async () => {
    const { wb, id } = await mount();
    tab('Data').click();
    const sortButton = view.el.querySelector('.ribbon-panel:not([hidden]) [aria-label="Sort A to Z"]');
    sortButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    menuItem('Add to Quick Access Toolbar').click();
    await tick();
    expect(quickAccessStore.get().items).toEqual(['save', 'undo', 'redo', 'sort:"asc"']);
    const added = () => qat().querySelector('[data-qat-command=\'sort:"asc"\']');
    expect(added()).not.toBeNull();
    for (const [r, v] of [[0, 'pear'], [1, 'apple']]) wb.setInput(id, r, 0, v);
    view.goTo('Sheet1!A1:A2');
    await tick();
    added().click();
    await tick();
    expect(wb.getValue(id, 0, 0)).toBe('apple');
    // The same menu now offers to take it off again.
    sortButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
    menuItem('Remove from Quick Access Toolbar').click();
    await tick();
    expect(added()).toBeNull();
  });

  it('moves under the ribbon, and shows names, from its customize menu', async () => {
    await mount();
    qat().querySelector('.qat-customize').click();
    await tick();
    menuItem('Print').click();
    await tick();
    expect(qatLabels()).toContain('Print');
    qat().querySelector('.qat-customize').click();
    await tick();
    menuItem('Show Below the Ribbon').click();
    await tick();
    expect(view.el.querySelector('.editor-main > .quick-access-bar .quick-access')).not.toBeNull();
    expect(view.el.querySelector('.editor-header .quick-access')).toBeNull();
    qat().querySelector('.qat-customize').click();
    await tick();
    menuItem('Show Command Labels').click();
    await tick();
    expect(qat().classList.contains('qat-labels')).toBe(true);
    quickAccessStore.set({ ...quickAccessStore.get(), below: false });
    expect(view.el.querySelector('.editor-header .quick-access')).not.toBeNull();
  });

  it('is arranged in Options: add, reorder, remove and reset', async () => {
    await mount();
    view.run('options', 'quickAccess');
    await tick();
    const dialog = document.querySelector('.options-modal');
    const [from, mine] = dialog.querySelectorAll('.opt-list');
    const search = dialog.querySelector('.opt-search');
    search.value = 'spelling';
    search.dispatchEvent(new Event('input'));
    from.querySelector('[data-id="spelling"]').click();
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Add ›').click();
    expect(quickAccessStore.get().items).toEqual(['save', 'undo', 'redo', 'spelling']);
    mine.focus();
    mine.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(quickAccessStore.get().items).toEqual(['save', 'undo', 'spelling', 'redo']);
    expect(qatLabels().slice(-3)).toEqual(['Spelling', 'Redo', 'Customize Quick Access Toolbar']);
    mine.querySelector('[data-id="undo"]').click();
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === '‹ Remove').click();
    expect(quickAccessStore.get().items).toEqual(['save', 'spelling', 'redo']);
    expect(qatLabels()).not.toContain('Undo');
    [...dialog.querySelectorAll('.opt-foot button')].find((b) => b.textContent === 'Restore Defaults').click();
    expect(quickAccessStore.get().items).toEqual(['save', 'undo', 'redo']);
    expect(qatLabels()).toContain('Undo history');
  });
});

describe('the ribbon’s arrangement', () => {
  it('hides, renames and reorders tabs', async () => {
    await mount();
    ribbonLayoutStore.set({ ...EMPTY_LAYOUT, hidden: ['Draw'], names: { Data: 'Numbers' }, order: ['Home', 'Data', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Review', 'View', 'Automate'] });
    expect(tab('Draw').hidden).toBe(true);
    expect(tab('Numbers')).toBeTruthy();
    const shown = [...view.el.querySelectorAll('.ribbon-tab')].filter((t) => !t.hidden).map((t) => t.textContent);
    expect(shown.slice(0, 3)).toEqual(['Home', 'Numbers', 'Insert']);
    // Arrow keys follow the order on screen.
    tab('Home').focus();
    tab('Home').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tab('Numbers'));
  });

  it('builds a tab of one’s own in Options, whose buttons run their commands', async () => {
    const { wb, id } = await mount();
    view.run('options', 'ribbon');
    await tick();
    const dialog = document.querySelector('.options-modal');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'New Tab').click();
    const name = dialog.querySelector('.opt-rename input');
    name.value = 'My Tools';
    name.dispatchEvent(new Event('change'));
    expect(tab('My Tools')).toBeTruthy();
    const [from, tree] = dialog.querySelectorAll('.opt-list');
    tree.querySelector('[data-kind="group"]').click();
    const search = dialog.querySelector('.opt-search');
    search.value = 'bold';
    search.dispatchEvent(new Event('input'));
    from.querySelector('[data-id="bold"]').click();
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Add ›').click();
    const layout = ribbonLayoutStore.get();
    expect(layout.tabs.map((t) => t.name)).toEqual(['My Tools']);
    expect(Object.values(layout.groups)[0][0].commands).toEqual(['bold']);
    // Space on the tab's row hides it.
    tree.querySelector('[data-kind="tab"][aria-checked]')?.click();
    closeAllModals();
    await tick();
    tab('My Tools').click();
    await tick();
    const bold = view.el.querySelector('.ribbon-panel:not([hidden]) .ribbon-custom-group [aria-label="Bold"]');
    expect(bold).not.toBeNull();
    wb.setInput(id, 0, 0, 'x');
    view.goTo('Sheet1!A1');
    await tick();
    bold.click();
    expect(wb.getCell(id, 0, 0).s?.bold).toBe(true);
  });

  it('adds a group of one’s own to a built-in tab, and hides tabs with Space', async () => {
    await mount();
    view.run('options', 'ribbon');
    await tick();
    const dialog = document.querySelector('.options-modal');
    const tree = dialog.querySelectorAll('.opt-list')[1];
    tree.querySelector('[data-id="tab:Formulas"]').click();
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'New Group').click();
    expect(ribbonLayoutStore.get().groups.Formulas).toHaveLength(1);
    expect(view.el.querySelectorAll('.ribbon-custom-group')).toHaveLength(1);
    tree.querySelector('[data-id="tab:Review"]').click();
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(ribbonLayoutStore.get().hidden).toEqual(['Review']);
    expect(tab('Review').hidden).toBe(true);
    [...dialog.querySelectorAll('.opt-foot button')].find((b) => b.textContent === 'Restore Defaults').click();
    expect(tab('Review').hidden).toBe(false);
    expect(view.el.querySelectorAll('.ribbon-custom-group')).toHaveLength(0);
  });
});

describe('keyboard shortcuts of one’s own', () => {
  const press = (target, key, code, mods) => target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }));

  it('run their command on the sheet, ahead of the built-in keys, and show in the menus', async () => {
    const { wb, id, viewport } = await mount();
    wb.setInput(id, 0, 0, 'x');
    view.goTo('Sheet1!A1');
    await tick();
    keymapStore.set({ 'Mod+Alt+K': 'bold', 'Mod+I': null });
    press(viewport, 'k', 'KeyK', { ctrlKey: true, altKey: true });
    expect(wb.getCell(id, 0, 0).s?.bold).toBe(true);
    // Ctrl+I is turned off: nothing happens.
    press(viewport, 'i', 'KeyI', { ctrlKey: true });
    expect(wb.getCell(id, 0, 0).s?.italic).toBeFalsy();
    const items = menuLeaves(menubarMenus({}).flatMap((m) => m.items));
    const bold = items.find((i) => i.cmd === 'bold');
    const italic = items.find((i) => i.cmd === 'italic');
    expect(bold.shortcut).toBe('Ctrl+B');
    expect(italic.shortcut).toBeUndefined();
    expect(effectiveShortcut({ cmd: 'bold', shortcut: 'Ctrl+B' }, { 'Mod+B': 'italic', 'Mod+Alt+K': 'bold' }, false)).toBe('Ctrl+Alt+K');
    expect(withCustomShortcuts([{ label: 'Bold', cmd: 'bold', shortcut: 'Ctrl+B' }], { 'Mod+B': null }, false)[0].shortcut).toBeUndefined();
  });

  it('are assigned in Options, which says what a chord would be taken from', async () => {
    await mount();
    view.run('options', 'keyboard');
    await tick();
    const dialog = document.querySelector('.options-modal');
    const search = dialog.querySelector('.opt-search');
    search.value = 'italic';
    search.dispatchEvent(new Event('input'));
    dialog.querySelector('.opt-list [data-id="italic"]').click();
    const capture = dialog.querySelector('.opt-key-capture');
    press(capture, 'b', 'KeyB', { ctrlKey: true });
    expect(capture.value).toBe('Ctrl+B');
    expect(dialog.querySelector('.opt-key-message').textContent).toMatch(/Now runs Bold/);
    press(capture, 'c', 'KeyC', { ctrlKey: true });
    expect(dialog.querySelector('.opt-key-message').textContent).toMatch(/Copy/);
    expect([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Assign').disabled).toBe(true);
    press(capture, 'j', 'KeyJ', { ctrlKey: true, shiftKey: true });
    const assign = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Assign');
    expect(assign.disabled).toBe(false);
    assign.click();
    expect(keymapStore.get()).toEqual({ 'Mod+Shift+J': 'italic' });
    expect([...dialog.querySelectorAll('.opt-key-chip kbd')].map((k) => k.textContent)).toEqual(['Ctrl+I', 'Ctrl+Shift+J']);
    // Removing the built-in one turns it off.
    dialog.querySelector('.opt-key-chip [aria-label="Remove Ctrl+I"]').click();
    expect(keymapStore.get()).toEqual({ 'Mod+Shift+J': 'italic', 'Mod+I': null });
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Reset this command').click();
    expect(keymapStore.get()).toEqual({});
  });
});
