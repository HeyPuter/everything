import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A message of two lines sat over the top edge of the page controls floating at the foot of
// the page view, and an error message stays there until the next press or key.
test('a long message stays clear of the page controls', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'damaged.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
  });
  const toast = page.locator('#toast');
  await expect(toast).toHaveText(/could not be opened/);
  const box = async (locator) =>
    (await locator.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  const [message, controls] = await Promise.all([box(toast), box(page.locator('.page-controls'))]);
  const overlap =
    message.x < controls.x + controls.width &&
    controls.x < message.x + message.width &&
    message.y < controls.y + controls.height &&
    controls.y < message.y + message.height;
  expect(overlap).toBe(false);
});

// A file name without spaces (underscores, a camera's numbering) ran out of the message box and
// past the edge of a phone's screen, where the end of it could not be read.
test('a message naming a long file keeps the name inside its box', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const doc = await PDFDocument.create();
  doc.addPage();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles([
    {
      name: 'Quarterly_financial_statement_consolidated_balance_sheet_2026_final_v12.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
  ]);
  const toast = page.locator('#toast');
  await expect(toast).toHaveText(/One PDF opens at a time/);
  const { scrollWidth, clientWidth } = await toast.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});
