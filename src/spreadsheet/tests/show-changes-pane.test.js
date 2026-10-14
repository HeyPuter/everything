// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { session } from '../src/lib/session.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { paletteCommands } from '../src/ui/palette.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
let savedUser;
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
  savedUser = session.user;
  session.user = { username: 'ada' };
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; session.user = savedUser; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Changes', path: 'Spreadsheets/Changes.xlsx' });
  const wb = doc.wb;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const pane = () => view.el.querySelector('.chg-pane');
  const cards = () => [...pane().querySelectorAll('.chg-card')];
  const tick = () => vi.advanceTimersByTimeAsync(1);
  return { wb, id: wb.activeSheetId, pane, cards, tick };
}

describe('Show Changes pane', () => {
  it('lists edits newest first with author, place and old and new values, and follows new edits', async () => {
    const { wb, id, pane, cards, tick } = await mount();
    wb.setInput(id, 1, 1, '10');
    wb.setInput(id, 1, 1, '=5*3');
    view.run('showChanges');
    await tick();
    expect(pane().hidden).toBe(false);
    expect(pane().getAttribute('role')).toBe('region');
    expect(cards()).toHaveLength(2);
    const [latest] = cards();
    expect(latest.querySelector('.chg-author').textContent).toBe('You');
    expect(latest.querySelector('.chg-place').textContent).toBe('Sheet1!B2');
    expect([...latest.querySelectorAll('.chg-value')].map((n) => n.textContent)).toEqual(['10', '=5*3']);
    expect(latest.querySelector('time').title).toBeTruthy();
    wb.setInput(id, 0, 0, 'later');
    await tick();
    expect(cards()).toHaveLength(3);
    expect(cards()[0].querySelector('.chg-diff .chg-blank').textContent).toBe('blank');
  });

  it('shows a many-cell edit as one card with its cells listed, and a click selects them', async () => {
    const { wb, id, cards, tick } = await mount();
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: 1 } }, { r: 1, c: 0, cell: { v: 2 } }, { r: 2, c: 2, cell: { v: 3 } }], 'Paste');
    view.run('showChanges');
    await tick();
    const [card] = cards();
    expect(card.querySelector('.chg-cells summary').textContent).toBe('3 cells changed');
    expect(card.querySelectorAll('.chg-cell')).toHaveLength(3);
    card.querySelector('.chg-place').click();
    await tick();
    expect(view.el.querySelector('.status-left .status-item').textContent).toBe('A1:C3');
    card.querySelectorAll('.chg-cell-ref')[2].click();
    await tick();
    expect(view.el.querySelector('.grid-viewport').getAttribute('aria-activedescendant')).toBe('gc-2-2');
  });

  it('narrows to the selected cells from the cell menu command, and to a typed range', async () => {
    const { wb, id, pane, cards, tick } = await mount();
    wb.setInput(id, 0, 0, 'a');
    wb.setInput(id, 4, 4, 'e');
    view.goTo('Sheet1!E5');
    await tick();
    view.run('showChanges', 'selection');
    await tick();
    expect(pane().querySelector('.chg-scope').value).toBe('sheet');
    expect(pane().querySelector('.chg-range').value).toBe('E5');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].querySelector('.chg-place').textContent).toBe('Sheet1!E5');
    const input = pane().querySelector('.chg-range');
    input.value = 'Z9';
    input.dispatchEvent(new Event('input'));
    expect(cards()).toHaveLength(0);
    expect(pane().querySelector('.chg-summary').textContent).toMatch(/No changes to Z9/);
    input.value = 'nonsense!';
    input.dispatchEvent(new Event('input'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(cards()).toHaveLength(2);
    pane().querySelector('.chg-clear-range').click();
    expect(input.value).toBe('');
  });

  it('pages older edits behind Load More, and clears the record after asking', async () => {
    const { wb, id, pane, cards, tick } = await mount();
    for (let i = 0; i < 60; i++) wb.setInput(id, i, 0, String(i));
    view.run('showChanges');
    await tick();
    expect(cards()).toHaveLength(50);
    const more = pane().querySelector('.chg-more');
    expect(more.hidden).toBe(false);
    more.click();
    expect(cards()).toHaveLength(60);
    expect(more.hidden).toBe(true);
    pane().querySelector('.chg-clear').click();
    await tick();
    const confirm = [...document.querySelectorAll('.modal-panel button')].find((b) => b.textContent === 'Clear history');
    confirm.click();
    await tick();
    expect(wb.changeHistory).toEqual([]);
    expect(cards()).toHaveLength(0);
    expect(pane().querySelector('.chg-summary').textContent).toMatch(/No changes yet/);
  });

  it('opens from the cell menu on the cell right-clicked', async () => {
    const { wb, id, pane, cards, tick } = await mount();
    wb.setInput(id, 0, 0, 'a');
    wb.setInput(id, 2, 0, 'b');
    view.goTo('Sheet1!A3');
    await tick();
    view.el.querySelector('#gc-2-0').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    await tick();
    const item = [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === 'Show Changes');
    item.click();
    await tick();
    expect(pane().hidden).toBe(false);
    expect(cards().map((c) => c.querySelector('.chg-place').textContent)).toEqual(['Sheet1!A3']);
  });

  it('records the signed-in user as the author, and closes on the same command', async () => {
    const { wb, id, pane, tick } = await mount();
    wb.setInput(id, 0, 0, 'x');
    expect(wb.changeHistory.at(-1).author).toBe('ada');
    view.run('showChanges');
    await tick();
    view.run('showChanges');
    await tick();
    expect(pane().hidden).toBe(true);
  });

  it('is offered by the menu bar, the palette and the ribbon', async () => {
    expect(menuLeaves(menubarMenus({}).find((m) => m.id === 'file').items).some((it) => it.cmd === 'showChanges')).toBe(true);
    expect(paletteCommands({}).some((c) => c.cmd === 'showChanges')).toBe(true);
    await mount();
    const ribbonTab = [...view.el.querySelectorAll('.ribbon-tabs [role="tab"]')].find((t) => t.textContent === 'Review');
    ribbonTab.click();
    await vi.advanceTimersByTimeAsync(1);
    expect([...view.el.querySelectorAll('.ribbon button')].some((b) => /Show Changes/.test(b.getAttribute('aria-label') || b.textContent))).toBe(true);
  });
});
