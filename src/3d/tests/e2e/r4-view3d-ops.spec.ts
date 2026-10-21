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
