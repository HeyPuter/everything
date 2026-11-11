// Particles tab: the system list's specials menu, the boid brain (states, rules, relations), Use
// Count of collection instancing, and the Ocean / Explode / Dynamic Paint bake buttons.
import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors, type AppLike } from './helpers';

const showTab = (page: import('@playwright/test').Page, tab: string) =>
  page.evaluate((tab) => {
    (window as unknown as { __propertiesTab?: string }).__propertiesTab = tab;
    (window as unknown as { app: AppLike }).app.changed('ui');
  }, tab);

test('particle specials: duplicate, copy to selected and remove all', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    a.run('object.particle_system_add');
  });
  await showTab(page, 'PARTICLES');
  const list = page.locator('.uilist').first();
  await expect(list.locator('.ul-row')).toHaveCount(1);
  // the specials menu next to the list
  await page.locator('.ul-specials').first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Duplicate Particle System' }).click();
  await expect(list.locator('.ul-row')).toHaveCount(2);
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    const src = a.activeObject!;
    a.run('mesh.primitive_plane_add', {}, { invoke: false });
    const plane = a.activeObject!;
    src.select = true;
    (a as unknown as { activeObject: unknown }).activeObject = src;
    a.changed('select');
    a.flush();
    const res = a.run('particle.copy_particle_systems', { use_active: false }, { invoke: false });
    const copied = plane.particle_systems.length;
    a.run('particle.particle_system_remove_all', {}, { invoke: false });
    return { res, copied, left: src.particle_systems.length, mods: src.modifiers.filter((m: { type: string }) => m.type === 'PARTICLE_SYSTEM').length };
  });
  expect(r).toEqual({ res: 'FINISHED', copied: 2, left: 0, mods: 0 });
  await expectNoErrors(errors);
});

test('boid brain: rules from the + menu, states and relations', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    a.run('object.particle_system_add');
    const ps = a.activeObject!.particle_systems[0];
    a.doc.particles[ps.settings].physics_type = 'BOIDS';
    a.changed('doc');
  });
  await showTab(page, 'PARTICLES');
  const brain = page.locator('[data-panel="pa-boid-brain"]');
  await expect(brain).toBeVisible();
  const rules = brain.locator('.uilist').nth(1);
  await expect(rules.locator('.ul-row')).toHaveCount(2);
  await rules.locator('.ul-side button').first().click();
  await page.locator('.menu .menu-item', { hasText: 'Fight' }).click();
  await expect(rules.locator('.ul-row')).toHaveCount(3);
  await expect(brain.getByText('Fight Distance')).toBeVisible();
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    a.run('boid.rule_move_up');
    a.run('boid.state_add');
    a.run('particle.new_target');
    const ps = a.activeObject!.particle_systems[0];
    const b = a.doc.particles[ps.settings].boids;
    return { rules: b.states[0].rules.map((x: { type: string }) => x.type), states: b.states.length, active: b.active_boid_state_index, targets: ps.targets.length };
  });
  expect(r).toEqual({ rules: ['SEPARATE', 'FIGHT', 'FLOCK'], states: 2, active: 1, targets: 1 });
  await expect(page.locator('[data-panel="pa-relations"] .ul-row')).toHaveCount(1);
  await expectNoErrors(errors);
});

test('ocean bake and explode refresh from their modifier panels', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    a.run('object.modifier_add', { type: 'OCEAN' });
    const m = a.activeObject!.modifiers.at(-1);
    Object.assign(m, { frame_start: 1, frame_end: 4, use_foam: true, viewport_resolution: 2, resolution: 2 });
    a.changed('doc');
  });
  await showTab(page, 'MODIFIER');
  const bakeBtn = page.locator('[data-op="object.ocean_bake"]').first();
  if (!(await bakeBtn.isVisible())) await page.getByText('Bake', { exact: true }).first().click();
  await expect(bakeBtn).toBeVisible();
  await bakeBtn.click();
  const cached = await page.evaluate(() => (window as unknown as { app: AppLike }).app.activeObject!.modifiers.at(-1).is_cached);
  expect(cached).toBe(true);
  await page.locator('[data-op="object.ocean_bake"]', { hasText: 'Delete Bake' }).first().click();
  expect(await page.evaluate(() => (window as unknown as { app: AppLike }).app.activeObject!.modifiers.at(-1).is_cached)).toBe(false);
  await expectNoErrors(errors);
});

test('dynamic paint image sequence bake writes images', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    const canvas = a.activeObject!;
    a.run('dpaint.type_toggle', { type: 'CANVAS' }, { invoke: false });
    const m = canvas.modifiers.find((x: { type: string }) => x.type === 'DYNAMIC_PAINT');
    const sf = m.canvas_settings.canvas_surfaces[0];
    Object.assign(sf, { surface_format: 'IMAGE', image_resolution: 64, use_output_b: true });
    sf.point_cache.frame_end = 6;
    a.run('mesh.primitive_uv_sphere_add', { radius: 0.5, location: [0.9, 0, 0] }, { invoke: false });
    a.run('dpaint.type_toggle', { type: 'BRUSH' }, { invoke: false });
    (a as unknown as { activeObject: unknown }).activeObject = canvas;
    a.changed('doc');
    const res = a.run('dpaint.bake', {}, { invoke: false });
    return { res, images: Object.values(a.doc.images).map((i: { name: string; width: number }) => [i.name, i.width]).sort() };
  });
  expect(r).toEqual({
    res: 'FINISHED',
    images: [
      ['dp_paintmap', 64],
      ['dp_wetmap', 64],
    ],
  });
  await showTab(page, 'PHYSICS');
  await expect(page.locator('[data-op="dpaint.bake"]').first()).toBeVisible();
  await expectNoErrors(errors);
});

test('rigid body bake to keyframes keeps quaternion keys continuous', async ({ page }) => {
  const errors = await openApp(page);
  const flips = await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { loadRapier } = await import('/src/physics/engine.ts');
    await loadRapier();
    const { defaultRigidBody, defaultRigidBodyWorld } = await import('/src/physics/types.ts');
    const { newObject, newMeshData } = await import('/src/data/defaults.ts');
    const { plane } = await import('/src/mesh/primitives.ts');
    const doc = app.doc;
    doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 250);
    const me = newMeshData('G', plane(40));
    doc.meshes[me.id] = me;
    const g = newObject('Ground', 'MESH', me.id);
    g.rotation_euler = [0.5, 0, 0];
    g.rigid_body = defaultRigidBody('PASSIVE');
    doc.objects[g.id] = g;
    doc.object_order.push(g.id);
    doc.collections[doc.scene.collection].objects.push(g.id);
    // a ball rolling down a slope turns far enough for decomposed quaternions to change sign
    const ball = app.activeObject;
    ball.location = [0, 5, 6];
    ball.rotation_mode = 'QUATERNION';
    ball.rigid_body = { ...defaultRigidBody('ACTIVE'), collision_shape: 'SPHERE', friction: 1 };
    app.run('object.select_all', { action: 'DESELECT' }, { invoke: false });
    ball.select = true;
    app.run('rigidbody.bake_to_keyframes', { frame_start: 1, frame_end: 200, step: 1 }, { invoke: false });
    const act = doc.actions[ball.animation_data.action];
    const q = [0, 1, 2, 3].map((i) => act.fcurves.find((f: any) => f.data_path === 'rotation_quaternion' && f.array_index === i).keyframe_points.map((k: any) => k.co[1])); // eslint-disable-line @typescript-eslint/no-explicit-any
    let n = 0;
    for (let f = 1; f < q[0].length; f++) if (q[0][f] * q[0][f - 1] + q[1][f] * q[1][f - 1] + q[2][f] * q[2][f - 1] + q[3][f] * q[3][f - 1] < 0) n++;
    return [q[0].length, n];
  });
  expect(flips).toEqual([200, 0]);
  await expectNoErrors(errors);
});

test('a physics engine that fails to download is reported, not thrown', async ({ page }) => {
  const errors = await openApp(page);
  await page.route(/rapier/i, (r) => r.abort());
  const reports = await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.run('rigidbody.object_add', {}, { invoke: false });
    app.setFrame(20);
    app.flush();
    await new Promise((r) => setTimeout(r, 800));
    app.run('ptcache.bake_all', { bake: true }, { invoke: false });
    await new Promise((r) => setTimeout(r, 800));
    return app.reports.filter((x: { type: string }) => x.type === 'ERROR').map((x: { message: string }) => x.message);
  });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/physics engine could not be loaded/);
  await expectNoErrors(errors.filter((e) => !/Failed to load resource/.test(e)));
});

test('a bake that does not fit in the cache memory budget stops with a report', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { cacheMemory } = await import('/src/physics/common.ts');
    const was = cacheMemory.budget;
    app.run('object.modifier_add', { type: 'CLOTH' }, { invoke: false });
    const mod = app.activeObject.modifiers.find((m: { type: string }) => m.type === 'CLOTH');
    // room for a few frames of the cube's cloth
    cacheMemory.budget = 8 * 4 * 3 * 5;
    try {
      app.run('ptcache.bake_all', { bake: true }, { invoke: false });
    } finally {
      cacheMemory.budget = was;
    }
    return { baked: mod.point_cache.is_baked, errors: app.reports.filter((x: { type: string }) => x.type === 'ERROR').map((x: { message: string }) => x.message) };
  });
  expect(r.baked).toBe(false);
  expect(r.errors.join()).toMatch(/Bake stopped at frame \d+/);
  await expectNoErrors(errors);
});
