import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';
import { importedNumeral } from '../src/engine/list-numerals.js';

// ST_NumberFormat (ECMA-376 Part 1 §17.18.59) lists many more number styles than the list dialogs offer.
// Chinese and Japanese documents number with 一、二、三 and ①②③, legal documents with "First" or "1st",
// Korean documents with 가나다. A document using any of them opened read-only ("Unsupported numbering
// format"). They are now numbered and the document is editable; the format is kept on save.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const FORMATS = [['chineseCounting', '%1、'], ['decimalEnclosedCircle', '%1'], ['ordinalText', '%1:'], ['ganada', '%1.'], ['japaneseCounting', '第%1条'], ['decimalFullWidth', '%1．']];
function listPackage(count = 3) {
  const abstracts = FORMATS.map(([format, text], i) => `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`).join('');
  const nums = FORMATS.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`).join('');
  const body = FORMATS.flatMap((_, i) => Array.from({ length: count }, (__, n) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${i + 1}"/></w:numPr></w:pPr><w:r><w:t>Item ${n + 1}</w:t></w:r></w:p>`)).join('');
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/numbering.xml': `<w:numbering xmlns:w="${W}">${abstracts}${nums}</w:numbering>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  }).map(([name, xml]) => [name, strToU8(xml)])));
}
const labels = pkg => listMarkers(pkg.paragraphs, pkg.numbering).map(m => m?.text);

it('numbers lists in Chinese, Japanese, Korean, enclosed, full-width and English word formats and opens them for editing', async () => {
  const pkg = await DocxPackage.open(listPackage());
  expect(pkg.readOnly).toBeFalsy();
  expect(labels(pkg)).toEqual(['一、', '二、', '三、', '①', '②', '③', 'First:', 'Second:', 'Third:', '가.', '나.', '다.', '第一条', '第二条', '第三条', '１．', '２．', '３．']);
});

it('keeps each imported format through an edit, a new item and a reopen', async () => {
  const pkg = await DocxPackage.open(listPackage(2));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  // A new item after the second Chinese item continues that list.
  doc.select(doc.text.indexOf('Item 2') + 6); doc.insertParagraph(); doc.replace('Item 3');
  const parts = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  const numbering = strFromU8(parts['word/numbering.xml']);
  for (const [format] of FORMATS) expect(numbering).toContain(`<w:numFmt w:val="${format}"/>`);
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).toBeFalsy();
  expect(labels(reopened).slice(0, 5)).toEqual(['一、', '二、', '三、', '①', '②']);
});

it('counts in Chinese and Japanese numerals and falls back to digits past a sequence', () => {
  const cases = [[10, '十', '十'], [11, '十一', '十一'], [20, '二十', '二十'], [100, '一百', '百'], [101, '一百零一', '百一'], [110, '一百一十', '百十'], [1010, '一千零一十', '千十'], [10001, '一万零一', '一万一'], [100000, '十万', '十万']];
  for (const [value, chinese, japanese] of cases) {
    expect(importedNumeral(value, 'chineseCounting'), String(value)).toBe(chinese);
    expect(importedNumeral(value, 'japaneseCounting'), String(value)).toBe(japanese);
  }
  expect([1, 20, 21, 35, 36, 50, 51].map(n => importedNumeral(n, 'decimalEnclosedCircle'))).toEqual(['①', '⑳', '㉑', '㉟', '㊱', '㊿', '51']);
  expect(importedNumeral(21, 'decimalEnclosedParen')).toBe('21');
  expect(importedNumeral(10, 'ideographTraditional')).toBe('癸');
  expect(importedNumeral(11, 'ideographTraditional')).toBe('11');
  expect(['ordinal', 'cardinalText', 'ordinalText'].map(f => importedNumeral(21, f))).toEqual(['21st', 'Twenty-one', 'Twenty-first']);
  expect(importedNumeral(2024, 'ideographDigital')).toBe('二〇二四');
});

// Korean counting and digits, Hebrew numerals and alphabet, the Arabic abjad and alphabet and the iroha.
it('numbers lists in Korean, Hebrew, Arabic and iroha sequences', () => {
  const sample = (format, values) => values.map(n => importedNumeral(n, format));
  expect(sample('koreanCounting', [1, 10, 11, 20, 100, 101, 1234, 10000])).toEqual(['일', '십', '십일', '이십', '백', '백일', '천이백삼십사', '일만']);
  expect(sample('koreanDigital', [1, 10, 205])).toEqual(['일', '일영', '이영오']);
  expect(sample('hebrew1', [1, 10, 15, 16, 21, 100, 345, 500, 999, 1000])).toEqual(['א', 'י', 'טו', 'טז', 'כא', 'ק', 'שמה', 'תק', 'תתקצט', '1000']);
  expect(sample('hebrew2', [1, 2, 22, 23])).toEqual(['א', 'ב', 'ת', '23']);
  expect(sample('arabicAbjad', [1, 2, 3, 28, 29])).toEqual(['أ', 'ب', 'ج', 'غ', '29']);
  expect(sample('arabicAlpha', [1, 2, 3, 28])).toEqual(['أ', 'ب', 'ت', 'ي']);
  expect(sample('irohaFullWidth', [1, 2, 3, 47, 48])).toEqual(['イ', 'ロ', 'ハ', 'ス', '48']);
});
