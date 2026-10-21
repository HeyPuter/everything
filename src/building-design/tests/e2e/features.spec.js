import { test, expect } from '@playwright/test';
import { openApp, inkCoverage } from './helpers.js';

test('every ribbon tab shows its tools without errors', async ({ page }) => {
  const errors = await openApp(page, '?sample');
  const tabs = page.locator('.ribbon [role="tab"]');
  const n = await tabs.count();
  expect(n).toBeGreaterThan(8);
  for (let i = 0; i < n; i++) {
    const tab = tabs.nth(i);
    if (!(await tab.isVisible())) continue;
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
  expect(errors).toEqual([]);
});

test('dialogs for settings, collaboration and analysis open and close', async ({ page }) => {
  const errors = await openApp(page, '?sample');
  const commands = ['options', 'shortcuts', 'worksets', 'designOptions', 'globalParams', 'lineStyles', 'sunSettings', 'zones', 'syncHistory', 'manageLinks', 'phases', 'objectStyles'];
  for (const cmd of commands) {
    await page.evaluate((c) => window.bd.run(c), cmd);
    const dialog = page.locator('dialog[open]');
    await expect(dialog, cmd).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog, cmd).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test('views can be tiled side by side and drawn', async ({ page }) => {
  const errors = await openApp(page, '?sample');
  await page.evaluate(() => {
    const app = window.bd;
    app.open3D();
    app.openView(app.doc.all('elevation')[0].id);
    app.run('tileViews');
  });
  expect(await page.evaluate(() => window.bd.viewport.tiles.length)).toBe(3);
  expect(await inkCoverage(page)).toBeGreaterThan(0.01);
  // Clicking a tile makes its view active.
  const target = await page.evaluate(() => {
    const t = window.bd.viewport.tiles.find((x) => x.viewId !== window.bd.activeViewId);
    const r = window.bd.shell.overlay.getBoundingClientRect();
    return { id: t.viewId, x: r.left + t.x + t.w / 2, y: r.top + t.y + t.h / 2 };
  });
  await page.mouse.click(target.x, target.y);
  expect(await page.evaluate(() => window.bd.activeViewId)).toBe(target.id);
  await page.evaluate(() => window.bd.run('tabViews'));
  expect(await page.evaluate(() => window.bd.viewport.tiled)).toBe(false);
  expect(errors).toEqual([]);
});

test('3D shadows, render and model elements from the newer tabs draw without errors', async ({ page }) => {
  const errors = await openApp(page, '?sample');
  await page.evaluate(() => {
    const app = window.bd;
    const doc = app.doc;
    const L = doc.levels()[0].id;
    app.commit('things', () => {
      doc.add({ kind: 'truss', typeId: 'tt-pratt', levelId: L, a: [15000, 0], b: [24000, 0], offset: 2800 });
      doc.add({ kind: 'modelText', levelId: L, at: [15000, -3000], rotation: 0, text: 'TEST', size: 400, depth: 40, plane: 'vertical', offset: 0 });
      doc.add({ kind: 'wallSweep', wallId: doc.all('wall')[0].id, typeId: 'swt-band', side: 'exterior', z: 600 });
      doc.add({ kind: 'duct', typeId: 'dct-rect', levelId: L, a: [15000, 4000], b: [20000, 4000], offset: 2700 });
    });
    app.open3D();
    app.run('shadows');
  });
  expect(await inkCoverage(page)).toBeGreaterThan(0.01);
  await page.evaluate(() => window.bd.run('render'));
  await page.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(page.locator('.render-preview img')).toBeVisible();
  expect(errors).toEqual([]);
});
