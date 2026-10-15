import { test, expect, type Page } from '@playwright/test';
import { openApp, viewportCenter, expectNoErrors } from './helpers';

type W = { app: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Replace the scene with one primitive and enter a paint/sculpt mode. */
async function setup(page: Page, mode = 'SCULPT', add = 'mesh.primitive_uv_sphere_add', props: Record<string, unknown> = { segments: 32, ring_count: 16 }) {
  await page.evaluate(
    ({ mode, add, props }) => {
      const a = (window as unknown as W).app;
      a.run('object.select_all', { action: 'SELECT' });
      a.run('object.delete');
      a.run(add, props);
      a.run('object.mode_set', { mode });
      a.flush();
    },
    { mode, add, props },
  );
}

const meshInfo = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as W).app;
    const me = a.doc.meshes[a.activeObject.data];
    const sum = (x?: ArrayLike<number>) => (x ? Array.from(x).reduce((s: number, v: number) => s + (v ? 1 : 0), 0) : 0);
    return {
      nf: me.offsets.length - 1,
      nv: me.positions.length / 3,
      hidden: sum(me.hide_poly),
      masked: sum(me.sculpt_mask),
      sets: me.sculpt_face_set ? new Set(Array.from(me.sculpt_face_set)).size : 0,
    };
  });

async function openHeaderMenu(page: Page, label: string) {
  await page.locator('.hdr-row button', { hasText: new RegExp(`^${label}$`) }).first().dispatchEvent('pointerdown');
}

test('sculpt header menus, face sets and visibility shortcuts', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'SCULPT', 'mesh.primitive_cube_add', {});
  // menus
  for (const [menu, item] of [
    ['Sculpt', 'Hide Masked'],
    ['Mask', 'Lasso Mask'],
    ['Face Sets', 'Randomize Colors'],
  ]) {
    await openHeaderMenu(page, menu);
    await expect(page.locator('.menu .menu-item', { hasText: item }).first()).toBeVisible();
    await page.keyboard.press('Escape');
  }
  // Face Sets ▸ Initialize Face Sets ▸ By Normals
  await page.evaluate(() => (window as unknown as W).app.run('sculpt.face_sets_init', { mode: 'NORMALS' }));
  expect((await meshInfo(page)).sets).toBe(6);
  // H hides the face set under the cursor, Alt+H shows everything, Shift+H isolates
  const c = await viewportCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('h');
  expect((await meshInfo(page)).hidden).toBe(1);
  await page.keyboard.press('Alt+h');
  expect((await meshInfo(page)).hidden).toBe(0);
  await page.keyboard.press('Shift+h');
  expect((await meshInfo(page)).hidden).toBe(5);
  await page.keyboard.press('Shift+h');
  expect((await meshInfo(page)).hidden).toBe(0);
  await expectNoErrors(errors);
});

test('lasso and box gestures mask, hide and create face sets', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page);
  const c = await viewportCenter(page);
  const nf = (await meshInfo(page)).nf;
  // Shift+Ctrl+drag: lasso mask
  await page.mouse.move(c.x - 15, c.y - 15);
  await page.keyboard.down('Shift');
  await page.keyboard.down('Control');
  await page.mouse.down();
  for (const [dx, dy] of [
    [15, -15],
    [15, 15],
    [-15, 15],
    [-15, -15],
  ])
    await page.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');
  const m = await meshInfo(page);
  expect(m.masked).toBeGreaterThan(5);
  expect(m.masked).toBeLessThan(m.nv);
  // Face Set from Masked
  await page.evaluate(() => (window as unknown as W).app.run('sculpt.face_sets_create', { mode: 'MASKED' }));
  expect((await meshInfo(page)).sets).toBe(2);
  // Box Hide tool from the toolbar slot
  await page.evaluate(() => (window as unknown as W).app.run('paint.brush_select', { brush: 'builtin.box_hide' }));
  await page.mouse.move(c.x - 400, c.y - 300);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 300, { steps: 5 });
  await page.mouse.up();
  const h = await meshInfo(page);
  expect(h.hidden).toBeGreaterThan(0);
  expect(h.hidden).toBeLessThan(nf);
  await page.keyboard.press('Control+z');
  expect((await meshInfo(page)).hidden).toBe(0);
  await expectNoErrors(errors);
});

test('mesh filter tool drag and expand mask (Shift+A)', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page);
  const c = await viewportCenter(page);
  const r0 = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('paint.brush_select', { brush: 'builtin.mesh_filter' });
    const me = a.doc.meshes[a.activeObject.data];
    return Math.hypot(me.positions[3], me.positions[4], me.positions[5]);
  });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 100, c.y, { steps: 4 });
  await page.mouse.up();
  const r1 = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    const me = a.doc.meshes[a.activeObject.data];
    return { r: Math.hypot(me.positions[3], me.positions[4], me.positions[5]), op: a.lastOp?.idname };
  });
  expect(r1.op).toBe('sculpt.mesh_filter');
  expect(r1.r).toBeGreaterThan(r0 + 0.05);
  // expand: Shift+A over the mesh, move, click
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Shift+a');
  await page.mouse.move(c.x + 8, c.y + 6, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  const m = await meshInfo(page);
  expect(m.masked).toBeGreaterThan(0);
  expect(m.masked).toBeLessThan(m.nv);
  await expectNoErrors(errors);
});

test('box trim tool cuts through the mesh', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'SCULPT', 'mesh.primitive_uv_sphere_add', { segments: 32, ring_count: 16, radius: 4 });
  const c = await viewportCenter(page);
  await page.evaluate(() => (window as unknown as W).app.run('paint.brush_select', { brush: 'builtin.box_trim' }));
  await expect(page.locator('.tool-header')).toContainText('Box Trim');
  const nf0 = (await meshInfo(page)).nf;
  await page.mouse.move(c.x - 20, c.y - 40);
  await page.mouse.down();
  await page.mouse.move(c.x + 20, c.y + 40, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    return { op: a.lastOp?.idname, nf: a.doc.meshes[a.activeObject.data].offsets.length - 1 };
  });
  expect(after.op).toBe('sculpt.trim_box_gesture');
  expect(after.nf).not.toBe(nf0);
  await expectNoErrors(errors);
});
