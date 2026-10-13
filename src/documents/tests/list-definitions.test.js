import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { listMarkers, levelFor } from '../src/engine/numbering.js';
import { defineBullet, defineNumberFormat, adjustListIndents, defineMultilevelList, continueNumbering, previousList, currentListValue, selectedLevelDefinition } from '../src/engine/list-definitions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
function listDocument(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return { pkg, doc };
}
const labels = doc => listMarkers(doc.paragraphs, doc.numbering).map(m => m?.text ?? null);
async function roundTrip(pkg, doc) {
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { reopened: await DocxPackage.open(bytes), numberingXml: strFromU8(unzipSync(bytes)['word/numbering.xml']) };
}

it('defines a new bullet with its own font and alignment and keeps it through DOCX', async () => {
  const { pkg, doc } = listDocument(['one', 'two']);
  doc.select(0, doc.text.length); doc.toggleList('bullet');
  doc.select(1);
  expect(defineBullet(doc, { character: '★', font: 'Noto Sans', alignment: 'center' })).toBe(true);
  expect(labels(doc)).toEqual(['★', '★']);
  expect(selectedLevelDefinition(doc).level).toMatchObject({ format: 'bullet', text: '★', alignment: 'center', markerStyle: { fontAscii: 'Noto Sans' } });
  doc.undo();
  expect(labels(doc)).toEqual(['•', '•']);
  doc.redo();
  const { reopened, numberingXml } = await roundTrip(pkg, doc);
  expect(numberingXml).toMatch(/<w:lvlText w:val="★"\/>/);
  expect(numberingXml).toMatch(/<w:lvlJc w:val="center"\/>/);
  expect(listMarkers(reopened.paragraphs, reopened.numbering).map(m => m?.text)).toEqual(['★', '★']);
  expect(() => defineBullet(doc, { character: '' })).toThrow(/bullet/);
});

it('defines a number format with literal text, a start value and bold labels', async () => {
  const { pkg, doc } = listDocument(['alpha', 'beta', 'gamma']);
  doc.select(0, doc.text.length);
  expect(defineNumberFormat(doc, { format: 'upperRoman', before: 'Part ', after: ':', start: 3, bold: true })).toBe(true);
  expect(labels(doc)).toEqual(['Part III:', 'Part IV:', 'Part V:']);
  const { reopened, numberingXml } = await roundTrip(pkg, doc);
  expect(numberingXml).toMatch(/<w:numFmt w:val="upperRoman"\/>/);
  expect(numberingXml).toMatch(/<w:start w:val="3"\/>/);
  expect(listMarkers(reopened.paragraphs, reopened.numbering).map(m => m?.text)).toEqual(['Part III:', 'Part IV:', 'Part V:']);
  expect(levelFor(reopened.numbering, reopened.paragraphs[0].list).markerStyle.bold).toBe(true);
  expect(() => defineNumberFormat(doc, { before: '%' })).toThrow(/percent/);
});

it('adjusts list indents and what follows the number', async () => {
  const { pkg, doc } = listDocument(['one', 'two']);
  doc.select(0, doc.text.length); doc.toggleList('number');
  expect(adjustListIndents(doc, { numberPosition: 360, textIndent: 1080, suffix: 'space', tabStop: null })).toBe(true);
  const level = levelFor(doc.numbering, doc.paragraphs[0].list);
  expect(level).toMatchObject({ suffix: 'space', geometry: { indentLeft: 1080, firstLine: -720 } });
  const { reopened, numberingXml } = await roundTrip(pkg, doc);
  expect(numberingXml).toMatch(/<w:suff w:val="space"\/>/);
  expect(levelFor(reopened.numbering, reopened.paragraphs[0].list).geometry).toMatchObject({ indentLeft: 1080, firstLine: -720 });
  doc.select(0); doc.toggleList('number');
  expect(() => adjustListIndents(doc, { numberPosition: 0, textIndent: 360 })).toThrow(/list/);
});

it('continues numbering from a previous list and sets a numbering value', () => {
  const { doc } = listDocument(['a', 'b', 'gap', 'c', 'd']);
  doc.select(0, 3); doc.toggleList('number');
  const second = doc.text.indexOf('c');
  doc.select(second, doc.text.length); doc.toggleList('number');
  doc.select(doc.text.indexOf('gap')); // a plain paragraph between them
  doc.select(second);
  // toggleList joined to the previous list only when adjacent; restart to make two lists.
  doc.restartNumbering(1);
  expect(labels(doc)).toEqual(['1.', '2.', null, '1.', '2.']);
  expect(previousList(doc)).not.toBeNull();
  expect(continueNumbering(doc)).toBe(true);
  expect(labels(doc)).toEqual(['1.', '2.', null, '3.', '4.']);
  expect(currentListValue(doc)).toBe(3);
  doc.restartNumbering(10);
  expect(labels(doc)).toEqual(['1.', '2.', null, '10.', '11.']);
  doc.undo(); doc.undo();
  expect(labels(doc)).toEqual(['1.', '2.', null, '1.', '2.']);
  doc.select(0);
  expect(continueNumbering(doc)).toBe(false);
});

it('defines all nine levels of a multilevel list', async () => {
  const { pkg, doc } = listDocument(['one', 'one.one', 'two']);
  doc.select(0, doc.text.length);
  const levels = Array.from({ length: 9 }, (_, i) => ({ format: i % 2 ? 'lowerLetter' : 'decimal', text: i === 1 ? '%1.%2' : `%${i + 1})`, start: 1, alignment: 'left', suffix: 'tab', geometry: { indentLeft: 360 * (i + 1), firstLine: -360 } }));
  expect(defineMultilevelList(doc, levels)).toBe(true);
  doc.select(doc.text.indexOf('one.one')); doc.changeListLevel(1);
  expect(labels(doc)).toEqual(['1)', '1.a', '2)']);
  const { reopened } = await roundTrip(pkg, doc);
  expect(listMarkers(reopened.paragraphs, reopened.numbering).map(m => m?.text)).toEqual(['1)', '1.a', '2)']);
  expect(() => defineMultilevelList(doc, levels.slice(1))).toThrow(/nine/);
});
