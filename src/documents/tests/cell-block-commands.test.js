import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { tableCells } from '../src/engine/tables.js';
import { changeCase } from '../src/engine/home-editing.js';
import { listKind } from '../src/engine/numbering.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

/** A 3×3 table of "a1 b1 c1 / a2 …" with the block from a1 to b2 selected as a drag selects it: the text range runs from a1 to b2, through c1. */
function blockDocument() {
  const pkg = createDocx([paragraph('Before'), paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(doc.text.length);
  doc.insertTable(3, 3, 9000);
  const table = doc.tables.at(-1);
  tableCells(table).forEach((cell, i) => { doc.selectCell(cell.id); doc.replace(`${'abc'[i % 3]}${Math.floor(i / 3) + 1}`); });
  const select = () => { doc.select(doc.text.indexOf('a1'), doc.text.indexOf('b2') + 2); doc.cellBlock = { tableId: table.id, top: 0, bottom: 1, left: 0, right: 2 }; };
  select();
  return { doc, select, cell: text => doc.paragraphs.find(p => p.cellId && paragraphText(p).toLowerCase() === text) };
}

it('styles, lists, clearing and case changes over a block of cells leave the cells between its corners alone', () => {
  const { doc, select, cell } = blockDocument();
  const heading = Object.values(doc.styles.definitions).find(s => s.type === 'paragraph' && /^heading 1$/i.test(s.name)).id;
  expect(doc.setParagraphStyle(heading)).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2'].map(t => cell(t).styleId)).toEqual([heading, heading, heading, heading]);
  expect(cell('c1').styleId || null).toBe(null);
  expect(doc.range).toEqual([doc.text.indexOf('a1'), doc.text.indexOf('b2') + 2]);

  select();
  expect(doc.toggleList('number')).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2'].map(t => listKind(doc.numbering, cell(t).list))).toEqual(['number', 'number', 'number', 'number']);
  // One list, numbered on through the block's cells.
  expect(new Set(['a1', 'b1', 'a2', 'b2'].map(t => cell(t).list.numId)).size).toBe(1);
  expect(cell('c1').list).toBeFalsy();
  select();
  expect(doc.toggleList('number')).toBe(true);
  expect(['a1', 'b1', 'c1', 'a2', 'b2'].map(t => !!cell(t).list)).toEqual([false, false, false, false, false]);

  // Italic everywhere, then cleared over the block: c1 keeps it.
  doc.select(doc.text.indexOf('a1'), doc.text.indexOf('c3') + 2);
  expect(doc.setRunFormat({ italic: true, italicCs: true })).toBe(true);
  select();
  expect(doc.clearDirectTextFormatting()).toBe(true);
  expect(['a1', 'b1', 'c1', 'a2', 'b2'].map(t => cell(t).runs.some(r => r.italic))).toEqual([false, false, true, false, false]);

  select();
  expect(changeCase(doc, 'cycle')).toBe(true);
  expect(['a1', 'b1', 'c1', 'a2', 'b2'].map(t => paragraphText(cell(t)))).toEqual(['A1', 'B1', 'c1', 'A2', 'B2']);
  select();
  expect(changeCase(doc, 'cycle')).toBe(true);
  expect(['a1', 'b1', 'c1', 'a2', 'b2'].map(t => paragraphText(cell(t)))).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
});
