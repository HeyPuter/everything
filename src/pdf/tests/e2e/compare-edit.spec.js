import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

async function pdfBytes(word) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 12; i++)
    doc.addPage([400, 500]).drawText(`${word} on page ${i + 1}`, { x: 40, y: 250, size: 30, font });
  return Buffer.from(await doc.save());
}

/** How many dark pixels the drawn first page of one side of the comparison has. */
const inkOnFirstPage = (page, side) =>
  page
    .locator(`.compare-paper[data-side="${side}"] canvas`)
    .first()
    .evaluate((canvas) => {
      if (!canvas.width || !canvas.height) return 0;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 128) ink++;
      return ink;
    });

test('the compared pages still draw after the PDF is edited during a comparison', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const opened = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opened
  ).setFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Alpha') });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 12');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (
    await chosen
  ).setFiles({ name: 'new.pdf', mimeType: 'application/pdf', buffer: await pdfBytes('Beta') });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect.poll(() => inkOnFirstPage(page, 'old')).toBeGreaterThan(50);

  // An edit while the comparison is open replaces the editor's document.
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rotate clockwise' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

  // Scrolling the first pages far out of view lets their drawings go; back, they draw again.
  const docs = page.locator('.compare-docs');
  await docs.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect.poll(() => inkOnFirstPage(page, 'old')).toBe(0);
  await docs.evaluate((node) => (node.scrollTop = 0));
  await expect.poll(() => inkOnFirstPage(page, 'old')).toBeGreaterThan(50);
  await expect.poll(() => inkOnFirstPage(page, 'new')).toBeGreaterThan(50);
});
