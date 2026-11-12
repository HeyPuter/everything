import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, run } from './helpers';

// Warps of a pixel layer carry its linked layer mask, as Edit > Transform does.

const maskAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      const { readMask } = await import('/src/model/tiles.ts');
      return readMask(e.assets.tiles, e.layer!.maskGrid!, { x, y, width: 1, height: 1 }).data[0];
    },
    [x, y] as const,
  );
const option = (page: Page, name: string) => page.locator('#tool-options').getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#808080');
  // The mask reveals a 60 x 60 square in the middle.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const data = new Uint8Array(60 * 60).fill(255);
    e.command('Mask', (d) => (d.layers[0].maskGrid = writeRect(e.assets.tiles, emptyGrid(1), 170, 120, { width: 60, height: 60, data })));
  });
  await idle(page);
});

test('Pin Warp moves a linked layer mask with the pixels', async ({ page }) => {
  await run(page, 'edit.pin-warp');
  await canvasClick(page, 60, 150);
  await canvasClick(page, 340, 150);
  await canvasClick(page, 200, 150);
  await canvasDrag(page, [
    [200, 150],
    [200, 210],
  ]);
  await option(page, 'Commit Pin Warp').click();
  await idle(page);
  expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Pin Warp');
  // The revealed square went down with the middle of the layer.
  expect(await maskAt(page, 200, 200)).toBe(255);
  expect(await maskAt(page, 200, 125)).toBe(0);
  // Far from the pins nothing moved, and the hidden area stays hidden.
  expect(await maskAt(page, 20, 20)).toBe(0);
});

test('Perspective Warp warps a linked layer mask with the pixels', async ({ page }) => {
  // Red where the mask reveals, blue elsewhere: the mask must keep matching.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    const rgba = new Uint8ClampedArray(400 * 300 * 4);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) rgba.set(x >= 170 && x < 230 && y >= 120 && y < 180 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 400 + x) * 4);
    e.command('Paint', (d) => setLayerPixels(d.layers[0], writeRect(e.assets.tiles, emptyGrid(4), 0, 0, { width: 400, height: 300, data: rgba }), d));
  });
  await idle(page);
  await run(page, 'edit.perspective-warp');
  await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { ready?: boolean })?.ready);
  await canvasDrag(page, [
    [100, 50],
    [300, 250],
  ]);
  await option(page, 'Warp').click();
  // Pull the bottom-right corner of the plane up and left by 50.
  await canvasDrag(page, [
    [300, 250],
    [250, 200],
  ]);
  await option(page, 'Commit Perspective Warp').click();
  await idle(page);
  expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Perspective Warp');
  const samples = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask, readRGBA } = await import('/src/model/tiles.ts');
    const l = e.layer!;
    const out: [number, number][] = [];
    for (let k = 150; k < 260; k += 5) for (const [x, y] of [[k, 150], [200, k - 50], [k, k - 50]])
      out.push([readMask(e.assets.tiles, l.maskGrid!, { x, y, width: 1, height: 1 }).data[0], readRGBA(e.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[0]]);
    return out;
  });
  // The square shrank toward the plane's fixed corner, and the mask with it.
  expect(samples.filter(([m, r]) => Math.abs(m - r) > 64)).toEqual([]);
  expect(await maskAt(page, 226, 176)).toBe(0);
});
