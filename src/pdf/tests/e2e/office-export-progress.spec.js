import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

async function openPdf(page, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++)
    doc.addPage([400, 500]).drawText(`Text on page ${i + 1}`, { x: 50, y: 400, size: 14, font });
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${pages}`);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

/** Export through the tools pane and collect every progress message the dialog shows. */
async function exportWithProgress(page, item, { slidePictures = false } = {}) {
  await page.evaluate(() => {
    window.progressTexts = [];
    new MutationObserver(() => {
      for (const status of document.querySelectorAll('dialog [role="status"]'))
        if (window.progressTexts.at(-1) !== status.textContent)
          window.progressTexts.push(status.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: item, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Export to/ });
  if (slidePictures) await dialog.getByLabel(/Put a picture of each page/).check();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await download;
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  return page.evaluate(() => window.progressTexts);
}

test('Export progress counts the pages being exported', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await openPdf(page, 3);
  const texts = await exportWithProgress(page, 'Microsoft Word (.docx)…');
  expect(texts.at(-1)).toBe('Writing the file…');
  for (const text of texts.filter((t) => t.startsWith('Page ')))
    expect(text).toMatch(/^Page [1-3] of 3…$/);
  expect(texts).toContain('Page 3 of 3…');

  const slides = await exportWithProgress(page, 'Presentation (.pptx)…', { slidePictures: true });
  expect(slides.at(-1)).toBe('Writing the file…');
  for (const text of slides.filter((t) => /^(Page|Drawing) /.test(t)))
    expect(text).toMatch(/^(Page|Drawing slide) [1-3] of 3…$/);
  expect(slides).toContain('Drawing slide 3 of 3…');
});
