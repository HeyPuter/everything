import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, historyLabels, idle, openImage, tool, undo } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#c04040', 'crop.png');
});

const docSize = (page: Page) => page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height]);
const cropBox = (page: Page) => page.evaluate(() => [...document.querySelectorAll('rect.crop-box')].map((r) => [Number(r.getAttribute('width')), Number(r.getAttribute('height'))]));

test('undoing a crop puts a crop box around the whole restored canvas', async ({ page }) => {
  await tool(page, 'Crop Tool');
  await canvasDrag(page, [[100, 100], [300, 200]], 5);
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await docSize(page)).toEqual([200, 100]);
  await undo(page);
  expect(await docSize(page)).toEqual([400, 300]);
  // The box left from the cropped canvas (200 × 100 at the corner) must not survive.
  await expect.poll(() => cropBox(page)).toEqual([[400, 300]]);
  await expect(page.locator('#crop-size')).toHaveText('400 × 300 px');
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await docSize(page)).toEqual([400, 300]);
});

test('Perspective Crop refuses a dented outline instead of failing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await tool(page, 'Perspective Crop Tool');
  for (const [x, y] of [[50, 50], [350, 50], [200, 100], [50, 250]]) await canvasClick(page, x, y);
  await expect(page.locator('polygon.crop-box')).toHaveClass(/invalid/);
  await expect(page.getByRole('button', { name: 'Commit perspective crop' })).toBeDisabled();
  await page.keyboard.press('Enter');
  await idle(page);
  await expect(page.locator('#status')).toContainText('convex');
  expect(await docSize(page)).toEqual([400, 300]);
  expect(await historyLabels(page)).toEqual([]);
  expect(errors).toEqual([]);
});
