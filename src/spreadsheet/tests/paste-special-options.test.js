// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

// The Paste Special dialog as composable options: every combination of what to paste, an
// operation, Skip blanks and Transpose is written once and undone in one step.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };

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

async function mount(prep) {
  const doc = new Doc({ name: 'Special', path: 'Spreadsheets/Special.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  prep?.(wb, id);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  let copied = {};
  const ev = (type, data = {}) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t) => data[t] ?? '', setData: (t, v) => { copied[t] = v; }, files: [] } });
    return e;
  };
  const at = async (a) => { view.goTo(`Sheet1!${a}`); await vi.advanceTimersByTimeAsync(1); };
  const copy = async (a) => { copied = {}; await at(a); viewport.dispatchEvent(ev('copy')); await vi.advanceTimersByTimeAsync(1); return copied; };
  const clipboardOf = (data) => vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: Object.keys(data), getType: async (t) => ({ text: async () => data[t] }) }] } });
  /** Ctrl+Alt+V at `a`: the Paste Special dialog over the clipboard (what was copied, unless `data` says otherwise). */
  const openDialog = async (a, data = copied) => {
    clipboardOf(data);
    await at(a);
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', altKey: true, bubbles: true, cancelable: true, ...mod }));
    await vi.advanceTimersByTimeAsync(5);
    return [...document.querySelectorAll('.modal-root:not(.closing) form.paste-special')].at(-1);
  };
  const choose = async (form, { what = 'all', operation = 'none', skipBlanks = false, transpose = false } = {}) => {
    form.querySelector(`input[type="radio"][value="${what}"]`).click();
    form.querySelector(`input[type="radio"][value="${operation}"]`).click();
    const [skip, flip] = form.querySelectorAll('.paste-special-checks input');
    if (skip.checked !== skipBlanks) skip.click();
    if (flip.checked !== transpose) flip.click();
    form.requestSubmit();
    await vi.advanceTimersByTimeAsync(5);
  };
  const special = async (from, to, options) => { await copy(from); await choose(await openDialog(to), options); };
  return { wb, id, viewport, at, copy, openDialog, choose, special, clipboardOf, copied: () => copied };
}

const steps = (wb) => wb.undoLabels(50).length;

describe('the Paste Special dialog', () => {
  it('opens on Ctrl+Alt+V with every choice offered, All and None chosen', async () => {
    const { copy, openDialog } = await mount((wb, id) => wb.setInput(id, 0, 0, '1'));
    await copy('A1');
    const form = await openDialog('C1');
    expect(form).toBeTruthy();
    expect(form.closest('[role="dialog"]').getAttribute('aria-label')).toBe('Paste Special');
    const labels = [...form.querySelectorAll('label.check span')].map((s) => s.textContent);
    expect(labels).toEqual(['Everything', 'Everything, with the source theme', 'Formulas', 'Everything but borders', 'Values', 'Column widths', 'Formats', 'Formulas with number formats',
      'Comments and notes', 'Values with number formats', 'Data validation rules', 'Everything, merging conditional formats', 'None', 'Add', 'Subtract', 'Multiply', 'Divide', 'Skip blanks', 'Transpose']);
    expect(form.querySelector('input[value="all"]').checked).toBe(true);
    expect(form.querySelector('input[value="none"]').checked).toBe(true);
    expect([...form.querySelectorAll('input')].every((i) => !i.disabled)).toBe(true);
    expect([...form.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Paste Link', 'Cancel', 'OK']);
  });

  it('greys what another app\'s content cannot carry', async () => {
    const { openDialog } = await mount();
    const form = await openDialog('A1', { 'text/plain': '1\t2' });
    const enabled = [...form.querySelectorAll('input[type="radio"]')].filter((i) => !i.disabled).map((i) => i.value);
    expect(enabled).toEqual(['all', 'formulas', 'values', 'formats', 'none', 'add', 'sub', 'mul', 'div']);
    expect([...form.querySelectorAll('button')].find((b) => b.textContent === 'Paste Link').disabled).toBe(true);
  });

  it('chooses by the underlined letters, and rules out operations for Formats', async () => {
    const { copy, openDialog } = await mount((wb, id) => wb.setInput(id, 0, 0, '1'));
    await copy('A1');
    const form = await openDialog('C1');
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
    expect(form.querySelector('input[value="values"]').checked).toBe(true);
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(form.querySelector('input[value="mul"]').checked).toBe(true);
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(form.querySelectorAll('.paste-special-checks input')[1].checked).toBe(true);
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    expect(form.querySelector('input[value="formats"]').checked).toBe(true);
    expect(form.querySelector('input[value="none"]').checked).toBe(true);
    expect(form.querySelector('input[value="mul"]').disabled).toBe(true);
  });

  it('pastes Values + Transpose: what the cells showed, turned, in the formatting already there', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '1'); wb.setInput(id, 0, 1, '=A1*2'); wb.setInput(id, 1, 0, '3'); wb.setInput(id, 1, 1, 'x');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { bold: true });
      wb.applyStyle(id, { r1: 0, c1: 3, r2: 0, c2: 3 }, { italic: true });
    });
    await special('A1:B2', 'D1', { what: 'values', transpose: true });
    expect([wb.getValue(id, 0, 3), wb.getValue(id, 0, 4), wb.getValue(id, 1, 3), wb.getValue(id, 1, 4)]).toEqual([1, 3, 2, 'x']);
    expect(wb.getCell(id, 1, 3).f).toBe(null);
    expect(wb.styleAt(id, 0, 3)?.bold).toBeFalsy();
    expect(wb.styleAt(id, 0, 3).italic).toBe(true);
    expect(steps(wb)).toBe(1);
    wb.undo();
    expect([wb.getValue(id, 0, 3), wb.getValue(id, 1, 4)]).toEqual([null, null]);
  });

  it('pastes Values + Multiply over numbers, formulas, blanks and text', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '5'); wb.setInput(id, 2, 0, 'x'); wb.setInput(id, 3, 0, '=2*3'); wb.setInput(id, 4, 0, '4');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 4, c2: 0 }, { italic: true });
      wb.setInput(id, 0, 2, '10'); wb.setInput(id, 1, 2, '10'); wb.setInput(id, 2, 2, '10'); wb.setInput(id, 3, 2, '=1+1'); wb.setInput(id, 4, 2, 't');
      wb.applyStyle(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, { fmt: 'number', dec: 2 });
    });
    await special('A1:A5', 'C1', { what: 'values', operation: 'mul' });
    expect([0, 1, 2, 4].map((r) => wb.getValue(id, r, 2))).toEqual([50, 0, 10, 't']);
    expect(wb.getCell(id, 3, 2).f).toBe('(1+1)*6');
    expect(wb.getValue(id, 3, 2)).toBe(12);
    expect(wb.styleAt(id, 0, 2)).toMatchObject({ fmt: 'number', dec: 2 });
    expect(wb.styleAt(id, 0, 2)?.italic).toBeFalsy();
    expect(steps(wb)).toBe(1);
    wb.undo();
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 2))).toEqual([10, 10, 10]);
    expect(wb.getCell(id, 3, 2).f).toBe('1+1');
  });

  it('pastes All + Add with the copied formatting and combined formulas', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '5'); wb.setInput(id, 1, 0, '=2*3');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
      wb.setInput(id, 0, 2, '10'); wb.setInput(id, 1, 2, '=1+1');
    });
    await special('A1:A3', 'C1', { what: 'all', operation: 'add' });
    expect(wb.getValue(id, 0, 2)).toBe(15);
    expect(wb.styleAt(id, 0, 2).bold).toBe(true);
    expect(wb.getCell(id, 1, 2).f).toBe('(1+1)+(2*3)');
    expect(wb.getCell(id, 2, 2)).toBeFalsy();
    await special('A1:A3', 'E1', { what: 'all', operation: 'sub' });
    expect(wb.getValue(id, 0, 4)).toBe(-5);
    expect(wb.getCell(id, 1, 4).f).toBe('0-(2*3)');
    await special('A1:A3', 'G1', { what: 'all', operation: 'div' });
    expect(wb.getValue(id, 0, 6)).toBe(0);
    expect(wb.getCell(id, 2, 6)).toBeFalsy(); // blank over blank stays blank
  });

  it('pastes Formats + Skip blanks: a blank copied cell leaves its target\'s formatting alone', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, 'x');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { bold: true });
      wb.applyStyle(id, { r1: 0, c1: 2, r2: 1, c2: 2 }, { italic: true });
      wb.setInput(id, 1, 2, '3');
    });
    await special('A1:A2', 'C1', { what: 'formats', skipBlanks: true });
    expect(wb.styleAt(id, 0, 2).bold).toBe(true);
    expect(wb.styleAt(id, 0, 2)?.italic).toBeFalsy();
    expect(wb.getValue(id, 0, 2)).toBe(null);
    expect(wb.styleAt(id, 1, 2)).toMatchObject({ italic: true });
    expect(wb.styleAt(id, 1, 2)?.bold).toBeFalsy();
    expect(wb.getValue(id, 1, 2)).toBe(3);
    expect(steps(wb)).toBe(1);
  });

  it('pastes Formulas + Transpose with references transposed, keeping the formatting here', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '5'); wb.setInput(id, 1, 0, '=A1+1'); wb.setInput(id, 1, 1, '=$A$1+A1'); wb.setInput(id, 0, 1, '=H2');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { bold: true });
      wb.applyStyle(id, { r1: 4, c1: 3, r2: 5, c2: 4 }, { bg: '#ffff00' });
    });
    await special('A1:B2', 'D5', { what: 'formulas', transpose: true });
    expect(wb.getValue(id, 4, 3)).toBe(5);
    expect(wb.getCell(id, 4, 4).f).toBe('D5+1');
    expect(wb.getCell(id, 5, 4).f).toBe('$D$5+D5');
    expect(wb.getCell(id, 5, 3).f).toBe('E12');
    expect(wb.styleAt(id, 4, 4)).toMatchObject({ bg: '#ffff00' });
    expect(wb.styleAt(id, 4, 4)?.bold).toBeFalsy();
    expect(steps(wb)).toBe(1);
  });

  it('pastes Column widths alone', async () => {
    const { wb, id, special } = await mount((wb, id) => { wb.setInput(id, 0, 0, '1'); wb.setColWidth(id, 0, 180); wb.setColWidth(id, 1, 40); });
    await special('A1:B1', 'D3', { what: 'widths' });
    expect([wb.colWidth(id, 3), wb.colWidth(id, 4)]).toEqual([180, 40]);
    expect(wb.getValue(id, 2, 3)).toBe(null);
    expect(steps(wb)).toBe(1);
  });

  it('pastes Values + Skip blanks + Transpose, Values and number formats, and Formulas and number formats', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '0.5'); wb.setInput(id, 2, 0, '=A1*2');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 2, c2: 0 }, { fmt: 'percent', dec: 0, bold: true });
      for (let c = 2; c <= 4; c++) wb.setInput(id, 5, c, 'old');
      wb.applyStyle(id, { r1: 10, c1: 2, r2: 12, c2: 3 }, { italic: true, fmt: 'currency' });
    });
    await special('A1:A3', 'C6', { what: 'values', skipBlanks: true, transpose: true });
    expect([2, 3, 4].map((c) => wb.getValue(id, 5, c))).toEqual([0.5, 'old', 1]);
    await special('A1:A3', 'C11', { what: 'valuesNumFmt' });
    expect(wb.styleAt(id, 10, 2)).toMatchObject({ fmt: 'percent', dec: 0, italic: true });
    expect(wb.styleAt(id, 10, 2)?.bold).toBeFalsy();
    expect(wb.getCell(id, 12, 2).f).toBe(null);
    expect(wb.getValue(id, 12, 2)).toBe(1);
    await special('A1:A3', 'D11', { what: 'formulasNumFmt' });
    expect(wb.getCell(id, 12, 3).f).toBe('D11*2');
    expect(wb.styleAt(id, 12, 3)).toMatchObject({ fmt: 'percent', italic: true });
    expect(wb.getDisplay(id, 12, 3)).toBe('100%');
  });

  it('pastes everything but borders, comments and notes, and data validation rules each alone', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '7');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true, bt: true, bb: true, bl: true, br: true });
      wb.setNote(id, 0, 0, 'Check');
      wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: ['a', 'b'], strict: true });
      wb.setInput(id, 0, 3, 'here');
    });
    await special('A1', 'C1', { what: 'noBorders' });
    expect(wb.getValue(id, 0, 2)).toBe(7);
    expect(wb.styleAt(id, 0, 2).bold).toBe(true);
    expect(wb.styleAt(id, 0, 2)?.bt).toBeFalsy();
    await special('A1', 'D1', { what: 'comments' });
    expect(wb.getNote(id, 0, 3)).toBe('Check');
    expect(wb.getValue(id, 0, 3)).toBe('here');
    expect(wb.validationAt(id, 0, 3)).toBeFalsy();
    await special('A1', 'E1', { what: 'validation' });
    expect(wb.validationAt(id, 0, 4)).toMatchObject({ type: 'list' });
    expect(wb.getValue(id, 0, 4)).toBe(null);
    expect(wb.getNote(id, 0, 4)).toBe(null);
    wb.undo();
    expect(wb.validationAt(id, 0, 4)).toBeFalsy();
  });

  it('pastes everything merging conditional formats, keeping the rules already here', async () => {
    const { wb, id, special } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '7');
      wb.addRule(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'notEmpty', style: { bold: true } });
      wb.addRule(id, { range: { r1: 0, c1: 2, r2: 0, c2: 2 }, type: 'empty', style: { italic: true } });
    });
    const before = wb.sheet(id).rules.length;
    await special('A1', 'C1', { what: 'allMergeCF' });
    const rules = wb.sheet(id).rules.filter((r) => r.range.c1 === 2);
    expect(rules.map((r) => r.type).sort()).toEqual(['empty', 'notEmpty']);
    expect(wb.sheet(id).rules.length).toBe(before + 1);
    expect(steps(wb)).toBe(1);
  });

  it('pastes links with the Paste Link button', async () => {
    const { wb, id, copy, openDialog } = await mount((wb, id) => wb.setInput(id, 0, 0, '9'));
    await copy('A1');
    const form = await openDialog('C3');
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'Paste Link').click();
    await vi.advanceTimersByTimeAsync(5);
    expect(wb.getCell(id, 2, 2).f).toBe('A1');
    expect(wb.getValue(id, 2, 2)).toBe(9);
  });

  it('combines another app\'s text with Values + Transpose', async () => {
    const { wb, id, openDialog, choose } = await mount();
    await choose(await openDialog('B2', { 'text/plain': '1\t2\n3\t4' }), { what: 'values', transpose: true });
    expect([[1, 1], [1, 2], [2, 1], [2, 2]].map(([r, c]) => wb.getValue(id, r, c))).toEqual([1, 3, 2, 4]);
    expect(steps(wb)).toBe(1);
  });
});

describe('the Paste gallery and the Paste Options button', () => {
  const ribbonButton = (label) => [...view.el.querySelectorAll(`button[aria-label="${label}"]`)].find((b) => !b.closest('[hidden]'));
  const menuItem = (label) => [...document.querySelectorAll('.menu [role^="menuitem"]')].find((b) => b.querySelector('.menu-label')?.firstChild?.textContent === label);

  it('offers a gallery under Home ▸ Paste and pastes Values & Number Formatting from it', async () => {
    const { wb, id, copy, clipboardOf, at, copied } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '=0.25*2');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'percent', bold: true });
    });
    await copy('A1');
    clipboardOf(copied());
    await at('C1');
    ribbonButton('Paste options').click();
    await vi.advanceTimersByTimeAsync(5);
    const labels = [...document.querySelectorAll('.menu [role^="menuitem"] .menu-label')].map((n) => n.firstChild?.textContent);
    expect(labels).toEqual(['Paste', 'Formulas', 'Formulas & Number Formatting', 'Keep Source Formatting', 'No Borders', 'Keep Source Column Widths', 'Transpose',
      'Values', 'Values & Number Formatting', 'Values & Source Formatting', 'Formatting', 'Paste Link', 'Picture', 'Linked Picture', 'Paste Special…']);
    menuItem('Values & Number Formatting').click();
    await vi.advanceTimersByTimeAsync(5);
    expect(wb.getCell(id, 0, 2)).toMatchObject({ v: 0.5, f: null });
    expect(wb.styleAt(id, 0, 2).fmt).toBe('percent');
    expect(wb.styleAt(id, 0, 2)?.bold).toBeFalsy();
  });

  it('shows the Paste Options button after a paste, re-pastes another way as one step, and goes on the next edit', async () => {
    const { wb, id, viewport, copy, at, copied } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, '=1+1');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    });
    const data = await copy('A1');
    await at('C1');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (t) => data[t] ?? '', files: [] } });
    viewport.dispatchEvent(paste);
    await vi.advanceTimersByTimeAsync(5);
    const button = view.el.querySelector('.option-button');
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Paste Options (Ctrl)');
    expect(wb.getCell(id, 0, 2).f).toBe('1+1');
    // Ctrl pressed and released alone opens the choices.
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    viewport.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    await vi.advanceTimersByTimeAsync(5);
    expect(menuItem('Values')).toBeTruthy();
    expect(menuItem('Paste').getAttribute('aria-checked')).toBe('true');
    menuItem('Values').click();
    await vi.advanceTimersByTimeAsync(5);
    expect(wb.getCell(id, 0, 2)).toMatchObject({ v: 2, f: null });
    expect(wb.styleAt(id, 0, 2)?.bold).toBeFalsy();
    expect(steps(wb)).toBe(1); // the first paste was undone, not kept under the second
    expect(button.hidden).toBe(false);
    wb.undo();
    expect(wb.getCell(id, 0, 2)).toBeFalsy();
    expect(button.hidden).toBe(true);
    void copied;
  });

  it('hides the Paste Options button on Escape', async () => {
    const { viewport, copy, at } = await mount((wb, id) => wb.setInput(id, 0, 0, '1'));
    const data = await copy('A1');
    await at('C1');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (t) => data[t] ?? '', files: [] } });
    viewport.dispatchEvent(paste);
    await vi.advanceTimersByTimeAsync(5);
    const button = view.el.querySelector('.option-button');
    expect(button.hidden).toBe(false);
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(5);
    expect(button.hidden).toBe(true);
  });
});

describe('Insert Copied Cells', () => {
  it('is offered in the cell menu after a copy and inserts through the Insert Paste dialog', async () => {
    const { wb, id, copy, at, clipboardOf, copied } = await mount((wb, id) => {
      wb.setInput(id, 0, 0, 'new'); wb.setInput(id, 0, 2, 'old'); wb.setInput(id, 1, 2, 'below');
    });
    await copy('A1');
    clipboardOf(copied());
    await at('C1');
    const cell = view.el.querySelector('.cell[data-r="0"][data-c="2"]') || view.el.querySelector('.grid-viewport');
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 250, clientY: 10, button: 2 }));
    await vi.advanceTimersByTimeAsync(5);
    const item = [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Insert Copied Cells…');
    expect(item).toBeTruthy();
    view.goTo('Sheet1!C1');
    await vi.advanceTimersByTimeAsync(1);
    item.click();
    await vi.advanceTimersByTimeAsync(5);
    const dialog = document.querySelector('[role="dialog"][aria-label="Insert Paste"]');
    expect([...dialog.querySelectorAll('label.check span')].map((s) => s.textContent)).toEqual(['Shift cells right', 'Shift cells down']);
    dialog.querySelector('input[value="down"]').click();
    dialog.querySelector('form').requestSubmit();
    await vi.advanceTimersByTimeAsync(10);
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 2))).toEqual(['new', 'old', 'below']);
    wb.undo();
    expect([0, 1].map((r) => wb.getValue(id, r, 2))).toEqual(['old', 'below']);
  });
});
