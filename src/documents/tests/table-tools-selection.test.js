import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { tableCells } from '../src/engine/tables.js';

// Count the toolbar's own questions about the selection; the engine's commands use their own binding.
vi.mock('../src/engine/table-editing.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, selectionBlock: vi.fn(actual.selectionBlock) };
});
const T = await import('../src/engine/table-editing.js');
const { createTableTools } = await import('../src/views/table-tools.js');

let dom;
beforeAll(() => {
  dom = new JSDOM();
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement });
});
afterAll(() => { for (const key of ['document', 'Node', 'HTMLElement']) delete globalThis[key]; dom.window.close(); });

function tools() {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  model.select(0); model.insertTable(3, 3, 9000);
  const cells = tableCells(model.tables[0]);
  cells.forEach((cell, i) => { model.selectCell(cell.id); model.replace(`c${i}`); });
  const engine = { model, execute: fn => fn() !== false, finishComposition() {}, focus() {} };
  return { model, cells, table: createTableTools({ editor: () => engine, pkg: () => pkg }) };
}
const item = (items, label) => items.find(i => i.label === label);
const checkedAlignment = items => item(items, 'Cell Alignment').items.find(i => i.checked)?.label || null;

describe('table toolbar state', () => {
  it('works out the selection block once per document state, and again after each change', () => {
    const { model, cells, table } = tools();
    model.selectCell(cells[4].id);
    T.selectionBlock.mockClear();
    const menu = table.extendMenu('table'), context = table.contextMenuItems('table');
    expect(T.selectionBlock).toHaveBeenCalledTimes(1);
    expect(item(menu, 'Merge Cells').disabled).toBe(true);
    expect(item(context, 'Merge Cells').disabled).toBe(true);
    expect(checkedAlignment(context)).toBe('Align Top Left');

    // A new selection is a new question.
    model.setCellBlock({ tableId: model.tables[0].id, top: 1, bottom: 1, left: 1, right: 3 });
    expect(item(table.extendMenu('table'), 'Merge Cells').disabled).toBe(false);
    expect(T.selectionBlock).toHaveBeenCalledTimes(2);

    // So is a change to the document under the same selection: the cells' alignment, then their structure.
    model.setParagraphFormat({ alignment: 'center' });
    expect(checkedAlignment(table.contextMenuItems('table'))).toBe('Align Top Center');
    expect(T.selectionBlock).toHaveBeenCalledTimes(3);
    T.mergeBlock(model);
    expect(item(table.extendMenu('table'), 'Merge Cells').disabled).toBe(true);
    expect(T.selectionBlock).toHaveBeenCalledTimes(4);

    // Leaving the table leaves the toolbar without a block.
    model.select(model.text.length);
    expect(table.contextMenuItems('table')).toEqual([]);
    expect(item(table.extendMenu('table'), 'Merge Cells').disabled).toBe(true);
  });
});
