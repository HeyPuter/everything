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
