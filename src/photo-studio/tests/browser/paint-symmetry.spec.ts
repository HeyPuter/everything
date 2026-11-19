import { test, expect } from '@playwright/test';
import { boot, canvasDrag, client, idle, layerPixel, openImage, tool, undo } from './helpers';

// Paint symmetry on the Brush, Pencil and Eraser options bars.

test('a symmetric brush stroke paints its mirror image in one step', async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 100, '#ffffff');
  await tool(page, 'Brush Tool');
  await page.evaluate(() => window.photoStudio.setForeground('#000000'));
  const button = page.locator('#symmetry-button');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  const popover = page.getByRole('dialog', { name: 'Paint symmetry' });
  const symmetry = popover.locator('#paint-symmetry');
  await expect(symmetry).toBeFocused();
  await symmetry.selectOption('vertical');
  await expect(page.locator('.symmetry-axes line')).toHaveCount(1);
  await expect(popover.locator('#symmetry-segments')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('aria-label', 'Paint symmetry: Vertical');
  const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
  await canvasDrag(page, [
    [30, 30],
    [50, 30],
  ]);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps + 1);
  expect((await layerPixel(page, 40, 30))[0]).toBeLessThan(60);
  // Mirrored about x = 100.
  expect((await layerPixel(page, 160, 30))[0]).toBeLessThan(60);
  expect((await layerPixel(page, 100, 30))[0]).toBe(255);
  await undo(page);
  expect((await layerPixel(page, 160, 30))[0]).toBe(255);
  // Radial symmetry shows its segment count and one spoke per segment.
  await button.click();
  await symmetry.selectOption('radial');
  await expect(popover.locator('#symmetry-segments')).toHaveValue('6');
  await expect(page.locator('.symmetry-axes line')).toHaveCount(6);
  await popover.locator('#symmetry-segments').fill('8');
  await popover.locator('#symmetry-segments').press('Enter');
  await expect(page.locator('.symmetry-axes line')).toHaveCount(8);
  await page.keyboard.press('Escape');
  // Other tools do not show the axes.
  await tool(page, 'Move Tool');
  await expect(page.locator('.symmetry-axes')).toHaveCount(0);
  await tool(page, 'Eraser Tool');
  await expect(page.locator('#symmetry-button')).toHaveAttribute(
    'aria-label',
    'Paint symmetry: Radial',
  );
});

test('Pulled String Mode trails the pointer and catches up at the end when asked', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 200, 100, '#ffffff');
  await tool(page, 'Brush Tool');
  await page.evaluate(() => window.photoStudio.setForeground('#000000'));
  await page.locator('#brush-smoothing').fill('50');
  await page.locator('#brush-smoothing').press('Enter');
  await page.getByRole('button', { name: 'Brush preset and size' }).click();
  const pop = page.getByRole('dialog', { name: 'Brush settings' });
  await pop.getByLabel('Pulled String Mode').check();
  await pop.getByLabel('Catch Up on Stroke End').uncheck();
  await page.keyboard.press('Escape');
  const stroke = () =>
    canvasDrag(page, [
      [20, 50],
      [70, 50],
      [120, 50],
    ]);
  await stroke();
  await idle(page);
  expect((await layerPixel(page, 20, 50))[0]).toBeLessThan(60);
  // The stroke stopped a string's length behind the pointer.
  expect((await layerPixel(page, 119, 50))[0]).toBe(255);
  await undo(page);
  await page.getByRole('button', { name: 'Brush preset and size' }).click();
  await pop.getByLabel('Catch Up on Stroke End').check();
  await page.keyboard.press('Escape');
  await stroke();
  await idle(page);
  expect((await layerPixel(page, 119, 50))[0]).toBeLessThan(60);
});

test('right-clicking the canvas with a brush opens the brush picker at the pointer', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 200, 100, '#ffffff');
  await tool(page, 'Brush Tool');
  const [x, y] = await client(page, 60, 40);
  await page.mouse.click(x, y, { button: 'right' });
  const pop = page.getByRole('dialog', { name: 'Brush settings' });
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  expect(Math.abs(box.x - x)).toBeLessThan(2);
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  // The Move tool keeps the canvas context menu.
  await tool(page, 'Move Tool');
  await page.mouse.click(x, y, { button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
});
