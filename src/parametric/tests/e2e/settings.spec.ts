import { expect, test } from '@playwright/test';
import { canvasCenter, openApp } from './helpers';

test('damaged saved preferences still allow sketching with valid units', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('parametric:settings', JSON.stringify({
    defaultUnits: 'unknown', showRelations: 'false', showPlanes: true, quality: 2,
  })));
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: 'Front Plane' }).click();
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.locator('[data-cmd="sketch"]').first().click();
  await expect(page.locator('.view-label')).toHaveText('Front');
  const { x, y } = await canvasCenter(page);
  await page.locator('[data-cmd="tool:rectangle"]').click();
  await page.mouse.click(x - 100, y + 60);
  await page.mouse.click(x + 100, y - 60);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await expect(page.locator('.statusbar')).toContainText('MMGS');
  expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.settings))
    .toMatchObject({ defaultUnits: 'MMGS', showRelations: true, showPlanes: true, quality: 2 });
});
