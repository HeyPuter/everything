// File → Revert goes back to the saved document, which has no unsaved
// changes: the tab's marker clears and closing does not ask to save. Undo
// brings the changes back as unsaved.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, redo, run, undo } from './helpers';

test('Revert leaves the document without unsaved changes until undone', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#ff0000', 'revert.png');
  await page.evaluate(() => window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.5)));
  await idle(page);
  const marker = page.locator('#dirty');
  await expect(marker).toBeVisible();
  await run(page, 'file.revert');
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(1);
  await expect(marker).toBeHidden();
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(0.5);
  await expect(marker).toBeVisible();
  await redo(page);
  await expect(marker).toBeHidden();
  // Nothing to save: closing does not ask.
  await page.evaluate(() => void window.photoStudio.runCommand('file.close'));
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(false);
  await expect(page.locator('#dialog[open]')).toHaveCount(0);
});
