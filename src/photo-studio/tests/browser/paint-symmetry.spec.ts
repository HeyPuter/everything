import { test, expect } from '@playwright/test';
import { boot, canvasDrag, idle, layerPixel, openImage, tool, undo } from './helpers';

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
