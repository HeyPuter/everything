import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';

// A comment chosen in the Comments panel is brought into view. On a phone its settings open
// below the page and take the lower part of the view, where a comment low on the page was
// left hidden behind them.
test('a comment chosen in the Comments panel is in view beside its settings', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 400, y: 60, width: 120, height: 50 },
    text: 'Low on the page',
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-reveal.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await page.getByRole('tab', { name: /Comments/ }).click();
  await page.getByRole('button', { name: 'Rectangle on page 1: Low on the page' }).click();
  const target = page.locator('.annotation-target.is-selected');
  await expect(target).toBeFocused();
  await expect(page.getByRole('complementary', { name: 'Selection properties' })).toContainText(
    'Rectangle',
  );
  const view = page.locator('.workspace');
  await expect
    .poll(async () => {
      const box = await target.boundingBox();
      const shown = await view.boundingBox();
      if (!box || !shown) return false;
      return box.y >= shown.y && box.y + box.height <= shown.y + shown.height;
    })
    .toBe(true);
});
