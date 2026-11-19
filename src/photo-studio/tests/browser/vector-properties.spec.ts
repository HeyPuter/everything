import { expect, test } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, tool } from './helpers';

// Live shape fields in the Properties panel.
test('a corner radius larger than the rectangle allows is shown as the radius drawn', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Rectangle Tool');
  await canvasDrag(page, [[220, 30], [380, 120]]);
  const radius = page.locator('.vec-props [data-vec="radius"]');
  await radius.fill('500');
  await radius.press('Enter');
  await idle(page);
  const radii = () => page.evaluate(() => (window.photoStudio.layer!.vector!.live as { radii: number[] }).radii);
  // 160 × 90: a stadium, corners of 45.
  expect(await radii()).toEqual([45, 45, 45, 45]);
  await expect(page.locator('.vec-props [data-vec="radius"]')).toHaveValue('45');
  await page.keyboard.press('Meta+z');
  await idle(page);
  expect(await radii()).toEqual([0, 0, 0, 0]);
});

test('shape Transform fields resize with the link, move with units and undo one step each', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Rectangle Tool');
  await canvasDrag(page, [
    [220, 30],
    [380, 120],
  ]);
  await idle(page);
  const props = page.locator('#properties');
  const spin = (name: string) => props.getByRole('spinbutton', { name, exact: true });
  await expect(spin('W')).toHaveValue('160');
  const before = (await page.evaluate(() => window.photoStudio.history.labels)).length;
  await props.getByRole('button', { name: 'Link layer width and height' }).click();
  await spin('W').fill('80');
  await spin('W').press('Enter');
  await idle(page);
  await expect(spin('H')).toHaveValue('45');
  await spin('X').fill('1in');
  await spin('X').press('Tab');
  await idle(page);
  await expect(spin('X')).toHaveValue('72');
  expect((await page.evaluate(() => window.photoStudio.history.labels)).slice(before)).toEqual([
    'Resize Shape',
    'Move Shape',
  ]);
  await page.keyboard.press('Meta+z');
  await idle(page);
  await expect(spin('X')).toHaveValue('220');
  await expect(props.getByRole('region', { name: 'Appearance' })).toBeVisible();
});