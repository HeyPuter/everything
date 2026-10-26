import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { tableCells } from '../src/engine/tables.js';
import { changeCase } from '../src/engine/home-editing.js';
import { listKind, listMarkers } from '../src/engine/numbering.js';
import { applyListLibrary, applyMultilevelList, BULLET_LIBRARY } from '../src/engine/list-library.js';
import { defineBullet, selectedListLevel } from '../src/engine/list-definitions.js';

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
  return { pkg, doc, select, cell: text => doc.paragraphs.find(p => p.cellId && paragraphText(p).toLowerCase() === text) };
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

it('indents and list levels over a block of cells reach its cells and only them, in one undo step', () => {
  const { doc, select, cell } = blockDocument();
  const indent = t => cell(t).format?.indentLeft ?? 0;
  // Increase Indent outside a list.
  expect(doc.changeListLevel(1)).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2', 'c1'].map(indent)).toEqual([720, 720, 720, 720, 0]);
  select();
  expect(doc.adjustIndent(-720)).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2', 'c1'].map(indent)).toEqual([0, 0, 0, 0, 0]);
  // A selected column's text range covers only its first cell; the command still reaches every cell.
  const table = doc.tables.at(-1);
  doc.setCellBlock({ tableId: table.id, top: 0, bottom: 3, left: 1, right: 2 });
  expect(doc.adjustIndent(360)).toBe(true);
  expect(['b1', 'b2', 'b3', 'a1', 'c1'].map(indent)).toEqual([360, 360, 360, 0, 0]);
  // List levels in a numbered block.
  select();
  expect(doc.toggleList('number')).toBe(true);
  select();
  expect(doc.changeListLevel(1)).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2'].map(t => cell(t).list.level)).toEqual([1, 1, 1, 1]);
  expect(cell('c1').list).toBeFalsy();
  expect(indent('c1')).toBe(0);
});

it('the bullet and numbering libraries and Define New Bullet reach every cell of a block and only those', async () => {
  const { pkg, doc, select, cell } = blockDocument();
  const table = doc.tables.at(-1);
  const marker = t => { const i = doc.paragraphs.indexOf(cell(t)); return listMarkers(doc.paragraphs, doc.numbering)[i]?.text ?? null; };
  // A selected column: its text range covers only the first cell.
  const column = () => doc.setCellBlock({ tableId: table.id, top: 0, bottom: 3, left: 1, right: 2 });
  column();
  const square = BULLET_LIBRARY.findIndex(([, ch]) => ch === '■');
  const before = doc.history.length;
  expect(applyListLibrary(doc, 'bullet', square)).toBe(true);
  expect(['b1', 'b2', 'b3', 'a1', 'c1'].map(marker)).toEqual(['■', '■', '■', null, null]);
  expect(doc.history.length).toBe(before + 1);
  // The column is now one list level: the gallery shows it, and a new marker changes all of it.
  column();
  expect(selectedListLevel(doc)).toBeTruthy();
  expect(defineBullet(doc, { character: '✓' })).toBe(true);
  expect(['b1', 'b2', 'b3', 'a1', 'c1'].map(marker)).toEqual(['✓', '✓', '✓', null, null]);
  // A block dragged from a1 to b2 leaves c1, which its text range runs through, alone.
  select();
  expect(applyListLibrary(doc, 'number', 0)).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2', 'c1'].map(marker)).toEqual(['1.', '2.', '3.', '4.', null]);
  select();
  expect(applyMultilevelList(doc, 1)).toBe(true);
  expect(['a1', 'b1', 'a2', 'b2', 'c1'].map(marker)).toEqual(['1)', '2)', '3)', '4)', null]);
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  const reopenedMarkers = listMarkers(reopened.paragraphs, reopened.numbering);
  const at = t => reopenedMarkers[reopened.paragraphs.findIndex(p => p.cellId && paragraphText(p) === t)]?.text ?? null;
  expect(['a1', 'b1', 'c1', 'a2', 'b2', 'b3'].map(at)).toEqual(['1)', '2)', null, '3)', '4)', '✓']);
});
