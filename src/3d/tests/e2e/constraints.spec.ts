// Constraint stacks in the Properties editor: add menus, panel menus, hover shortcuts, apply and
// disable-and-keep-transform.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, hoverViewport } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const item = (page: Page, text: string) => page.locator('.menu-item').filter({ has: page.getByText(text, { exact: true }) });

/** Cube active, an Empty at (3, 0, 0) also selected. */
async function setup(page: Page) {
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.empty_add', { location: [3, 0, 0] }, { invoke: false });
    const e = a.activeObject;
    a.flush();
    const cube = Object.values(a.doc.objects).find((o: any) => o.name === 'Cube') as any;
    for (const o of Object.values(a.doc.objects) as any[]) o.select = false;
    cube.select = true;
    e.select = true;
    a.doc.scene.active_object = cube.id;
    a.changed('doc', 'select');
  });
}

async function openTab(page: Page, tab: string) {
  await page.locator(`.rail-tab[data-tab="${tab}"]`).click();
}

const cubeLoc = (page: Page) => get(page, `(() => { const c = Object.values(app.doc.objects).find((o) => o.name === 'Cube'); const e = app.graph.get(c.id).world.elements; return [e[12], e[13], e[14]].map((v) => Math.round(v * 1000) / 1000); })()`) as Promise<number[]>;

test('object constraints: add menu, panel menu, hover shortcuts and apply', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page);
  await openTab(page, 'CONSTRAINT');
  await page.locator('.add-mod', { hasText: 'Add Object Constraint' }).dispatchEvent('pointerdown');
  await item(page, 'Tracking').first().hover();
  for (const l of ['Clamp To', 'Damped Track', 'Locked Track', 'Stretch To', 'Track To']) await expect(item(page, l).first()).toBeVisible();
  await expect(item(page, 'Inverse Kinematics')).toHaveCount(0);
  await item(page, 'Transform').first().hover();
  await item(page, 'Copy Location').first().click();
  const panel = page.locator('[data-con="Copy Location"]');
  await expect(panel).toBeVisible();
  // pick the target
  await panel.locator('.enum-menu').first().dispatchEvent('pointerdown');
  await item(page, 'Empty').first().click();
  await expect.poll(() => cubeLoc(page)).toEqual([3, 0, 0]);
  // Shift D over the panel duplicates it with a unique name
  await panel.locator('.sr-label', { hasText: 'Axis' }).hover();
  await page.keyboard.press('Shift+D');
  await expect(page.locator('[data-con="Copy Location.001"]')).toBeVisible();
  // the panel menu
  await panel.locator('.mod-menu').dispatchEvent('pointerdown');
  for (const l of ['Apply', 'Duplicate', 'Copy to Selected', 'Move to First', 'Move to Last']) await expect(item(page, l).first()).toBeVisible();
  await item(page, 'Apply').first().click();
  expect(await get(page, 'app.activeObject.constraints.map((c) => c.name)')).toEqual(['Copy Location.001']);
  expect((await get(page, 'app.activeObject.location')) as number[]).toEqual([3, 0, 0]);
  // X over a panel deletes it
  await page.locator('[data-con="Copy Location.001"] .sr-label', { hasText: 'Axis' }).hover();
  await page.keyboard.press('x');
  await expect(page.locator('[data-con]')).toHaveCount(0);
  // Object > Constraint > Add Constraint (with Targets) asks for the type, then targets the other selected object
  await page.locator('.hdr-menu', { hasText: /^Object$/ }).first().dispatchEvent('pointerdown');
  await item(page, 'Constraint').first().hover();
  await item(page, 'Add Constraint (with Targets)').first().click();
  await item(page, 'Track To').first().click();
  expect(await get(page, `app.activeObject.constraints.map((c) => [c.type, app.doc.objects[c.target]?.name])`)).toEqual([['TRACK_TO', 'Empty']]);
  await expectNoErrors(errors);
});

test('disable and keep transform, invalid constraints and the bone constraint menu', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page);
  await page.evaluate(() => (window as any).app.run('object.constraint_add_with_targets', { type: 'COPY_LOCATION' }, { invoke: false }));
  await openTab(page, 'CONSTRAINT');
  await expect.poll(() => cubeLoc(page)).toEqual([3, 0, 0]);
  await page.locator('[data-con="Copy Location"] [data-op="constraint.disable_keep_transform"]').click();
  expect(await get(page, 'app.activeObject.constraints[0].influence')).toBe(0);
  await expect.poll(() => cubeLoc(page)).toEqual([3, 0, 0]);
  // a type without its target shows as invalid
  await page.evaluate(() => (window as any).app.run('object.constraint_add', { type: 'CLAMP_TO' }, { invoke: false }));
  await expect(page.locator('[data-con="Clamp To"].invalid')).toBeVisible();

  // Affect Transform: moving the object stays inside the limits
  await page.evaluate(() => {
    const a = (window as any).app;
    a.activeObject.constraints = [];
    a.run('object.constraint_add', { type: 'LIMIT_LOCATION' }, { invoke: false });
    Object.assign(a.activeObject.constraints[0], { use_max_x: true, max_x: 1, use_transform_limit: true });
    a.activeObject.location = [0, 0, 0];
    a.changed('doc');
  });
  await expect(page.locator('[data-con="Limit Location"]').getByText('Affect Transform')).toBeVisible();
  await page.evaluate(() => (window as any).app.run('transform.translate', { value: [5, 0, 0] }, { invoke: false }));
  expect(((await get(page, 'app.activeObject.location')) as number[])[0]).toBeCloseTo(1, 4);

  // pose bones offer the IK solvers in the Tracking group
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.armature_add', {}, { invoke: false });
    a.flush();
    a.run('object.mode_set', { mode: 'POSE' });
  });
  // Shift I: IK with a new empty as target
  await hoverViewport(page);
  await page.keyboard.press('Shift+I');
  await expect(item(page, 'Without Targets')).toBeVisible();
  await item(page, 'To New Empty Object').click();
  expect(await get(page, `(() => { const pb = app.activeObject.pose[app.doc.armatures[app.activeObject.data].active_bone]; const c = pb.constraints[0]; return [c.type, app.doc.objects[c.target].type]; })()`)).toEqual(['IK', 'EMPTY']);
  await openTab(page, 'BONE_CONSTRAINT');
  await page.locator('.add-mod', { hasText: 'Add Bone Constraint' }).dispatchEvent('pointerdown');
  await item(page, 'Tracking').first().hover();
  await expect(item(page, 'Inverse Kinematics').first()).toBeVisible();
  await expect(item(page, 'Spline IK').first()).toBeVisible();
  await item(page, 'Spline IK').first().click();
  await expect(page.locator('[data-con="Spline IK"]')).toBeVisible();
  await expect(page.locator('[data-con="Inverse Kinematics"] .sr-label', { hasText: 'Chain Length' })).toBeVisible();
  // the Bone tab has the bone's IK settings
  await openTab(page, 'BONE');
  await expect(page.locator('[data-panel="bone-ik"]')).toBeVisible();
  await expectNoErrors(errors);
});
