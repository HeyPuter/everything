import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { docxWithParagraphs } from './helpers/docx.js';

// One part that is not well-formed XML (or is written in Latin-1, which package XML may not use: ECMA-376
// Part 2, §8.1.4) failed the whole open with "The DOCX contains invalid XML." or the decoder's
// "The encoded data was not valid for encoding utf-8", even when it was only the styles, settings, font
// table or comments. Word offers to recover such a file. The main document's text now opens as the
// read-only preview, which names the part it could not read.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function packageWith(name, type, bytes) {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Minutes of the meeting' }, { text: 'Second item' }]));
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', `<Relationship Id="rX" Type="${R}/${type}" Target="${name.slice(5)}"/></Relationships>`));
  parts[name] = typeof bytes === 'string' ? strToU8(bytes) : bytes;
  return parts;
}
const text = pkg => pkg.paragraphs.map(p => p.runs.map(r => r.text).join(''));
const latin1 = source => Uint8Array.from(source, c => c.charCodeAt(0));

// A notes part no note in the body uses yet is where Insert Footnote and Insert Endnote add theirs: one that cannot be
// read opened for editing, and the first inserted note then failed with "The DOCX contains invalid XML."
for (const [name, type] of [['word/styles.xml', 'styles'], ['word/settings.xml', 'settings'], ['word/fontTable.xml', 'fontTable'], ['word/comments.xml', 'comments'], ['word/footnotes.xml', 'footnotes'], ['word/endnotes.xml', 'endnotes']]) {
  it(`shows the text of a document whose ${type} part is not well-formed`, async () => {
    const parts = packageWith(name, type, `<w:${type} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:unclosed>`);
    const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
    expect(pkg.readOnly).toBe(true);
    expect(text(pkg)).toEqual(['Minutes of the meeting', 'Second item']);
    expect(pkg.previewIssues).toEqual([`${name}: invalid XML; the read-only preview shows the document's text without this part`]);
    // Opening it to edit still refuses it, and nothing in the package was rewritten.
    await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow('invalid XML');
    expect(pkg.parts[name]).toEqual(parts[name]);
  });
}

it('names a part written in an encoding package XML may not use', async () => {
  const parts = packageWith('word/styles.xml', 'styles', latin1('<?xml version="1.0" encoding="ISO-8859-1"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Café"/></w:styles>'));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(text(pkg)).toEqual(['Minutes of the meeting', 'Second item']);
  expect(pkg.previewIssues).toEqual(["word/styles.xml: XML not encoded as UTF-8 or UTF-16; the read-only preview shows the document's text without this part"]);
});

it('shows the text when the main document relationships are not well-formed', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Minutes of the meeting' }]));
  parts['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship');
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(text(pkg)).toEqual(['Minutes of the meeting']);
  expect(pkg.previewIssues).toEqual(["word/_rels/document.xml.rels: invalid XML; the read-only preview shows the document's text without this part"]);
});

it('still reports a main document that is not well-formed', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Minutes' }]));
  parts['word/document.xml'] = strToU8('<w:document');
  await expect(DocxPackage.open(zipSync(parts), { bestEffort: true })).rejects.toThrow('The DOCX contains invalid XML.');
  parts['word/document.xml'] = latin1('<?xml version="1.0" encoding="ISO-8859-1"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Café</w:t></w:r></w:p></w:body></w:document>');
  // Said in words, not as the decoder's TypeError.
  await expect(DocxPackage.open(zipSync(parts), { bestEffort: true })).rejects.toThrow('The DOCX contains XML that is not encoded as UTF-8 or UTF-16.');
});

// A content-control data binding reads every custom XML store, so one that is not readable XML made the
// whole document a bare-text preview (and failed to open it before that). The binding is reported as
// unsupported instead, and the preview keeps the document's styles.
it('keeps the formatted preview when a bound control meets an unreadable custom XML part', async () => {
  const parts = packageWith('word/item1.xml', 'customXml', latin1('<?xml version="1.0" encoding="ISO-8859-1"?><root>café</root>'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml'])
    .replace('<w:document ', '<w:document xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ')
    .replace('<w:p><w:r><w:t xml:space="preserve">Second item', '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Second item')
    .replace('<w:sectPr/>', `<w:p><w:sdt><w:sdtPr><w15:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="/ns0:root[1]/ns0:a[1]" w:storeItemID="{11111111-2222-3333-4444-555555555555}"/><w:id w:val="5"/></w:sdtPr><w:sdtContent><w:r><w:t>Bound</w:t></w:r></w:sdtContent></w:sdt></w:p><w:sectPr/>`));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues).toEqual(['content-control data bindings with unreadable custom XML parts']);
  expect(text(pkg)).toEqual(['Minutes of the meeting', 'Second item', 'Bound']);
  expect(pkg.paragraphs[1].styleId).toBe('Heading1');
});
