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
  // Play and Pause name the action, not a pressed state; one speed is chosen.
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).not.toHaveAttribute('aria-pressed');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(play).toBeVisible();
  expect(await page.getByLabel('Playback speed').evaluate((s) => [...(s as HTMLSelectElement).options].filter((o) => o.defaultSelected).length)).toBe(1);
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

test('CAM panels follow the tool library, deletions and the post settings', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Pipe Flange/ }).click();
  await page.waitForFunction(() => !!(window as unknown as W).__parametric.bbox);
  await page.getByRole('tab', { name: 'CAM' }).click();
  await page.locator('[data-cmd="cam:setup"]').click();
  await page.locator('.confirm-corner .ok').click();

  // A smaller tool chosen in the tool library while the operation is open previews again.
  await page.locator('[data-cmd="cam:contour"]').click();
  const length = page.locator('.cam-stats tr', { hasText: 'Cutting length' }).locator('td');
  await expect(length).toBeVisible({ timeout: 60_000 });
  const before = await length.innerText();
  await page.getByRole('button', { name: 'Tool Library...' }).click();
  const tools = page.getByRole('dialog', { name: 'Tool Library' });
  const dia = tools.getByRole('textbox', { name: 'Diameter' });
  await dia.fill('3');
  await dia.press('Tab');
  await tools.getByRole('button', { name: 'OK' }).click();
  await expect(length).not.toHaveText(before, { timeout: 60_000 });
  // OK keeps the toolpath previewed for these values instead of generating it again.
  await page.evaluate(() => {
    const c = (window as unknown as W).__parametric.cam!.client;
    const generate = c.generate.bind(c);
    (window as unknown as { generated: number }).generated = 0;
    c.generate = (...a) => { (window as unknown as { generated: number }).generated++; return generate(...a); };
  });
  await page.locator('.confirm-corner .ok').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as W).__parametric;
    const s = app.store.doc.cam!.setups[0];
    return s.ops.length === 1 && app.cam!.state(s, s.ops[0]) === 'ok';
  }, null, { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as { generated: number }).generated)).toBe(0);

  // Download pressed right after changing the controller writes that controller's program.
  await page.locator('[data-cmd="cam:post"]').click();
  const post = page.getByRole('dialog', { name: 'Post Process' });
  await expect(post.getByLabel('G-code preview')).toContainText('O1001', { timeout: 60_000 });
  const download = page.waitForEvent('download');
  await post.evaluate((dialog) => {
    const controller = dialog.querySelector('select')!;
    controller.value = 'grbl';
    controller.dispatchEvent(new Event('change', { bubbles: true }));
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Download G-code')!.click();
  });
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.gcode$/);
  const fs = await import('node:fs');
  expect(new TextDecoder().decode(fs.readFileSync((await file.path())!))).not.toContain('O1001');

  // An operation deleted from the tree while its panel is open is not brought back by OK.
  await page.getByRole('treeitem', { name: /^Contour1/ }).dblclick();
  await expect(page.getByRole('heading', { name: 'Contour1' })).toBeVisible();
  await page.locator('#left-tab-tree').click();
  await page.getByRole('treeitem', { name: /^Contour1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.confirm-corner .ok')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as W).__parametric.panel)).toBeNull();
  await expect(page.getByRole('treeitem', { name: /^Contour1/ })).toHaveCount(0);

  // A pocket preview still being made when its last floor is removed is not shown.
  await page.locator('[data-cmd="cam:pocket"]').click();
  await expect(page.getByRole('heading', { name: 'New 2D Pocket' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const app = (window as unknown as W).__parametric;
    type Panel = { o: { faces: unknown[] }; run(): Promise<void>; error: string | null; toolpath: unknown };
    const p = app.panel as unknown as Panel;
    const f = app.faces.find((x) => x.type === 'plane' && Math.abs(x.normal![1]) > 0.99)!;
    p.o.faces = [{ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }];
    const first = p.run();
    p.o.faces = [];
    await p.run();
    await first;
    return { error: p.error, toolpath: !!p.toolpath, shown: !!app.cam!.preview?.toolpath };
  })).toEqual({ error: 'Pick the floor faces of the pockets.', toolpath: false, shown: false });
  expect(errors).toEqual([]);
});
