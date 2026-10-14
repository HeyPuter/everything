import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test('work survives a reload without an account', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Metric project/ }).click();
  await page.evaluate(() => {
    const bd = window.bd;
    const [l1, l2] = bd.doc.levels();
    bd.commit('Wall', () => bd.doc.add({ kind: 'wall', typeId: 'wt-generic', levelId: l1.id, topLevelId: l2.id, a: [0, 0], b: [5000, 0], baseOffset: 0, topOffset: 0, height: 3000, locationLine: 'center' }));
    bd.openView(bd.doc.all('view3d')[0].id);
  });
  // The recovery copy is written shortly after the edit.
  await page.waitForTimeout(2000);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.bd?.doc?.count('wall') ?? -1)).toBe(1);
  await expect(page.locator('.vtab.active')).toContainText('3D View');
  // Unsaved work is still marked as modified.
  expect(await page.evaluate(() => window.bd.doc.modified)).toBe(true);
});
