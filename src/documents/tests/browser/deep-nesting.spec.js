import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { downloadDocx } from './helpers/editor-tools.js';

// Generated or hostile files can nest elements thousands deep. The recursive readers exhausted the
// stack ("Maximum call stack size exceeded") and the document did not open, and tables nested 800
// deep took half a minute. Past the nesting limit a document opens as a read-only text preview.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const nest = (depth, open, close, inner) => open.repeat(depth) + inner + close.repeat(depth);
const P = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = body => Buffer.from(zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${P('Before')}${body}${P('After')}<w:sectPr/></w:body></w:document>`,
}).map(([name, xml]) => [name, strToU8(xml)]))));
const cases = {
  'hyperlinks nested 3,000 deep': [`<w:p>${nest(3000, '<w:hyperlink w:anchor="a">', '</w:hyperlink>', '<w:r><w:t>inner</w:t></w:r>')}</w:p>`, 'inner'],
  'simple fields nested 2,000 deep': [`<w:p>${nest(2000, '<w:fldSimple w:instr="PAGE">', '</w:fldSimple>', '<w:r><w:t>7</w:t></w:r>')}</w:p>`, '7'],
  'tables nested 800 deep': [nest(800, '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>', '<w:p/></w:tc></w:tr></w:tbl>', P('inner')), 'inner'],
  'an equation nested 1,500 deep in a smart tag': [`<w:p><w:smartTag w:element="x"><m:oMath>${nest(1500, '<m:d><m:e>', '</m:e></m:d>', '<m:r><m:t>x+1</m:t></m:r>')}</m:oMath></w:smartTag></w:p>`, 'x+1'],
};
for (const [name, [body, text]] of Object.entries(cases)) test(`a document with ${name} opens as a read-only preview`, async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  const bytes = docx(body), started = Date.now();
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'deep.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes });
  await expect(input).toHaveValue(new RegExp(`^Before\\n${text.replace('+', '\\+')}\\n(\\n)*After$`), { timeout: 15000 });
  expect(Date.now() - started).toBeLessThan(10000);
  await expect(page.locator('#playground-error')).toBeEmpty();
  await expect(input).toHaveJSProperty('readOnly', true);
  // The file itself is kept as it was.
  const download = page.waitForEvent('download');
  await downloadDocx(page);
  expect(readFileSync(await (await download).path()).equals(bytes)).toBe(true);
  expect(errors).toEqual([]);
});
