// Grease Pencil and paint / sculpt modes: regressions found in review (real pointer input).
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
  // a press and release in empty space does nothing
  await page.mouse.move(box.x + 120, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 60);
  await page.mouse.up();
  expect(await ev(page, () => (window as any).app.undo.index)).toBe(undo0 + 1); // eslint-disable-line @typescript-eslint/no-explicit-any
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
