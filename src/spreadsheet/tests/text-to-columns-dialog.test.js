// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { splitPieces, suggestBreaks, detectDelimiter } from '../src/core/text-split.js';
import { parseBreaks } from '../src/ui/textcolumnsdialog.js';

// Text to Columns: a dialog with separators or fixed widths, a live preview, a format per column and a
// destination, over the workbook's split.

describe('splitting one text', () => {
  it('cuts on several separators, keeping qualified pieces whole', () => {
    expect(splitPieces('a;b,c', { mode: 'delimited', delimiters: [',', ';'], qualifier: '"' })).toEqual(['a', 'b', 'c']);
    expect(splitPieces('"Austin, TX",12', { mode: 'delimited', delimiters: [','], qualifier: '"' })).toEqual(['Austin, TX', '12']);
    expect(splitPieces("'x,y',z", { mode: 'delimited', delimiters: [','], qualifier: "'" })).toEqual(['x,y', 'z']);
    expect(splitPieces('"say ""hi""",1', { mode: 'delimited', delimiters: [','], qualifier: '"' })).toEqual(['say "hi"', '1']);
    expect(splitPieces('"a,b",c', { mode: 'delimited', delimiters: [','], qualifier: '' })).toEqual(['"a', 'b"', 'c']);
  });
  it('counts repeated separators once when asked, and keeps empty pieces otherwise', () => {
    expect(splitPieces('a,,b', { mode: 'delimited', delimiters: [','] })).toEqual(['a', '', 'b']);
    expect(splitPieces('  a   b  ', { mode: 'delimited', delimiters: [' '], consecutive: true })).toEqual(['a', 'b']);
  });
  it('cuts at fixed positions without trailing empty pieces on short lines', () => {
    expect(splitPieces('A12  Bolts     400', { mode: 'fixed', breaks: [5, 15] })).toEqual(['A12', 'Bolts', '400']);
    expect(splitPieces('B7', { mode: 'fixed', breaks: [5, 15] })).toEqual(['B7']);
    expect(suggestBreaks(['ID   Name      Qty', 'A12  Bolts     400', 'C301 Washers   75'])).toEqual([5, 15]);
    expect(detectDelimiter(['a;b', 'c;d', 'e,f'])).toBe(';');
    expect(parseBreaks('14, 6 6')).toEqual([6, 14]);
    expect(parseBreaks('6, x')).toBeNull();
  });
});

describe('the workbook split with options', () => {
  it('reads each piece as its column says, skips columns and writes at a destination as one step', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '007|Ann|x'); wb.setInput(id, 1, 0, '010|Bo|y');
    wb.clearHistory();
    const out = wb.splitTextToColumns(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { mode: 'delimited', delimiters: ['|'], formats: ['text', 'skip', 'general'], dest: { r: 4, c: 2 } });
    expect(out).toEqual({ rows: 2, cols: 2 });
    expect(wb.getValue(id, 4, 2)).toBe('007'); expect(wb.styleAt(id, 4, 2)?.fmt).toBe('text');
    expect(wb.getValue(id, 4, 3)).toBe('x'); expect(wb.getValue(id, 5, 2)).toBe('010');
    expect(wb.getValue(id, 0, 0)).toBe('007|Ann|x'); // the text itself stays when the pieces go elsewhere
    expect(wb.undoLabels()).toEqual(['Split text']);
    wb.undo(); expect(wb.getValue(id, 4, 2)).toBeNull();
  });
  it('plans a split without writing it', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'a b');
    const plan = wb.splitTextPlan(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { mode: 'fixed', breaks: [2] });
    expect(plan.entries.map(({ r, c }) => [r, c])).toEqual([[0, 0], [0, 1]]);
    expect(wb.getValue(id, 0, 0)).toBe('a b');
  });
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}

describe('the dialog', () => {
  let view;
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
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

  async function mount(cells) {
    const doc = new Doc({ name: 'Split', path: 'Spreadsheets/Split.xlsx' });
    const wb = doc.wb, id = wb.activeSheetId;
    for (const [r, c, text] of cells) wb.setInput(id, r, c, text);
    wb.clearHistory();
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.querySelector('#app').append(view.el);
    await vi.advanceTimersByTimeAsync(1);
    return { wb, id };
  }
  const panel = () => [...document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')].at(-1);
  const field = (label) => panel().querySelector(`[aria-label="${label}"]`);
  const checkbox = (label) => [...panel().querySelectorAll('label.find-option')].find((l) => l.textContent === label).querySelector('input');
  const cells = () => [...panel().querySelectorAll('.ttc-preview tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));

  it('opens from the Data menu on the detected separator and previews the pieces live', async () => {
    const { wb, id } = await mount([[0, 0, 'a;b;c'], [1, 0, 'd;e;f']]);
    view.goTo('Sheet1!A1:A2'); await vi.advanceTimersByTimeAsync(1);
    view.el.querySelector('[data-menu="data"]').click();
    [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === 'Text to Columns…').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(panel().getAttribute('aria-label')).toBe('Text to Columns');
    expect(checkbox('Semicolon').checked).toBe(true);
    expect(cells()).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']]);
    checkbox('Semicolon').click();
    expect(cells()).toEqual([['a;b;c'], ['d;e;f']]);
    checkbox('Semicolon').click();
    field('Column 2 format').value = 'skip'; field('Column 2 format').dispatchEvent(new Event('change'));
    expect(panel().querySelectorAll('.ttc-preview td.skip')).toHaveLength(2);
    expect(wb.toJSON().sheets[0]).toBeDefined(); expect(wb.undoLabels()).toEqual([]); // nothing written while previewing
    panel().querySelector('form').requestSubmit();
    await vi.advanceTimersByTimeAsync(10);
    expect([0, 1].map((c) => wb.getValue(id, 0, c))).toEqual(['a', 'c']);
    expect(wb.undoLabels()).toEqual(['Split text']);
  });

  it('splits at fixed widths into a destination, refusing an unreadable one, and leaves all on Escape', async () => {
    const { wb, id } = await mount([[0, 0, 'ID   Name'], [1, 0, 'A12  Bolts']]);
    view.goTo('Sheet1!A1:A2'); await vi.advanceTimersByTimeAsync(1);
    await view.run('splitTextDialog');
    panel().querySelector('.ttc-mode input[value="fixed"]').click();
    expect(field('Break positions').value).toBe('5');
    expect(cells()).toEqual([['ID', 'Name'], ['A12', 'Bolts']]);
    // A click on the ruler adds a break there.
    panel().querySelector('.ttc-line span[data-pos="2"]').click();
    expect(field('Break positions').value).toBe('2, 5');
    panel().querySelector('.ttc-line span[data-pos="2"]').click();
    field('Destination').value = 'nowhere!';
    panel().querySelector('form').requestSubmit();
    expect(panel().querySelector('.field-error:not([hidden])')?.textContent).toMatch(/cell on this sheet/);
    field('Destination').value = 'D3';
    panel().querySelector('form').requestSubmit();
    await vi.advanceTimersByTimeAsync(10);
    expect([wb.getValue(id, 2, 3), wb.getValue(id, 2, 4), wb.getValue(id, 3, 4)]).toEqual(['ID', 'Name', 'Bolts']);
    expect(wb.getValue(id, 0, 0)).toBe('ID   Name');
    await view.run('splitTextDialog');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(panel()).toBeUndefined();
    expect(wb.undoLabels()).toEqual(['Split text']);
  });
});
