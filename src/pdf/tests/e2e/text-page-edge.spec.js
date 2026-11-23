import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

test('new text wraps at the page edge instead of running off the page', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'blank.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  const sentence =
    'This sentence is far too long to fit between the middle of the page and its right edge';
  await input.fill(sentence);
  // The box shows every row the text wraps onto.
  await expect
    .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(0);
  await clickAway(page);
  await expect(input).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(await (await pending).path())),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const content = await (await (await task.promise).getPage(1)).getTextContent();
    const rows = content.items.filter((item) => item.str.trim());
    // Saved line by line as it wrapped: every word is on the page.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((item) => item.str.trim()).join(' ')).toBe(sentence);
    for (const item of rows) expect(item.transform[4] + item.width).toBeLessThanOrEqual(400);
  } finally {
    await task.destroy();
  }
});
