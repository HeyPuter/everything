// 3D Viewport: transform modal keys, Adjust Last Operation for transforms, transform tools,
// orientations, view navigation and view regions.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = <T = unknown>(page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`) as Promise<T>;
const run = (page: Page, op: string, props: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => page.evaluate(([o, p, x]) => (window as any).app.run(o, p, x), [op, props, opts] as const); // eslint-disable-line @typescript-eslint/no-explicit-any

test('transform modal: typed values, constraints, redo panel', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  // move along X by a typed expression with units
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  // '=' switches to expression mode so unit letters can be typed
  await page.keyboard.type('=1+50cm');
  await expect(page.locator('.hdr-modal-text')).toContainText('along global X');
  await page.keyboard.press('Enter');
  expect(await get(page, 'app.activeObject.location')).toEqual([1.5, 0, 0]);
  expect(await get(page, 'app.lastOp.idname')).toBe('transform.translate');
  // Adjust Last Operation re-runs the move with new values
  await page.evaluate(() => (window as any).app.redoLast({ value: [0, 2, 0], constraint_axis: [false, true, false] })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await get(page, 'app.activeObject.location')).toEqual([0, 2, 0]);
  // rotate around Z by typing degrees, then scale on a plane (Shift+Z keeps Z)
  await page.keyboard.press('r');
  await page.keyboard.press('z');
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  expect(await get<number>(page, 'app.activeObject.rotation_euler[2]')).toBeCloseTo(Math.PI / 2, 5);
  await page.keyboard.press('s');
  await page.keyboard.press('Shift+Z');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  expect(await get(page, 'app.activeObject.scale.map(v => Math.round(v * 1000) / 1000)')).toEqual([2, 2, 1]);
  // C clears the constraint; Escape cancels
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.press('c');
  await expect(page.locator('.hdr-modal-text')).not.toContainText('along');
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 3 });
  await page.keyboard.press('Escape');
  expect(await get(page, 'app.activeObject.location')).toEqual([0, 2, 0]);
  await expectNoErrors(errors);
});

test('edit mode transform tools: shear, bend, warp, randomize', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  const positions = () => get<number[]>(page, 'Array.from(app.doc.meshes[app.activeObject.data].positions)');
  const before = await positions();
  await page.keyboard.press('Shift+Control+Alt+S');
  await page.mouse.move(c.x + 50, c.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  expect(await get(page, 'app.lastOp.idname')).toBe('transform.shear');
  expect(await positions()).not.toEqual(before);
  // the shear angle can be adjusted afterwards
  await page.evaluate(() => (window as any).app.redoLast({ angle: 0 })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect((await positions()).map((v) => Math.round(v * 1e4) / 1e4)).toEqual(before);
  await run(page, 'transform.vertex_random', { offset: 0.1, seed: 4 }, { invoke: false });
  const r1 = await positions();
  await page.keyboard.press('Control+z');
  await run(page, 'transform.vertex_random', { offset: 0.1, seed: 4 }, { invoke: false });
  expect(await positions()).toEqual(r1);
  await page.keyboard.press('Control+z');
  // Bend with Shift+W, typed angle
  await page.mouse.move(c.x + 120, c.y, { steps: 2 });
  await page.keyboard.press('Shift+W');
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  expect(await get(page, 'app.lastOp.idname')).toBe('transform.bend');
  expect(await positions()).not.toEqual(before);
  await page.keyboard.press('Control+z');
  // the Mesh ▸ Transform menu lists the extra tools
  await page.locator('.hdr-menu', { hasText: 'Mesh' }).click();
  await page.locator('.menu-item', { hasText: 'Transform' }).first().hover();
  await expect(page.locator('.menu-item', { hasText: 'Warp' })).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Warp' }).click();
  await page.keyboard.type('180');
  await page.keyboard.press('Enter');
  expect(await get(page, 'app.lastOp.idname')).toBe('transform.vertex_warp');
  await expectNoErrors(errors);
});

test('custom transform orientations', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.rotation_euler = [0, 0, Math.PI / 2];
    a.changed('doc');
  });
  await run(page, 'transform.create_orientation', { name: 'Turned' }, { invoke: false });
  expect(await get(page, 'app.doc.scene.transform_orientations.map(o => o.name)')).toEqual(['Turned']);
  await expect(page.locator('.hdr-drop', { hasText: 'Turned' })).toBeVisible();
  // moving along X in the custom orientation follows the object's turned X axis (world Y)
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.activeObject.rotation_euler = [0, 0, 0];
    a.changed('doc');
  });
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  const loc = await get<number[]>(page, 'app.activeObject.location');
  expect(loc[0]).toBeCloseTo(0, 5);
  expect(loc[1]).toBeCloseTo(1, 5);
  await run(page, 'transform.delete_orientation');
  expect(await get(page, 'app.doc.scene.transform_orientations.length')).toBe(0);
  await expectNoErrors(errors);
});

const view = (page: Page, expr: string) =>
  page.evaluate(async (e) => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts');
    const v = activeView3D()!;
    return new Function('v', `return ${e}`)(v);
  }, expr);

test('view regions: clipping region, render region, center pick, relative axis views', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  // Alt+B: drag a clipping region; the cube outside it can no longer be picked
  await page.keyboard.press('Alt+B');
  await page.mouse.move(c.x - 300, c.y - 200);
  await page.mouse.down();
  await page.mouse.move(c.x - 200, c.y - 100, { steps: 3 });
  await page.mouse.up();
  expect(await view(page, 'v.clipPlanes?.length')).toBe(4);
  expect(await view(page, `v.pick(v.width / 2, v.height / 2, 2)`)).toBeNull();
  await page.keyboard.press('Alt+B');
  expect(await view(page, 'v.clipPlanes')).toBeNull();
  // Ctrl+B in camera view sets the render region, Ctrl+Alt+B clears it
  await page.keyboard.press('Numpad0');
  await page.keyboard.press('Control+B');
  await page.mouse.move(c.x - 60, c.y - 40);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 3 });
  await page.mouse.up();
  const border = await get<number[]>(page, '[app.doc.scene.render.border_min_x, app.doc.scene.render.border_max_x]');
  expect(await get(page, 'app.doc.scene.render.use_border')).toBe(true);
  expect(border[0]).toBeGreaterThan(0.2);
  expect(border[1]).toBeLessThan(0.8);
  await page.keyboard.press('Control+Alt+B');
  expect(await get(page, 'app.doc.scene.render.use_border')).toBe(false);
  await page.keyboard.press('Numpad0');
  // Alt+MMB click centers the view on the surface under the mouse
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Alt');
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  // Alt+MMB drag turns to the axis view on that side
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(c.x, c.y + 60, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  await page.keyboard.up('Alt');
  await page.waitForTimeout(250);
  expect(await view(page, 'v.nav.view')).toBe('TOP');
  expect(await view(page, 'Math.abs(v.nav.pivot.length() - 0) < 1.75')).toBe(true);
  // View ▸ View Regions lists the region operators
  await page.locator('.hdr-menu', { hasText: 'View' }).first().click();
  await page.locator('.menu-item', { hasText: 'View Regions' }).hover();
  await expect(page.locator('.menu-item', { hasText: 'Clipping Region' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('walk and fly navigation', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const eye = () => view(page, 'v.nav.eye.toArray()') as Promise<number[]>;
  const e0 = await eye();
  await page.keyboard.press('Shift+Backquote');
  expect(await get(page, 'app.modal?.label')).toBe('Walk Navigation');
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await page.keyboard.press('Enter');
  const e1 = await eye();
  expect(Math.hypot(e1[0] - e0[0], e1[1] - e0[1])).toBeGreaterThan(0.1);
  expect(e1[2]).toBeCloseTo(e0[2], 5);
  // fly: W accelerates, Escape restores the view
  await run(page, 'view3d.fly');
  await page.keyboard.press('w');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  const e2 = await eye();
  expect(e2.map((x) => +x.toFixed(4))).toEqual(e1.map((x) => +x.toFixed(4)));
  await expectNoErrors(errors);
});

test('quad view toggles fixed views around the user view', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  const views = () => page.locator('.view3d').count();
  const before = await views();
  await page.keyboard.press('Control+Alt+Q');
  expect(await views()).toBe(before + 3);
  await expect(page.locator('.v3d-info-line', { hasText: 'Top Orthographic' })).toBeVisible();
  await expect(page.locator('.v3d-info-line', { hasText: 'Right Orthographic' })).toBeVisible();
  // the fixed views cannot be turned
  const top = page.locator('.view3d').first();
  const box = (await top.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await run(page, 'view3d.view_orbit', { type: 'ORBITLEFT' })).toBe('CANCELLED');
  await page.keyboard.press('Control+Alt+Q');
  expect(await views()).toBe(before);
  await expect(page.locator('.v3d-info-line', { hasText: 'User Perspective' })).toBeVisible();
  await expectNoErrors(errors);
});

test('cursor tool drag, object gizmos, protractor', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  // Cursor tool: dragging moves the cursor across the surface
  await page.click('[data-tool="builtin.cursor"]');
  await page.mouse.move(c.x - 200, c.y + 100);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y, { steps: 4 });
  await page.mouse.up();
  const cur = await get<number[]>(page, 'app.doc.scene.cursor.location');
  expect(Math.max(...cur.map(Math.abs))).toBeLessThan(1.01); // on the cube's surface
  // Object gizmos show move handles with the select tool active
  await page.click('[data-tool="builtin.select_box"]');
  expect(await page.locator('[data-gizmo^="move:"]').count()).toBe(0);
  await run(page, 'view3d.transform_gizmo_set', { type: 'TRANSLATE' }, { invoke: false });
  await expect(page.locator('[data-gizmo^="move:"]').first()).toBeAttached();
  await run(page, 'view3d.transform_gizmo_set', { type: 'TRANSLATE' }, { invoke: false });
  expect(await page.locator('[data-gizmo^="move:"]').count()).toBe(0);
  // Measure: drag a ruler, then drag its midpoint to measure an angle
  await page.click('[data-tool="builtin.measure"]');
  const p0 = { x: c.x - 300, y: c.y + 250 },
    p1 = { x: c.x - 100, y: c.y + 250 };
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p1.x, p1.y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move((p0.x + p1.x) / 2, p0.y);
  await page.mouse.down();
  await page.mouse.move((p0.x + p1.x) / 2, p0.y - 80, { steps: 4 });
  await page.mouse.up();
  expect(await get(page, 'app.doc.scene.rulers.length')).toBe(1);
  expect(await get(page, '!!app.doc.scene.rulers[0].c')).toBe(true);
  await expect(page.locator('.protractor text')).toContainText('°');
  await expectNoErrors(errors);
});

test('B box select adds and removes, Shift+B zoom region in and out', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const selected = () => get<string>(page, `Object.values(app.doc.objects).filter(o => o.select).map(o => o.name).sort().join(',')`);
  await page.keyboard.press('Alt+A');
  expect(await selected()).toBe('');
  // B then drag around the cube adds it; the tool stays the same
  const toolBefore = await page.evaluate(async () => (await import('/src/app/prefs.ts')).activeTools.OBJECT);
  await page.keyboard.press('b');
  await page.mouse.move(c.x - 80, c.y - 80);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 80, { steps: 3 });
  await page.mouse.up();
  expect(await selected()).toBe('Cube');
  expect(await page.evaluate(async () => (await import('/src/app/prefs.ts')).activeTools.OBJECT)).toBe(toolBefore);
  // B with the middle button removes from the selection
  await page.keyboard.press('b');
  await page.mouse.move(c.x - 80, c.y - 80);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(c.x + 80, c.y + 80, { steps: 3 });
  await page.mouse.up({ button: 'middle' });
  expect(await selected()).toBe('');
  // zoom region: LMB zooms in, MMB zooms out
  const dist = () => view(page, 'v.nav.distance') as Promise<number>;
  const d0 = await dist();
  await page.keyboard.press('Shift+B');
  await page.mouse.move(c.x - 50, c.y - 50);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y + 50, { steps: 3 });
  await page.mouse.up();
  const d1 = await dist();
  expect(d1).toBeLessThan(d0);
  await page.keyboard.press('Shift+B');
  await page.mouse.move(c.x - 50, c.y - 50);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(c.x + 50, c.y + 50, { steps: 3 });
  await page.mouse.up({ button: 'middle' });
  expect(await dist()).toBeGreaterThan(d1);
  await expectNoErrors(errors);
});

test('local axis constraint moves each object along its own axis', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cam = Object.values(a.doc.objects as Record<string, any>).find((o) => o.name === 'Camera'); // eslint-disable-line @typescript-eslint/no-explicit-any
    cam.select = true;
    cam.location = [0, 0, 0];
    cam.rotation_euler = [0, 0, Math.PI / 2];
    a.activeObject.rotation_euler = [0, 0, 0];
    a.changed('doc');
  });
  // X twice switches the constraint from global to local
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.press('x');
  await expect(page.locator('.hdr-modal-text')).toContainText('along local X');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  const locs = await get<number[][]>(page, `['Cube', 'Camera'].map(n => Object.values(app.doc.objects).find(o => o.name === n).location.map(v => Math.round(v * 1000) / 1000))`);
  expect(locs[0]).toEqual([2, 0, 0]);
  expect(locs[1]).toEqual([0, 2, 0]);
  await expectNoErrors(errors);
});

test('curve tilt and radius transforms', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await run(page, 'curve.primitive_bezier_curve_add');
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await page.keyboard.press('Control+T');
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  const tilts = await get<number[]>(page, 'app.doc.curves[app.activeObject.data].splines[0].bezier_points.map(b => b.tilt)');
  for (const t of tilts) expect(t).toBeCloseTo(Math.PI / 6, 5);
  expect(await get(page, 'app.lastOp.idname')).toBe('transform.tilt');
  await page.keyboard.press('Alt+S');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  const radii = await get<number[]>(page, 'app.doc.curves[app.activeObject.data].splines[0].bezier_points.map(b => b.radius)');
  for (const r of radii) expect(r).toBeCloseTo(2, 5);
  await expectNoErrors(errors);
});

test('sidebar median of the edit selection can be typed', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('a');
  await page.keyboard.press('n');
  await page.click('.sb-tab:has-text("Item")');
  await page.locator('.v3d-sidebar .num-field').first().click();
  await expect(page.locator('.v3d-sidebar input.num-field')).toBeFocused();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  const xs = await get<number[]>(page, 'Array.from(app.doc.meshes[app.activeObject.data].positions).filter((_, i) => i % 3 === 0)');
  expect(Math.min(...xs)).toBeCloseTo(0, 5);
  expect(Math.max(...xs)).toBeCloseTo(2, 5);
  await expectNoErrors(errors);
});
