import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphFormat } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';

// Word's built-in List Number and List Bullet styles (and the documents python-docx and many templates
// make) number through a definition with one level (w:multiLevelType singleLevel, ECMA-376 §17.9.12, which
// "shall only be used ... to determine user interface behaviors"). Tab, Increase Indent and Alt+Shift+Right
// on such an item failed with "Numbering level 2 is missing." Word indents the item instead, keeping its
// number, as these commands do for a paragraph outside a list.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const level = (ilvl, left, text = `%${ilvl + 1}.`) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;
function docx(levels = level(0, 720), type = 'singleLevel') {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/numbering.xml': `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="${type}"/>${levels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${['One', 'Two', 'Three'].map(t => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const markers = d => listMarkers(d.paragraphs, d.numbering).map(m => m?.text);
const indents = d => d.paragraphs.map(p => paragraphFormat(p, d.numbering).indentLeft);

it('indents an item of a one-level list on Tab, keeping its number, and Shift+Tab takes it back', async () => {
  const p = await DocxPackage.open(docx()), d = model(p);
  d.select(d.text.indexOf('Two'));
  expect(d.changeListLevel(1)).toBe(true);
  expect(d.paragraphs.map(q => q.list.level)).toEqual([0, 0, 0]);
  expect(markers(d)).toEqual(['1.', '2.', '3.']);
  expect(indents(d)).toEqual([720, 1440, 720]);
  const xml = strFromU8(unzipSync(await save(p, d))["word/document.xml"]);
  expect(xml).toMatch(/<w:p><w:pPr><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr><w:ind w:left="1440"[^>]*\/><\/w:pPr><w:r><w:t[^>]*>Two</);
  const again = model(await DocxPackage.open(await save(p, d)));
  expect(indents(again)).toEqual([720, 1440, 720]);
  expect(markers(again)).toEqual(['1.', '2.', '3.']);
  // Decrease Indent undoes the indent; at the list's own indent it changes nothing, as before.
  expect(d.changeListLevel(-1)).toBe(true);
  expect(indents(d)).toEqual([720, 720, 720]);
  expect(d.changeListLevel(-1)).toBe(false);
  expect(indents(d)).toEqual([720, 720, 720]);
  expect(strFromU8(unzipSync(await save(p, d))['word/document.xml'])).not.toContain('<w:ind');
  d.undo(); expect(indents(d)).toEqual([720, 1440, 720]);
});

it('indents an item whose list defines no deeper level, and still changes level where one is defined', async () => {
  const p = await DocxPackage.open(docx(level(0, 720) + level(1, 1440, '%1.%2.'), 'multilevel')), d = model(p);
  d.select(d.text.indexOf('Two'));
  expect(d.changeListLevel(1)).toBe(true);
  expect(d.paragraphs[1].list.level).toBe(1);
  expect(markers(d)).toEqual(['1.', '1.1.', '2.']);
  expect(d.changeListLevel(1)).toBe(true);
  expect(d.paragraphs[1].list.level).toBe(1);
  expect(indents(d)).toEqual([720, 2160, 720]);
  // A selection whose items cannot all go a level deeper is indented as a whole.
  d.select(0, d.text.length);
  expect(d.changeListLevel(1)).toBe(true);
  expect(d.paragraphs.map(q => q.list.level)).toEqual([0, 1, 0]);
  expect(indents(d)).toEqual([1440, 2880, 1440]);
});

it('pastes a nested list item into a one-level list a single indent deeper', async () => {
  const { htmlFragment, pasteFragment } = await import('../src/engine/clipboard-fragment.js');
  const p = await DocxPackage.open(docx()), d = model(p);
  d.select(d.text.length);
  pasteFragment(d, htmlFragment('<ol><li>Four<ol><li>Nested</li></ol></li></ol>'));
  const nested = d.paragraphs.find(q => q.runs.map(r => r.text).join('') === 'Nested');
  expect(nested?.list).toBeTruthy();
  expect(paragraphFormat(nested, d.numbering).indentLeft).toBeLessThanOrEqual(1440);
});
