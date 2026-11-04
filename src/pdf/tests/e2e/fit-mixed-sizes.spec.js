import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Fit width and fit page size every page by the largest one, so scrolling never changes the
// zoom. The sizes are read in the background while the first page renders; a PDF whose wide
// page comes later must still open fitted, not with that page spilling out sideways.
async function mixedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 12; i++)
    doc
      .addPage(i % 3 === 2 ? [842, 595] : [595, 842])
      .drawText(`Page ${i + 1}`, { x: 40, y: 400, size: 24, font });
  return doc;
}

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'mixed.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

const overflow = (page) =>
  page.locator('.workspace').evaluate((node) => node.scrollWidth - node.clientWidth);

test('a PDF whose wide page comes later opens fitted to the widest page', async ({ page }) => {
  await open(page, await mixedPdf());
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('fit');
  await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0);
  const view = await page.locator('.workspace').boundingBox();
  const wide = await page.locator('.page-slot[data-page="2"]').boundingBox();
  expect(wide.width).toBeLessThanOrEqual(view.width);
  // The first page sits inside the view, not pushed off to the right by the wide one.
  const first = await page.locator('.page-slot[data-page="0"]').boundingBox();
  expect(first.x).toBeGreaterThanOrEqual(view.x);
  expect(first.x + first.width).toBeLessThanOrEqual(view.x + view.width);
});
