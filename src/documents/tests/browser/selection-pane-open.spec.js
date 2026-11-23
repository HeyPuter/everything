import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// The Selection pane lists the objects as it opens, and takes the keyboard to the selected one, even
// when the editor has nothing to update (here a shape from the gallery is still waiting to be drawn).
test('the Selection pane lists the objects as soon as it opens', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Shapes sit beside this paragraph of text. '.repeat(4));
  const shape = async name => {
    await onTab(page, 'insert');
    await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  await shape('Rectangle');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 420, box.y + 370, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  // Another shape is chosen but not drawn yet.
  await shape('Oval');
  await expect(page.getByText(/^Oval: drag on the page/)).toBeVisible();
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  await expect(pane.locator('.pic-selection-status')).toHaveText('1 object', { timeout: 2000 });
  await expect(pane.getByRole('button', { name: 'Rectangle 1', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
