// Document thumbnails (recent files, recovery copies, versions) are drawn on
// the workspace canvas, which then shows what it showed before: an open
// adjustment dialog's live preview stays on the canvas.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

const shown = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    await e.renderer.settle();
    const px = await e.renderer.pixels();
    const i = (20 * e.doc.width + 30) * 4;
    return px[i];
  });
const thumbnail = (page: Page) =>
  page.evaluate(async () => {
    const { documentThumbnail } = await import('/src/features/versions/thumbs.ts');
    await documentThumbnail(window.photoStudio, window.photoStudio.session, 100);
  });

test('a thumbnail taken while an adjustment dialog previews keeps the preview on the canvas', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 60, 40, '#808080');
  await start(page, 'adjust.brightness-contrast');
  const dialog = page.locator('dialog.adj-dialog[open]');
  const brightness = dialog.getByRole('spinbutton', { name: 'Brightness value' });
  await brightness.fill('100');
  await brightness.press('Tab');
  await expect.poll(() => shown(page)).toBeGreaterThan(150);
  await thumbnail(page);
  expect(await shown(page)).toBeGreaterThan(150);
  // Once the dialog is cancelled the canvas shows the document, also after a thumbnail.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await idle(page);
  await expect.poll(() => shown(page)).toBe(128);
  await thumbnail(page);
  expect(await shown(page)).toBe(128);
});
