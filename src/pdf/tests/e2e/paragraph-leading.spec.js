import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

test('a paragraph ending in a larger space keeps its leading on the lines it gains', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  // Word ends each paragraph with a space in its mark's font, often larger than the text's.
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const mark = await doc.embedFont(StandardFonts.TimesRoman);
  const sheet = doc.addPage([400, 400]);
  const lines = [
    'Our team will review the revised project schedule and',
    'prepare a clear summary for the next meeting.',
  ];
  lines.forEach((text, i) =>
    sheet.drawText(text, { font: body, size: 11, x: 40, y: 300 - i * 15 }),
  );
  sheet.drawText(' ', {
    font: mark,
    size: 12,
    x: 40 + body.widthOfTextAtSize(lines[1], 11),
    y: 285,
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'paragraph.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('[aria-label^="Edit text: Our team will review"]').click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  await input.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.querySelector('span').firstChild, 0);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.type('Next week, ');
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
    expect(rows.map((item) => item.str)).toEqual([
      'Next week, Our team will review the revised project',
      'schedule and prepare a clear summary for the next',
      'meeting.',
    ]);
    // Each line sits one leading (15 pt) below the last, the new third line too.
    expect(rows.map((item) => item.transform[5])).toEqual([
      300,
      expect.closeTo(285, 1),
      expect.closeTo(270, 1),
    ]);
  } finally {
    await task.destroy();
  }
});
