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
