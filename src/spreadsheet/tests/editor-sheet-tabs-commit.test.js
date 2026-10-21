// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

// The tab strip called the workbook's structural methods directly. With a cell
// still being edited, the edit was committed inside the structure event, so it
// landed in the history before the sheet change and the structural step's
// snapshot predated it: the first undo took the sheet and the edit away.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function setup() {
  const doc = new Doc({ name: 'Tabs', path: 'Spreadsheets/Tabs.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id };
}

/** Start typing "hello" into the active cell and leave the editor open. */
async function typeHello() {
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = 'hello';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing') || editor.value === 'hello').toBe(true);
}
const menuItem = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);

describe('a pending edit and the tab strip', () => {
  it('commits an unfinished entry to its original sheet when choosing a filtered sheet', async () => {
    const { wb, id } = await setup();
    for (let i = 2; i <= 10; i++) wb.addSheet(`Sheet${i}`);
    wb.setActiveSheet(id);
    await vi.advanceTimersByTimeAsync(1);
    await typeHello();
    view.el.querySelector('.tab-all').click();
    const input = document.querySelector('[aria-label="Search sheets"]');
    input.value = '10'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheet(wb.activeSheetId).name).toBe('Sheet10');
    expect(wb.getValue(id, 0, 0)).toBe('hello');
  });

  it('keeps an entry open when keyboard focus moves to sheet scrolling controls', async () => {
    const { wb, id } = await setup();
    await typeHello();
    const nav = view.el.querySelector('.tab-navigation');
    nav.hidden = false;
    nav.querySelector('button').focus();
    await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
    expect(view.el.querySelector('.grid-editor').value).toBe('hello');
    expect(wb.getValue(id, 0, 0)).toBeNull();
  });

  it('is committed before the + button adds a sheet, so one undo removes only the sheet', async () => {
    const { wb, id } = await setup();
    await typeHello();
    view.el.querySelector('.tab-add').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheets).toHaveLength(2);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
    expect(wb.undoLabel()).toBe('Add sheet');
    wb.undo();
    expect(wb.sheets).toHaveLength(1);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
    expect(wb.undoLabel()).toBe('Edit cell');
  });

  it('is committed before the tab menu duplicates the sheet', async () => {
    const { wb, id } = await setup();
    await typeHello();
    view.el.querySelector('.tab-menu-btn').click();
    menuItem('Duplicate').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheets).toHaveLength(2);
    expect(wb.undoLabel()).toBe('Duplicate sheet');
    wb.undo();
    expect(wb.sheets).toHaveLength(1);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
  });

  it('commits before Move or Copy opens, then copies at the chosen destination with one undo', async () => {
    const { wb, id } = await setup();
    wb.addSheet('Two');
    wb.addSheet('Three');
    wb.setActiveSheet(id);
    wb.clearHistory();
    await typeHello();
    view.el.querySelector('.tab-menu-btn').click();
    menuItem('Move or Copy…').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
    const panel = document.querySelector('.modal-panel[aria-label="Move or Copy"]');
    const list = panel.querySelector('[aria-label="Before sheet"]');
    list.value = '';
    list.dispatchEvent(new Event('change'));
    panel.querySelector('[type="checkbox"]').click();
    panel.querySelector('form').requestSubmit();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheets.map(s => s.name)).toEqual(['Sheet1', 'Two', 'Three', 'Sheet1 (2)']);
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('hello');
    expect(document.querySelector('.modal-root:not(.closing)')).toBeNull();
    wb.undo();
    expect(wb.sheets.map(s => s.name)).toEqual(['Sheet1', 'Two', 'Three']);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
    expect(wb.undoLabel()).toBe('Edit cell');
  });

  it('is committed before a hidden sheet is shown from the All sheets menu', async () => {
    const { wb, id } = await setup();
    const other = wb.addSheet('Two');
    wb.setSheetHidden(other.id, true);
    wb.setActiveSheet(id);
    wb.clearHistory();
    await vi.advanceTimersByTimeAsync(1);
    await typeHello();
    view.el.querySelector('.tab-all').click();
    menuItem('Two').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheet(other.id).hidden).toBe(false);
    expect(wb.undoLabel()).toBe('Show sheet');
    wb.undo();
    expect(wb.sheet(other.id).hidden).toBe(true);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
  });

  it('is committed before the tab menu hides the active sheet', async () => {
    const { wb, id } = await setup();
    wb.addSheet('Two');
    wb.setActiveSheet(id);
    wb.clearHistory();
    await vi.advanceTimersByTimeAsync(1);
    await typeHello();
    view.el.querySelector('.tab-menu-btn').click();
    menuItem('Hide').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheet(id).hidden).toBe(true);
    expect(wb.undoLabel()).toBe('Hide sheet');
    wb.undo();
    expect(wb.sheet(id).hidden).toBe(false);
    expect(wb.getValue(id, 0, 0)).toBe('hello');
  });
});
