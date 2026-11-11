// Volumes and point clouds: Add menu wiring, Object Data tabs, modifiers, viewport display and
// Point Cloud Edit Mode.
import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors, hoverViewport, type AppLike } from './helpers';

test('Add ▸ Volume ▸ Empty and a Mesh to Volume modifier show a volume', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Shift+A');
  await page.locator('.menu .menu-item', { hasText: /^Volume$/ }).first().hover();
  const sub = page.locator('.menu').last();
  await expect(sub.locator('.menu-item')).toHaveText(['Import OpenVDB…', 'Empty']);
  await sub.locator('.menu-item', { hasText: 'Empty' }).click();
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    const cube = Object.values(a.doc.objects).find((o: { name: string }) => o.name === 'Cube') as { id: string };
    const vo = a.activeObject!;
    a.run('object.modifier_add', { type: 'MESH_TO_VOLUME' });
    vo.modifiers[0].object = cube.id;
    a.changed('doc');
    a.flush();
    return { type: vo.type, grids: a.graph.get(vo.id).mesh?.volume?.length };
  });
  expect(r).toEqual({ type: 'VOLUME', grids: 1 });
  await page.locator('.rail-tab[data-tab="DATA"]').click();
  await expect(page.locator('[data-panel="vo-grids"] .ul-row')).toHaveCount(1);
  await expect(page.locator('[data-panel="vo-display"]')).toBeVisible();
  await expectNoErrors(errors);
});

test('point clouds draw as spheres and edit with the Point Cloud keymap', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  await page.keyboard.press('Shift+A');
  await page.locator('.menu .menu-item', { hasText: /^Point Cloud$/ }).first().click();
  const n = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    a.flush();
    return { type: a.activeObject!.type, radii: a.graph.get(a.activeObject!.id).mesh?.pointRadius?.length };
  });
  expect(n).toEqual({ type: 'POINTCLOUD', radii: 400 });
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Alt+A');
  const sel = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    const pc = a.doc.pointclouds[a.activeObject!.data];
    const s = pc.attributes.find((x: { name: string }) => x.name === '.selection');
    return { mode: a.doc.mode, selected: s ? Array.from(s.data as Uint8Array).filter(Boolean).length : -1 };
  });
  expect(sel).toEqual({ mode: 'EDIT', selected: 0 });
  await page.keyboard.press('a');
  await page.keyboard.press('x');
  const left = await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    return a.doc.pointclouds[a.activeObject!.data].positions.length;
  });
  expect(left).toBe(0);
  await expectNoErrors(errors);
});

test('point cloud Separate copies the object like mesh Separate; Convert to Mesh keeps attributes', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.pointcloud_random_add', {}, { invoke: false });
    const ob = a.activeObject;
    ob.delta_location = [1, 2, 3];
    ob.rotation_mode = 'QUATERNION';
    ob.rotation_quaternion = [0.5, 0.5, 0.5, 0.5];
    ob.modifiers.push({ id: 'md_test', name: 'Nodes', type: 'NODES', show_viewport: true, show_render: true, show_in_editmode: true, show_expanded: true });
    a.run('object.mode_set', { mode: 'EDIT' }, { invoke: false });
    a.run('pointcloud.select_random', { probability: 0.5, seed: 3 }, { invoke: false });
    const before = new Set(Object.keys(a.doc.objects));
    a.run('pointcloud.separate', {}, { invoke: false });
    const nob = Object.values(a.doc.objects).find((o: any) => !before.has(o.id)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const copy = [nob.delta_location, nob.rotation_mode, nob.rotation_quaternion, nob.modifiers.length, nob.modifiers[0]?.id !== 'md_test'];
    a.run('object.mode_set', { mode: 'OBJECT' }, { invoke: false });
    a.run('object.select_all', { action: 'DESELECT' }, { invoke: false });
    nob.select = true;
    a.doc.scene.active_object = nob.id;
    a.flush();
    const n = a.doc.pointclouds[nob.data].positions.length / 3;
    a.run('object.convert', { target: 'MESH' }, { invoke: false });
    const me = a.doc.meshes[nob.data];
    return {
      copy,
      inCollection: Object.values(a.doc.collections).some((c: any) => c.objects.includes(nob.id)), // eslint-disable-line @typescript-eslint/no-explicit-any
      mesh: [nob.type, me?.positions.length / 3 === n, (me?.attributes ?? []).find((x: { name: string }) => x.name === 'radius')?.data.length === n],
    };
  });
  expect(r.copy).toEqual([[1, 2, 3], 'QUATERNION', [0.5, 0.5, 0.5, 0.5], 1, true]);
  expect(r.inCollection).toBe(true);
  expect(r.mesh).toEqual(['MESH', true, true]);
  await expectNoErrors(errors);
});
