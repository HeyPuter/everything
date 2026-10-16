import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const workspace = async (page: Page, name: string) => {
  await page.locator('.ws-tab', { hasText: new RegExp(`^${name}$`) }).first().click();
  await page.waitForTimeout(300);
};

test('Shading workspace opens a look-development viewport and fits narrow headers', async ({ page }) => {
  const errors = await openApp(page);
  // a wide 3D header shows its menus and labelled dropdowns
  const v3d = page.locator('.area[data-editor="VIEW_3D"]').first();
  await expect(v3d.locator('.hdr-collapsed-menus')).toHaveCount(0);
  await expect(v3d.locator('.area-header')).not.toHaveClass(/hdr-compact/);
  await workspace(page, 'Shading');
  const view = await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const v = shell.screen.areas.find((a: any) => a.type === 'VIEW_3D').editor;
    const n = shell.screen.areas.find((a: any) => a.type === 'SHADER').editor;
    return { type: v.shading.type, alpha: v.shading.studiolight_background_alpha, spheres: v.overlay.show_look_dev, toolbar: v.showToolbar, nodeToolbar: n.showToolbar };
  });
  expect(view).toEqual({ type: 'MATERIAL', alpha: 1, spheres: true, toolbar: false, nodeToolbar: false });
  // the narrow image editor folds its menus into one button that still lists them
  const img = page.locator('.area[data-editor="IMAGE_EDITOR"]').first();
  const fold = img.locator('.hdr-collapsed-menus');
  await expect(fold).toBeVisible();
  await fold.dispatchEvent('pointerdown');
  await expect(page.locator('.menu').last()).toContainText('Image');
  await page.keyboard.press('Escape');
  // the material preview popover offers the HDRI background controls
  await v3d.locator('[data-tip="Shading"]').dispatchEvent('pointerdown');
  const pop = page.locator('.popover').last();
  await expect(pop.locator('.num-field', { hasText: 'World Opacity' })).toBeVisible();
  await expect(pop.locator('.num-field', { hasText: 'Blur' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});
