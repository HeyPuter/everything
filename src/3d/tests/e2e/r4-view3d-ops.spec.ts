// Object Mode / 3D View operators added in round 4.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = <T = unknown>(page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`) as Promise<T>;
const run = (page: Page, op: string, props: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => page.evaluate(([o, p, x]) => (window as any).app.run(o, p, x), [op, props, opts] as const); // eslint-disable-line @typescript-eslint/no-explicit-any
const view = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; const v = (app.hoverArea ?? app.activeArea).editor; return ${expr}; })()`);

test('duplicate in place, render restriction helpers, mode with sub-mode, property defaults', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const n0 = await get<number>(page, 'Object.keys(app.doc.objects).length');
  expect(await run(page, 'object.duplicate', { linked: true })).toBe('FINISHED');
  expect(await get<number>(page, 'Object.keys(app.doc.objects).length')).toBe(n0 + 1);
  expect(await get(page, 'app.activeObject.name')).toBe('Cube.001');
  expect(await get(page, 'app.activeObject.data === app.doc.objects[Object.keys(app.doc.objects).find(k => app.doc.objects[k].name === "Cube")].data')).toBe(true);
  expect(await get(page, 'app.activeObject.location')).toEqual([0, 0, 0]);
  // Cube.001 selected: the other mesh (Cube) stops rendering
  expect(await run(page, 'object.isolate_type_render')).toBe('FINISHED');
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.hide_render).map(o => o.name)')).toEqual(['Cube']);
  expect(await run(page, 'object.hide_render_clear_all')).toBe('FINISHED');
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.hide_render).length')).toBe(0);
  // custom property defaults
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.custom = { size: 2.5, flags: [1, 0, 1] };
  });
  expect(await run(page, 'object.assign_property_defaults')).toBe('FINISHED');
  expect(await get(page, 'app.activeObject.custom_ui.size.default')).toBe(2.5);
  expect(await get(page, 'app.activeObject.custom_ui.flags.default')).toEqual([1, 0, 1]);
  // edit mode with the edge select mode
  expect(await run(page, 'object.mode_set_with_submode', { mode: 'EDIT', mesh_select_mode: [false, true, false] })).toBe('FINISHED');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  expect(await get(page, 'app.doc.scene.tool_settings.mesh_select_mode')).toEqual([false, true, false]);
  await expectNoErrors(errors);
});

test('a locked view keeps its pan offset; Home centres it again', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.location = [2, 1, 0];
    a.changed('doc');
  });
  await run(page, 'view3d.view_lock_to_active');
  await page.waitForTimeout(100);
  await view(page, '(v.nav.pan(80, 0), v.afterNav(), 0)');
  await page.waitForTimeout(150);
  const pivot = await view(page, 'v.nav.pivot.toArray().map(x => Math.round(x * 100) / 100)');
  expect(pivot).not.toEqual([2, 1, 0]);
  await page.keyboard.press('Home');
  await page.waitForTimeout(100);
  expect(await view(page, 'v.nav.pivot.toArray().map(x => Math.round(x * 100) / 100)')).toEqual([2, 1, 0]);
  await expectNoErrors(errors);
});

test('rotate view operator follows the mouse; Esc restores', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const q0 = (await view(page, 'v.nav.rot.toArray()')) as number[];
  await run(page, 'view3d.rotate', {}, { invoke: true });
  await page.mouse.move(c.x + 10, c.y, { steps: 2 });
  await page.mouse.move(c.x + 80, c.y + 20, { steps: 4 });
  const q1 = (await view(page, 'v.nav.rot.toArray()')) as number[];
  expect(q1.some((x, i) => Math.abs(x - q0[i]) > 0.01)).toBe(true);
  await page.keyboard.press('Escape');
  const q2 = (await view(page, 'v.nav.rot.toArray()')) as number[];
  q2.forEach((x, i) => expect(x).toBeCloseTo(q0[i], 5));
  await expectNoErrors(errors);
});

test('shading popover: wireframe colour, outline colour, MatCap flip', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.locator('[data-tip="Shading"]').first().dispatchEvent('pointerdown');
  const pop = page.locator('.pop-panel').last();
  await expect(pop).toContainText('Wireframe');
  await expect(pop).toContainText('Custom');
  await pop.locator('.enum-row, .enum-btn, button', { hasText: /^Random$/ }).first().click();
  expect(await view(page, 'v.shading.wireframe_color_type')).toBe('RANDOM');
  await pop.locator('button', { hasText: /^MatCap$/ }).first().click();
  await pop.locator('[data-tip^="Flip MatCap"]').click();
  expect(await view(page, 'v.shading.matcap_flip')).toBe(true);
  await pop.locator('.checkbox', { hasText: 'Cavity' }).click();
  expect(await view(page, 'v.shading.show_cavity')).toBe(true);
  await expect(pop).toContainText('Valley');
  await pop.locator('.checkbox', { hasText: 'Depth of Field' }).click();
  expect(await view(page, 'v.shading.use_dof')).toBe(true);
  await pop.locator('.checkbox', { hasText: 'Shadow' }).click();
  expect(await view(page, 'v.shading.show_shadows')).toBe(true);
  await page.waitForTimeout(150);
  await page.waitForTimeout(200);
  await expectNoErrors(errors);
});

test('transform.from_gizmo starts the handle under the pointer', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.move' });
  await page.waitForTimeout(100);
  const b = (await page.locator('.v3d-svg path[data-gizmo="move:2"]').first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  expect(await page.evaluate(([x, y]) => (window as any).app.run('transform.from_gizmo', {}, { event: { x, y } }), [b.x + b.width / 2, b.y + b.height / 2])).toBe('RUNNING_MODAL'); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  if (await get(page, '!!app.modal')) await page.keyboard.press('Enter');
  const loc = await get<number[]>(page, 'app.activeObject.location');
  expect(loc[2]).toBeGreaterThan(0.05);
  expect(Math.abs(loc[0]) + Math.abs(loc[1])).toBeLessThan(1e-6);
  await expectNoErrors(errors);
});

test('ruler_add with Ctrl snaps the ends to vertices', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const sp = (p: number[]) =>
    page.evaluate((pt) => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const v = (a.hoverArea ?? a.activeArea).editor;
      const r = v.el.getBoundingClientRect();
      const s = v.project(v.nav.pivot.clone().set(pt[0], pt[1], pt[2]));
      return { x: r.left + s.x, y: r.top + s.y };
    }, p);
  const a = await sp([1, -1, 1]),
    b = await sp([1, 1, 1]);
  expect(await run(page, 'view3d.ruler_add', {}, { invoke: true })).toBe('RUNNING_MODAL');
  await page.keyboard.down('Control');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 3, b.y - 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  const rulers = await get<{ a: number[]; b: number[] }[]>(page, 'app.doc.scene.rulers');
  expect(rulers.length).toBe(1);
  const len = Math.hypot(...rulers[0].a.map((x, i) => x - rulers[0].b[i]));
  expect(len).toBeCloseTo(2, 4);
  await expectNoErrors(errors);
});

test('bpy.context.space_data exposes the 3D viewport settings', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const r = await page.evaluate(async () => {
    const { runJavaScript } = await import('/src/scripting/runner.ts' as string);
    return runJavaScript(`
      const sd = bpy.context.space_data;
      if (sd.type !== 'VIEW_3D') throw new Error('type ' + sd.type);
      sd.shading.type = 'WIREFRAME';
      sd.overlay.show_face_orientation = true;
      sd.lens = 35;
      sd.region_3d.view_location = [1, 2, 3];
      sd.region_3d.view_perspective = 'ORTHO';
    `);
  });
  expect(r.ok).toBe(true);
  expect(await view(page, '[v.shading.type, v.overlay.show_face_orientation, v.nav.lens, v.nav.pivot.toArray(), v.nav.ortho]')).toEqual(['WIREFRAME', true, 35, [1, 2, 3], true]);
  await expectNoErrors(errors);
});

test('annotate line, polygon and eraser tools', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const strokes = () => get<{ points: number[] }[]>(page, 'app.doc.scene.annotations ?? []');
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.annotate_line' });
  await page.mouse.move(c.x - 150, c.y + 100);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(c.x - 150 + i * 30, c.y + 100 - i * 10);
  await page.mouse.up();
  let s = await strokes();
  expect(s.length).toBe(1);
  expect(s[0].points.length).toBe(6);
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.annotate_polygon' });
  for (const [dx, dy] of [
    [-100, -120],
    [0, -160],
    [100, -120],
  ]) {
    await page.mouse.move(c.x + dx, c.y + dy);
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.keyboard.press('Enter');
  s = await strokes();
  expect(s.length).toBe(2);
  expect(s[1].points.length).toBe(9);
  // the eraser cuts the polygon where it passes over its top corner: two pieces remain, the line is untouched
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.annotate_eraser' });
  await page.mouse.move(c.x - 2, c.y - 162);
  await page.mouse.down();
  await page.mouse.move(c.x + 2, c.y - 158, { steps: 3 });
  await page.mouse.up();
  s = await strokes();
  expect(s.length).toBe(3);
  expect(s[0].points.length).toBe(6);
  // each piece keeps one corner and ends where the eraser cut it
  expect(s.slice(1).map((x) => x.points.length)).toEqual([6, 6]);
  await expectNoErrors(errors);
});

test('right button cancels a middle-button orbit', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const q0 = (await view(page, 'v.nav.rot.toArray()')) as number[];
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(c.x + 90, c.y + 30, { steps: 5 });
  const q1 = (await view(page, 'v.nav.rot.toArray()')) as number[];
  expect(q1.some((x, i) => Math.abs(x - q0[i]) > 0.01)).toBe(true);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up({ button: 'middle' });
  const q2 = (await view(page, 'v.nav.rot.toArray()')) as number[];
  q2.forEach((x, i) => expect(x).toBeCloseTo(q0[i], 5));
  // no context menu was opened by the cancelling click
  await expect(page.locator('.menu')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('Camera Parent Lock moves the camera parent when navigating a locked camera view', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cam = a.doc.objects[a.doc.scene.camera];
    a.run('object.empty_add', { location: [0, 0, 0] });
    const rig = a.activeObject;
    cam.parent = rig.id;
    cam.use_camera_lock_parent = true;
    a.changed('doc');
    a.flush();
    a.run('view3d.view_camera');
    const v = (a.hoverArea ?? a.activeArea).editor;
    v.lockCameraToView = true;
  });
  const before = await get<number[]>(page, 'app.doc.objects[app.doc.scene.camera].location.slice()');
  await view(page, '(v.leaveCameraIfNeeded?.(), v.nav.pan(60, 0), v.afterNav(), 0)');
  await page.evaluate(() => (window as any).app.flush()); // eslint-disable-line @typescript-eslint/no-explicit-any
  const after = await get<number[]>(page, 'app.doc.objects[app.doc.scene.camera].location.slice()');
  const rig = await get<number[]>(page, 'app.doc.objects[app.doc.objects[app.doc.scene.camera].parent].location.slice()');
  after.forEach((x, i) => expect(x).toBeCloseTo(before[i], 4));
  expect(Math.hypot(...rig)).toBeGreaterThan(0.01);
  await expectNoErrors(errors);
});

test('object context menu offers type-specific adjustments', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  await run(page, 'object.light_add', { type: 'SPOT', location: [0, 0, 3] });
  await page.mouse.click(c.x + 200, c.y + 150, { button: 'right' });
  const menu = page.locator('.menu').last();
  await expect(menu).toContainText('Adjust Light Power');
  await expect(menu).toContainText('Adjust Spot Light Beam Angle');
  await expect(menu).not.toContainText('Shade Smooth');
  const e0 = await get<number>(page, 'app.doc.lights[app.activeObject.data].energy');
  const item = menu.locator('.menu-item', { hasText: 'Adjust Light Power' });
  const ib = (await item.boundingBox())!;
  await item.click();
  // the value follows the horizontal motion from where the item was clicked
  await page.mouse.move(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2, { steps: 4 });
  await page.mouse.click(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2);
  expect(await get<number>(page, 'app.doc.lights[app.activeObject.data].energy')).toBeGreaterThan(e0);
  await run(page, 'object.camera_add', { location: [0, -5, 1] });
  await page.mouse.click(c.x + 200, c.y + 150, { button: 'right' });
  await expect(page.locator('.menu').last()).toContainText('Adjust Focal Length');
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});
