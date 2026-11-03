// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, MAX_FORMULA_LENGTH } from '../src/core/workbook.js';

// A typed formula Excel refuses (=ROUND(A1), =ABS(1,2), functions nested 70 deep, SUM of 300 arguments, one
// past 8,192 characters) became the text typed when entered, without a word: the user saw "=ROUND(A1)" in the
// cell and nothing said why. Excel says what is wrong ("You've entered too few arguments for this function")
// and keeps the cell in Edit mode to put it right. The entry now stays open, the notice names the problem and
// the function, a screen reader hears it, and the caret lands on the call at fault.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

async function setup(fill) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  fill?.(wb, id);
  const invalid = [], announced = [], arrayRefusals = [];
  wb.addEventListener('change', (e) => { if (e.detail?.type === 'array-edit') arrayRefusals.push(e.detail.reason); });
  const grid = createGrid({ wb, sheetId: id, announce: (t) => announced.push(t), onInvalid: (v) => invalid.push(v.message) });
  document.body.replaceChildren(grid.el);
  await flush();
  const editor = grid.el.querySelector('.grid-editor');
  const type = (text) => {
    grid.beginEdit({ text: '', mode: 'type' });
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k, mods = {}) => editor.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  const selected = () => editor.value.slice(editor.selectionStart, editor.selectionEnd);
  return { wb, id, grid, editor, invalid, announced, arrayRefusals, type, key, selected };
}

describe('a typed formula Excel refuses', () => {
  it('stays open on Enter, says which function needs more arguments, and puts the caret where one goes', async () => {
    const { wb, id, grid, editor, invalid, announced, type, key } = await setup();
    try {
      type('=ROUND(A1)');
      key('Enter');
      expect(grid.editing).toBe(true);
      expect(wb.getCell(id, 0, 0)).toBeFalsy();
      expect(grid.selection.active).toEqual({ r: 0, c: 0 });
      expect(invalid).toEqual(['ROUND needs 2 arguments']);
      expect(announced.at(-1)).toBe('ROUND needs 2 arguments. Your entry is still being edited.');
      expect(document.activeElement).toBe(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([9, 9]); // before the closing parenthesis
      // Put right, it goes in.
      editor.value = '=ROUND(A1,2)';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      key('Enter');
      expect(grid.editing).toBe(false);
      expect(wb.getCell(id, 0, 0).f).toBe('ROUND(A1,2)');
    } finally { grid.destroy(); }
  });

  it('selects the arguments too many on Tab, for Delete to take them out', async () => {
    const { wb, id, grid, invalid, type, key, selected } = await setup();
    try {
      type('=1+abs(-1,2,3)');
      key('Tab');
      expect(grid.editing).toBe(true);
      expect(wb.getCell(id, 0, 0)).toBeFalsy();
      expect(invalid).toEqual(['ABS takes only 1 argument']);
      expect(selected()).toBe(',2,3');
    } finally { grid.destroy(); }
  });

  it('names each kind of limit', async () => {
    const { grid, invalid, type, key, selected } = await setup();
    try {
      type('=NOW(1)'); key('Enter');
      expect(invalid.at(-1)).toBe('NOW takes no arguments');
      expect(selected()).toBe('1');
      grid.cancelEdit();
      type('=TEXTJOIN(",")'); key('Enter');
      expect(invalid.at(-1)).toBe('TEXTJOIN needs at least 3 arguments');
      grid.cancelEdit();
      type('=IF(1,2,3,4)'); key('Enter');
      expect(invalid.at(-1)).toBe('IF takes at most 3 arguments');
      expect(selected()).toBe(',4');
      grid.cancelEdit();
      type(`=${'ABS('.repeat(70)}-1${')'.repeat(70)}`); key('Enter');
      expect(invalid.at(-1)).toBe('Functions can be nested at most 64 levels deep');
      expect(selected()).toBe('ABS');
      grid.cancelEdit();
      type(`=SUM(${Array(300).fill(1).join(',')})`); key('Enter');
      expect(invalid.at(-1)).toBe('SUM can take at most 255 arguments');
      grid.cancelEdit();
      const long = `="${'x'.repeat(MAX_FORMULA_LENGTH)}"`;
      type(long); key('Enter');
      expect(invalid.at(-1)).toBe('A formula can be at most 8,192 characters long; this one has 8,194');
      grid.cancelEdit();
      type(`=${'('.repeat(300)}1${')'.repeat(300)}`); key('Enter');
      expect(invalid.at(-1)).toBe('Parentheses can be nested at most 256 levels deep');
      expect(grid.editing).toBe(true);
    } finally { grid.destroy(); }
  });

  it('is given up with Escape, the cell as it was', async () => {
    const { wb, id, grid, type, key } = await setup((w, i) => w.setInput(i, 0, 0, 'kept'));
    try {
      type('=ABS(1,2)');
      key('Enter');
      expect(grid.editing).toBe(true);
      key('Escape');
      expect(grid.editing).toBe(false);
      expect(wb.getValue(id, 0, 0)).toBe('kept');
    } finally { grid.destroy(); }
  });

  it('stays open on Ctrl+Enter over a selection, writing no cell', async () => {
    const { wb, id, grid, invalid, type, key } = await setup();
    try {
      grid.selectByName('A1:B2');
      type('=ROUND(C1)');
      key('Enter', { ctrlKey: true });
      expect(grid.editing).toBe(true);
      for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) expect(wb.getCell(id, r, c)).toBeFalsy();
      expect(invalid).toEqual(['ROUND needs 2 arguments']);
    } finally { grid.destroy(); }
  });

  it('stays open as an array entry with the same specific notice', async () => {
    const { wb, id, grid, invalid, arrayRefusals, type, key } = await setup();
    try {
      grid.selectByName('A1:A2');
      type('=ABS({1;2},3)');
      key('Enter', { ctrlKey: true, shiftKey: true });
      expect(grid.editing).toBe(true);
      expect(wb.getCell(id, 0, 0)).toBeFalsy();
      expect(invalid).toEqual(['ABS takes only 1 argument']);
      expect(arrayRefusals).toEqual([]);
    } finally { grid.destroy(); }
  });

  it('stays open when a click on another cell would enter it', async () => {
    const { wb, id, grid, invalid, type } = await setup();
    try {
      type('=ROUND(1.5)');
      expect(grid.commitEdit()).toBe(false);
      expect(grid.editing).toBe(true);
      expect(wb.getCell(id, 0, 0)).toBeFalsy();
      expect(invalid).toEqual(['ROUND needs 2 arguments']);
    } finally { grid.destroy(); }
  });

  it('puts the caret in the formula bar when the entry was typed there', async () => {
    const { grid, invalid, editor } = await setup();
    const bar = document.createElement('textarea');
    document.body.append(bar);
    grid.setFormulaInput(bar);
    try {
      grid.beginEdit({ text: '', mode: 'inplace', focusEditor: false });
      bar.focus();
      bar.value = '=ABS(1,2)';
      grid.setEditText(bar.value);
      grid.handleEditKey(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      expect(grid.editing).toBe(true);
      expect(invalid).toEqual(['ABS takes only 1 argument']);
      expect(document.activeElement).toBe(bar);
      expect(bar.value.slice(bar.selectionStart, bar.selectionEnd)).toBe(',2');
      expect(editor.selectionStart).toBe(editor.selectionEnd);
    } finally { grid.destroy(); }
  });

  it('lets an unchanged formula read from a file be entered again as it is', async () => {
    const { wb, id, grid, invalid, key } = await setup((w, i) => w.setCells(i, [{ r: 0, c: 0, cell: { v: null, f: 'ROUND(1.5)' } }]));
    try {
      grid.beginEdit({ mode: 'inplace' });
      key('Enter');
      expect(grid.editing).toBe(false);
      expect(invalid).toEqual([]);
      expect(wb.getCell(id, 0, 0).f).toBe('ROUND(1.5)');
    } finally { grid.destroy(); }
  });

  it('still enters a formula Excel takes, and text that only looks like one', async () => {
    const { wb, id, grid, invalid, type, key } = await setup();
    try {
      type('=ROUND(1.5,)'); key('Enter');
      expect(wb.getValue(id, 0, 0)).toBe(2);
      type("'=ABS(1,2)"); key('Enter');
      expect(wb.getValue(id, 1, 0)).toBe('=ABS(1,2)');
      expect(invalid).toEqual([]);
    } finally { grid.destroy(); }
  });
});
