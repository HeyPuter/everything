// Grease Pencil and paint / sculpt modes: regressions found in review (real pointer input).
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { openApp, viewportCenter, expectNoErrors } from './helpers';

const ev = <T>(page: Page, fn: () => T | Promise<T>) => page.evaluate(fn as never) as Promise<T>;

async function emptyGP(page: Page, mode = 'PAINT_GREASE_PENCIL') {
  await page.evaluate((m) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('object.grease_pencil_add', { type: 'EMPTY' }, { invoke: false });
    a.run('object.mode_set', { mode: m }, { invoke: false });
  }, mode);
  await page.waitForTimeout(100);
}

const gpPoints = (page: Page) =>
  ev(page, () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = a.doc.grease_pencils[a.activeObject.data];
    return g.drawings.reduce((n: number, d: { position: ArrayLike<number> }) => n + d.position.length / 3, 0) as number;
  });

test('Esc during a Draw stroke drops the live preview', async ({ page }) => {
  const errors = await openApp(page);
  await emptyGP(page);
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 100, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - 100 + i * 10, y);
  await page.waitForTimeout(50);
  const shown = () => ev(page, async () => (await import('/src/greasepencil/render.ts' as string)).strokePreviewObject());
  expect(await shown()).not.toBeNull();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await shown()).toBeNull();
  expect(await gpPoints(page)).toBe(0);
  await expectNoErrors(errors);
});

test('a sculpt stroke pressed off the mesh starts when it reaches the surface', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_uv_sphere_add', { radius: 3 }, { invoke: false });
    a.run('object.mode_set', { mode: 'SCULPT' }, { invoke: false });
    a.run('wm.tool_set_by_id', { name: 'brush_draw' }, { invoke: false });
  });
  await page.waitForTimeout(100);
  const sum = () =>
    ev(page, () => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      return (Array.from(a.doc.meshes[a.activeObject.data].positions) as number[]).reduce((s, v) => s + Math.abs(v), 0);
    });
  const s0 = await sum();
  const undo0 = await ev(page, () => (window as any).app.undo.index); // eslint-disable-line @typescript-eslint/no-explicit-any
  const { x, y, box } = await viewportCenter(page);
  // press in empty space, then drag across the sphere
  await page.mouse.move(box.x + 120, y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 120 + ((x - box.x - 40) * i) / 30, y);
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(Math.abs((await sum()) - s0)).toBeGreaterThan(1e-3);
  expect(await ev(page, () => (window as any).app.undo.index)).toBe(undo0 + 1); // eslint-disable-line @typescript-eslint/no-explicit-any
  // the Draw Face Sets brush too
  await page.evaluate(() => (window as any).app.run('wm.tool_set_by_id', { name: 'brush_draw_face_sets' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.mouse.move(box.x + 120, y + 30);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 120 + ((x - box.x - 120) * i) / 30, y + 30);
  await page.mouse.up();
  expect(await ev(page, () => (window as any).app.undo.index)).toBe(undo0 + 2); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await ev(page, () => new Set((window as any).app.doc.meshes[(window as any).app.activeObject.data].sculpt_face_set).size)).toBe(2); // eslint-disable-line @typescript-eslint/no-explicit-any
  // a press and release in empty space does nothing
  await page.mouse.move(box.x + 120, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 60);
  await page.mouse.up();
  expect(await ev(page, () => (window as any).app.undo.index)).toBe(undo0 + 2); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('the Grease Pencil brush ring hides when the pointer leaves the viewport', async ({ page }) => {
  const errors = await openApp(page);
  await emptyGP(page);
  const { y, box } = await viewportCenter(page);
  const ring = page.locator('.view3d svg circle[stroke="rgba(255, 255, 255,0.9)"]');
  await page.mouse.move(box.x + box.width - 30, y, { steps: 4 });
  await expect(ring).toHaveCount(1);
  await page.mouse.move(box.x + box.width + 150, y, { steps: 4 });
  await expect(ring).toHaveCount(0);
  await page.mouse.move(box.x + box.width - 60, y, { steps: 4 });
  await expect(ring).toHaveCount(1);
  await expectNoErrors(errors);
});

test('Ctrl+Z right after a texture paint stroke undoes that stroke', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_uv_sphere_add', { radius: 3 }, { invoke: false });
    a.run('object.mode_set', { mode: 'TEXTURE_PAINT' }, { invoke: false });
    a.run('paint.add_texture_paint_slot', { name: 'Paint', width: 2048, height: 2048 }, { invoke: false });
    a.doc.scene.tool_settings.unified_paint.color = [1, 0, 0];
  });
  await page.waitForTimeout(300);
  // red pixels of the paint image once its canvas is current
  const red = () =>
    ev(page, async () => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const { imageCanvas, imageReady } = await import('/src/render/images.ts' as string);
      const img = Object.values(a.doc.images as Record<string, { name: string }>).find((i) => i.name === 'Paint');
      if (!img) return -1;
      for (let k = 0; k < 100 && !imageReady(img); k++) await new Promise((r) => setTimeout(r, 30));
      const d = imageCanvas(img).getContext('2d').getImageData(0, 0, 2048, 2048).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 80) n++;
      return n;
    });
  const top = () => ev(page, () => (window as any).app.undo.topLabel); // eslint-disable-line @typescript-eslint/no-explicit-any
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 50, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - 50 + i * 10, y);
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await top()).toBe('Add Texture Paint Slot');
  expect(await red()).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await top()).toBe('Texture Paint');
  await expect.poll(red).toBeGreaterThan(1000);
  await page.waitForTimeout(500);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await red()).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(red).toBeGreaterThan(1000);
  await expectNoErrors(errors);
});

async function sculptSphere(page: Page) {
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_uv_sphere_add', { radius: 3 }, { invoke: false });
    a.run('object.mode_set', { mode: 'SCULPT' }, { invoke: false });
    a.run('wm.tool_set_by_id', { name: 'brush_draw' }, { invoke: false });
  });
  await page.waitForTimeout(100);
}

const sculptState = (page: Page) =>
  ev(page, () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    return { mode: a.doc.mode as string, top: a.undo.topLabel as string, sum: (Array.from(me.positions) as number[]).reduce((s, v) => s + Math.abs(v), 0) };
  });

test('shortcuts wait while a brush stroke runs', async ({ page }) => {
  const errors = await openApp(page);
  await sculptSphere(page);
  const s0 = await sculptState(page);
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 80, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x - 80 + i * 10, y);
  // undo and a mode switch in the middle of the stroke are ignored
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('Tab');
  for (let i = 6; i <= 12; i++) await page.mouse.move(x - 80 + i * 10, y);
  await page.mouse.up();
  const s1 = await sculptState(page);
  expect(s1.mode).toBe('SCULPT');
  expect(s1.top).toBe('Draw');
  expect(Math.abs(s1.sum - s0.sum)).toBeGreaterThan(1e-3);
  // one undo step for the stroke
  await page.keyboard.press('ControlOrMeta+z');
  expect((await sculptState(page)).sum).toBeCloseTo(s0.sum, 3);
  // and shortcuts work again once it is over
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await sculptState(page)).mode).toBe('EDIT');
  await expectNoErrors(errors);
});

test('a stroke whose release was lost ends at the next move without the button', async ({ page }) => {
  const errors = await openApp(page);
  await sculptSphere(page);
  const { x, y } = await viewportCenter(page);
  const cdp = await page.context().newCDPSession(page);
  const mouse = (type: string, px: number, buttons: number) =>
    cdp.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x: px, y, button: buttons || type !== 'mouseMoved' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse('mouseMoved', x - 80, 0);
  await mouse('mousePressed', x - 80, 1);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x - 80 + i * 10, 1);
  await page.waitForTimeout(50);
  // the button went up outside the page: the moves arrive without it
  await mouse('mouseMoved', x - 20, 0);
  const s1 = await sculptState(page);
  expect(s1.top).toBe('Draw');
  for (let i = 7; i <= 12; i++) await mouse('mouseMoved', x - 80 + i * 10, 0);
  await page.waitForTimeout(50);
  expect((await sculptState(page)).sum).toBe(s1.sum);
  await expectNoErrors(errors);
});

test('a long Draw stroke places each sample once (Surface placement)', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_uv_sphere_add', { radius: 3 }, { invoke: false });
    a.run('object.grease_pencil_add', { type: 'EMPTY' }, { invoke: false });
    a.run('object.mode_set', { mode: 'PAINT_GREASE_PENCIL' }, { invoke: false });
    a.doc.scene.tool_settings.gpencil_stroke_placement_view3d = 'SURFACE';
  });
  await page.waitForTimeout(100);
  // count the surface raycasts made while drawing
  await page.evaluate(async () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts' as string);
    const { Placement } = await import('/src/greasepencil/placement.ts' as string);
    const gp = a.doc.grease_pencils[a.activeObject.data];
    const proto = Object.getPrototypeOf(new Placement(activeView3D(), a.activeObject, gp, null).ray);
    const cast = proto.intersectObjects;
    (window as any).__rays = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
    proto.intersectObjects = function (...args: unknown[]) {
      (window as any).__rays++; // eslint-disable-line @typescript-eslint/no-explicit-any
      return cast.apply(this, args);
    };
  });
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 150, y - 60);
  await page.mouse.down();
  for (let i = 1; i <= 80; i++) await page.mouse.move(x - 150 + i * 4, y - 60 + (i % 2) * 6);
  await page.mouse.up();
  const n = await gpPoints(page);
  expect(n).toBeGreaterThan(40);
  const rays = await ev(page, () => (window as any).__rays as number); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(rays).toBeGreaterThan(0);
  expect(rays).toBeLessThan(n * 3);
  await expectNoErrors(errors);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a second finger neither joins nor ends a Draw stroke', async ({ page }) => {
    const errors = await openApp(page);
    await emptyGP(page);
    const { x, y } = await viewportCenter(page);
    const cdp = await page.context().newCDPSession(page);
    // CDP: touchStart / touchMove list the active points, touchEnd the released ones
    const touch = (type: string, pts: [number, number, number][]) => cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: pts.map(([px, py, id]) => ({ x: px, y: py, id })) });
    await touch('touchStart', [[x - 100, y, 0]]);
    for (let i = 1; i <= 5; i++) await touch('touchMove', [[x - 100 + i * 10, y, 0]]);
    await touch('touchStart', [[x - 50, y, 0], [x + 100, y + 150, 1]]);
    for (let i = 1; i <= 3; i++) await touch('touchMove', [[x - 50 + i * 10, y, 0], [x + 100 + i * 10, y + 150, 1]]);
    await touch('touchEnd', [[x + 130, y + 150, 1]]);
    for (let i = 4; i <= 8; i++) await touch('touchMove', [[x - 50 + i * 10, y, 0]]);
    await touch('touchEnd', [[x + 30, y, 0]]);
    await page.waitForTimeout(100);
    const d = await ev(page, () => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const g = a.doc.grease_pencils[a.activeObject.data];
      const dr = g.drawings[g.layers[g.active_layer_index].frames[0].drawing];
      return { strokes: dr.offsets.length - 1, pos: Array.from(dr.position) as number[] };
    });
    expect(d.strokes).toBe(1);
    // the stroke runs left to right along the first finger (no jumps to the second one)
    for (let i = 1; i < d.pos.length / 3; i++) expect(d.pos[i * 3]).toBeGreaterThan(d.pos[i * 3 - 3]);
    await expectNoErrors(errors);
  });
});

test('saving right after a texture paint stroke keeps the stroke in the file', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_uv_sphere_add', { radius: 3 }, { invoke: false });
    a.run('object.mode_set', { mode: 'TEXTURE_PAINT' }, { invoke: false });
    a.run('paint.add_texture_paint_slot', { name: 'Paint', width: 2048, height: 2048 }, { invoke: false });
    a.doc.scene.tool_settings.unified_paint.color = [1, 0, 0];
  });
  await page.waitForTimeout(300);
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 50, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - 50 + i * 10, y);
  await page.mouse.up();
  const download = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+s');
  const file = readFileSync(await (await download).path());
  const red = await page.evaluate(async (bytes) => {
    const { decodeDocument } = await import('/src/io/native.ts' as string);
    const out = decodeDocument(new Uint8Array(bytes));
    const doc = out.doc ?? out;
    const img = Object.values(doc.images as Record<string, { name: string; bytes?: Uint8Array; mime: string }>).find((i) => i.name === 'Paint');
    if (!img?.bytes?.length) return -1;
    const bmp = await createImageBitmap(new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.mime }));
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 80) n++;
    return n;
  }, Array.from(file));
  expect(red).toBeGreaterThan(1000);
  await expectNoErrors(errors);
});

test('a fill reaches the stroke all around in a perspective view', async ({ page }) => {
  const errors = await openApp(page);
  await emptyGP(page);
  const { x, y } = await viewportCenter(page);
  // a circle on the (tilted) drawing plane: its far side is deeper than its start
  await page.mouse.move(x + 100, y);
  await page.mouse.down();
  for (let i = 1; i <= 64; i++) await page.mouse.move(x + 100 * Math.cos((i / 64) * Math.PI * 2), y + 100 * Math.sin((i / 64) * Math.PI * 2));
  await page.mouse.up();
  await page.evaluate(() => (window as any).app.run('wm.tool_set_by_id', { name: 'builtin.brush.Fill' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.mouse.click(x, y);
  // distances of the fill outline from the circle's center, in viewport pixels
  const r = await page.evaluate(async () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts' as string);
    const { layerScreen } = await import('/src/greasepencil/paint.ts' as string);
    const g = a.doc.grease_pencils[a.activeObject.data];
    const d = g.drawings[g.layers[0].frames[0].drawing];
    const scr = layerScreen(activeView3D(), a.activeObject, g.layers[0]);
    const pts = (s: number) => {
      const out: [number, number][] = [];
      for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) out.push(scr({ co: [d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]] }));
      return out;
    };
    // fills go first (behind), the drawn circle last
    const circle = pts(d.offsets.length - 2);
    const cx = circle.reduce((s, p) => s + p[0], 0) / circle.length,
      cy = circle.reduce((s, p) => s + p[1], 0) / circle.length;
    const dist = pts(0).map(([px, py]) => Math.hypot(px - cx, py - cy));
    return { strokes: d.offsets.length - 1, min: Math.min(...dist), max: Math.max(...dist) };
  });
  expect(r.strokes).toBe(2);
  // the 25 px stroke's inner edge sits 87.5 px from the center
  expect(r.min).toBeGreaterThan(84);
  expect(r.max).toBeLessThan(96);
  await expectNoErrors(errors);
});

test.describe('right click while dragging cancels', () => {
  const objState = (page: Page) =>
    ev(page, () => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      return { loc: (a.activeObject?.location as number[]).map((v) => +v.toFixed(3)), modal: !!a.modal, sel: Object.values(a.doc.objects as Record<string, { select: boolean }>).filter((o) => o.select).length };
    });

  test('a tweak-drag move, a box select and a lasso; a plain right click still opens the menu', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y, box } = await viewportCenter(page);
    await page.evaluate(() => (window as any).app.run('wm.tool_set_by_id', { name: 'builtin.select' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
    // tweak: drag the cube, right click with the left still held
    const s0 = await objState(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y + 30, { steps: 6 });
    expect((await objState(page)).modal).toBe(true);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.mouse.up();
    const s1 = await objState(page);
    expect(s1.modal).toBe(false);
    expect(s1.loc).toEqual(s0.loc);
    await expect(page.locator('.menu')).toHaveCount(0);
    // box select around the cube from empty space: cancelled, nothing gets selected
    await page.evaluate(() => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      a.run('object.select_all', { action: 'DESELECT' }, { invoke: false });
      a.run('wm.tool_set_by_id', { name: 'builtin.select_box' }, { invoke: false });
    });
    await page.mouse.move(box.x + 150, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 150, box.y + box.height - 150, { steps: 6 });
    await expect(page.locator('.view3d .select-box').first()).toBeVisible();
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await expect(page.locator('.view3d .select-box').first()).toBeHidden();
    await page.mouse.up();
    expect((await objState(page)).sel).toBe(0);
    await expect(page.locator('.menu')).toHaveCount(0);
    // lasso: cancelled too
    await page.evaluate(() => (window as any).app.run('wm.tool_set_by_id', { name: 'builtin.select_lasso' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
    await page.mouse.move(box.x + 150, box.y + 150);
    await page.mouse.down();
    for (const [dx, dy] of [[400, 0], [400, 400], [0, 400], [0, 10]]) await page.mouse.move(box.x + 150 + dx, box.y + 150 + dy, { steps: 4 });
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.mouse.up();
    expect((await objState(page)).sel).toBe(0);
    await expect(page.locator('.menu')).toHaveCount(0);
    // an ordinary right click opens the context menu
    await page.mouse.click(x, y, { button: 'right' });
    await expect(page.locator('.menu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expectNoErrors(errors);
  });

  test('a Pen tool handle drag', async ({ page }) => {
    const errors = await openApp(page);
    await emptyGP(page, 'EDIT');
    await page.evaluate(() => (window as any).app.run('wm.tool_set_by_id', { name: 'builtin.pen' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
    const { x, y } = await viewportCenter(page);
    await page.mouse.click(x, y);
    await page.waitForTimeout(400);
    // drag out a new point, then cancel it with a right click
    await page.mouse.move(x + 100, y);
    await page.mouse.down();
    await page.mouse.move(x + 140, y + 30, { steps: 5 });
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.mouse.up();
    expect(await gpPoints(page)).toBe(1);
    expect(await ev(page, () => (window as any).app.modal)).toBeNull(); // eslint-disable-line @typescript-eslint/no-explicit-any
    await expectNoErrors(errors);
  });
});

test('texture painting leaves a UDIM tiled image intact', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_uv_sphere_add', { radius: 3 }, { invoke: false });
    a.run('object.mode_set', { mode: 'TEXTURE_PAINT' }, { invoke: false });
    a.run('paint.add_texture_paint_slot', { name: 'Paint', width: 256, height: 256 }, { invoke: false });
    const { makeTiled, addTile } = await import('/src/render/udim.ts' as string);
    const img = Object.values(a.doc.images as Record<string, { name: string }>).find((i) => i.name === 'Paint');
    makeTiled(img);
    addTile(img, 1002, { width: 256, height: 256 });
    a.pushUndo('Tiles');
    a.changed('doc');
  });
  await page.waitForTimeout(300);
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 50, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - 50 + i * 10, y);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const r = await ev(page, () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const img = Object.values(a.doc.images as Record<string, { name: string; source: string; bytes: Uint8Array | null; tiles?: unknown[] }>).find((i) => i.name === 'Paint')!;
    return { source: img.source, tiles: img.tiles?.length, bytes: img.bytes?.length ?? 0, report: a.reports[a.reports.length - 1].message };
  });
  expect(r).toEqual({ source: 'TILED', tiles: 2, bytes: 0, report: 'Painting on UDIM tiled images is not supported yet' });
  await expectNoErrors(errors);
});

test('vertex painting a face corner attribute blends each corner from its own color', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('mesh.primitive_cube_add', { size: 4 }, { invoke: false });
    const me = a.doc.meshes[a.activeObject.data];
    const data = new Float32Array(me.indices.length * 4);
    for (let f = 0; f + 1 < me.offsets.length; f++) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) data.set([f / 10, f / 10, f / 10, 1], c * 4);
    me.color_attributes = [{ name: 'Col', domain: 'CORNER', data }];
    me.active_color_index = 0;
    a.run('object.mode_set', { mode: 'VERTEX_PAINT' }, { invoke: false });
    const b = a.doc.brushes.brush_vertpaint;
    b.strength = 0.5;
    b.radius = 400;
    a.doc.scene.tool_settings.unified_paint.size = 400;
    a.doc.scene.tool_settings.unified_paint.color = [1, 1, 1];
  });
  await page.waitForTimeout(200);
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 10, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 3 });
  await page.mouse.up();
  const r = await ev(page, () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const me = a.doc.meshes[a.activeObject.data];
    const d = me.color_attributes[0].data as Float32Array;
    // painted vertices: their corners should still differ (each face its own grey)
    let painted = 0,
      flattened = 0;
    for (let v = 0; v < me.positions.length / 3; v++) {
      const greys: number[] = [];
      for (let c = 0; c < me.indices.length; c++) if (me.indices[c] === v) greys.push(+d[c * 4].toFixed(3));
      const f0 = me.offsets.findIndex((o: number, f: number) => f + 1 < me.offsets.length && me.indices.slice(o, me.offsets[f + 1]).includes(v));
      if (greys[0] === +(f0 / 10).toFixed(3) && greys.every((g, i) => i === 0 || g !== greys[0])) continue;
      painted++;
      if (new Set(greys).size === 1) flattened++;
    }
    return { painted, flattened };
  });
  expect(r.painted).toBeGreaterThan(0);
  expect(r.flattened).toBe(0);
  await expectNoErrors(errors);
});
