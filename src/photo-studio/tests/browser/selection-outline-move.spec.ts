import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, client, historyLabels, idle, openImage, selectRect, tool } from './helpers';

const selection = (page: Page) => page.evaluate(() => window.photoStudio.doc.selection);

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150);
});

test('dragging inside a selection with a selection tool moves the outline, not the pixels', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  const layerBefore = await page.evaluate(() => window.photoStudio.layer?.pixels);
  await canvasDrag(page, [
    [30, 30],
    [60, 50],
  ]);
  expect(await selection(page)).toEqual({ x: 50, y: 40, width: 40, height: 30 });
  expect((await historyLabels(page)).at(-1)).toBe('Move Selection Outline');
  expect(await page.evaluate(() => window.photoStudio.layer?.pixels)).toEqual(layerBefore);

  // Shift pressed during the drag constrains it to an axis.
  const a = await client(page, 60, 50);
  const b = await client(page, 75, 52);
  const c = await client(page, 90, 53);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 3 });
  await page.keyboard.down('Shift');
  await page.mouse.move(c[0], c[1], { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await idle(page);
  expect(await selection(page)).toEqual({ x: 80, y: 40, width: 40, height: 30 });
});

test('a click inside the selection still deselects, and drags outside draw a new marquee', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await canvasClick(page, 30, 30);
  expect(await selection(page)).toBeNull();
  await canvasDrag(page, [
    [100, 60],
    [140, 90],
  ]);
  expect(await selection(page)).toEqual({ x: 100, y: 60, width: 40, height: 30 });
});

test('arrow keys nudge the selection outline with selection tools', async ({ page }) => {
  await tool(page, 'Lasso Tool');
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await page.locator('#viewport').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await idle(page);
  expect(await selection(page)).toEqual({ x: 21, y: 30, width: 40, height: 30 });
  expect((await historyLabels(page)).at(-1)).toBe('Nudge Selection Outline');
});

test('Space held while dragging a marquee repositions it', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  const a = await client(page, 10, 10);
  const b = await client(page, 40, 30);
  const c = await client(page, 70, 60);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 4 });
  await page.keyboard.down('Space');
  await page.mouse.move(c[0], c[1], { steps: 4 });
  await page.keyboard.up('Space');
  await page.mouse.up();
  await idle(page);
  // The 30 x 20 rectangle moved by (30, 30) without changing size.
  expect(await selection(page)).toEqual({ x: 40, y: 40, width: 30, height: 20 });
});

test('marquee options: fixed fields enable with the style, swap exchanges them, rectangles have no anti-alias', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  const bar = page.locator('#tool-options');
  await expect(bar.locator('#marquee-w')).toBeDisabled();
  await expect(bar.locator('#marquee-swap')).toBeDisabled();
  await expect(bar.locator('#sel-aa')).toBeDisabled();
  await bar.locator('#marquee-style').selectOption('size');
  await expect(bar.locator('#marquee-w')).toBeEnabled();
  await expect(bar.locator('#marquee-w')).toHaveValue('64');
  await bar.locator('#marquee-w').fill('80');
  await bar.locator('#marquee-w').press('Enter');
  await bar.locator('#marquee-swap').click();
  await expect(bar.locator('#marquee-w')).toHaveValue('64');
  await expect(bar.locator('#marquee-h')).toHaveValue('80');
  await canvasClick(page, 10, 10);
  expect(await selection(page)).toEqual({ x: 10, y: 10, width: 64, height: 80 });

  await tool(page, 'Elliptical Marquee Tool');
  await expect(bar.locator('#sel-aa')).toBeEnabled();
});
