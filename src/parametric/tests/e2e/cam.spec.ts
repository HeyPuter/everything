import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

type W = { __parametric: import('../../src/app/app').App };

test('machines a part from the CAM tab: setup, tools, operations, simulation and G-code', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Pipe Flange/ }).click();
  await page.waitForFunction(() => !!(window as unknown as W).__parametric.bbox);
  await page.getByRole('tab', { name: 'CAM' }).click();

  // A setup from the top.
  await page.locator('[data-cmd="cam:setup"]').click();
  await expect(page.getByRole('heading', { name: 'New Setup' })).toBeVisible();
  await expect(page.getByLabel('Tool direction')).toHaveValue('+Y');
  await page.locator('.confirm-corner .ok').click();
  await expect(page.getByRole('treeitem', { name: 'Setup1' })).toBeVisible();

  // A 7 mm drill for the bolt holes, added in the tool library.
  await page.locator('[data-cmd="cam:tools"]').click();
  const dialog = page.getByRole('dialog', { name: 'Tool Library' });
  await dialog.getByRole('button', { name: 'Add' }).click();
  await dialog.getByLabel('Type').selectOption('drill');
  const dia = dialog.getByRole('textbox', { name: 'Diameter' });
  await dia.fill('7');
  await dia.press('Tab');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('7 mm drill');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as W).__parametric.store.doc.cam!.tools.some((t) => t.type === 'drill' && t.diameter === 7))).toBe(true);

  // Drill: every hole of the drill's size.
  await page.locator('[data-cmd="cam:drill"]').click();
  await expect(page.getByLabel('Tool', { exact: true })).toContainText('7 mm drill');
  await expect(page.locator('.cam-stats')).toBeVisible({ timeout: 60_000 });
  await page.locator('.confirm-corner .ok').click();
  await expect(page.getByRole('treeitem', { name: /^Drill1/ })).toBeVisible();
  await page.waitForFunction(() => {
    const app = (window as unknown as W).__parametric;
    const s = app.store.doc.cam!.setups[0];
    return s.ops.every((o) => app.cam!.state(s, o) === 'ok');
  }, null, { timeout: 60_000 });
  expect(await page.evaluate(() => {
    const app = (window as unknown as W).__parametric;
    return app.cam!.result(app.store.doc.cam!.setups[0].ops[0].id)!.toolpath!.cycles.length;
  })).toBe(6);

  // A contour round the outside.
  await page.locator('[data-cmd="cam:contour"]').click();
  await expect(page.locator('.cam-stats')).toBeVisible({ timeout: 60_000 });
  await page.locator('.confirm-corner .ok').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as W).__parametric;
    const s = app.store.doc.cam!.setups[0];
    return s.ops.length === 2 && s.ops.every((o) => app.cam!.state(s, o) === 'ok');
  }, null, { timeout: 90_000 });

  // The simulation finds no collisions.
  await page.locator('[data-cmd="cam:simulate"]').click();
  await expect(page.getByText('No collisions')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByLabel('Program position')).toBeVisible();
  await page.getByRole('button', { name: 'Exit Simulation' }).click();

  // G-code with peck drilling cycles, downloaded.
  await page.locator('[data-cmd="cam:post"]').click();
  const post = page.getByRole('dialog', { name: 'Post Process' });
  await expect(post.getByLabel('G-code preview')).toContainText('G83', { timeout: 60_000 });
  await expect(post.getByLabel('G-code preview')).toContainText('T9 M6');
  const download = page.waitForEvent('download');
  await post.getByRole('button', { name: 'Download G-code' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.nc$/);
  const fs = await import('node:fs');
  const text = new TextDecoder().decode(fs.readFileSync((await file.path())!));
  expect(text).toMatch(/^%\nO1001 \(Pipe Flange\)/);
  expect(text).toContain('G21');

  // Undo takes the contour away, with its row.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('treeitem', { name: /^Contour1/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
