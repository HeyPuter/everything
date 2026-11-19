import { test, expect } from '@playwright/test';
import { boot, client, idle, openImage, tool } from './helpers';

// The Lasso keeps its outline open while Alt is held: clicks add straight
// segments, and releasing Alt closes the selection.

test('Alt held at release adds straight segments until Alt comes up', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080');
  await tool(page, 'Lasso Tool');
  const at = (x: number, y: number) => client(page, x, y);
  let [x, y] = await at(50, 50);
  await page.mouse.move(x, y);
  await page.mouse.down();
  [x, y] = await at(100, 52);
  await page.mouse.move(x, y, { steps: 4 });
  [x, y] = await at(150, 50);
  await page.mouse.move(x, y, { steps: 4 });
  await page.keyboard.down('Alt');
  await page.mouse.up();
  // Still open: no selection yet, the outline is shown.
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toBeFalsy();
  for (const [px, py] of [
    [150, 150],
    [50, 150],
  ]) {
    [x, y] = await at(px, py);
    await page.mouse.click(x, y);
  }
  await expect(page.locator('.marching')).toHaveCount(1);
  await page.keyboard.up('Alt');
  await idle(page);
  const sel = await page.evaluate(() => window.photoStudio.doc.selection);
  expect(sel).toMatchObject({ x: 50, y: 50 });
  expect(sel!.width).toBeGreaterThanOrEqual(99);
  expect(sel!.height).toBeGreaterThanOrEqual(99);
});

test('Escape drops an open Lasso outline', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080');
  await tool(page, 'Lasso Tool');
  let [x, y] = await client(page, 50, 50);
  await page.mouse.move(x, y);
  await page.mouse.down();
  [x, y] = await client(page, 150, 60);
  await page.mouse.move(x, y, { steps: 4 });
  await page.keyboard.down('Alt');
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await page.keyboard.up('Alt');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toBeFalsy();
  await expect(page.locator('.marching')).toHaveCount(0);
});
