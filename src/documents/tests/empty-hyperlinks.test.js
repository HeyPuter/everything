import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// A hyperlink wrapper with nothing in it (§17.16.22 `hyperlink`; some producers leave `<w:hyperlink/>`
// behind after its text is deleted) shows nothing and links nothing. It no longer opens the document
// read-only; an untouched paragraph keeps it, and a rewritten one keeps everything that was visible.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function docx(link, inCell = false) {
  const p = `<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r>${link}<w:r><w:t>beta</w:t></w:r></w:p>`;
  const body = inCell ? `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/></w:tcPr>${p}</w:tc></w:tr></w:tbl><w:p/>` : p;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>',
    'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => unzipSync(new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()));

it.each([
  ['self-closing, external', '<w:hyperlink r:id="rIdLink"/>'],
  ['self-closing, without a destination', '<w:hyperlink/>'],
  ['holding an empty run', '<w:hyperlink r:id="rIdLink" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t></w:t></w:r></w:hyperlink>'],
  ['holding only a bookmark', '<w:hyperlink w:anchor="top"><w:bookmarkStart w:id="4" w:name="Kept"/><w:bookmarkEnd w:id="4"/></w:hyperlink>'],
])('opens an empty hyperlink %s for editing', async (_, link) => {
  for (const inCell of [false, true]) {
    const bytes = docx(link, inCell), pkg = await DocxPackage.open(bytes), doc = model(pkg);
    expect(pkg.readOnly).toBeFalsy();
    expect(doc.text).toContain('Alpha beta');
    expect(doc.paragraphs.flatMap(p => p.runs).some(r => r.link)).toBe(false);
    expect(await save(pkg, doc)).toEqual(unzipSync(bytes));
    doc.select(doc.text.indexOf('beta')); doc.replace('and ');
    const out = await save(pkg, doc), reopened = model(await DocxPackage.open(zipSync(out)));
    expect(reopened.text).toBe(doc.text);
    expect(reopened.text).toContain('Alpha and beta');
    if (link.includes('bookmarkStart')) expect(strFromU8(out['word/document.xml'])).toMatch(/<w:bookmarkStart w:id="4" w:name="Kept"\/><w:bookmarkEnd w:id="4"\/>/);
    for (const name of Object.keys(out)) if (name !== 'word/document.xml') expect(out[name]).toEqual(unzipSync(bytes)[name]);
  }
});
