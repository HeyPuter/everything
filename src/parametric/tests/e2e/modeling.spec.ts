import { expect, test } from '@playwright/test';
import { canvasCenter, openApp, waitForFeature } from './helpers';

test.describe('part modeling', () => {
  test('opens an example and rebuilds it without errors', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    for (const name of ['Extrude1', 'Hole1', 'Fillet1']) await waitForFeature(page, name);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect(page.locator('.statusbar')).toContainText('MMGS');
    expect(errors).toEqual([]);
  });

  test('sketches a rectangle, dimensions it and extrudes it', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.statusbar')).toContainText('Defined');
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 160, y - 90);
    await page.keyboard.press('Escape');
    await expect(page.locator('.rel-badge').first()).toBeVisible();
    // Dimension the bottom edge to 50 mm.
    await page.keyboard.press('d');
    await page.mouse.click(x + 80, y);
    await page.mouse.click(x + 80, y + 40);
    const modify = page.getByRole('dialog', { name: /Modify/ });
    await expect(modify).toBeVisible();
    await modify.getByRole('textbox').fill('50');
    await modify.getByRole('textbox').press('Enter');
    await expect(page.locator('.dim-label', { hasText: '50.00' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Extrude: finishing the sketch makes it the profile.
    await page.getByRole('tab', { name: 'Features' }).click();
    await page.locator('[data-cmd="extrude"]').first().click();
    await expect(page.getByRole('heading', { name: 'Extrude' })).toBeVisible();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Extrude1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    // Undo removes the feature again.
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('evaluates mass properties of the flange', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Pipe Flange/ }).click();
    await waitForFeature(page, 'Circular Pattern1');
    await page.getByRole('tab', { name: 'Evaluate' }).click();
    await page.locator('[data-cmd="massProperties"]').first().click();
    const dlg = page.getByRole('dialog', { name: 'Mass Properties' });
    await expect(dlg).toContainText('Volume');
    await expect(dlg).toContainText('Stainless Steel');
  });

  test('switches themes and keeps the choice', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Account/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
  });

  test('opens a SolidWorks part as an imported solid', async ({ page }) => {
    const errors = await openApp(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open from device/ }).click();
    await (await chooser).setFiles(decodeURIComponent(new URL('../fixtures/sldprt/cube-hole-sw2022.sldprt', import.meta.url).pathname));
    await waitForFeature(page, 'Imported1');
    await expect(page.locator('.doc-title')).toHaveText('cube-hole-sw2022');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect(page.locator('.toast.success')).toContainText('Opened cube-hole-sw2022.sldprt');
    expect(errors).toEqual([]);
  });
});
