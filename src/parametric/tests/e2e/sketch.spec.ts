import { type Page, expect, test } from '@playwright/test';
import { canvasCenter, openApp } from './helpers';

/** Opens a sketch on the Front plane once the camera faces it. */
async function startSketch(page: Page) {
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: 'Front Plane' }).click();
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.locator('[data-cmd="sketch"]').first().click();
  await expect(page.locator('.view-label')).toHaveText('Front');
  return canvasCenter(page);
}

test.describe('sketching', () => {
  test('a dimension that would over-define the sketch is driven and undoes in one step', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y - 60);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    // Bottom edge, then the top edge, whose length the rectangle already fixes.
    await page.mouse.click(x, y + 60);
    await page.mouse.click(x, y + 110);
    await page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox').press('Enter');
    await page.mouse.click(x, y - 60);
    await page.mouse.click(x, y - 110);
    await expect(page.locator('.toast')).toContainText('driven');
    await expect(page.locator('.dim-label.driven')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dim-label')).toHaveCount(1);
    await expect(page.locator('.statusbar')).toContainText('Under Defined');
    expect(errors).toEqual([]);
  });

  test('previews in the Modify box never leave the geometry moved or broken', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y + 20);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.mouse.click(x, y + 40);
    await page.mouse.click(x - 20, y + 100);
    const points = () => page.evaluate(() => JSON.stringify((window as unknown as { __parametric: { sketchEditor: { sketch: { entities: unknown[] } } } }).__parametric.sketchEditor.sketch.entities));
    const before = await points();
    const box = page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox');
    // An absurd value overflows the solver; Esc then restores the line exactly.
    await box.fill('1e300');
    await box.fill('5');
    await box.press('Escape');
    expect(await points()).toBe(before);
    expect(before).not.toContain('null');
    expect(errors).toEqual([]);
  });
});
