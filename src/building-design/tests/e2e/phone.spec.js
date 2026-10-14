import { test, expect } from '@playwright/test';
import { openApp, inkCoverage } from './helpers.js';

test('the phone layout shows the canvas, toolbar and sheets', async ({ page }) => {
  await openApp(page, '?sample');
  const canvas = page.locator('.canvas-wrap');
  const box = await canvas.boundingBox();
  expect(box.width).toBeGreaterThan(300);
  expect(await inkCoverage(page)).toBeGreaterThan(0.01);
  await expect(page.locator('.phonebar')).toBeVisible();
  await page.locator('.pb-btn', { hasText: 'Properties' }).click();
  await expect(page.locator('.pane-props')).toBeVisible();
  await page.locator('.pb-btn', { hasText: 'Properties' }).click();
  await expect(page.locator('.pane-props')).toBeHidden();
  await page.locator('.pb-btn', { hasText: 'Tools' }).click();
  await expect(page.getByRole('dialog', { name: 'Tools' })).toBeVisible();
});
