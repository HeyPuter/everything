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
