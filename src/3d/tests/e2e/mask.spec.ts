import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function maskingWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Masking').create());
  });
  await page.waitForTimeout(300);
  const box = (await page.locator('.clip-root').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

/** Screen point of a mask-space position in the hovered clip editor. */
const at = (page: Page, u: number, v: number) =>
  page.evaluate(
    ([u, v]) => {
      const ed = (window as any).app.hoverArea.editor;
      const r = ed.el.getBoundingClientRect();
      const [W, H] = ed.frameSize();
      const p = ed.toScreen(u * W, (1 - v) * H);
      return { x: r.left + p[0], y: r.top + p[1] };
    },
    [u, v] as const,
  );
const mask = (page: Page) => page.evaluate(() => Object.values((window as any).app.doc.masks ?? {})[0] as any);

test('mask: new mask, Ctrl click draws a spline, Alt C closes it, G moves points, I keys the shape', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('t');
  await page.keyboard.press('n');
  await page.keyboard.press('Home');
  for (const [u, v] of [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.5, 0.65],
  ]) {
    const p = await at(page, u, v);
    await page.keyboard.down('Control');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Control');
  }
  let m = await mask(page);
  expect(m.layers[0].splines.map((s: any) => s.points.length)).toEqual([3]);
  const mid = await at(page, 0.5, 0.5);
  await page.mouse.move(mid.x, mid.y);
  await page.keyboard.press('Alt+c');
  await page.keyboard.press('a');
  await page.keyboard.press('g');
  await page.mouse.move(mid.x + 40, mid.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  m = await mask(page);
  expect(m.layers[0].splines[0].use_cyclic).toBe(true);
  expect(m.layers[0].splines[0].points[0].co[0]).toBeGreaterThan(0.41);
  await page.keyboard.press('i');
  m = await mask(page);
  expect(m.layers[0].shape_keys.length).toBe(1);
  // undo the key
  await page.keyboard.press('Control+z');
  expect((await mask(page)).layers[0].shape_keys.length).toBe(0);
  await expectNoErrors(errors);
});

test('mask: Add ▸ Circle, box select, delete, layers and the sequencer mask strip', async ({ page }) => {
  const { errors } = await maskingWorkspace(page);
  await page.locator('.clip-header .btn', { hasText: 'New' }).click();
  await page.locator('.clip-header .hdr-menu', { hasText: /^Add$/ }).dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu-item', { hasText: 'Circle' }).click();
  let m = await mask(page);
  expect(m.layers[0].splines[0].points.length).toBe(4);
  // deselect, then box select everything and delete
  await page.keyboard.press('Alt+a');
  const a = await at(page, 0.05, 0.05);
  const b = await at(page, 0.95, 0.95);
  await page.mouse.move(a.x, b.y);
  await page.mouse.down();
  await page.mouse.move(b.x, a.y, { steps: 4 });
  await page.mouse.up();
  m = await mask(page);
  expect(m.layers[0].splines[0].points.every((p: any) => p.select)).toBe(true);
  await page.keyboard.press('x');
  expect((await mask(page)).layers[0].splines.length).toBe(0);
  await page.keyboard.press('Control+z');
  expect((await mask(page)).layers[0].splines.length).toBe(1);
  // a mask strip shows it in the sequencer
  const id = (await mask(page)).id;
  await page.evaluate((id) => {
    const app = (window as any).app;
    app.run('sequencer.mask_strip_add', { mask: id, frame_start: 1, channel: 1 }, { invoke: false });
  }, id);
  const strip = await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips[0]);
  expect([strip.type, strip.mask]).toEqual(['MASK', id]);
  await expectNoErrors(errors);
});
