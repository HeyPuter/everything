import { expect, test } from '@playwright/test';
import { boot, client, historyLabels, idle, openImage, tool } from './helpers';

// Escape cancels a drag that is still in progress, like it does for transforms.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#808080', 'gray.png');
});

test('Escape while pulling a guide out of a ruler drops it', async ({ page }) => {
  const box = (await page.locator('#ruler-x').boundingBox())!;
  const [x, y] = await client(page, 300, 200);
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/dragging-hguide/);
  await page.mouse.move(x, y + 20, { steps: 2 });
  await page.mouse.up();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.guides ?? [])).toEqual([]);
  expect(await historyLabels(page)).toEqual([]);
});

test('Escape while moving a guide leaves it where it was', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.command('New Guide', (d) => void (d.guides = [{ orientation: 'vertical', position: 100 }])));
  await tool(page, 'Move Tool');
  await idle(page);
  const [x, y] = await client(page, 100, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.guides)).toEqual([{ orientation: 'vertical', position: 100 }]);
  expect(await historyLabels(page)).toEqual(['New Guide']);
  // The layer did not move either.
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.transform?.x ?? 0))).toEqual([0]);
});
