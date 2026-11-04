import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// At 320 CSS pixels (a small phone, or a desktop window zoomed to 400%) the page and zoom
// controls must all stay on screen, clear of the side rail, rather than spill off both edges.
test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

for (const count of [12, 400])
  test(`every page control stays in view at 320 pixels with ${count} pages`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    for (let i = 0; i < count; i++) doc.addPage([400, 500]);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'pages.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${count}`);
    const rail = await page.locator('.right-rail').boundingBox();
    for (const name of [
      'Previous page',
      'Page number',
      'Next page',
      'Zoom out',
      'Zoom',
      'Zoom in',
    ]) {
      const box = await page.getByLabel(name, { exact: true }).boundingBox();
      expect(box.x, name).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, name).toBeLessThanOrEqual(rail.x);
    }
    await expect(page.locator('.page-controls')).toContainText(`/ ${count}`);
  });
