// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { appOption, setAppOptions, resetAppOptions, reloadAppOptions } from '../src/lib/app-options.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(() => ({ dismiss: () => {} })) }));

// File ▸ Options in the editor: the dialog, and what its options do to the window, the sheet and new workbooks.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  reloadAppOptions();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { toast.mockClear(); closeMenu(); closeAllModals(); view?.destroy(); view = null; resetAppOptions(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount(doc = new Doc({ name: 'Book', path: 'Spreadsheets/Book.xlsx' })) {
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { doc, wb: doc.wb, id: doc.wb.activeSheetId, viewport, key };
}
const dialog = () => document.querySelector('.modal-root:not(.closing) .options-modal');
const section = (title) => [...dialog().querySelectorAll('.opt-nav-item')].find((b) => b.textContent === title);
const checkbox = (label) => [...dialog().querySelectorAll('.opt-check')].find((r) => r.querySelector('.opt-label')?.textContent === label)?.querySelector('input');

describe('the Options dialog', () => {
  it('opens from File ▸ Options and with Ctrl/Cmd+,', async () => {
    const { viewport, key } = await mount();
    const file = menubarMenus({}).find((m) => m.id === 'file');
    expect(menuLeaves(file.items).some((i) => i.cmd === 'options')).toBe(true);
    key(viewport, ',', { code: 'Comma', ctrlKey: true, metaKey: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(dialog()).not.toBeNull();
    expect(dialog().querySelector('.opt-title').textContent).toBe('General');
  });

  it('finds options by any word of their names, across sections', async () => {
    await mount();
    view.run('options');
    await vi.advanceTimersByTimeAsync(1);
    const find = dialog().querySelector('.opt-find');
    find.value = 'decimal';
    find.dispatchEvent(new Event('input'));
    expect(dialog().querySelector('.opt-title').textContent).toBe('Editing');
    const shown = [...dialog().querySelectorAll('.opt-page .opt-row')].filter((r) => !r.hidden);
    expect(shown.map((r) => r.dataset.key)).toEqual(['fixedDecimal', 'fixedDecimalPlaces']);
    expect(section('General').hidden).toBe(true);
    find.value = 'zzzz';
    find.dispatchEvent(new Event('input'));
    expect(dialog().querySelector('.opt-empty').hidden).toBe(false);
  });

  it('applies and keeps a change at once, and Restore Defaults puts the page back', async () => {
    const { wb } = await mount();
    view.run('options', 'view');
    await vi.advanceTimersByTimeAsync(1);
    const status = checkbox('Status bar');
    status.checked = false;
    status.dispatchEvent(new Event('change'));
    expect(appOption('showStatusBar')).toBe(false);
    expect(view.el.classList.contains('no-status-bar')).toBe(true);
    checkbox('Sheet tabs').click();
    expect(view.el.classList.contains('no-sheet-tabs')).toBe(true);
    reloadAppOptions();
    expect(appOption('showStatusBar')).toBe(false);
    [...dialog().querySelectorAll('.opt-foot button')].find((b) => b.textContent === 'Restore Defaults').click();
    expect(appOption('showStatusBar')).toBe(true);
    expect(view.el.classList.contains('no-status-bar')).toBe(false);
    expect(wb.dirty).toBeFalsy();
  });

  it('greys an option that depends on another until that one is on', async () => {
    await mount();
    view.run('options', 'edit');
    await vi.advanceTimersByTimeAsync(1);
    const places = dialog().querySelector('.opt-row[data-key="fixedDecimalPlaces"]');
    expect(places.classList.contains('opt-dependent')).toBe(true);
    expect(places.querySelector('input').disabled).toBe(true);
    checkbox('Put in a decimal point automatically').click();
    expect(appOption('fixedDecimal')).toBe(true);
    expect(places.querySelector('input').disabled).toBe(false);
    const input = places.querySelector('input');
    input.value = '3';
    input.dispatchEvent(new Event('change'));
    expect(appOption('fixedDecimalPlaces')).toBe(3);
    const direction = dialog().querySelector('.opt-row[data-key="enterDirection"] select');
    direction.value = 'right';
    direction.dispatchEvent(new Event('change'));
    expect(appOption('enterDirection')).toBe('right');
  });

  it('sets the workbook’s own calculation, saying so, apart from the choice for new workbooks', async () => {
    const { wb } = await mount();
    view.run('options', 'formulas');
    await vi.advanceTimersByTimeAsync(1);
    expect(dialog().textContent).toMatch(/Saved with “Book”/);
    const manual = [...dialog().querySelectorAll('.opt-radio input')].find((i) => i.value === 'manual');
    manual.checked = true;
    manual.dispatchEvent(new Event('change'));
    expect(wb.calcMode).toBe('manual');
    const iterate = [...dialog().querySelectorAll('.opt-check')].find((r) => /circular/.test(r.textContent)).querySelector('input');
    iterate.checked = true;
    iterate.dispatchEvent(new Event('change'));
    expect(wb.iteration).toEqual({ iterate: true, iterateCount: 100, iterateDelta: 0.001 });
    expect(appOption('newCalcMode')).toBe('automatic');
  });

  it('turns error checking rules off for the person', async () => {
    await mount();
    view.run('options', 'formulas');
    await vi.advanceTimersByTimeAsync(1);
    const rule = checkbox('Numbers formatted as text or preceded by an apostrophe');
    rule.checked = false;
    rule.dispatchEvent(new Event('change'));
    const { errorCheckingOptions } = await import('../src/core/error-checking.js');
    expect(errorCheckingOptions().numberStoredAsText).toBe(false);
    rule.checked = true;
    rule.dispatchEvent(new Event('change'));
  });
});

describe('what the options change in the editor', () => {
  it('View ▸ Formula bar is the same switch as the option', async () => {
    await mount();
    view.run('formulaBar');
    expect(appOption('showFormulaBar')).toBe(false);
    expect(view.el.classList.contains('no-formula-bar')).toBe(true);
    view.run('formulaBar');
    expect(view.el.classList.contains('no-formula-bar')).toBe(false);
  });

  it('hides objects, scroll bars and comment marks', async () => {
    await mount();
    setAppOptions({ showObjects: false, showHScroll: false, commentIndicators: 'none' });
    expect(view.el.classList.contains('no-objects')).toBe(true);
    expect(view.el.classList.contains('no-hscroll')).toBe(true);
    expect(view.el.classList.contains('no-comment-marks')).toBe(true);
  });

  it('starts new sheets in the chosen view, without headers when asked', async () => {
    const { wb } = await mount();
    setAppOptions({ newView: 'pageLayout', showHeaders: false });
    view.run('newSheet');
    const added = wb.sheets.at(-1);
    expect(added.viewMode).toBe('pageLayout');
    expect(added.headers).toBe(false);
  });

  it('writes the chosen name on changes', async () => {
    const { wb } = await mount();
    setAppOptions({ userName: 'Grace H.' });
    expect(wb.changeAuthor).toBe('Grace H.');
  });

  it('asks before a command that changes very many cells', async () => {
    const { wb, id } = await mount();
    for (let r = 0; r < 30; r++) wb.setInput(id, r, 0, String(r));
    setAppOptions({ longOperationCells: 1 }); // a thousand cells
    view.goTo('Sheet1!A1:A2000');
    view.run('fillDown');
    await vi.advanceTimersByTimeAsync(1);
    const ask = document.querySelector('.modal-root:not(.closing) .modal-panel');
    expect(ask.textContent).toMatch(/2,000 cells/);
    [...ask.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 1, 0)).toBe(1);
    // Clearing counts only the cells that hold something.
    view.run('clear');
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.modal-root:not(.closing)')).toBeNull();
    expect(wb.getValue(id, 1, 0)).toBeNull();
  });

  it('turns the Paste and Auto Fill Options buttons off', async () => {
    const { wb, id, viewport } = await mount();
    wb.setInput(id, 0, 0, '1');
    setAppOptions({ fillOptionsButton: false });
    view.goTo('Sheet1!A1');
    await vi.advanceTimersByTimeAsync(1);
    const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse' }));
    pointer(view.el.querySelector('.fill-handle'), 'pointerdown', 99, 25);
    pointer(viewport, 'pointermove', 50, 90);
    pointer(viewport, 'pointerup', 50, 90);
    await vi.advanceTimersByTimeAsync(5);
    expect(wb.getValue(id, 2, 0)).toBe(1);
    expect(view.el.querySelector('.option-button').hidden).toBe(true);
  });

  it('offers Flash Fill once two examples follow a pattern', async () => {
    const { wb, id, viewport, key } = await mount();
    const names = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Edsger Dijkstra'];
    names.forEach((n, r) => wb.setInput(id, r, 0, n));
    const type = async (a, text) => {
      view.goTo(`Sheet1!${a}`);
      await vi.advanceTimersByTimeAsync(1);
      key(viewport, text[0]);
      const editor = view.el.querySelector('.grid-editor');
      editor.value = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text.slice(-1), inputType: 'insertText' }));
      key(editor, 'Enter');
      await vi.advanceTimersByTimeAsync(1);
    };
    await type('B1', 'Ada');
    const offers = () => toast.mock.calls.filter(([message]) => /Flash Fill can fill/.test(message));
    expect(offers()).toHaveLength(0);
    await type('B2', 'Alan');
    expect(offers()).toHaveLength(1);
    const [message, { action }] = offers()[0];
    expect(message).toMatch(/fill 2 more cells/);
    action.onClick();
    expect(wb.getValue(id, 2, 1)).toBe('Grace');
    expect(wb.getValue(id, 3, 1)).toBe('Edsger');
    expect(wb.undoLabels(1)).toEqual(['Flash Fill']);
  });

  it('carries a list’s format and formula onto a row typed under it, as one step', async () => {
    const { wb, id, viewport, key } = await mount();
    for (let r = 0; r < 3; r++) {
      wb.setInput(id, r, 0, String(r + 1));
      wb.setInput(id, r, 1, `=A${r + 1}*10`);
      wb.applyStyle(id, { r1: r, c1: 0, r2: r, c2: 0 }, { italic: true });
    }
    view.goTo('Sheet1!A4');
    await vi.advanceTimersByTimeAsync(1);
    key(viewport, '7');
    key(view.el.querySelector('.grid-editor'), 'Enter');
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 3, 1)).toBe(70);
    expect(wb.getCell(id, 3, 0).s?.italic).toBe(true);
    wb.undo();
    expect(wb.getValue(id, 3, 0)).toBeNull();
    expect(wb.getValue(id, 3, 1)).toBeNull();
  });
});

describe('new workbooks', () => {
  it('start with the font, sheets, view and calculation the options give', () => {
    const doc = Doc.blank({ excel: true, start: { fontName: 'Arial', fontSize: 12, newSheets: 3, newView: 'pageBreak', showHeaders: false, newCalcMode: 'manual' } });
    const { wb } = doc;
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3']);
    expect(wb.normalFont).toMatchObject({ name: 'Arial', sz: 12 });
    expect(wb.sheets.every((s) => s.viewMode === 'pageBreak' && s.headers === false)).toBe(true);
    expect(wb.calcMode).toBe('manual');
    const plain = Doc.blank({ excel: true });
    expect(plain.wb.normalFont).toMatchObject({ name: 'Calibri', sz: 11 });
    expect(plain.wb.sheets).toHaveLength(1);
  });
});
