import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

// On macOS, Chrome blocks the page's thread inside FontFace.load() for the local() name of an
// on-demand system font that is not downloaded (NanumGothic, NanumMyeongjo, Osaka), and lookups of
// other missing names stall behind it. A document or Hanword file naming such fonts used to freeze
// the page while it opened. Elsewhere these fonts are simply missing, and the files open as usual.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run = (text, font) => `<w:p><w:r>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/></w:rPr>` : ''}<w:t>${text}</w:t></w:r></w:p>`;
const docx = () => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${run('Before')}${run('한국어 Korean', 'NanumGothic')}${run('日本語', 'Osaka')}${run('After')}<w:sectPr/></w:body></w:document>`,
}).map(([name, xml]) => [name, strToU8(xml)])));

test('a document using on-demand system fonts opens and stays responsive', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'nanum.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx()) });
  await expect(input).toHaveValue('Before\n한국어 Korean\n日本語\nAfter', { timeout: 15000 });
  await expect(input).toHaveJSProperty('readOnly', false);
  await input.focus();
  await page.keyboard.type('Typed ');
  await expect(input).toHaveValue(/^Typed Before/);
  expect(errors).toEqual([]);
});

test('a Hanword file naming on-demand system fonts imports without freezing', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/home');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await (await chooser).setFiles({ name: 'basicsReport.hwp', mimeType: 'application/x-hwp', buffer: readFileSync('tests/fixtures/hwp/basicsReport.hwp') });
  await expect(page.locator('.canvas-message .import-notice summary')).toHaveText(/^Hanword HWP import/, { timeout: 20000 });
  expect(errors).toEqual([]);
});
