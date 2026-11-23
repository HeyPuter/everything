import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// A job's progress bar was the browser's own: a short bar in the corner of the dialog, in the
// browser's blue rather than the app's color.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test('a job’s progress bar spans its dialog', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  // The export waits at its first step until the test lets it go.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/src/core/export-office.js*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/#library');
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
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Microsoft Word (.docx)…', exact: true }).click();
  await page
    .getByRole('dialog', { name: /^Export to/ })
    .getByRole('button', { name: 'Export', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Exporting to Microsoft Word document' });
  const bar = dialog.getByRole('progressbar', { name: 'Export progress' });
  await expect(bar).toBeVisible();
  const [barWidth, textWidth] = await Promise.all([
    bar.evaluate((node) => node.getBoundingClientRect().width),
    dialog.getByRole('status').evaluate((node) => node.getBoundingClientRect().width),
  ]);
  expect(Math.abs(barWidth - textWidth)).toBeLessThan(1);
  release();
});
