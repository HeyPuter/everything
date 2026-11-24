import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';

// On a phone the comments count on the side panel's rail stood 2 px past the edge of the screen.
test('the comments count on the rail stays on the screen of a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 300, width: 120, height: 60 },
    text: 'Box',
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'badge.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  const badge = page.locator('.right-rail .tab-count');
  await expect(badge).toHaveText('1');
  const { right } = await badge.evaluate((node) => node.getBoundingClientRect().toJSON());
  expect(right).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
