import { test, expect, type Locator } from '@playwright/test';
import { boot, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 160, 120, '#808080');
});

/** Commit an entry in a numeric field the way typing and Tab do. */
async function enter(field: Locator, text: string) {
  await field.fill(text);
  await field.press('Tab');
}

test('Perspective Planes fields keep the value in use for blank or out-of-range entries', async ({ page }) => {
  await start(page, 'filter.vanishing-point');
  const d = page.locator('dialog.perspective-dialog[open]');
  await expect(d).toBeVisible();
  const size = d.locator('#pp-size');
  const initial = await size.inputValue();
  await enter(size, '');
  await expect(size).toHaveValue(initial);
  await enter(size, '5000');
  await expect(size).toHaveValue('2000');
  await enter(d.locator('#pp-opacity'), '0');
  await expect(d.locator('#pp-opacity')).toHaveValue('1');
  await d.locator('.pp-cancel').click();
});

test('Wide Angle Correction fields keep the value in use for blank or out-of-range entries', async ({ page }) => {
  await start(page, 'filter.adaptive-wide-angle');
  const d = page.locator('dialog.wide-angle-dialog[open]');
  await expect(d).toBeVisible();
  const focal = d.locator('#wa-focal');
  const initial = await focal.inputValue();
  await enter(focal, '');
  await expect(focal).toHaveValue(initial);
  await enter(focal, '999');
  await expect(focal).toHaveValue('200');
  await enter(d.locator('#wa-scale'), '10');
  await expect(d.locator('#wa-scale')).toHaveValue('50');
  await d.locator('.wa-cancel').click();
});
