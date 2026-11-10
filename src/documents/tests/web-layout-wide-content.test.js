import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { viewGeometry, fitContinuousPages } from '../src/engine/document-views.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const measure = (text, style) => ({ width: text.length * style.fontSize * .5, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const p = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// Independently written: a fixed-width table of eight 1.5-inch columns (12 inches, 1,152 px).
function wideTable() {
  const cell = text => `<w:tc><w:tcPr><w:tcW w:w="2160" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`;
  const rows = Array.from({ length: 3 }, (_, r) => `<w:tr>${Array.from({ length: 8 }, (_, c) => cell(`R${r}C${c}`)).join('')}</w:tr>`).join('');
  const table = `<w:tbl><w:tblPr><w:tblW w:w="17280" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2160"/>'.repeat(8)}</w:tblGrid>${rows}</w:tbl>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${p('Before the table.')}${table}${p('After the table.')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

// Web Layout and Draft wrap text to the window, but a fixed-width table keeps its width. Wider than
// the window, its right-hand columns were cut off at the strip's edge, out of reach of the view's
// horizontal scrolling: they could be neither seen nor clicked.
it.each(['web', 'draft'])('widens a %s view strip to hold a table wider than the window', async kind => {
  const pkg = await DocxPackage.open(wideTable()), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  const view = viewGeometry({ kind, width: 800 });
  const layout = fitContinuousPages(layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, undefined, { viewGeometry: view }), null);
  const page = layout.pages[0], right = Math.max(...layout.cells.map(c => c.x + c.width));
  expect(right).toBeGreaterThan(800);
  expect(page.width).toBeGreaterThanOrEqual(right);
  // The text area, and so the text's wrapping and the ruler's margins, stay as the window gives them.
  const text = view(pageGeometry(doc.pageSettings));
  expect(page.width - page.left - page.right).toBe(text.width - text.left - text.right);
  expect(page.left).toBe(text.left);
});

it('keeps a strip the window\'s width when its content fits', () => {
  const view = viewGeometry({ kind: 'web', width: 800 });
  const layout = fitContinuousPages(layoutDocument([paragraph('A short paragraph.')], measure, pageGeometry(), undefined, [], undefined, { viewGeometry: view }), null);
  expect(layout.pages[0].width).toBe(800);
});
