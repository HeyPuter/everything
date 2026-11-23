import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { formatPageNumber } from '../src/engine/page-numbering.js';
import { PAGE_FORMATS } from '../src/views/insert-dialogs.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const measure = text => ({ width: text.length * 7, ascent: 12, descent: 4 });

/** Independently written: two pages, numbered "- 1 -" style (w:pgNumType w:fmt="numberInDash") in a footer PAGE field. */
function fixture() {
  const types = (name, type) => `<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types('document.xml', 'document.main')}${types('footer1.xml', 'footer')}</Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rF" Type="${R}/footer" Target="footer1.xml"/></Relationships>`),
    'word/footer1.xml': strToU8(`<w:ftr xmlns:w="${W}"><w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>Two</w:t></w:r></w:p>`
      + '<w:sectPr><w:footerReference w:type="default" r:id="rF"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:fmt="numberInDash"/></w:sectPr></w:body></w:document>'),
  });
}

// Word's Page Number Format dialog offers "- 1 -, - 2 -, - 3 -, …"; a document numbered that way opened read-only
// ("Some features are shown approximately"), as the format could not be shown.
it('shows and offers "- 1 -" page numbers, so documents numbered that way open for editing', async () => {
  expect(formatPageNumber(12, 'numberInDash')).toBe('- 12 -');
  const source = fixture(), pkg = await DocxPackage.open(source);
  const body = layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, pkg.pageStories);
  const stories = layoutPageStories(body, pkg.pageStories, [pkg.pageSettings], measure, pkg.numbering);
  expect(stories.unsupported).toEqual([]);
  expect([0, 1].map(page => stories.lines.filter(l => l.page === page).map(l => l.fragments.map(f => f.text).join('')).join(''))).toEqual(['- 1 -', '- 2 -']);
  expect(pkg.readOnly).toBeFalsy();
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))['word/document.xml']).toEqual(unzipSync(source)['word/document.xml']);
  expect(PAGE_FORMATS.find(([format]) => format === 'numberInDash')?.[1]).toBe('- 1 -, - 2 -, - 3 -, …');
});
