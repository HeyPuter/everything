import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { openReadOnlyPreview } from './helpers/preview.js';

// A document whose styles part is cut short (here, a truncated download) used to fail with "The DOCX
// contains invalid XML." and show nothing. Its text now opens read-only, and the notice names the part.
test('a document with an unreadable styles part opens as a read-only preview of its text', async ({ page }) => {
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const parts = unzipSync(new Uint8Array(readFileSync('public/fixtures/two-paragraphs.docx')));
  parts['word/styles.xml'] = parts['word/styles.xml'].subarray(0, 4000);
  const buffer = Buffer.from(zipSync(parts));
  await openReadOnlyPreview(page, { name: 'truncated.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  expect(await page.getByRole('textbox', { name: 'Document text' }).inputValue()).toContain('A small beginning.');
  await page.locator('.canvas-message summary').click();
  await expect(page.getByText("Word/styles.xml: invalid XML; the read-only preview shows the document's text without this part")).toBeVisible();
});

test('a document whose main part is unreadable still says so', async ({ page }) => {
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const parts = unzipSync(new Uint8Array(readFileSync('public/fixtures/two-paragraphs.docx')));
  parts['word/document.xml'] = strToU8('<w:document');
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
  await expect(page.getByRole('alert')).toContainText('invalid XML');
});
