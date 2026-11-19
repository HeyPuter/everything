import { test, expect } from '@playwright/test';
import { boot, canvasClick, idle, openImage, run, tool } from './helpers';

// Zoom All Windows and Scroll All Windows with two windows of one document.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#808080');
  await run(page, 'window.new-window');
  await run(page, 'window.tile-vertical');
  await idle(page);
});

const views = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const e = window.photoStudio;
    return e.views.map((v) => ({ active: v === e.activeView, zoom: v.zoom, pan: { ...v.pan } }));
  });

test('Zoom All Windows zooms the other window by the same factor', async ({ page }) => {
  expect((await views(page)).length).toBe(2);
  await tool(page, 'Zoom Tool');
  await page.locator('#zoom-all').check();
  const before = await views(page);
  await canvasClick(page, 200, 150);
  await expect
    .poll(async () => (await views(page)).find((v) => !v.active)!.zoom)
    .toBeCloseTo(before.find((v) => !v.active)!.zoom * 1.5, 3);
  // Off: only the active window zooms.
  await page.locator('#zoom-all').uncheck();
  const mid = await views(page);
  await canvasClick(page, 200, 150);
  await expect
    .poll(async () => (await views(page)).find((v) => v.active)!.zoom)
    .toBeGreaterThan(mid.find((v) => v.active)!.zoom);
  expect((await views(page)).find((v) => !v.active)!.zoom).toBe(mid.find((v) => !v.active)!.zoom);
});

test('Scroll All Windows scrolls the other window with the Hand tool', async ({ page }) => {
  await tool(page, 'Hand Tool');
  const before = (await views(page)).find((v) => !v.active)!;
  const box = (await page.locator('#viewport').boundingBox())!;
  const drag = async () => {
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 130, { steps: 4 });
    await page.mouse.up();
  };
  await drag();
  expect((await views(page)).find((v) => !v.active)!.pan).toEqual(before.pan);
  await page.locator('#scroll-all').check();
  await drag();
  const after = (await views(page)).find((v) => !v.active)!;
  expect(Math.round(after.pan.x - before.pan.x)).toBe(40);
  expect(Math.round(after.pan.y - before.pan.y)).toBe(30);
});
