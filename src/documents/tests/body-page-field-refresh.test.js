import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const field = (instruction, cached = '1', lock = false) => `<w:fldSimple w:instr="${instruction}"${lock ? ' w:fldLock="true"' : ''}><w:r><w:t>${cached}</w:t></w:r></w:fldSimple>`;
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
/** Independently written: PAGE fields on the first and third pages, numbered in lower-case Roman numerals from ii. */
function fixture() {
  const body = `<w:p><w:r><w:t xml:space="preserve">First page </w:t></w:r>${field(' PAGE ')}<w:r><w:t xml:space="preserve"> of </w:t></w:r>${field(' SECTIONPAGES ')}</w:p>${pageBreak}${pageBreak}`
    + `<w:p><w:r><w:t xml:space="preserve">Third page </w:t></w:r>${field(' PAGE ')}<w:r><w:t xml:space="preserve"> as </w:t></w:r>${field(' PAGE \\* Arabic ')}`
    + `<w:r><w:t xml:space="preserve"> locked </w:t></w:r>${field(' PAGE ', '7', true)}<w:r><w:t xml:space="preserve"> see </w:t></w:r>${field(' PAGEREF Mark ', '9')}</w:p>`
    + `<w:p><w:bookmarkStart w:id="1" w:name="Mark"/><w:r><w:t>Target</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:fmt="lowerRoman" w:start="2"/></w:sectPr>';
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`),
  });
}
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const layoutOf = p => d => layoutDocument(d.paragraphs, (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 }), pageGeometry(d.pageSettings), d.numbering, d.tables, p.pageStories, { styles: d.styles });
const values = d => bodyFieldRanges(d.paragraphs).map(r => d.text.slice(r.start, r.end));
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());

// Update Fields (F9) gave a PAGE field in the text the number of the page it was inserted on for good: after text
// moved it to another page it still showed the old number, while NUMPAGES beside it ("Page 1 of 3") updated.
it('gives PAGE and SECTIONPAGES fields in the text the numbers of the pages they are on when asked', async () => {
  const p = await DocxPackage.open(fixture()), d = model(p);
  expect(values(d)).toEqual(['1', '1', '1', '1', '7', '9']);
  // Page references alone (inserting a table of contents, a cross-reference) leave PAGE fields as they are.
  refreshPageReferences(d, layoutOf(p), p.pageStories);
  expect(values(d)).toEqual(['1', '1', '1', '1', '7', 'iv']);
  const result = refreshPageReferences(d, layoutOf(p), p.pageStories, { pageFields: true });
  expect(result.changed).toBe(4);
  // The first page is ii of the section's 3, the third iv; \* Arabic shows 4; a locked field keeps its result.
  expect(values(d)).toEqual(['ii', '3', 'iv', '4', '7', 'iv']);
  expect(values(model(await DocxPackage.open(await save(p, d))))).toEqual(values(d));
  d.undo();
  expect(values(d)).toEqual(['1', '1', '1', '1', '7', 'iv']);
});
