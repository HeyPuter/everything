import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// Tables as some producers write them: an unchanged tblGridChange record in the grid.
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => unzipSync(await bytes(pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables)));
const parse = text => new DOMParser().parseFromString(text, 'application/xml');
function docx(body) {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}
const table = ({ grid = '<w:gridCol w:w="4680"/><w:gridCol w:w="4680"/>', tblW = '9360', margin = '100' } = {}) => `<w:tbl><w:tblPr><w:tblW w:w="${tblW}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid><w:tr><w:tc><w:tcPr><w:tcMar><w:top w:w="${margin}" w:type="dxa"/></w:tcPr></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`.replace('</w:tcPr></w:tcPr>', '</w:tcMar></w:tcPr>');
const gridChange = '<w:tblGridChange w:id="0"><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid></w:tblGridChange>';

it('opens a table whose grid records an earlier grid for editing and keeps the record', async () => {
  const source = docx(table({ grid: '<w:gridCol w:w="4680"/><w:gridCol w:w="4680"/>' + gridChange }));
  const pkg = await DocxPackage.open(source, { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.tables[0].grid).toEqual([4680, 4680]);
  expect(unzipSync(await bytes(pkg.export()))).toEqual(unzipSync(source));
  const doc = model(pkg);
  doc.select(0); doc.replace('Z');
  let main = parse(strFromU8((await save(pkg, doc))['word/document.xml']));
  expect(main.getElementsByTagNameNS(W, 'tblGridChange')).toHaveLength(1);
  // A new column rewrites the grid; the earlier grid stays recorded after the new columns.
  doc.insertTableColumn();
  const saved = await save(pkg, doc);
  main = parse(strFromU8(saved['word/document.xml']));
  const grid = main.getElementsByTagNameNS(W, 'tblGrid')[0];
  expect([...grid.children].map(n => n.localName)).toEqual(['gridCol', 'gridCol', 'gridCol', 'tblGridChange']);
  expect([...grid.lastElementChild.getElementsByTagNameNS(W, 'gridCol')].map(n => n.getAttributeNS(W, 'w'))).toEqual(['4680', '4680']);
  const reopened = await DocxPackage.open(zipSync(saved), { bestEffort: true });
  expect(reopened.readOnly).not.toBe(true); expect(reopened.tables[0].grid).toHaveLength(3);
});

it('keeps malformed grid revision records read-only', async () => {
  for (const record of ['<w:tblGridChange w:id="0"/>', '<w:tblGridChange><w:tblGrid/></w:tblGridChange>', '<w:tblGridChange w:id="0"><w:tblGrid><w:gridCol w:w="x"/></w:tblGrid></w:tblGridChange>', gridChange + gridChange]) {
    const pkg = await DocxPackage.open(docx(table({ grid: '<w:gridCol w:w="4680"/><w:gridCol w:w="4680"/>' + record })), { bestEffort: true });
    expect(pkg.readOnly).toBe(true);
  }
});
