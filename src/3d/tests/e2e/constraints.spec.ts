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
  await item(page, 'Constraints').first().hover();
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

test('physics tab: dynamic paint canvas and brush, rigid body constraint limits, field types, cache buttons', async ({ page }) => {
  const errors = await openApp(page);
  // the cube becomes a dynamic paint brush through the Physics tab
  await openTab(page, 'PHYSICS');
  await page.locator('.phys-toggle', { hasText: 'Dynamic Paint' }).click();
  await page.locator('[data-panel="dp"] .enum-row button', { hasText: 'Brush' }).click();
  await page.locator('[data-panel="dp"] button', { hasText: 'Add Brush' }).click();
  await expect(page.locator('[data-panel="dp-brush-source"]')).toBeVisible();
  // a plane canvas under it
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('mesh.primitive_grid_add', { x_subdivisions: 10, y_subdivisions: 10, size: 4, location: [0, 0, 0] }, { invoke: false });
  });
  await page.locator('.phys-toggle', { hasText: 'Dynamic Paint' }).click();
  await page.locator('[data-panel="dp"] button', { hasText: 'Add Canvas' }).click();
  await expect(page.locator('[data-panel="dp-surface"]')).toBeVisible();
  await expect(page.locator('[data-panel="dp-cache"]')).toBeVisible();
  // the canvas gets painted where the cube intersects it
  await page.evaluate(() => (window as any).app.setFrame(3));
  await expect
    .poll(() => get(page, `(() => { const m = app.graph.get(app.activeObject.id).mesh; return m.colors ? Math.min(...Array.from(m.colors).filter((_, i) => i % 4 === 0)) : 1; })()`))
    .toBeLessThan(0.5);
  // Calculate to Frame keeps the cache unbaked
  await page.locator('[data-panel="dp-cache"] button', { hasText: 'Calculate to Frame' }).click();
  expect(await get(page, `app.activeObject.modifiers[0].canvas_settings.canvas_surfaces[0].point_cache.is_baked`)).toBe(false);
  await page.locator('[data-panel="dp-cache"] button', { hasText: 'Current Cache to Bake' }).click();
  expect(await get(page, `app.activeObject.modifiers[0].canvas_settings.canvas_surfaces[0].point_cache.is_baked`)).toBe(true);

  // rigid body constraint types show their limits
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.empty_add', { location: [0, 0, 3] }, { invoke: false });
    a.run('rigidbody.constraint_add', { type: 'GENERIC' }, { invoke: false });
  });
  await expect(page.locator('[data-panel^="ph-rbc-lim-"]')).toBeVisible();
  await page.evaluate(() => {
    const a = (window as any).app;
    a.activeObject.rigid_body_constraint.type = 'MOTOR';
    a.changed('doc');
  });
  await expect(page.locator('[data-panel^="ph-rbc-mot-"]')).toBeVisible();
  // the new field types are offered and get their settings
  await page.evaluate(() => (window as any).app.run('object.effector_add', { type: 'HARMONIC' }, { invoke: false }));
  await expect(page.locator('[data-panel="ph-field"] .sr-label', { hasText: 'Rest Length' })).toBeVisible();
  await expectNoErrors(errors);
});

test('quick liquid makes a liquid domain whose surface falls', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.hdr-menu', { hasText: /^Object$/ }).first().dispatchEvent('pointerdown');
  await item(page, 'Quick Effects').first().hover();
  await item(page, 'Quick Liquid').first().click();
  expect(await get(page, `[app.activeObject.name, app.activeObject.modifiers[0].domain_settings.domain_type]`)).toEqual(['Liquid Domain', 'LIQUID']);
  await openTab(page, 'PHYSICS');
  await expect(page.locator('[data-panel="ph-fl-liquid"]')).toBeVisible();
  await page.evaluate(() => (window as any).app.setFrame(12));
  await expect.poll(() => get(page, `app.graph.get(app.activeObject.id).mesh.offsets.length`), { timeout: 15000 }).toBeGreaterThan(10);
  await expectNoErrors(errors);
});

test('bone constraints apply into the pose and copy to selected bones', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.armature_add', {}, { invoke: false });
    a.flush();
    a.run('object.mode_set', { mode: 'EDIT' });
    a.run('armature.extrude_move', { TRANSFORM_OT_translate: { value: [0, 0, 1] } }, { invoke: false });
    a.run('object.mode_set', { mode: 'POSE' });
    const ob = a.activeObject;
    const arm = a.doc.armatures[ob.data];
    const names = arm.bones.map((b: any) => b.name);
    // a Limit Rotation pinning X to 0.5 rad on the first bone
    a.run('object.mode_set', { mode: 'POSE' });
    arm.active_bone = names[0];
    a.run('pose.constraint_add', { type: 'LIMIT_ROTATION' }, { invoke: false });
    const c = ob.pose[names[0]].constraints[0];
    Object.assign(c, { use_limit_x: true, min_x: 0.5, max_x: 0.5, owner_space: 'LOCAL' });
    a.flush();
    const r1 = a.run('constraint.apply', { constraint: c.name, owner: 'BONE' }, { invoke: false });
    const pb = ob.pose[names[0]];
    const q = pb.rotation_quaternion;
    // copy to the other selected bones
    a.run('pose.constraint_add', { type: 'COPY_SCALE' }, { invoke: false });
    for (const n of names) ob.pose[n].select = true;
    const c2 = ob.pose[names[0]].constraints[0];
    const r2 = a.run('constraint.copy_to_selected', { constraint: c2.name, owner: 'BONE' }, { invoke: false });
    return { names: names.length, r1, r2, q, left: ob.pose[names[0]].constraints.map((x: any) => x.type), other: names.length > 1 ? ob.pose[names[1]].constraints.map((x: any) => x.type) : [] };
  });
  expect(r.r1).toBe('FINISHED');
  // a 0.5 rad rotation around X became part of the pose
  expect(Math.abs(r.q[1])).toBeGreaterThan(0.2);
  expect(r.left).toEqual(['COPY_SCALE']);
  if (r.names > 1) expect(r.other).toEqual(['COPY_SCALE']);
  await expectNoErrors(errors);
});
