// Texture baking on the GPU: numeric checks of baked passes, the Bake panel, progress with Esc
// to cancel, and one undo step per bake.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Run a JavaScript snippet with the scripting API; returns `window.__out`. */
async function script(page: Page, code: string): Promise<any> {
  return page.evaluate(async (c) => {
    const { runJavaScript } = await import('/src/scripting/runner.ts' as string);
    (window as any).__out = undefined;
    const r = runJavaScript(c);
    if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
    return (window as any).__out;
  }, code);
}

/** A plane with a material whose active Image Texture node holds a Non-Color image `T` (size px). */
const PLANE = (size: number, extra = '') => `
  bpy.ops.object.select_all({action: 'SELECT'}); bpy.ops.object.delete();
  bpy.ops.mesh.primitive_plane_add({size: 2});
  const ob = C.object;
  const ma = D.materials.new('M'); ma.use_nodes = true; ob.data.materials.append(ma);
  const img = D.images.new('T', ${size}, ${size}); img.colorspace_settings.name = 'Non-Color';
  const n = ma.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img; ma.node_tree.nodes.active = n;
  const px = (x, y) => { const p = [...img.pixels]; return p.slice((y * ${size} + x) * 4, (y * ${size} + x) * 4 + 4).map((v) => Math.round(v * 255)); };
  ${extra}`;

test('baked passes have the expected values', async ({ page }) => {
  const errors = await openApp(page);
  const out = await script(
    page,
    PLANE(
      16,
      `
      const bs = ma.node_tree.nodes['Principled BSDF'];
      bs.inputs['Emission Color'].default_value = [1, 0.5, 0.25, 1];
      bs.inputs['Emission Strength'].default_value = 0.5;
      bs.inputs['Roughness'].default_value = 0.25;
      window.__out = {};
      bpy.ops.object.bake({type: 'NORMAL'}); window.__out.normal = px(8, 8);
      bpy.ops.object.bake({type: 'EMIT'}); window.__out.emit = px(8, 8);
      bpy.ops.object.bake({type: 'ROUGHNESS'}); window.__out.rough = px(8, 8);
      bpy.ops.object.bake({type: 'DIFFUSE', pass_filter: ['COLOR']}); window.__out.diffuse = px(8, 8);
      bpy.ops.object.bake({type: 'NORMAL', normal_g: 'NEG_Y', normal_space: 'OBJECT'}); window.__out.obj = px(8, 8);`,
    ),
  );
  expect(out.normal).toEqual([128, 128, 255, 255]);
  expect(out.emit).toEqual([128, 64, 32, 255]);
  expect(out.rough).toEqual([64, 64, 64, 255]);
  expect(out.diffuse).toEqual([204, 204, 204, 255]);
  expect(out.obj).toEqual([128, 128, 255, 255]);
  await expectNoErrors(errors);
});

test('procedural node textures bake through the material shader', async ({ page }) => {
  const errors = await openApp(page);
  const out = await script(
    page,
    PLANE(
      16,
      `
      const nt = ma.node_tree;
      const ck = nt.nodes.new('ShaderNodeTexChecker');
      ck.inputs['Scale'].default_value = 2;
      ck.inputs['Color1'].default_value = [1, 0, 0, 1];
      ck.inputs['Color2'].default_value = [0, 0, 1, 1];
      nt.links.new(nt.nodes.new('ShaderNodeTexCoord').outputs['UV'], ck.inputs['Vector']);
      nt.links.new(ck.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color']);
      nt.nodes.active = n;
      bpy.ops.object.bake({type: 'DIFFUSE', pass_filter: ['COLOR']});
      window.__out = [px(2, 2), px(12, 2), px(12, 12), px(2, 12)];`,
    ),
  );
  expect(out).toEqual([
    [0, 0, 255, 255],
    [255, 0, 0, 255],
    [0, 0, 255, 255],
    [255, 0, 0, 255],
  ]);
  await expectNoErrors(errors);
});

test('bake from multires: detail of the top level as normals and displacement', async ({ page }) => {
  const errors = await openApp(page);
  const out = await script(
    page,
    `
    const ob = C.object;
    bpy.ops.object.modifier_add({type: 'MULTIRES'});
    bpy.ops.object.multires_subdivide({modifier: 'Multires', mode: 'CATMULL_CLARK'});
    bpy.ops.object.multires_subdivide({modifier: 'Multires', mode: 'CATMULL_CLARK'});
    ob.modifiers[0].levels = 0;
    const ma = ob.data.materials[0];
    const img = D.images.new('T', 64, 64); img.colorspace_settings.name = 'Non-Color';
    const n = ma.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img; ma.node_tree.nodes.active = n;
    C.scene.render.bake.use_multires = true;
    const sum = () => [...img.pixels].reduce((a, b) => a + b, 0);
    bpy.ops.object.bake_image();
    const normals = sum();
    C.scene.render.bake.type = 'DISPLACEMENT';
    bpy.ops.object.bake_image();
    window.__out = { normals, disp: sum(), report: window.app.reports.at(-1).message };`,
  );
  // the smoothed top level dips inside the cube: heights are negative (below mid grey)
  expect(out.report).toMatch(/Baked multires displacement into "T" \(heights -/);
  expect(out.normals).toBeGreaterThan(0);
  await expectNoErrors(errors);
});

test('ambient occlusion next to a wall and a tilted surface baked selected-to-active', async ({ page }) => {
  const errors = await openApp(page);
  const out = await script(
    page,
    `
    bpy.ops.object.select_all({action: 'SELECT'}); bpy.ops.object.delete();
    bpy.ops.mesh.primitive_plane_add({size: 2, location: [1, 0, 0]});
    const ground = C.object;
    bpy.ops.mesh.primitive_plane_add({size: 10, rotation: [0, Math.PI / 2, 0]});
    bpy.ops.object.select_all({action: 'DESELECT'}); ground.select_set(true); C.view_layer.objects.active = ground;
    C.scene.render.samples = 512;
    window.app.doc.scene.render.ambient_occlusion_distance = 100;
    const ma = D.materials.new('M'); ma.use_nodes = true; ground.data.materials.append(ma);
    const img = D.images.new('T', 32, 32); img.colorspace_settings.name = 'Non-Color';
    const n = ma.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img; ma.node_tree.nodes.active = n;
    const px = (x, y) => [...img.pixels][(y * 32 + x) * 4];
    bpy.ops.object.bake({type: 'AO'});
    window.__out = { near: px(0, 16), far: px(31, 16) };
    // a high-resolution plane tilted 30° about Y seen from a flat low plane
    bpy.ops.object.select_all({action: 'SELECT'}); bpy.ops.object.delete();
    bpy.ops.mesh.primitive_plane_add({size: 4, location: [0, 0, 0.1], rotation: [0, Math.PI / 6, 0]});
    const high = C.object;
    bpy.ops.mesh.primitive_plane_add({size: 2});
    const low = C.object; high.select_set(true);
    low.data.materials.append(ma);
    bpy.ops.object.bake({type: 'NORMAL', use_selected_to_active: true, cage_extrusion: 1});
    window.__out.tilt = [...img.pixels].slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 3);`,
  );
  // an infinite wall hides half of the cosine-weighted hemisphere; a 5 m wall 2 m away ~29 %
  expect(out.near).toBeGreaterThan(0.43);
  expect(out.near).toBeLessThan(0.57);
  expect(out.far).toBeGreaterThan(0.64);
  expect(out.far).toBeLessThan(0.77);
  expect(out.tilt[0]).toBeCloseTo(0.75, 1);
  expect(out.tilt[1]).toBeCloseTo(0.5, 1);
  expect(out.tilt[2]).toBeCloseTo(0.933, 1);
  await expectNoErrors(errors);
});

test('Bake panel: bake with progress, undo in one step, Esc cancels', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => ((window as any).app.doc.scene.render.engine = 'PATHTRACE'));
  await script(page, PLANE(64, `C.scene.cycles.bake_type = 'NORMAL'; C.scene.render.samples = 20000;`));
  await page.locator('.rail-tab[data-tab="RENDER"]').first().click();
  const header = page.locator('[data-panel="rs-bake"] > .panel-header').first();
  await header.scrollIntoViewIfNeeded();
  if (!(await page.locator('.bake-button').count())) await header.click();
  await expect(page.locator('.prop-note.bake-into')).toContainText('“T”');
  const before = await page.evaluate(() => Object.values((window as any).app.doc.images).find((i: any) => i.name === 'T') as any).then((i) => i.revision ?? 0);
  await page.locator('.bake-button').click();
  await expect.poll(() => page.evaluate(() => (window as any).app.reports.at(-1)?.message ?? '')).toMatch(/Baked Normal/);
  const img = () => page.evaluate(() => (Object.values((window as any).app.doc.images).find((i: any) => i.name === 'T') as any).revision ?? 0);
  expect(await img()).toBeGreaterThan(before);
  await page.keyboard.press('Control+z');
  await expect.poll(img).toBe(before);
  // a long AO bake: progress in the status bar, Esc cancels and leaves the image alone
  await page.evaluate(() => ((window as any).app.doc.scene.render.bake_type = 'AO'));
  await page.evaluate(() => (window as any).app.changed('ui'));
  await page.locator('.bake-button').click();
  await expect(page.locator('.sb-job', { hasText: 'Bake' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sb-job', { hasText: 'Bake' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).app.reports.at(-1)?.message ?? '')).toMatch(/cancelled/);
  expect(await img()).toBe(before);
  await expectNoErrors(errors);
});

/** Make the first area an Image Editor showing `id` (or the Render Result) and return its box. */
async function imageEditor(page: Page, id: string | null) {
  await page.evaluate((imgId) => {
    const a = (window as any).app;
    const el = document.querySelector('.area[data-editor="IMAGE_EDITOR"], .area[data-editor="VIEW_3D"]') as HTMLElement;
    el.dispatchEvent(new PointerEvent('pointerenter'));
    const area = a.hoverArea;
    area.setType('IMAGE_EDITOR');
    area.editor.setImage(imgId ?? '__render_result__');
  }, id);
  return page.locator('.area[data-editor="IMAGE_EDITOR"]').first();
}

test('Image Editor: render slots, Pack, sampling with a sample size, Shading header', async ({ page }) => {
  const errors = await openApp(page);
  const area = await imageEditor(page, null);
  const box = (await area.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const slots = () => page.evaluate(async () => ((await import('/src/render/final/result.ts' as string)) as any).renderResult.count);
  const n0 = await slots();
  await page.evaluate(() => (window as any).app.run('image.add_render_slot'));
  expect(await slots()).toBe(n0 + 1);
  await page.evaluate(() => (window as any).app.run('image.remove_render_slot'));
  expect(await slots()).toBe(n0);
  // a generated image: Pack stores its pixels; sampling shows averaged values while dragging
  const id = await page.evaluate(() => {
    const a = (window as any).app;
    a.run('image.new', { name: 'Gen', width: 64, height: 64, color: [1, 0, 0, 1] }, { invoke: false });
    return Object.values(a.doc.images).find((i: any) => i.name === 'Gen').id as string;
  });
  await imageEditor(page, id);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => (window as any).app.run('image.pack'));
  expect(await page.evaluate((i) => (window as any).app.doc.images[i].source, id)).toBe('FILE');
  await expect(area.locator('.ie-samplehdr')).toBeVisible();
  const size = area.locator('.ie-samplehdr .num-field').first();
  await size.dblclick();
  const input = page.locator('input.editing');
  await expect(input).toBeVisible();
  await input.fill('5');
  await input.press('Enter');
  const canvas = area.locator('.ie-canvas');
  const cb = (await canvas.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await expect(area.locator('.ie-sample')).toContainText('R:255');
  await expect(area.locator('.ie-sample')).toContainText('5×5 px');
  await page.mouse.up();
  await expect(area.locator('.ie-sample')).toHaveCount(0);
  // the narrow Image Editor of the Shading workspace starts with its menus collapsed
  await page.locator('.ws-tab', { hasText: 'Shading' }).first().click();
  await expect(page.locator('.area[data-editor="IMAGE_EDITOR"] .hdr-collapsed-menus')).toBeVisible();
  await expectNoErrors(errors);
});

test('UDIM tiles: convert, add / fill / remove tiles, bake into the tile under the UVs', async ({ page }) => {
  const errors = await openApp(page);
  // a plane whose UVs lie in tile 1002, emitting green
  await script(
    page,
    PLANE(
      16,
      `
      const me = window.app.doc.meshes[window.app.activeObject.data];
      me.uvs = me.uvs.map((v, i) => (i % 2 === 0 ? v + 1 : v));
      window.app.changed('doc');
      const bs = ma.node_tree.nodes['Principled BSDF'];
      bs.inputs['Emission Color'].default_value = [0, 1, 0, 1];
      bs.inputs['Emission Strength'].default_value = 1;`,
    ),
  );
  const id = await page.evaluate(() => (Object.values((window as any).app.doc.images).find((i: any) => i.name === 'T') as any).id);
  const area = await imageEditor(page, id);
  const box = (await area.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('n');
  // Source ▸ UDIM Tiles
  await area.locator(`[data-id="ie-src-${id}"]`).click();
  await page.locator('.menu-item', { hasText: 'UDIM Tiles' }).first().click();
  await expect(area.locator('[data-panel="ie-udim"]')).toBeVisible();
  const tiles = () => page.evaluate((i) => (window as any).app.doc.images[i].tiles.map((t: any) => t.number), id);
  expect(await tiles()).toEqual([1001]);
  await area.locator('[data-panel="ie-udim"] .ul-side button').first().click(); // +
  await page.evaluate(() => (window as any).app.run('image.tile_add', { number: 1011, count: 2 }, { invoke: false }));
  expect(await tiles()).toEqual([1001, 1002, 1011, 1012]);
  await page.evaluate(() => (window as any).app.run('image.tile_remove'));
  expect(await tiles()).toEqual([1001, 1002, 1011]);
  await page.evaluate(() => (window as any).app.run('image.tile_fill', { color: [1, 0, 0, 1], width: 8, height: 8, generated_type: 'BLANK' }, { invoke: false }));
  // bake: tile 1002 receives the emission, the others are cleared
  const px = await page.evaluate(async (i) => {
    const a = (window as any).app;
    a.run('object.bake', { type: 'EMIT', margin: 0 }, { invoke: false });
    const { readTile } = await import('/src/render/final/udimops.ts' as string);
    const img = a.doc.images[i];
    img.tiles.forEach((_: unknown, k: number) => readTile(img, k));
    await new Promise((r) => setTimeout(r, 300));
    return img.tiles.map((_: unknown, k: number) => Array.from(readTile(img, k).data.slice(0, 4)));
  }, id);
  expect(px[1]).toEqual([0, 255, 0, 255]);
  expect(px[0]).toEqual([0, 0, 0, 255]);
  await expectNoErrors(errors);
});
