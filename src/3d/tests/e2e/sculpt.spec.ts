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

test('vertex paint face selection masking limits the brush', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'VERTEX_PAINT', 'mesh.primitive_grid_add', { x_subdivisions: 10, y_subdivisions: 10, size: 6 });
  const c = await viewportCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('1');
  await expect(page.locator('.select-modes .hdr-toggle.on')).toHaveCount(1);
  await page.keyboard.press('Alt+a');
  await page.evaluate(() => (window as unknown as W).app.run('paint.brush_select', { brush: 'builtin.select' }));
  await page.mouse.click(c.x, c.y);
  // Select menu exists while masking
  await openHeaderMenu(page, 'Select');
  await expect(page.locator('.menu .menu-item', { hasText: 'Select Linked' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('paint.brush_select', { brush: 'brush_vertpaint' });
    a.doc.scene.tool_settings.unified_paint.color = [1, 0, 0];
  });
  await page.mouse.move(c.x - 200, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 200, c.y, { steps: 20 });
  await page.mouse.up();
  const red = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    const me = a.doc.meshes[a.activeObject.data];
    const col = me.color_attributes[me.active_color_index].data as Float32Array;
    let n = 0;
    for (let i = 0; i < col.length; i += 4) if (col[i + 1] < 0.9) n++;
    return n;
  });
  expect(red).toBe(4);
  await expectNoErrors(errors);
});

test('weight paint gradient, quantize and lock pie', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'WEIGHT_PAINT', 'mesh.primitive_grid_add', { x_subdivisions: 10, y_subdivisions: 10, size: 6 });
  const c = await viewportCenter(page);
  await page.mouse.move(c.x - 100, c.y);
  await page.keyboard.press('Shift+a');
  await page.mouse.down();
  await page.mouse.move(c.x + 100, c.y, { steps: 5 });
  await page.mouse.up();
  const w = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('object.vertex_group_quantize', { steps: 2 });
    const me = a.doc.meshes[a.activeObject.data];
    return [...new Set(Array.from(me.weights[0] as Float32Array).map((x) => +x.toFixed(2)))].sort();
  });
  expect(w).toEqual([0, 0.5, 1]);
  await openHeaderMenu(page, 'Weights');
  await expect(page.locator('.menu .menu-item', { hasText: 'Gradient (Radial)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('k');
  await expect(page.locator('.pie')).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('dyntopo refines the mesh under the brush', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'SCULPT', 'mesh.primitive_uv_sphere_add', { segments: 32, ring_count: 16, radius: 4 });
  const c = await viewportCenter(page);
  await page.locator('.tool-header .th-dyntopo').getByText('Dyntopo').click();
  const nf0 = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.doc.scene.tool_settings.sculpt.detail_size = 4;
    return a.doc.meshes[a.activeObject.data].offsets.length - 1;
  });
  expect(nf0).toBe(960); // triangulated
  await page.mouse.move(c.x - 30, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y, { steps: 10 });
  await page.mouse.up();
  const m = await meshInfo(page);
  expect(m.nf).toBeGreaterThan(nf0 * 2);
  await expectNoErrors(errors);
});

test('brush shelf, Properties tool tab and tool header popovers', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page);
  // shelf thumbnails pick brushes
  await page.locator('.ps-tile[data-brush="brush_clay_strips"]').click();
  await expect(page.locator('.tool-header')).toContainText('Clay Strips');
  await page.locator('.ps-tab', { hasText: 'Transform' }).click();
  await expect(page.locator('.paint-shelf .ps-tile')).toHaveCount(10);
  await page.locator('.ps-search').fill('snake');
  await page.locator('.ps-tab', { hasText: 'All' }).click();
  await expect(page.locator('.paint-shelf .ps-tile')).toHaveCount(1);
  // View ▸ Asset Shelf hides it
  await page.evaluate(() => (window as unknown as W).app.run('view3d.toggle_asset_shelf'));
  await expect(page.locator('.paint-shelf')).toHaveCount(0);
  // Properties ▸ Tool shows the brush panels
  await page.locator('.prop-rail [data-tip^="Tool"]').first().click();
  await expect(page.locator('.properties .panel-header', { hasText: 'Brush Settings' })).toBeVisible();
  await expect(page.locator('.properties .panel-header', { hasText: 'Dyntopo' })).toBeVisible();
  // tool header popover
  await page.locator('.tool-header .th-pop', { hasText: 'Falloff' }).dispatchEvent('pointerdown');
  await expect(page.locator('.popover .pop-title', { hasText: 'Falloff' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Space: brush picker at the pointer
  const c = await viewportCenter(page);
  await page.mouse.move(c.x, c.y - 100);
  await page.keyboard.press('Space');
  await page.locator('.popover .ps-tile[data-brush="brush_smooth"]').click();
  await expect(page.locator('.tool-header')).toContainText('Smooth');
  await expectNoErrors(errors);
});

test('sculpt paint brush and color fill (Ctrl+X)', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, 'SCULPT', 'mesh.primitive_uv_sphere_add', { segments: 32, ring_count: 16, radius: 4 });
  await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('paint.brush_select', { brush: 'brush_sculpt_paint' });
    a.doc.scene.tool_settings.unified_paint.color = [1, 0, 0];
  });
  const c = await viewportCenter(page);
  await page.mouse.move(c.x - 40, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y, { steps: 8 });
  await page.mouse.up();
  const red = () =>
    page.evaluate(() => {
      const a = (window as unknown as W).app;
      const me = a.doc.meshes[a.activeObject.data];
      const d = me.color_attributes[me.active_color_index].data as Float32Array;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] < 0.9) n++;
      return { n, nv: me.positions.length / 3 };
    });
  const r1 = await red();
  expect(r1.n).toBeGreaterThan(0);
  expect(r1.n).toBeLessThan(r1.nv);
  await page.keyboard.press('Control+x');
  expect((await red()).n).toBe(r1.nv);
  await expectNoErrors(errors);
});
