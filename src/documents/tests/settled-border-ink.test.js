import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

// Count the layout's own requests for border ink (calls inside the border modules are not counted).
const calls = vi.hoisted(() => ({ table: 0, paragraph: 0 }));
vi.mock('../src/engine/table-border-layout.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, layoutTableBorders: (...args) => { if (!args[1]) calls.table++; return original.layoutTableBorders(...args); } };
});
vi.mock('../src/engine/paragraph-border-layout.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, layoutParagraphBorders: (...args) => { calls.paragraph++; return original.layoutParagraphBorders(...args); } };
});
const { layoutTableBorders } = await vi.importActual('../src/engine/table-border-layout.js');
const { layoutParagraphBorders } = await vi.importActual('../src/engine/paragraph-border-layout.js');

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const words = i => Array.from({ length: 40 }, (_, k) => ['river', 'stone', 'cloud', 'field', 'paper'][(i + k) % 5]).join(' ');

/** Independently written: long paragraphs with a footnote each, a bordered paragraph and a bordered table. */
function notedDocx() {
  const single = side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const body = [];
  for (let i = 1; i <= 40; i++) {
    body.push(`<w:p>${i === 3 ? `<w:pPr><w:pBdr>${['top', 'left', 'bottom', 'right'].map(single).join('')}</w:pBdr></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${words(i)}</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${i}"/></w:r></w:p>`);
    if (i === 5) body.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(single).join('')}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${'<w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr>'.repeat(4)}</w:tbl>`);
  }
  const note = id => `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${words(id * 3)} ${words(id * 7)}</w:t></w:r></w:p></w:footnote>`;
  const type = (part, kind) => `<Override PartName="/word/${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`;
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${type('document.xml', 'document.main')}${type('footnotes.xml', 'footnotes')}${type('styles.xml', 'styles')}</Types>`,
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${Array.from({ length: 40 }, (_, i) => note(i + 1)).join('')}</w:footnotes>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

it('places border ink once for the layout it shows, however many passes settling footnotes takes', async () => {
  const pkg = await DocxPackage.open(notedDocx());
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  calls.table = calls.paragraph = 0;
  const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, pkg.pageStories, { styles: doc.styles });
  expect(layout.pageCount).toBeGreaterThan(3);
  expect(layout.footnoteAreas.length).toBeGreaterThan(3);
  // Each pass placed every border of the document again; only the shown layout is painted. Its 40 notes are
  // measured once each, as small layouts of their own.
  expect(calls).toEqual({ table: 1 + 40, paragraph: 1 + 40 });
  expect(layout.tableBorders.filter(stroke => !stroke.guide).length).toBeGreaterThan(8);
  expect(layout.paragraphBorders.length).toBeGreaterThan(0);
  // The same ink as placing it with each pass.
  const placed = JSON.parse(JSON.stringify({ table: layout.tableBorders, paragraph: layout.paragraphBorders }));
  expect(placed).toEqual(JSON.parse(JSON.stringify({ table: layoutTableBorders(layout.cells), paragraph: layoutParagraphBorders(layout) })));
});
