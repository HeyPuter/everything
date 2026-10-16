import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sceneNames = (page: Page) => page.evaluate(() => [(window as any).app.doc.scene.name, ...Object.values((window as any).app.doc.scenes ?? {}).map((s: any) => s.name)].sort());
const activeScene = (page: Page) => page.evaluate(() => (window as any).app.doc.scene.name as string);

async function menuItem(page: Page, label: string) {
  await page.locator('.popup-layer .menu-item .mi-label').getByText(label, { exact: true }).first().click();
}

test('top bar: new scene, switch scenes, rename and delete', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.tbid-scene-new').click();
  await menuItem(page, 'Linked Copy');
  await expect.poll(() => activeScene(page)).toBe('Scene.001');
  await expect(page.locator('.tb-id-scene input')).toHaveValue('Scene.001');
  // the outliner shows the linked objects
  await expect(page.locator('.outliner .ol-row').filter({ hasText: 'Cube' }).first()).toBeVisible();
  await page.locator('.tbid-scene-new').click();
  await menuItem(page, 'New');
  await expect.poll(() => activeScene(page)).toBe('Scene.002');
  await expect(page.locator('.outliner .ol-row').filter({ hasText: 'Cube' })).toHaveCount(0);
  // browse back to the first scene
  await page.locator('.tbid-scene-browse').click();
  await menuItem(page, 'Scene');
  await expect.poll(() => activeScene(page)).toBe('Scene');
  await expect(page.locator('.outliner .ol-row').filter({ hasText: 'Cube' }).first()).toBeVisible();
  // rename
  const name = page.locator('.tb-id-scene input');
  await name.fill('Main');
  await name.press('Enter');
  await expect.poll(() => activeScene(page)).toBe('Main');
  // delete the active scene
  await page.locator('.tbid-scene-delete').click();
  await expect.poll(() => sceneNames(page)).toEqual(['Scene.001', 'Scene.002']);
  // undo brings it back
  await page.keyboard.press('Control+z');
  await expect.poll(() => sceneNames(page)).toEqual(['Main', 'Scene.001', 'Scene.002']);
  await expectNoErrors(errors);
});

test('top bar: view layers keep their own collection exclusion', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.tbid-layer-add').click();
  await menuItem(page, 'Blank');
  await expect(page.locator('.tb-id-layer input')).toHaveValue('ViewLayer.001');
  // the blank layer excludes the collection: its objects are not visible
  const visible = () => page.evaluate(() => Object.keys((window as any).app.doc.objects).filter((id) => (window as any).app.isVisible(id)).length);
  await expect.poll(visible).toBe(0);
  await page.locator('.tbid-layer-browse').click();
  await menuItem(page, 'ViewLayer');
  await expect(page.locator('.tb-id-layer input')).toHaveValue('ViewLayer');
  await expect.poll(visible).toBe(3);
  await page.locator('.tbid-layer-remove').click();
  await expect.poll(() => page.evaluate(() => (window as any).app.doc.scene.view_layers.map((l: any) => l.name))).toEqual(['ViewLayer.001']);
  await expectNoErrors(errors);
});

test('light linking: Ctrl L ▸ Link Receivers and the Object ▸ Shading list', async ({ page }) => {
  const errors = await openApp(page);
  // select the cube, then the light (active)
  await page.evaluate(() => {
    const a = (window as any).app;
    const obs = Object.values(a.doc.objects) as any[];
    for (const o of obs) o.select = o.name === 'Cube' || o.name === 'Light';
    a.doc.scene.active_object = obs.find((o) => o.name === 'Light').id;
    a.changed('select');
  });
  const box = await page.locator('.view3d').first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press('Control+l');
  await menuItem(page, 'Link Receivers');
  await menuItem(page, 'Exclude');
  await expect.poll(() => page.evaluate(() => Object.values((window as any).app.doc.collections).some((c: any) => c.name === 'Light Linking for Light'))).toBe(true);
  await page.locator('.rail-tab[data-tab="OBJECT"]').first().click();
  await page.locator('[data-panel="ob-shading"] > .panel-header').click();
  await expect(page.locator('.properties').getByText('Light Linking', { exact: true })).toBeVisible();
  await expect(page.locator('.properties .ll-state.exclude')).toHaveCount(1);
  // flip the state to include
  await page.locator('.properties .ll-state.exclude').click();
  await expect.poll(() => page.evaluate(() => Object.values((Object.values((window as any).app.doc.collections).find((c: any) => c.name === 'Light Linking for Light') as any).light_linking))).toEqual(['INCLUDE']);
  await expect(page.locator('.properties .ll-state.exclude')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('View Layer tab: light groups list with add and remove', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="VIEW_LAYER"]').first().click();
  const lg = page.locator('[data-panel="vl-lightgroups"]');
  await lg.locator('> .panel-header').click();
  await lg.locator('.ul-side button[data-tip="Add"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).app.doc.scene.view_layers[0].lightgroups.map((g: any) => g.name))).toEqual(['Lightgroup']);
  await expect(lg.getByText('Lightgroup', { exact: true })).toBeVisible();
  await expectNoErrors(errors);
});
