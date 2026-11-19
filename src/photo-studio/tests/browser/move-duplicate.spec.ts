import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, client, idle, openImage, tool, undo } from './helpers';

// Move tool modifiers: Alt-drag moves a copy, Shift keeps the move on one axis.

const layers = (page: Page) =>
  page.evaluate(() =>
    window.photoStudio.doc.layers.map((l) => ({
      name: l.name,
      x: l.transform.x,
      y: l.transform.y,
    })),
  );

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ff0000');
  // A 100 x 100 layer at the top left over a transparent canvas.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Trim', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 100, height: 100 });
      setLayerPixels(
        l,
        writeRect(e.assets.tiles, { ...l.pixels!, tiles: {}, bounds: null }, 0, 0, img),
        d,
      );
    });
  });
  await idle(page);
  await tool(page, 'Move Tool');
});

test('Alt-drag moves a copy of the layer in one step', async ({ page }) => {
  const before = await layers(page);
  const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
  await canvasDrag(
    page,
    [
      [50, 50],
      [100, 80],
      [150, 110],
    ],
    6,
    ['Alt'],
  );
  await idle(page);
  const after = await layers(page);
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(after[1].name).toMatch(/copy/);
  expect(Math.round(after[1].x - before[0].x)).toBe(100);
  expect(Math.round(after[1].y - before[0].y)).toBe(60);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe(
    'Duplicate and Move',
  );
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps + 1);
  expect(await page.evaluate(() => window.photoStudio.layer?.name)).toMatch(/copy/);
  await undo(page);
  expect(await layers(page)).toEqual(before);
});

test('an Alt-click without moving adds no copy', async ({ page }) => {
  const original = await page.evaluate(() => window.photoStudio.selected);
  await canvasClick(page, 50, 50, ['Alt']);
  await idle(page);
  expect(await layers(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.photoStudio.selected)).toBe(original);
});

test('Shift pressed during a drag keeps the move horizontal or vertical', async ({ page }) => {
  const [before] = await layers(page);
  // Shift at the press adds a layer to the selection; pressed later it constrains.
  const [x0, y0] = await client(page, 50, 50);
  const [x1, y1] = await client(page, 170, 70);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
  await page.keyboard.down('Shift');
  await page.mouse.move(x1, y1, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await idle(page);
  const [after] = await layers(page);
  expect(Math.round(after.x - before.x)).toBe(120);
  expect(after.y).toBe(before.y);
});

test('Mod-drag with the Brush moves the layer, then the Brush comes back', async ({ page }) => {
  await tool(page, 'Brush Tool');
  const [before] = await layers(page);
  await canvasDrag(
    page,
    [
      [50, 50],
      [100, 80],
      [150, 110],
    ],
    6,
    ['ControlOrMeta'],
  );
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('brush');
  const [after] = await layers(page);
  expect(Math.round(after.x - before.x)).toBe(100);
  expect(Math.round(after.y - before.y)).toBe(60);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Move layers');
});
