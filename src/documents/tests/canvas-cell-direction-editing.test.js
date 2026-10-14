import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = name => readFileSync(`tests/fixtures/cell-text-direction/${name}.docx`);
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const directions = table => table.rows.map(row => row.cells.map(cell => cell.textDirection || 'lrTb'));
const sameParts = (bytes, original, changed = []) => {
  const parts = unzipSync(bytes);
  expect(Object.keys(parts).sort()).toEqual(Object.keys(original).sort());
  for (const [name, content] of Object.entries(original)) if (!changed.includes(name)) expect(parts[name], name).toEqual(content);
};

it.each(['btLr', 'tbRl'])('edits and round-trips %s cells, preserving unrelated parts and exact undo', async direction => {
  const p = await DocxPackage.open(source('control')), d = model(p);
  sameParts(await save(p, d), p.parts);
  const cell = d.tables[0].rows[0].cells.find(c => c.textDirection === direction);
  d.selectCell(cell.id); d.replace('Edited rotated text');
  const bytes = await save(p, d), again = await DocxPackage.open(bytes);
  expect(model(again).text).toBe(d.text);
  expect(again.tables.map(directions)).toEqual(d.tables.map(directions));
  sameParts(bytes, p.parts, ['word/document.xml']);
  d.undo(); sameParts(await save(p, d), p.parts);
});

it('retains explicit directions when authoring new cell shells after row insertion', async () => {
  const p = await DocxPackage.open(source('control')), d = model(p);
  d.selectCell(d.tables[0].rows[0].cells[1].id); d.insertTableRow();
  const row = d.tableContext.row;
  expect(row.cells.map(c => c.textDirection)).toEqual(['lrTb', 'btLr', 'tbRl']);
  for (const cell of row.cells) cell.shell = null;
  const again = await DocxPackage.open(await save(p, d));
  expect(directions(again.tables[0])).toEqual([['lrTb', 'btLr', 'tbRl'], ['lrTb', 'btLr', 'tbRl']]);
  expect(model(again).text).toBe(d.text);
  d.undo(); sameParts(await save(p, d), p.parts);
});

it('writes an explicit horizontal direction on new cell shells so it still overrides the table style', async () => {
  const p = await DocxPackage.open(source('styles')), d = model(p);
  d.selectCell(d.tables[3].rows[0].cells[0].id); d.insertTableRow();
  for (const cell of d.tableContext.row.cells) cell.shell = null;
  const again = await DocxPackage.open(await save(p, d));
  expect(again.tables[3].rows[1].cells.map(c => c.textDirection)).toEqual(['tbRl', 'lrTb']);
});

it('keeps ignored style directions inactive through topology changes and preserves their XML', async () => {
  const p = await DocxPackage.open(source('styles')), d = model(p), table = d.tables[0];
  expect(directions(table)).toEqual([['lrTb', 'lrTb'], ['lrTb', 'tbRl'], ['lrTb', 'lrTb']]);
  for (const other of d.tables.slice(1, 3)) expect(directions(other)).toEqual(directions(table));
  const formerLast = table.rows[2];
  d.selectCell(formerLast.cells[0].id); d.insertTableRow();
  expect(formerLast.cells.map(c => c.textDirection || 'lrTb')).toEqual(['lrTb', 'lrTb']);
  expect(directions(table)).toEqual([['lrTb', 'lrTb'], ['lrTb', 'tbRl'], ['lrTb', 'lrTb'], ['lrTb', 'lrTb']]);
  const bytes = await save(p, d), again = await DocxPackage.open(bytes);
  expect(directions(again.tables[0])).toEqual(directions(table));
  // Ignored directions stay in the retained style, never materialized as
  // direct formatting. The two original direct overrides remain authored.
  const xml = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
  const first = xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'tbl')[0];
  expect(first.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'textDirection')).toHaveLength(2);
  expect(unzipSync(bytes)['word/styles.xml']).toEqual(p.parts['word/styles.xml']);
  d.undo(); sameParts(await save(p, d), p.parts);
});

it.each(['<w:textDirection/>', '<w:textDirection w:val="tbRlV"/>', '<w:textDirection w:val="btLr" w:other="1"/>', '<w:textDirection w:val="btLr"><w:b/></w:textDirection>', '<w:textDirection w:val="btLr"/><w:textDirection w:val="lrTb"/>'])('rejects unsupported or malformed direction %s', async replacement => {
  const parts = unzipSync(source('control'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:textDirection w:val="btLr"/>', replacement));
  await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(/direction|textDirection/);
});
