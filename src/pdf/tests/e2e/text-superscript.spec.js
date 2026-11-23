import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

test('a paragraph with a footnote mark edits as one and keeps the mark raised', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([400, 400]);
  // A footnote mark is smaller text on a raised baseline, between the words of its line.
  const head = 'The survey found the result significant';
  sheet.drawText(head, { font, size: 11, x: 40, y: 300 });
  const mark = 40 + font.widthOfTextAtSize(head, 11);
  sheet.drawText('1', { font, size: 7, x: mark, y: 304 });
  sheet.drawText(' across every region and', {
    font,
    size: 11,
    x: mark + font.widthOfTextAtSize('1', 7),
    y: 300,
  });
  sheet.drawText('in each of the three years that it covered.', { font, size: 11, x: 40, y: 286 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'footnote.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('[aria-label^="Edit text: The survey found"]').click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveText(
    'The survey found the result significant1 across every region and in each of the three years that it covered.',
  );
  // The mark is raised in the draft too.
  const raised = await input
    .locator('span', { hasText: /^1$/ })
    .evaluate((el) => parseFloat(getComputedStyle(el).verticalAlign));
  expect(raised).toBeGreaterThan(0);
  await input.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.querySelector('span').firstChild, 0);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.type('Last year, ');
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
    expect(rows[0].str).toMatch(/^Last year, The survey/);
    const footnote = rows.find((item) => item.str === '1');
    expect(footnote.transform[5]).toBeCloseTo(304, 1);
    expect(footnote.transform[0]).toBeCloseTo(7, 1);
    expect(rows[0].transform[5]).toBeCloseTo(300, 1);
  } finally {
    await task.destroy();
  }
});
