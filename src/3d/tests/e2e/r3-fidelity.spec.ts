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

test('Properties: object Animation, world Volume, mesh Attributes / Texture Space, camera Background Images', async ({ page }) => {
  const errors = await openApp(page);
  const props = page.locator('.area[data-editor="PROPERTIES"]').first();
  const titles = () => props.locator('.prop-body > .panel > .panel-header .ph-title').allTextContents();
  await props.locator('.rail-tab[data-tab="OBJECT"]').click();
  expect((await titles()).slice(-2)).toEqual(['Animation', 'Custom Properties']);
  await props.locator('.rail-tab[data-tab="WORLD"]').click();
  expect((await titles()).slice(0, 3)).toEqual(['Surface', 'Volume', 'Mist Pass']);
  await props.locator('.rail-tab[data-tab="DATA"]').click();
  const t = await titles();
  expect(t.indexOf('Attributes')).toBe(t.indexOf('Color Attributes') + 1);
  expect(t.indexOf('Texture Space')).toBe(t.indexOf('Attributes') + 1);
  // a manual texture space starts from the mesh bounds
  await props.locator('[data-panel="me-texspace"] > .panel-header').dispatchEvent('pointerdown');
  await props.locator('[data-panel="me-texspace"] .checkbox', { hasText: 'Auto Texture Space' }).dispatchEvent('pointerdown');
  const ts = await page.evaluate(() => {
    const a = (window as any).app;
    const me = a.doc.meshes[a.activeObject.data];
    return { auto: me.use_auto_texspace, loc: me.texspace_location, size: me.texspace_size };
  });
  expect(ts).toEqual({ auto: false, loc: [0, 0, 0], size: [1, 1, 1] });
  // camera background images: add one, it draws in the camera view
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('image.new', { name: 'Ref', width: 64, height: 32, generated_type: 'COLOR_GRID' });
    const cam = Object.values(a.doc.objects).find((o: any) => o.type === 'CAMERA') as any;
    a.doc.scene.active_object = cam.id;
    a.changed('select');
  });
  await props.locator('.rail-tab[data-tab="DATA"]').click();
  await expect(props.locator('[data-panel="ca-bgimages"]')).toBeVisible();
  const order = await titles();
  expect(order.indexOf('Safe Areas')).toBe(order.indexOf('Viewport Display') + 1);
  await props.locator('[data-panel="ca-bgimages"] > .panel-header').dispatchEvent('pointerdown');
  await props.locator('[data-panel="ca-bgimages"] button', { hasText: 'Add Image' }).click();
  const cam = await page.evaluate(() => {
    const a = (window as any).app;
    const ca = a.doc.cameras[a.activeObject.data];
    return { show: ca.show_background_images, n: ca.background_images.length };
  });
  expect(cam).toEqual({ show: true, n: 1 });
  await expect(props.locator('.bgimg-box')).toHaveCount(1);
  await props.locator('.bgimg-box .bgimg-btn').last().click();
  await expect(props.locator('.bgimg-box')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('Status bar hints follow held modifiers; first-run splash starts with Quick Setup', async ({ page }) => {
  const errors = await openApp(page);
  const v = page.locator('.area[data-editor="VIEW_3D"] .area-main').first();
  const box = (await v.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const hints = page.locator('.statusbar .sb-hints');
  await expect(hints).toContainText('Rotate View');
  await page.keyboard.down('Shift');
  await expect(hints).toContainText('Set 3D Cursor');
  await expect(hints).toContainText('Pan View');
  await page.keyboard.up('Shift');
  await expect(hints).toContainText('Rotate View');
  // right-click on the status bar chooses its contents
  await page.locator('.statusbar').click({ button: 'right' });
  await expect(page.locator('.menu').last()).toContainText('Scene Statistics');
  await page.keyboard.press('Escape');
  // Quick Setup on the first run, then the regular splash
  await page.evaluate(async () => {
    localStorage.removeItem('3d.quick_setup_done');
    (await import('/src/ui/topbar.ts' as any)).showSplash({ startup: true });
  });
  const qs = page.locator('.splash .qs');
  await expect(qs).toBeVisible();
  await qs.locator('.enum-row button', { hasText: 'Search' }).click();
  expect(await page.evaluate(async () => (await import('/src/prefs/keyconfig.ts' as any)).keyconfig.data.options.spacebar_action)).toBe('SEARCH');
  await qs.locator('.enum-row button', { hasText: 'Play' }).click();
  await qs.locator('.qs-next').click();
  await expect(page.locator('.splash .splash-cols')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('3d.quick_setup_done'))).toBe('1');
  await expectNoErrors(errors);
});
