import { expect, test } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { newLayerComp } from '../../src/model/layer-comps';
import { boot, idle, openImage, openProject, panel } from './helpers';

test('applying layer comps from the keyboard retains focus for the next choice', async ({ page }) => {
  await boot(page);
  const doc = newDocument(16, 16, 'Comps');
  doc.layers = [layer('solid', 'Square', 16, 16)];
  const capture = { visibility: true, position: true, appearance: true };
  const first = newLayerComp(doc, 'First', capture);
  doc.layers[0].opacity = 0.25;
  const second = newLayerComp(doc, 'Second', capture);
  doc.layerComps = [first, second];
  doc.layers[0].opacity = 0.5;
  await openProject(page, doc);
  const body = await panel(page, 'Layer Comps');
  await idle(page);
  const firstButton = body.getByRole('button', { name: 'Apply First', exact: true });
  const secondButton = body.getByRole('button', { name: 'Apply Second', exact: true });
  await firstButton.focus();
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(1);
  await expect(firstButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(secondButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(firstButton).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(0.25);
  await expect(secondButton).toBeFocused();
});

test('Tab from the canvas still toggles panel visibility', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 16);
  await page.locator('#viewport').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.photoStudio.root.classList.contains('panels-hidden'))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.photoStudio.root.classList.contains('panels-hidden'))).toBe(false);
});

test('Tab from a document tab navigates to its close button', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 16);
  const tab = page.locator('.document-tab.active');
  await tab.focus();
  await page.keyboard.press('Tab');
  await expect(tab.locator('.tab-close')).toBeFocused();
  expect(await page.evaluate(() => window.photoStudio.root.classList.contains('panels-hidden'))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(tab).toBeFocused();
});
