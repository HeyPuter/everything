// Paint modes, round 4: scripted strokes, palettes, stencils, paint curves, loop selection in the
// paint masks, brush assets, Expand keys and painting in the Image Editor.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

type W = { app: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A UV sphere filling the front view, in the given mode. */
async function sphere(page: Page, mode: string, segments = 32, rings = 16) {
  await page.evaluate(
    ({ mode, segments, rings }) => {
      const a = (window as unknown as W).app;
      a.run('object.select_all', { action: 'SELECT' });
      a.run('object.delete');
      a.run('mesh.primitive_uv_sphere_add', { segments, ring_count: rings });
      a.run('view3d.view_axis', { type: 'FRONT' }, { invoke: false });
      a.run('view3d.view_selected', {}, { invoke: false });
      a.flush();
      a.run('object.mode_set', { mode });
      a.flush();
    },
    { mode, segments, rings },
  );
  await page.waitForTimeout(400);
}

const viewBox = async (page: Page) => (await page.locator('.view3d').first().boundingBox())!;

test('scripted strokes sculpt and paint; mode toggles switch modes', async ({ page }) => {
  const errors = await openApp(page);
  await sphere(page, 'SCULPT');
  const res = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    const me0 = Array.from(a.doc.meshes[a.activeObject.data].positions as Float32Array);
    const stroke = Array.from({ length: 9 }, (_, i) => ({ location: [-0.4 + i * 0.1, -1, 0] }));
    const r = a.run('sculpt.brush_stroke', { stroke }, { invoke: false });
    const me1 = a.doc.meshes[a.activeObject.data].positions as Float32Array;
    let moved = 0;
    for (let i = 0; i < me0.length; i++) if (Math.abs(me0[i] - me1[i]) > 1e-6) moved++;
    const off = a.run('sculpt.brush_stroke', { stroke: [{ mouse: [2, 2] }] }, { invoke: false });
    const t1 = a.run('paint.vertex_paint_toggle');
    const m1 = a.doc.mode;
    const r2 = a.run('paint.vertex_paint', { stroke }, { invoke: false });
    const t2 = a.run('paint.vertex_paint_toggle');
    return { r, moved, off, t1, m1, r2, t2, m2: a.doc.mode };
  });
  expect(res.r).toBe('FINISHED');
  expect(res.moved).toBeGreaterThan(10);
  expect(res.off).toBe('CANCELLED');
  expect(res.m1).toBe('VERTEX_PAINT');
  expect(res.r2).toBe('FINISHED');
  expect(res.m2).toBe('OBJECT');
  await expectNoErrors(errors.filter((e) => !/does not touch/.test(e)));
});

test('palettes: new, add colors, sort, pick a swatch, delete', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('object.mode_set', { mode: 'VERTEX_PAINT' });
    a.run('palette.new');
    for (const c of [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ]) {
      a.doc.scene.tool_settings.unified_paint.color = c;
      a.run('palette.color_add');
    }
    a.run('palette.sort', { type: 'HSV' });
  });
  const pal = await page.evaluate(() => Object.values((window as unknown as W).app.doc.palettes as Record<string, { colors: { color: number[] }[] }>)[0].colors.map((c) => c.color));
  expect(pal).toEqual([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  // the swatches in the Tool tab pick the brush color
  await page.evaluate(async () => {
    const w = await import('/src/ui/widgets.ts' as string);
    w.setPanelOpen('pt-palette-VERTEX_PAINT', true);
    const a = (window as unknown as W).app;
    for (const ar of a.activeArea?.screen?.areas ?? a.hoverArea?.screen?.areas ?? []) if (ar.editor?.setTab) ar.editor.setTab('TOOL');
    a.changed('ui');
  });
  await page.mouse.move(400, 300);
  await page.evaluate(() => {
    const a = (window as unknown as W).app;
    for (const ar of a.hoverArea?.screen?.areas ?? []) if (ar.editor?.setTab) ar.editor.setTab('TOOL');
    a.changed('ui');
  });
  const sw = page.locator('.paint-palette .pp-swatch[data-index="1"]').first();
  await sw.scrollIntoViewIfNeeded();
  await sw.click();
  expect(await page.evaluate(() => (window as unknown as W).app.doc.scene.tool_settings.unified_paint.color)).toEqual([0, 1, 0]);
  const n = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('palette.color_delete');
    return Object.values(a.doc.palettes as Record<string, { colors: unknown[] }>)[0].colors.length;
  });
  expect(n).toBe(2);
  await expectNoErrors(errors);
});

test('stencil: right-drag moves it, Ctrl+right-drag rotates it, Reset Transform restores it', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('view3d.view_axis', { type: 'FRONT' }, { invoke: false });
    a.run('view3d.view_selected', {}, { invoke: false });
    a.run('image.new', { name: 'Grid', width: 64, height: 64, generated_type: 'COLOR_GRID' }, { invoke: false });
    a.run('object.mode_set', { mode: 'TEXTURE_PAINT' });
    a.doc.scene.tool_settings.sculpt.use_symmetry_x = false;
    const img = Object.values(a.doc.images as Record<string, { id: string; name: string }>).find((i) => i.name === 'Grid')!;
    const b = a.doc.brushes.brush_texpaint;
    b.texture_slot = { source: 'IMAGE', image: img.id, map_mode: 'STENCIL', angle: 0, scale: 1, strength: 1 };
    b.stencil_pos = [300, 300];
    b.stencil_dimension = [60, 60];
    a.changed('ui');
  });
  await page.waitForTimeout(300);
  const box = await viewBox(page);
  const sx = box.x + 300,
    sy = box.y + box.height - 300;
  await page.mouse.move(sx, sy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(sx + 40, sy - 20, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  expect(await page.evaluate(() => (window as unknown as W).app.doc.brushes.brush_texpaint.stencil_pos)).toEqual([340, 320]);
  await expect(page.locator('.menu')).toHaveCount(0);
  await expect(page.locator('.paint-stencil-img')).toHaveCount(1);
  await page.keyboard.down('Control');
  await page.mouse.move(sx + 100, sy - 20);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(sx + 40, sy - 80, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Control');
  expect(Math.abs(await page.evaluate(() => (window as unknown as W).app.doc.brushes.brush_texpaint.texture_slot.angle))).toBeGreaterThan(1);
  await page.evaluate(() => (window as unknown as W).app.run('brush.stencil_reset_transform', {}, { invoke: false }));
  expect(await page.evaluate(() => (window as unknown as W).app.doc.brushes.brush_texpaint.stencil_pos)).toEqual([256, 256]);
  await expectNoErrors(errors);
});

test('paint curve: Ctrl+click adds points, drag moves one, Enter paints along it', async ({ page }) => {
  const errors = await openApp(page);
  await sphere(page, 'SCULPT');
  await page.evaluate(() => (window as unknown as W).app.run('paint.brush_stroke_method_set', { method: 'CURVE' }));
  const box = await viewBox(page);
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.keyboard.down('Control');
  for (const [dx, dy] of [
    [-30, 10],
    [0, -15],
    [30, 10],
  ]) {
    await page.mouse.click(cx + dx, cy + dy);
  }
  await page.keyboard.up('Control');
  const pts = await page.evaluate(() => Object.values((window as unknown as W).app.doc.paint_curves as Record<string, { points: unknown[] }>)[0].points.length);
  expect(pts).toBe(3);
  await page.mouse.move(cx, cy - 15);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 25, { steps: 3 });
  await page.mouse.up();
  const y1 = await page.evaluate(() => Object.values((window as unknown as W).app.doc.paint_curves as Record<string, { points: { co: number[] }[] }>)[0].points[1].co[1]);
  const me0 = await page.evaluate(() => Array.from((window as unknown as W).app.doc.meshes[(window as unknown as W).app.activeObject.data].positions as Float32Array));
  await page.keyboard.press('Enter');
  const moved = await page.evaluate((me0) => {
    const a = (window as unknown as W).app;
    const P = a.doc.meshes[a.activeObject.data].positions as Float32Array;
    let n = 0;
    for (let i = 0; i < P.length; i++) if (Math.abs(P[i] - me0[i]) > 1e-6) n++;
    return n;
  }, me0);
  expect(y1).toBeLessThan(cy - box.y - 20);
  expect(moved).toBeGreaterThan(5);
  await expectNoErrors(errors);
});

test('loop selection in the weight paint selection masks', async ({ page }) => {
  const errors = await openApp(page);
  await sphere(page, 'WEIGHT_PAINT', 16, 8);
  const box = await viewBox(page);
  const res = await page.evaluate(
    ({ x, y }) => {
      const a = (window as unknown as W).app;
      a.run('paint.selection_mask_toggle', { mode: 'FACE' });
      const r = a.run('paint.face_select_loop', {}, { event: { x, y } });
      const me = a.doc.meshes[a.activeObject.data];
      return { r, n: Array.from(me.select_vert as Uint8Array).filter(Boolean).length };
    },
    { x: box.x + box.width / 2 + 3, y: box.y + box.height / 2 - 20 },
  );
  expect(res.r).toBe('FINISHED');
  // one strip of faces around the sphere: more than a face, far less than everything
  expect(res.n).toBeGreaterThan(8);
  expect(res.n).toBeLessThan(60);
  await expectNoErrors(errors);
});

test('brush assets: revert a built-in brush, save a copy as an asset and edit its metadata', async ({ page }) => {
  const errors = await openApp(page);
  const res = await page.evaluate(() => {
    const a = (window as unknown as W).app;
    a.run('object.mode_set', { mode: 'SCULPT' });
    const b = a.doc.brushes.brush_draw;
    b.strength = 0.93;
    a.run('brush.asset_revert', {}, { invoke: false });
    const reverted = b.strength;
    a.run('brush.asset_save_as', { name: 'Mine' }, { invoke: false });
    const mine = Object.values(a.doc.brushes as Record<string, { id: string; name: string; asset_data?: { author: string } }>).find((x) => x.name === 'Mine')!;
    a.run('paint.brush_select', { brush: mine.id });
    a.run('brush.asset_edit_metadata', { author: 'Me', description: 'd', catalog_path: 'Sculpt' }, { invoke: false });
    const author = mine.asset_data?.author;
    const del = a.run('brush.asset_delete', {}, { invoke: false });
    return { reverted, author, del, gone: !a.doc.brushes[mine.id] };
  });
  expect(res).toEqual({ reverted: 0.5, author: 'Me', del: 'FINISHED', gone: true });
  await expectNoErrors(errors);
});

test('Expand: R recurses from the expanded region', async ({ page }) => {
  const errors = await openApp(page);
  await sphere(page, 'SCULPT');
  const box = await viewBox(page);
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const masked = () => page.evaluate(() => Math.round(Array.from(((window as unknown as W).app.doc.meshes[(window as unknown as W).app.activeObject.data].sculpt_mask ?? []) as number[]).reduce((s, x) => s + x, 0)));
  await page.mouse.move(cx, cy);
  await page.keyboard.press('Shift+A');
  await page.mouse.move(cx + 15, cy, { steps: 3 });
  const m1 = await masked();
  await page.keyboard.press('r');
  await page.mouse.move(cx + 30, cy, { steps: 3 });
  const m2 = await masked();
  await page.mouse.down();
  await page.mouse.up();
  expect(m1).toBeGreaterThan(0);
  expect(m2).toBeGreaterThan(m1);
  expect(await page.evaluate(() => !!(window as unknown as W).app.modal)).toBe(false);
  await expectNoErrors(errors);
});

test('Image Editor paint mode paints along the stroke', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Texture Paint' }).first().click();
  await page.waitForTimeout(600);
  const ie = page.locator('.ie-root').first();
  const box = (await ie.boundingBox())!;
  const rev0 = await page.evaluate(() => Object.values((window as unknown as W).app.doc.images as Record<string, { revision?: number }>)[0]?.revision ?? 0);
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const rev1 = await page.evaluate(() => Object.values((window as unknown as W).app.doc.images as Record<string, { revision?: number }>)[0]?.revision ?? 0);
  expect(rev1).toBeGreaterThan(rev0);
  await expectNoErrors(errors);
});
