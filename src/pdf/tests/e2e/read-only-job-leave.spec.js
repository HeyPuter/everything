import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Printing, saving pages as pictures, or exporting to an Office file only reads the PDF, yet
// while one ran the PDF counted as having unsaved changes: closing the tab asked to leave the
// site, and leaving the PDF asked to save changes there were none of.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test('an export under way is no unsaved change, and leaving stops it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  // The export waits here, at its first step, until the test lets it go.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/src/core/export-office.js*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 500]).drawText('Quarterly report', { x: 50, y: 400, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Microsoft Word (.docx)…', exact: true }).click();
  await page
    .getByRole('dialog', { name: /^Export to/ })
    .getByRole('button', { name: 'Export', exact: true })
    .click();
  const progress = page.getByRole('dialog', { name: 'Exporting to Microsoft Word document' });
  await expect(progress).toBeVisible();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
  // Closing the tab now loses nothing.
  const asked = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(asked).toBe(false);
  // Leaving for the library asks nothing, and takes the export's progress with it.
  await page.evaluate(() => (location.hash = '#library'));
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  // The export that was stopped never hands over a file.
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.waitForTimeout(500);
  expect(downloads).toEqual([]);
});
