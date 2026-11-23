// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';

// Tab and Shift+Tab between table cells only select another cell: they should cost what a caret move
// costs, not lay the document out again, while every other effect stays what the edit command gave.
let measured = 0;
beforeEach(() => {
  measured = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto',
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => { measured++; return { width: [...text].length * 8 }; },
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, strokeRect() {}, translate() {}, scale() {}, rotate() {},
  });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function tableEditor(rows = 40, columns = 3) {
  const host = document.createElement('div'); document.body.append(host);
  const calls = { change: 0, selection: 0, errors: [] };
  const editor = new CanvasEditor(host, { paragraphs: [paragraph('Before the table'), paragraph('After the table')],
    onChange: () => calls.change++, onSelection: () => calls.selection++, onError: e => calls.errors.push(e) });
  editor.model.select('Before the table'.length); expect(editor.insertTable(rows, columns)).toBe(true);
  // Text in each row, so the table runs over several pages.
  editor.model.tables[0].rows.forEach((row, r) => { editor.model.selectCell(row.cells[r % columns].id); editor.execute(() => editor.model.replace(`Row ${r} text `.repeat(12))); });
  editor.model.selectCell(editor.model.tables[0].rows[1].cells[1].id); editor.syncInput();
  Object.assign(calls, { change: 0, selection: 0 });
  return { editor, calls };
}
const press = (editor, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
  editor.input.dispatchEvent(event);
  return event.defaultPrevented;
};
const state = (editor, calls) => ({
  selection: { ...editor.model.selection }, text: editor.model.text, revision: editor.session.revision,
  history: editor.session.history.length, future: editor.session.future.length,
  affinity: editor.caretAffinity, page: editor.caretPage, preferredX: editor.preferredX,
  // The caret's cell by its place in the table (each editor's cells have their own ids).
  cell: (() => { const context = editor.model.tableContext; if (!context) return null; const row = context.table.rows.findIndex(r => r.cells.some(c => c.id === context.cell.id)); return [row, context.table.rows[row].cells.findIndex(c => c.id === context.cell.id)]; })(),
  scrollTop: editor.host.scrollTop, label: editor.input.getAttribute('aria-label'), input: [editor.input.value.length, editor.input.selectionStart, editor.input.selectionEnd],
  change: calls.change, selectionCalls: calls.selection, errors: calls.errors.length,
});

it('moves between cells with Tab and Shift+Tab as the edit command did, without laying the document out again', () => {
  const tested = tableEditor(), reference = tableEditor();
  expect(tested.editor.layout.pageCount).toBeGreaterThan(1);
  const relayout = vi.spyOn(tested.editor, 'relayout'), computeLayout = vi.spyOn(tested.editor, 'computeLayout'), layout = tested.editor.layout, history = [...tested.editor.session.history];
  const moves = [false, false, false, false, true, true, false, true, true, true, true, true, true, true, true];
  for (const shiftKey of moves) {
    measured = 0;
    expect(press(tested.editor, shiftKey)).toBe(true);
    expect(measured).toBe(0);
    // What Tab did before: the cell move as an edit command.
    reference.editor.execute(() => reference.editor.model.moveCell(shiftKey ? -1 : 1));
    expect(state(tested.editor, tested.calls)).toEqual(state(reference.editor, reference.calls));
  }
  expect(relayout).not.toHaveBeenCalled(); expect(computeLayout).not.toHaveBeenCalled(); expect(tested.editor.layout).toBe(layout);
  expect(tested.editor.session.history).toEqual(history); expect(tested.calls.change).toBe(0);
  // Shift+Tab in the first cell leaves the table for the paragraph before it, as before.
  expect(state(tested.editor, tested.calls).cell).toBe(null);
  // An undo after moving takes back the last edit, not a move.
  tested.editor.undo(); reference.editor.undo();
  expect(state(tested.editor, tested.calls)).toEqual(state(reference.editor, reference.calls));
});

it('adds a row with Tab in the last cell, one step to undo and redo', () => {
  const { editor, calls } = tableEditor(3, 2), table = editor.model.tables[0];
  editor.model.selectCell(table.rows.at(-1).cells.at(-1).id); editor.syncInput();
  const before = editor.model.snapshot(), history = editor.session.history.length, layout = editor.layout;
  expect(press(editor)).toBe(true);
  expect(table.rows).toHaveLength(4); expect(editor.session.history).toHaveLength(history + 1); expect(calls.change).toBe(1);
  expect(editor.model.tableContext.cell.id).toBe(table.rows[3].cells[0].id); expect(editor.layout).not.toBe(layout);
  expect(editor.layout.cells.some(c => c.id === table.rows[3].cells[0].id)).toBe(true);
  editor.undo(); expect(editor.model.snapshot()).toEqual(before); expect(editor.model.tables[0].rows).toHaveLength(3);
  editor.redo(); expect(editor.model.tables[0].rows).toHaveLength(4); expect(editor.model.tableContext.cell.id).toBe(editor.model.tables[0].rows[3].cells[0].id);
  expect(calls.errors).toHaveLength(0);
});

it('types a tab character in a cell with Option+Tab (Alt+Tab), keeping the caret in the document', () => {
  const { editor, calls } = tableEditor(2, 2), table = editor.model.tables[0];
  editor.model.selectCell(table.rows[0].cells[1].id); editor.syncInput();
  const cell = editor.model.tableContext.cell.id, history = editor.session.history.length;
  const event = new KeyboardEvent('keydown', { key: 'Tab', altKey: true, cancelable: true });
  editor.input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(editor.model.tableContext.cell.id).toBe(cell);
  expect(editor.model.paragraphs.find(p => p.cellId === cell).runs.map(r => r.text).join('')).toMatch(/^\t/);
  expect(editor.session.history).toHaveLength(history + 1);
  editor.undo(); expect(editor.model.paragraphs.find(p => p.cellId === cell).runs.map(r => r.text).join('')).not.toMatch(/\t/);
  expect(calls.errors).toHaveLength(0);
});

it('keeps a block of cells in the first row of a table that starts the document when Shift+Up has nowhere to go', () => {
  const host = document.createElement('div'); document.body.append(host);
  const editor = new CanvasEditor(host, { paragraphs: [paragraph('')] });
  editor.model.select(0); expect(editor.insertTable(3, 3)).toBe(true);
  const table = editor.model.tables[0];
  expect(editor.model.paragraphs[0].cellId).toBe(table.rows[0].cells[0].id);
  editor.model.setCellBlock({ tableId: table.id, top: 0, bottom: 0, left: 1, right: 3 }); editor.syncInput();
  const event = new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, cancelable: true });
  editor.input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const block = editor.model.activeCellBlock;
  expect(block && [block.top, block.bottom, block.left, block.right]).toEqual([0, 0, 1, 3]);
});
