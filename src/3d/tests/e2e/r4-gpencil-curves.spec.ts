// Grease Pencil round 4: stroke spline types and handles, the Pen and Gradient tools, stroke types,
// fill guides, scripted brush strokes and the annotation tools.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors, viewportCenter } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}, invoke = false) => page.evaluate(([o, p, i]) => (window as any).app.run(o, p, { invoke: i }), [op, props, invoke] as const);
const gp = `app.doc.grease_pencils[app.activeObject.data]`;
const activeDrawing = `${gp}.drawings[${gp}.layers[${gp}.active_layer_index].frames[0].drawing]`;

async function load2D(page: Page) {
  await page.evaluate(() => (window as any).app.run('wm.read_homefile', { app_template: '2D_Animation' }));
  await page.waitForTimeout(300);
}

test('spline types: convert, handles, resolution, V menu and the Stroke menu entries', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.select_all', { action: 'SELECT' });
  await run(page, 'object.delete');
  await run(page, 'object.grease_pencil_add', { type: 'STROKE' });
  await run(page, 'object.mode_set', { mode: 'EDIT' });
  await run(page, 'grease_pencil.select_all', { action: 'SELECT' });
  const before = (await get(page, `${gp}.drawings.map((d) => d.position.length / 3)`)) as number[];
  expect(await run(page, 'grease_pencil.convert_curve_type', { type: 'BEZIER', threshold: 0.01 })).toBe('FINISHED');
  const after = (await get(page, `${gp}.drawings.map((d) => d.position.length / 3)`)) as number[];
  expect(after.reduce((a, b) => a + b, 0)).toBeLessThan(before.reduce((a, b) => a + b, 0));
  expect(await get(page, `${gp}.drawings.every((d) => !d.curve_type || [...d.curve_type].every((t) => t === 2))`)).toBe(true);
  // resolution and handle types
  expect(await run(page, 'grease_pencil.set_curve_resolution', { resolution: 4 })).toBe('FINISHED');
  expect(await get(page, `${gp}.drawings.filter((d) => d.resolution).every((d) => [...d.resolution].every((r) => r === 4))`)).toBe(true);
  expect(await run(page, 'grease_pencil.set_handle_type', { type: 'VECTOR' })).toBe('FINISHED');
  expect(await get(page, `${gp}.drawings.filter((d) => d.handle_type_left).every((d) => [...d.handle_type_left].every((t) => t === 2))`)).toBe(true);
  // V opens the handle type menu
  await hoverViewport(page);
  await page.keyboard.press('v');
  await expect(page.locator('.menu .menu-item', { hasText: 'Toggle Free/Align' })).toBeVisible();
  await page.keyboard.press('Escape');
  // the Stroke menu offers the conversions and stroke types
  await page
    .locator('.hdr-menu', { hasText: /^Stroke$/ })
    .first()
    .dispatchEvent('pointerdown');
  for (const item of ['Convert Type', 'Set Resolution', 'Set Stroke Type', 'Reset UVs']) await expect(page.locator('.menu .menu-item', { hasText: item }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  // back to poly lines: the evaluated points
  expect(await run(page, 'grease_pencil.convert_curve_type', { type: 'POLY' })).toBe('FINISHED');
  expect(await get(page, `${gp}.drawings.every((d) => !d.curve_type || [...d.curve_type].every((t) => t === 1))`)).toBe(true);
  // stroke types: fill only, then select by type
  expect(await run(page, 'grease_pencil.set_stroke_type', { type: 'FILL' })).toBe('FINISHED');
  await run(page, 'grease_pencil.select_all', { action: 'DESELECT' });
  await run(page, 'grease_pencil.select_by_stroke_type', { type: 'FILL' });
  expect(await get(page, `${gp}.drawings.some((d) => d.select.some((x) => x))`)).toBe(true);
  await expectNoErrors(errors);
});

test('pen tool: click and drag build a Bézier stroke, points drag', async ({ page }) => {
  const errors = await openApp(page);
  await load2D(page);
  await run(page, 'object.mode_set', { mode: 'EDIT' });
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.pen' });
  const { x: cx, y: cy } = await viewportCenter(page);
  await page.mouse.click(cx - 200, cy + 40);
  await page.mouse.move(cx - 40, cy - 90);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx - 40 + i * 12, cy - 90);
  await page.mouse.up();
  await page.mouse.click(cx + 160, cy + 50);
  expect(await get(page, `${activeDrawing}.offsets.length - 1`)).toBe(1);
  expect(await get(page, `${activeDrawing}.position.length / 3`)).toBe(3);
  expect(await get(page, `[...${activeDrawing}.curve_type]`)).toEqual([2]);
  // the dragged point got aligned handles
  expect(await get(page, `${activeDrawing}.handle_type_left[1]`)).toBe(3);
  // a click on the first point selects it; dragging it moves it with its handles
  await page.mouse.move(cx - 200, cy + 40);
  await page.mouse.down();
  await page.mouse.move(cx - 190, cy + 30);
  await page.mouse.move(cx - 180, cy + 20);
  await page.mouse.up();
  expect(await get(page, `${activeDrawing}.position.length / 3`)).toBe(3);
  expect(await get(page, `[...${activeDrawing}.select]`)).toEqual([1, 0, 0]);
  await expectNoErrors(errors);
});

test('gradient tool, fill guides and scripted brush strokes', async ({ page }) => {
  const errors = await openApp(page);
  await load2D(page);
  // a scripted Draw stroke
  const pts = Array.from({ length: 20 }, (_, i) => ({ mouse: [300 + i * 15, 300 + Math.sin(i / 3) * 40], pressure: 1 }));
  expect(await run(page, 'grease_pencil.brush_stroke', { stroke: pts })).toBe('FINISHED');
  expect(await get(page, `${activeDrawing}.offsets.length - 1`)).toBe(1);
  // Alt drag with the Fill tool draws a fill guide; Remove Fill Guides deletes it
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.brush.Fill' });
  const { x: cx, y: cy } = await viewportCenter(page);
  await page.keyboard.down('Alt');
  await page.mouse.move(cx - 100, cy - 80);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 100 + i * 20, cy - 80 + i * 8);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(await get(page, `[...${activeDrawing}.is_fill_guide]`)).toEqual([0, 1]);
  expect(await run(page, 'grease_pencil.remove_fill_guides')).toBe('FINISHED');
  expect(await get(page, `${activeDrawing}.offsets.length - 1`)).toBe(1);
  // the Gradient tool places the fill gradient of the selected strokes
  await run(page, 'object.mode_set', { mode: 'EDIT' });
  await run(page, 'grease_pencil.select_all', { action: 'SELECT' });
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.texture_gradient' });
  await page.mouse.move(cx - 150, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 150 + i * 30, cy);
  await page.mouse.up();
  expect(await get(page, `${activeDrawing}.uv_scale && ${activeDrawing}.uv_scale[0] > 0`)).toBe(true);
  expect(await run(page, 'grease_pencil.reset_uvs')).toBe('FINISHED');
  expect(await get(page, `!${activeDrawing}.uv_scale`)).toBe(true);
  await expectNoErrors(errors);
});

test('annotations: line with arrows, polygon, D drag, eraser', async ({ page }) => {
  const errors = await openApp(page);
  const { x: cx, y: cy } = await viewportCenter(page);
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.annotate_line' });
  await page.mouse.move(cx - 200, cy + 100);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 200 + i * 20, cy + 100);
  await page.mouse.up();
  expect(await get(page, `app.doc.scene.annotations.length`)).toBe(1);
  expect(await get(page, `app.doc.scene.annotations[0].points.length`)).toBe(6);
  // polygon: three clicks and Enter
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.annotate_polygon' });
  await page.mouse.click(cx - 200, cy - 150);
  await page.mouse.click(cx - 120, cy - 200);
  await page.mouse.click(cx - 60, cy - 120);
  await page.keyboard.press('Enter');
  expect(await get(page, `app.doc.scene.annotations[1].points.length`)).toBe(9);
  // D + drag draws freehand whatever the tool
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.select_box' });
  await page.mouse.move(cx + 50, cy - 50);
  await page.keyboard.down('d');
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(cx + 50 + i * 8, cy - 50 + (i % 3) * 6);
  await page.mouse.up();
  await page.keyboard.up('d');
  expect(await get(page, `app.doc.scene.annotations.length`)).toBe(3);
  // scripted line with arrow heads
  expect(await run(page, 'gpencil.annotate', { mode: 'DRAW_STRAIGHT', arrowstyle_end: 'ARROW', stroke: [{ location: [0, 0, 0] }, { location: [1, 0, 1] }] })).toBe('FINISHED');
  expect(await get(page, `app.doc.scene.annotations[3].arrow_end`)).toBe('ARROW');
  await expect(page.locator('.view3d g.annotations polygon').first()).toBeAttached();
  // the eraser cuts the first line in two
  await run(page, 'wm.tool_set_by_id', { name: 'builtin.annotate_eraser' });
  await page.mouse.move(cx - 100, cy + 100);
  await page.mouse.down();
  await page.mouse.move(cx - 99, cy + 101);
  await page.mouse.up();
  const lens = (await get(page, `app.doc.scene.annotations.map((s) => s.points.length / 3)`)) as number[];
  expect(lens.length).toBe(5);
  // undo restores
  await page.keyboard.press('Control+z');
  expect(await get(page, `app.doc.scene.annotations.length`)).toBe(4);
  await expectNoErrors(errors);
});

test('annotations in a node editor: D drag draws in node space, D right drag erases', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.evaluate(() => {
    const a = (window as any).app;
    const scr = (a.activeArea ?? a.hoverArea).screen;
    scr.areas.find((x: any) => x.type === 'VIEW_3D').setType('SHADER');
  });
  await page.waitForTimeout(500);
  const r = (await page.evaluate(() => {
    const b = document.querySelector('.area-main')!.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })) as { x: number; y: number };
  await page.mouse.move(r.x - 150, r.y - 120);
  await page.keyboard.down('d');
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(r.x - 150 + i * 12, r.y - 120 + (i % 4) * 5);
  await page.mouse.up();
  const count = () =>
    page.evaluate(() => {
      const a = (window as any).app;
      const ed = (a.activeArea ?? a.hoverArea).screen.areas.find((x: any) => x.type === 'SHADER').editor;
      return ed.tree()?.annotation_strokes_2d?.length ?? 0;
    });
  expect(await count()).toBe(1);
  await expect(page.locator('.gp-annot2d polyline')).toHaveCount(1);
  // right drag with D erases it
  await page.mouse.move(r.x - 90, r.y - 115);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(r.x - 30, r.y - 110, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('d');
  const n = (await count()) as number;
  expect(n === 0 || n === 2).toBe(true);
  await expect(page.locator('.menu')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('multi-frame editing with falloff moves far keyframes less', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.select_all', { action: 'SELECT' });
  await run(page, 'object.delete');
  await run(page, 'object.grease_pencil_add', { type: 'STROKE' });
  // a second keyframe at frame 11 holding a copy of frame 1
  await page.evaluate(() => {
    const a = (window as any).app;
    const g = a.doc.grease_pencils[a.activeObject.data];
    for (const l of g.layers) {
      const f = l.frames[0];
      if (!f) continue;
      g.drawings.push(g.drawings[f.drawing]);
      l.frames.push({ frame_number: 11, drawing: g.drawings.length - 1, keyframe_type: 'KEYFRAME', select: true });
      f.select = true;
    }
    a.pushUndo('Test Keys');
  });
  await run(page, 'object.mode_set', { mode: 'EDIT' });
  const firstX = (f: number) =>
    get(
      page,
      `(() => { const l = ${gp}.layers.find((x) => x.frames.length > 1); const fr = l.frames.find((x) => x.frame_number === ${f}); return ${gp}.drawings[fr.drawing].position[0]; })()`,
    ) as Promise<number>;
  const before = await firstX(1);
  await page.evaluate(() => {
    const a = (window as any).app;
    const ts = a.doc.scene.tool_settings;
    ts.use_grease_pencil_multi_frame_editing = true;
    ts.use_multiframe_falloff = true;
  });
  await run(page, 'grease_pencil.select_all', { action: 'SELECT' });
  await run(page, 'transform.translate', { value: [1, 0, 0] });
  const d1 = (await firstX(1)) - before,
    d11 = (await firstX(11)) - before;
  expect(d1).toBeCloseTo(1, 3);
  expect(d11).toBeGreaterThan(0.01);
  expect(d11).toBeLessThan(0.9);
  await expectNoErrors(errors);
});
