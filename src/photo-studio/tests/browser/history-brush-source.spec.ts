// The History Brush paints from the state the document opened in. It used to
// read the oldest state history still kept, so once older steps were dropped
// (History States in Preferences) it painted back an intermediate edit.
import { expect, test } from '@playwright/test';
import { boot, canvasDrag, compositePixel, idle, openImage, run } from './helpers';

test('the History Brush restores the opened image after history drops old steps', async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 80, '#808080', 'gray.png');
  await page.evaluate(() => (window.photoStudio.history.limit = 3));
  // Five fills of the whole layer: only the last three stay undoable.
  for (const color of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff']) {
    await page.evaluate((c) => window.photoStudio.setForeground(c), color);
    await run(page, 'edit.fill-foreground');
  }
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(3);
  // The History panel's first row names the latest dropped step, not the
  // opened document it no longer returns to.
  const rows = await page.evaluate(() => {
    window.photoStudio.dock.show('history');
    window.photoStudio.update();
    return [...document.querySelectorAll('#history .history-entries .history-row')].map((r) => r.textContent);
  });
  expect(rows).toEqual(['Fill', 'Fill', 'Fill', 'Fill']);
  expect(await compositePixel(page, 60, 40)).toEqual([0, 255, 255, 255]);
  await page.evaluate(() => window.photoStudio.setTool('history-brush'));
  await canvasDrag(page, [[50, 40], [70, 40]]);
  await idle(page);
  expect(await compositePixel(page, 60, 40)).toEqual([128, 128, 128, 255]);
});
