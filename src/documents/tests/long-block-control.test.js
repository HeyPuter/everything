import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const P = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = body => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${P('Before')}${body}${P('After')}<w:sectPr/></w:body></w:document>`,
}).map(([name, xml]) => [name, strToU8(xml)])));

// Every paragraph in a block content control refers to the control, and paragraph copies copy it.
// The control kept its whole source XML and a signature with every paragraph's text, so memory grew
// with the square of its length: 5,000 paragraphs failed with "Invalid string length", 8,000 crashed the tab.
it('keeps a block control small however many paragraphs it holds, and saves its contents', async () => {
  const count = 2000, body = `<w:sdt><w:sdtPr><w:alias w:val="Whole body"/><w:id w:val="7"/></w:sdtPr><w:sdtContent>${Array.from({ length: count }, (_, i) => P(`Line ${i}`)).join('')}</w:sdtContent></w:sdt>`;
  const pkg = await DocxPackage.open(docx(body));
  expect(pkg.readOnly).toBeFalsy();
  const inside = pkg.paragraphs.filter(p => p.blockControls?.length);
  expect(inside).toHaveLength(count);
  expect(Math.max(...inside.slice(0, 50).map(p => JSON.stringify(p.blockControls).length))).toBeLessThan(1000);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const save = async () => strFromU8(unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()))['word/document.xml']);
  const unchanged = await save();
  expect(unchanged.match(/<w:sdt>/g)).toHaveLength(1);
  expect(unchanged).toContain('<w:alias w:val="Whole body"/>');
  expect(unchanged.match(/<w:t>Line \d+<\/w:t>/g)).toHaveLength(count);
  // An edit inside the control is saved inside it, with the rest of its contents.
  doc.select(doc.text.indexOf('Line 1000') + 4); doc.replace('!');
  const edited = await save(), content = edited.slice(edited.indexOf('<w:sdtContent>'), edited.indexOf('</w:sdtContent>'));
  expect(content).toMatch(/<w:t( xml:space="preserve")?>Line! 1000<\/w:t>/);
  expect(content.match(/<w:t( xml:space="preserve")?>Line!? \d+<\/w:t>/g)).toHaveLength(count);
  expect(edited.indexOf('Before')).toBeLessThan(edited.indexOf('<w:sdt>'));
});
