import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('the PDF/A bar follows undo and redo of Save as PDF/A', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 500]).drawText('Archive copy', { x: 40, y: 440, size: 18, font });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'archive.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const bar = page.locator('.standards-bar');
  await expect(bar).toBeHidden();

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'PDF standards', exact: true }).click();
  await pane.getByRole('button', { name: 'Save as PDF/A…' }).click();
  await page
    .getByRole('dialog', { name: 'Save as PDF/A' })
    .getByRole('button', { name: 'Convert' })
    .click();
  const done = page.getByRole('dialog', { name: 'Saved as PDF/A-2b' });
  await done.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(bar).toContainText('PDF/A-2b');

  // Undone, the file no longer claims PDF/A, and the bar says nothing of it.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await expect(bar).toBeHidden();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await expect(bar).toContainText('PDF/A-2b');
});
