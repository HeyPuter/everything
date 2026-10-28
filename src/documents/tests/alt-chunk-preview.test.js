import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { docxWithParagraphs } from './helpers/docx.js';

// ECMA-376 Part 1 §17.17.2.1 altChunk imports an Alternative Format Import part (§11.3.1): HTML, MIME
// HTML, plain text or another WordprocessingML package that the consumer converts. html-docx-js and
// document-assembly tools that merge files write whole documents this way. The editor does not
// convert them, so such a document opens read-only, and its preview used to be an empty page.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function chunkPackage(body, chunks) {
  const rels = chunks.map(c => `<Relationship Id="${c.id}" Type="${R}/aFChunk" Target="${c.target}"/>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="mht" ContentType="message/rfc822"/><Default Extension="htm" ContentType="text/html"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="rtf" ContentType="application/rtf"/><Default Extension="docx" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    ...Object.fromEntries(chunks.map(c => [c.target.replace(/^\//, '').replace(/^(?!afchunk)/, 'word/'), typeof c.bytes === 'string' ? strToU8(c.bytes) : c.bytes])),
  });
}
const text = pkg => pkg.paragraphs.map(p => p.runs.map(r => r.text).join(''));

// As html-docx-js writes it: a quoted-printable UTF-8 page in a MIME HTML archive at the package root.
const MHT = ['MIME-Version: 1.0', 'Content-Type: multipart/related;', '    type="text/html";', '    boundary="----=mhtDocumentPart"', '', '', '------=mhtDocumentPart', 'Content-Type: text/html;', '    charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable', 'Content-Location: file:///C:/fake/document.html', '',
  '<!DOCTYPE html><html><head><title>Ignored</title><style>p { color: red }</style></head><body><h1>Quarterly report</h1><p>Sales in the caf=C3=A9 grew by <b>12 %</b> and <i>kept</i> grow=', 'ing.</p><ul><li>First</li><li>Second</li></ul><table><tr><td>A</td><td>B</td></tr></table></body></html>', '', '------=mhtDocumentPart--', ''].join('\r\n');

it('previews the HTML page of a MIME HTML chunk instead of an empty page', async () => {
  const pkg = await DocxPackage.open(chunkPackage('<w:altChunk r:id="htmlChunk"/>', [{ id: 'htmlChunk', target: '/afchunk.mht', bytes: MHT }]), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(text(pkg)).toEqual(['Quarterly report', 'Sales in the café grew by 12 % and kept growing.', 'First', 'Second', 'A\tB']);
  const runs = pkg.paragraphs[1].runs;
  expect(runs.find(r => r.text === '12 %').bold).toBe(true);
  expect(runs.find(r => r.text === 'kept').italic).toBe(true);
  expect(pkg.paragraphs[0].runs[0].bold).toBe(true);
});

it('previews HTML, plain text and an embedded document in place among the other blocks', async () => {
  const html = new Uint8Array([...strToU8('<html><head><meta charset="windows-1252"></head><body><p>Na'), 0xef, ...strToU8('ve r'), 0xe9, ...strToU8('sum'), 0xe9, ...strToU8('</p></body></html>')]);
  const body = '<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:altChunk r:id="c1"/><w:altChunk r:id="c2"/><w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:altChunk r:id="c3"/><w:p/></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p>';
  const pkg = await DocxPackage.open(chunkPackage(body, [
    { id: 'c1', target: 'chunk1.htm', bytes: html },
    { id: 'c2', target: 'chunk2.txt', bytes: 'Line one\r\nLine two' },
    { id: 'c3', target: 'merged.docx', bytes: docxWithParagraphs([{ text: 'Merged heading', heading: true }, { text: 'Merged body' }]) },
  ]), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(text(pkg)).toEqual(['Before', 'Naïve résumé', 'Line one', 'Line two', 'Merged heading', 'Merged body', '', 'After']);
  // The embedded document's paragraphs stay in their table cell.
  expect(pkg.paragraphs[4].cellId).toBeTruthy();
  expect(pkg.paragraphs[5].cellId).toBe(pkg.paragraphs[4].cellId);
});

it('keeps an unreadable or unknown chunk out of the preview without failing the document', async () => {
  const pkg = await DocxPackage.open(chunkPackage('<w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:altChunk r:id="c1"/><w:altChunk r:id="missing"/><w:altChunk r:id="c2"/>', [
    { id: 'c1', target: 'chunk.rtf', bytes: '{\\rtf1 Hidden}' },
    { id: 'c2', target: 'broken.docx', bytes: 'not a zip' },
  ]), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(text(pkg)).toEqual(['Kept']);
});
