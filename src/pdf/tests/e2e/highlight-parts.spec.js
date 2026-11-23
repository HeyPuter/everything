import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';

// A markup across several lines has a target over each line. Each was a Tab stop of its own,
// so a page of long highlights took a Tab press for every line marked. A markup is one stop;
// a click or tap on any of its lines still chooses it.
test('a highlight across several lines is one Tab stop', async ({ page, isMobile }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 500]);
  for (let line = 0; line < 3; line++)
    sheet.drawText('Words that run on to the next line', { x: 40, y: 400 - line * 24, size: 14 });
  addHighlight(doc, 0, {
    quads: [0, 1, 2].map((line) => rectQuad({ x: 40, y: 396 - line * 24, width: 240, height: 18 })),
    text: 'Long',
  });
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 40, y: 200, width: 100, height: 18 })],
    text: 'Short',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'highlight-parts.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const first = page.getByRole('button', { name: 'Edit highlight: Long', exact: true });
  const second = page.getByRole('button', { name: 'Edit highlight: Short', exact: true });
  await first.focus();
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
  // The third line still chooses it.
  const last = page.getByRole('button', { name: 'Edit highlight: Long (part 3)', exact: true });
  if (isMobile) await last.tap();
  else await last.click();
  await expect(page.getByLabel('Highlight color', { exact: true })).toBeVisible();
});
