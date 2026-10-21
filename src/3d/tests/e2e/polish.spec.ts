import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors, objectNames } from './helpers';

const press = (page: Page, sel: string) => page.locator(sel).first().dispatchEvent('pointerdown');
const toolSettings = (page: Page) => page.evaluate(() => (window as any).app.doc.scene.tool_settings); // eslint-disable-line @typescript-eslint/no-explicit-any

test('3D view header floats over the viewport; Options popover holds transform and mesh options', async ({ page }) => {
  const errors = await openApp(page);
  const area = page.locator('.area[data-editor="VIEW_3D"]').first();
  // the main region fills the whole area under the headers
  const [a, m] = await Promise.all([area.boundingBox(), area.locator('.area-main').boundingBox()]);
  expect(Math.round(m!.y)).toBe(Math.round(a!.y));
  // Object Mode options: affect only origins / locations / parents
  await press(page, '.th-options');
  const pop = page.locator('.popover.ui, .popover').filter({ hasText: 'Affect Only' });
  await expect(pop).toBeVisible();
  await pop.locator('.checkbox', { hasText: 'Origins' }).dispatchEvent('pointerdown');
  expect((await toolSettings(page)).use_transform_data_origin).toBe(true);
  // Escape closes the popover
  await page.keyboard.press('Escape');
  await expect(page.locator('.popup-layer > .popover')).toHaveCount(0);
  // Edit Mode: select modes sit right after the mode selector, symmetry at the right of the tool settings
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  const hdr = area.locator('.area-header');
  await expect(hdr.locator('.hdr-mode')).toContainText('Edit Mode');
  const order = await hdr.locator('.hdr-mode, .select-modes, .hdr-menu').evaluateAll((els) => els.map((e) => (e.classList.contains('select-modes') ? 'modes' : e.textContent?.trim())));
  expect(order.slice(0, 3)).toEqual(['Edit Mode', 'modes', 'View']);
  await expect(area.locator('.area-toolheader .th-right .mesh-symmetry')).toBeVisible();
  await press(page, '.th-options');
  await page.locator('.popover .checkbox', { hasText: 'Auto Merge Vertices' }).dispatchEvent('pointerdown');
  expect((await toolSettings(page)).use_mesh_automerge).toBe(true);
  await expect(page.locator('.popover .num-field', { hasText: 'Threshold' })).toBeVisible();
  await expectNoErrors(errors);
});

test('Add menu search row finds entries in submenus', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Shift+A');
  const menu = page.locator('.menu').first();
  await expect(menu.locator('.menu-title')).toHaveText('Add');
  await expect(menu.locator('.menu-search')).toBeVisible();
  // typing starts a search over every entry, submenus included
  await page.keyboard.press('i');
  await page.keyboard.type('cosph');
  const hit = page.locator('.search-popup .menu-item', { hasText: 'Ico Sphere' }).first();
  await expect(hit).toBeVisible();
  await expect(hit.locator('.mi-path')).toContainText('Mesh');
  await page.keyboard.press('Enter');
  expect(await objectNames(page)).toContain('Icosphere');
  await expectNoErrors(errors);
});

test('menu entries carry operator icons and tooltips with shortcut and scripting call', async ({ page }) => {
  const errors = await openApp(page);
  const area = page.locator('.area[data-editor="VIEW_3D"]').first();
  await area.locator('.hdr-menu', { hasText: /^Object$/ }).dispatchEvent('pointerdown');
  const copy = page.locator('.menu-item', { hasText: 'Copy Objects' });
  await expect(copy.locator('.mi-icon [data-icon="copydown"]')).toHaveCount(1);
  await expect(page.locator('.menu-item', { hasText: 'Constraints' }).locator('[data-icon="constraint"]')).toHaveCount(1);
  await page.locator('.menu-item', { hasText: 'Duplicate Linked' }).hover();
  const tip = page.locator('.tooltip');
  await expect(tip).toContainText('Shortcut: Alt D');
  await expect(tip).toContainText('bpy.ops.object.duplicate_move_linked()');
  await expectNoErrors(errors);
});

test('status bar: mouse hints, statistics and its right-click menu', async ({ page }) => {
  const errors = await openApp(page);
  const bar = page.locator('.statusbar');
  await expect(bar.locator('.sb-mouse [data-icon="mouse_lmb"]')).toHaveCount(1);
  // the hints follow the editor under the pointer
  const ol = await page.locator('.area[data-editor="OUTLINER"]').first().boundingBox();
  await page.mouse.move(ol!.x + ol!.width / 2, ol!.y + ol!.height - 10);
  await expect(bar.locator('.sb-hints')).toContainText('Pan View');
  await hoverViewport(page);
  await expect(bar.locator('.sb-hints')).toContainText('Rotate View');
  await expect(bar.locator('.sb-stats')).toContainText('Collection | Cube | Verts:8 | Faces:6 | Tris:12 | Objects:1/3');
  await bar.locator('.sb-right').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Scene Duration' }).click();
  await expect(bar.locator('.sb-duration')).toContainText('Duration: 00:10.42 (Frame 1/250)');
  await bar.locator('.sb-right').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Scene Statistics' }).click();
  await expect(bar.locator('.sb-stats')).toHaveCount(0);
  // put the defaults back for other tests sharing the stored preferences
  await bar.locator('.sb-right').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Scene Statistics' }).click();
  await bar.locator('.sb-right').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Scene Duration' }).click();
  await expectNoErrors(errors);
});

test('timeline header: keying options under the auto keying dropdown, joined frame range', async ({ page }) => {
  const errors = await openApp(page);
  const tl = page.locator('.area[data-editor="TIMELINE"] .area-header');
  await expect(tl.locator('.hdr-menu', { hasText: 'Playback' })).toBeVisible();
  await tl.locator('.keying-drop').dispatchEvent('pointerdown');
  await expect(page.locator('.popover')).toContainText('Only Active Keying Set');
  await page.keyboard.press('Escape');
  await expect(tl.locator('.tl-range .tl-preview')).toHaveCount(1);
  await expect(tl.locator('.tl-range .num-field')).toHaveCount(2);
  await expectNoErrors(errors);
});

test('pie menus show the number key of each direction', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.down('z');
  const solid = page.locator('.pie-item', { hasText: 'Solid' });
  await expect(solid.locator('.pie-num')).toHaveText('6');
  await expect(solid).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await page.keyboard.up('z');
  await expect(page.locator('.pie')).toHaveCount(0);
  await expectNoErrors(errors);
});
