import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

// Round 6 stopped the body's block list from being spread into one push() call, which runs out of
// stack at about 120,000 entries. Table rows, a cell's paragraphs, an imported text chunk (altChunk), an
// unsupported block shown as its text, and unsupported inline content shown as its runs were still
// gathered that way: such a file failed with "Maximum call stack size exceeded" instead of the page limit.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const docx = (body, { types = '', rels = '', parts = {} } = {}) => [...zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:p/><w:sectPr/></w:body></w:document>`,
  ...parts,
}).map(([name, xml]) => [name, strToU8(xml)])))];
const N = 150000;
const cases = {
  'a table with 150,000 rows': () => docx(`<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${'<w:tr><w:tc><w:p/></w:tc></w:tr>'.repeat(N)}</w:tbl>`),
  'a table cell with 150,000 paragraphs': () => docx(`<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${'<w:p/>'.repeat(N)}</w:tc></w:tr></w:tbl>`),
  'an imported text chunk of 150,000 lines': () => docx('<w:altChunk r:id="rA"/>', { types: '<Default Extension="txt" ContentType="text/plain"/>', rels: `<Relationship Id="rA" Type="${R}/aFChunk" Target="a.txt"/>`, parts: { 'word/a.txt': 'line\n'.repeat(N) } }),
  'an unsupported block of 150,000 paragraphs': () => docx(`<w:customXml w:element="x">${'<w:p/>'.repeat(N)}</w:customXml>`),
};
for (const [name, build] of Object.entries(cases)) test(`${name} reaches the page limit, not a stack overflow`, async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async bytes => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    try { const { pkg } = await openCanvasDocument(new Uint8Array(bytes)); return { issues: pkg.previewIssues || [] }; }
    catch (e) { return { error: e.message }; }
  }, build());
  expect(result.error ?? result.issues.join('\n')).toContain('This preview supports up to 200 pages.');
  expect(JSON.stringify(result)).not.toContain('call stack');
});

// Inline content shown as its text (here a custom XML element around 150,000 runs) opens as that text.
test('unsupported inline content with 150,000 runs opens as its text', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async bytes => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    try { const { pkg } = await openCanvasDocument(new Uint8Array(bytes)); return { readOnly: pkg.readOnly, length: pkg.paragraphs[0].runs.map(r => r.text).join('').length }; }
    catch (e) { return { error: e.message }; }
  }, docx(`<w:p><w:customXml w:element="x">${'<w:r><w:t>a</w:t></w:r>'.repeat(N)}</w:customXml></w:p>`));
  expect(result).toEqual({ readOnly: true, length: N });
});
