// A save writes every table of the document from its source XML (the table, row and cell shells). Parsing each
// shell again on every save took about 135 ms of a 190 ms autosave task in a document with 150 tables. The
// parsed shells are kept by their XML, and each use imports a copy, so the saved file is the same.
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); vi.restoreAllMocks(); });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const cell = (text, i) => `<w:tc><w:tcPr><w:tcW w:w="${2000 + (i % 2) * 10}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const table = n => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2010"/></w:tblGrid>${
  Array.from({ length: 3 }, (_, r) => `<w:tr><w:trPr><w:trHeight w:val="${300 + r}"/></w:trPr>${cell(`T${n} r${r} a`, 0)}${cell(`T${n} r${r} b`, 1)}</w:tr>`).join('')}</w:tbl>`;
function docx(tables) {
  const body = Array.from({ length: tables }, (_, i) => `<w:p><w:r><w:t>Before table ${i}</w:t></w:r></w:p>${table(i)}`).join('') + '<w:p><w:r><w:t>End</w:t></w:r></w:p>';
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  });
}

// Opens the package, types into the first paragraph (so the body is written again) and saves it.
async function save(DocxPackage, TextDocument, bytes) {
  const pkg = await DocxPackage.open(bytes);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(0); doc.replace('Edited ');
  return { pkg, doc, write: () => pkg.exportParts(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables)['word/document.xml'] };
}

it('parses each table, row and cell shell once across saves, and writes the same file', async () => {
  const bytes = docx(30);
  const { DocxPackage } = await import('../src/engine/docx.js'), { TextDocument } = await import('../src/engine/model.js');
  const { write } = await save(DocxPackage, TextDocument, bytes);
  const first = write();
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
  const second = write();
  // 30 tables of 3 rows and 6 cells: 300 shells, which a save parsed every time.
  const shells = parse.mock.calls.filter(([xml]) => /^<w:(tbl|tr|tc)[\s>]/.test(xml)).length;
  expect(shells).toBe(0);
  parse.mockRestore();
  expect(new TextDecoder().decode(second)).toBe(new TextDecoder().decode(first));
  // A fresh module, which has parsed nothing yet, writes the same document.
  vi.resetModules();
  const fresh = await import('../src/engine/docx.js'), freshModel = await import('../src/engine/model.js');
  const again = (await save(fresh.DocxPackage, freshModel.TextDocument, bytes)).write();
  expect(new TextDecoder().decode(again).replace(/w14:paraId="[^"]*"|w:rsid\w*="[^"]*"/g, '')).toBe(new TextDecoder().decode(first).replace(/w14:paraId="[^"]*"|w:rsid\w*="[^"]*"/g, ''));
  expect(new TextDecoder().decode(first)).toContain('Edited Before table 0');
  expect(new TextDecoder().decode(first).match(/<w:tbl>/g)).toHaveLength(30);
});
