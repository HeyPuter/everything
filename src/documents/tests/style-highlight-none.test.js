import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';

// [MS-OI29500] §§2.1.245, 2.1.248, 2.1.260 and 2.1.291: Word does not allow highlighting in document
// defaults or styles, so the editor refuses an active one. <w:highlight w:val="none"/> (§17.3.2.15)
// highlights nothing, but it opened the whole document read-only as well. It is now accepted and kept.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function styled(highlight) {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Styled text' }]));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:p>', '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>').replace('<w:r>', '<w:r><w:rPr><w:rStyle w:val="Marked"/></w:rPr>'));
  parts['word/styles.xml'] = strToU8(`<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/>${highlight}</w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:rPr><w:i/>${highlight}</w:rPr></w:style><w:style w:type="character" w:styleId="Marked"><w:name w:val="Marked"/><w:rPr><w:b/>${highlight}</w:rPr></w:style></w:styles>`);
  parts['word/_rels/document.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  return zipSync(parts);
}

it('opens styles and document defaults that switch highlighting off for editing', async () => {
  const pkg = await DocxPackage.open(styled('<w:highlight w:val="none"/>'));
  expect(pkg.readOnly).toBeFalsy();
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const run = doc.paragraphs[0].runs[0];
  expect([run.highlight, run.bold, run.italic]).toEqual(['none', true, true]);
  doc.select(doc.text.length); doc.replace(' more');
  const parts = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  expect(strFromU8(parts['word/styles.xml'])).toBe(strFromU8(unzipSync(styled('<w:highlight w:val="none"/>'))['word/styles.xml']));
});

it('still opens a style that highlights read-only', async () => {
  await expect(DocxPackage.open(styled('<w:highlight w:val="yellow"/>'))).rejects.toThrow('highlighting in document defaults');
});
