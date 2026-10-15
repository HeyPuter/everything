import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, viewportCenter } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Win = { app: any };

/** Open the "Assets" workspace from the "+" workspace menu. */
async function openAssetsWorkspace(page: Page) {
  await page.locator('.ws-add').dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: /^General/ }).hover();
  await page.locator('.menu .menu-item', { hasText: /^Assets$/ }).click();
  await expect(page.locator('.asset-browser')).toBeVisible();
}

const item = (page: Page, name: string) => page.locator(`.ab-item[data-name="${name}"]`);

/** Drag an asset from the browser to a client point (with intermediate moves for the drop hint). */
async function dragAsset(page: Page, name: string, x: number, y: number) {
  await page.locator('.ab-filter input').fill(name);
  const b = (await item(page, name).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 20, b.y + 10, { steps: 3 });
  await page.mouse.move(x, y, { steps: 6 });
  await expect(page.locator('.ab-drag')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.ab-drag')).toHaveCount(0);
  await page.locator('.ab-filter input').fill('');
  await page.locator('.ab-filter input').press('Escape');
}

test('assets: Essentials in the Assets workspace, dropped on the cube and on the ground', async ({ page }) => {
  const errors = await openApp(page);
  await openAssetsWorkspace(page);
  await expect(page.locator('.ab-lib.on')).toHaveAttribute('data-lib', 'ESSENTIALS');
  // previews are rendered with the app's renderer
  await expect(item(page, 'Polished Gold').locator('img')).toBeVisible();
  // catalogs filter the grid
  await page.locator('.ab-cat', { hasText: /^Metal/ }).click();
  await expect(page.locator('.ab-item')).toHaveCount(3);
  await page.locator('.ab-cat', { hasText: /^All/ }).click();
  const c = await viewportCenter(page);
  await dragAsset(page, 'Polished Gold', c.x, c.y);
  const mat = () => page.evaluate(() => {
    const a = (window as unknown as Win).app;
    const cube: any = Object.values(a.doc.objects).find((o: any) => o.name === 'Cube');
    return a.doc.materials[a.doc.meshes[cube.data].materials[0]].name;
  });
  expect(await mat()).toBe('Polished Gold');
  await dragAsset(page, 'Pedestal', c.box.x + 120, c.box.y + c.box.height - 60);
  const ped = await page.evaluate(() => (Object.values((window as unknown as Win).app.doc.objects) as any[]).find((o) => o.name === 'Pedestal')?.location);
  expect(ped).toBeTruthy();
  expect(Math.abs(ped[2])).toBeLessThan(1e-4);
  // the drop is one undo step
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => (Object.values((window as unknown as Win).app.doc.objects) as any[]).some((o) => o.name === 'Pedestal'))).toBe(false);
  expect(await mat()).toBe('Polished Gold');
  await expectNoErrors(errors);
});

test('assets: mark from the Object menu, edit metadata, file into a catalog, clear from the Outliner', async ({ page }) => {
  const errors = await openApp(page);
  await openAssetsWorkspace(page);
  const c = await viewportCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.locator('.area[data-editor="VIEW_3D"] .hdr-menu', { hasText: /^Object$/ }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: /^Asset/ }).hover();
  await page.locator('.menu .menu-item', { hasText: 'Mark as Asset' }).click();
  await page.locator('.ab-lib[data-lib="LOCAL"]').click();
  await expect(item(page, 'Cube')).toBeVisible();
  await expect(item(page, 'Cube').locator('img')).toBeVisible();
  await item(page, 'Cube').click();
  // metadata
  await page.locator('.ab-details textarea[data-field="description"]').fill('A plain box');
  await page.locator('.ab-details textarea[data-field="description"]').blur();
  await page.locator('.ab-details input[data-field="author"]').fill('Me');
  await page.locator('.ab-details input[data-field="author"]').press('Enter');
  await page.locator('.ab-tag-add').click();
  const meta = () => page.evaluate(() => (Object.values((window as unknown as Win).app.doc.objects) as any[]).find((o) => o.name === 'Cube')?.asset_data);
  await expect.poll(async () => (await meta())?.tags).toEqual(['Tag']);
  expect((await meta()).description).toBe('A plain box');
  expect((await meta()).author).toBe('Me');
  // a new catalog, renamed in place
  await page.locator('.ab-side-title', { hasText: 'Catalogs' }).locator('.ab-side-add').click();
  await page.locator('.ab-cat', { hasText: /^Catalog/ }).dblclick();
  await page.locator('.ab-cat-rename').fill('Props');
  await page.locator('.ab-cat-rename').press('Enter');
  await expect(page.locator('.ab-cat', { hasText: /^Props/ })).toBeVisible();
  await page.locator('.ab-cat', { hasText: /^All/ }).click();
  // drag the asset onto the catalog
  const target = (await page.locator('.ab-cat', { hasText: /^Props/ }).boundingBox())!;
  const b = (await item(page, 'Cube').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 8 });
  await expect(page.locator('.ab-drag-hint')).toContainText('Props');
  await page.mouse.up();
  await expect.poll(async () => {
    const m = await meta();
    const cats = await page.evaluate(() => (window as unknown as Win).app.doc.asset_catalogs);
    return cats.find((x: any) => x.id === m.catalog_id)?.path;
  }).toBe('Props');
  await page.locator('.ab-cat', { hasText: /^Unassigned/ }).click();
  await expect(page.locator('.ab-item')).toHaveCount(0);
  await page.locator('.ab-cat', { hasText: /^Props/ }).click();
  await expect(page.locator('.ab-item')).toHaveCount(1);
  // the Outliner's Assets submenu clears it
  await page.locator('.outliner .ol-row', { has: page.locator('.ol-name', { hasText: /^Cube$/ }) }).first().click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: /^Assets/ }).hover();
  await page.locator('.menu .menu-item', { hasText: /^Clear Asset$/ }).click();
  await expect(page.locator('.ab-item')).toHaveCount(0);
  expect(await meta()).toBeUndefined();
  await expectNoErrors(errors);
});

test('assets: a user library keeps copied assets across reloads; node group assets in the Add menu', async ({ page }) => {
  const errors = await openApp(page);
  await openAssetsWorkspace(page);
  // mark the material through its data-block selector in the Material properties
  await page.locator('.rail-tab[data-tab="MATERIAL"]').click();
  await page.locator('.properties .id-selector').first().click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Mark as Asset' }).click();
  await page.locator('.ab-lib[data-lib="LOCAL"]').click();
  await expect(item(page, 'Material')).toBeVisible();
  await item(page, 'Material').click();
  await page.locator('.area[data-editor="ASSETS"] .hdr-menu', { hasText: /^Asset$/ }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Copy to Library' }).click();
  await page.locator('.menu .menu-item', { hasText: 'New Library' }).click();
  await page.locator('.prompt-input').fill('My Shelf');
  await page.locator('.prompt-input').press('Enter');
  const lib = page.locator('.ab-lib', { hasText: 'My Shelf' });
  await expect(lib).toBeVisible();
  await lib.click();
  await expect(item(page, 'Material')).toBeVisible();
  // stored in the browser: still there after a reload
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as Win).app);
  await openAssetsWorkspace(page);
  await page.locator('.ab-lib', { hasText: 'My Shelf' }).click();
  await expect(item(page, 'Material')).toBeVisible();
  // node group assets under their catalogs in the shader editor's Add menu
  await page.locator('.ws-tab', { hasText: 'Shading' }).click();
  const sh = (await page.locator('.area[data-editor="SHADER"]').boundingBox())!;
  await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2);
  await page.keyboard.press('Shift+A');
  await page.locator('.menu .menu-item', { hasText: /^Node Groups/ }).hover();
  await page.locator('.menu .menu-item', { hasText: /^Shading/ }).hover();
  await page.locator('.menu .menu-item', { hasText: 'Edge Tint' }).click();
  await page.mouse.click(sh.x + sh.width / 2 + 20, sh.y + sh.height / 2);
  const groups = await page.evaluate(() => {
    const a = (window as unknown as Win).app;
    const ma: any = Object.values(a.doc.materials)[0];
    return ma.tree.nodes.filter((n: any) => n.type === 'ShaderNodeGroup').map((n: any) => a.doc.node_groups[n.props.node_tree]?.name);
  });
  expect(groups).toEqual(['Edge Tint']);
  await expectNoErrors(errors);
});
