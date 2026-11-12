import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, client, idle } from './helpers';

// A 200×150 layer, opaque red on the left half and transparent on the right,
// with its transparent pixels locked.
async function lockedHalf(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const doc = newDocument(200, 150, 'Locked');
    const data = new Uint8ClampedArray(100 * 150 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([220, 30, 30, 255], i);
    const layer = newPixelLayer('Half', doc, gridFromImage(e.assets.tiles, { width: 100, height: 150, data }));
    layer.protection = { transparency: true, composite: false, position: false };
    doc.layers = [layer];
    e.history.reset(doc);
    e.hasDocument = true;
    e.selected = layer.id;
    e.zoom = 2;
    e.pan = { x: 0, y: 0 };
    e.update();
  });
  await idle(page);
}
// Alpha values found in the locked (transparent) right half, and in the left half.
const alphas = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers[0];
    const set = (x: number) => {
      const d = readRGBA(e.assets.tiles, l.pixels!, { x, y: 0, width: 100, height: 150 }).data;
      return [...new Set(d.filter((_, i) => i % 4 === 3))].sort((a, b) => a - b);
    };
    return { right: set(100), left: set(0), history: e.history.labels.at(-1) };
  });

test.beforeEach(async ({ page }) => {
  await boot(page);
});

for (const [id, label] of [
  ['clone-stamp', 'Clone Stamp'],
  ['mixer-brush', 'Mixer Brush'],
  ['smudge-tool', 'Smudge Tool'],
] as const) {
  test(`${label} keeps locked transparent pixels transparent`, async ({ page }) => {
    await lockedHalf(page);
    await page.evaluate(async (id) => {
      const e = window.photoStudio;
      e.settings.smudgeStrength = 100;
      e.setTool(id);
      const { brushFor } = await import('/src/features/paint.ts');
      Object.assign(brushFor(id), { size: 30, smoothing: 0 });
    }, id);
    if (id === 'clone-stamp') await canvasClick(page, 50, 75, ['Alt']);
    await canvasDrag(page, [[85, 75], [140, 75]], 12);
    const result = await alphas(page);
    expect(result.history).toBe(label);
    expect(result.right).toEqual([0]);
    expect(result.left).toEqual([255]);
  });
}

test('History Brush keeps locked transparent pixels transparent', async ({ page }) => {
  // The oldest history state is opaque everywhere; the current one is
  // transparent on the right with transparency locked.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument, findLayer } = await import('/src/model/document.ts');
    const { newPixelLayer, setLayerPixels } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const doc = newDocument(200, 150, 'Locked');
    const full = new Uint8ClampedArray(200 * 150 * 4);
    for (let i = 0; i < full.length; i += 4) full.set([20, 30, 220, 255], i);
    const layer = newPixelLayer('Half', doc, gridFromImage(e.assets.tiles, { width: 200, height: 150, data: full }));
    doc.layers = [layer];
    e.history.reset(doc);
    e.hasDocument = true;
    e.selected = layer.id;
    const half = new Uint8ClampedArray(100 * 150 * 4);
    for (let i = 0; i < half.length; i += 4) half.set([220, 30, 30, 255], i);
    const grid = gridFromImage(e.assets.tiles, { width: 100, height: 150, data: half });
    e.command('Erase', (d) => {
      const l = findLayer(d.layers, layer.id)!;
      setLayerPixels(l, grid, d);
      l.protection = { transparency: true, composite: false, position: false };
    });
    e.zoom = 2;
    e.pan = { x: 0, y: 0 };
    e.update();
    e.setTool('history-brush');
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('history-brush'), { size: 30, smoothing: 0 });
  });
  await idle(page);
  await canvasDrag(page, [[85, 75], [140, 75]], 12);
  const result = await alphas(page);
  expect(result.history).toBe('History Brush');
  expect(result.right).toEqual([0]);
  expect(result.left).toEqual([255]);
});

for (const [id, label] of [
  ['healing-brush', 'Healing Brush'],
  ['spot-healing', 'Spot Healing Brush'],
] as const) {
  test(`${label} keeps locked transparent pixels transparent`, async ({ page }) => {
    await lockedHalf(page);
    await page.evaluate(async (id) => {
      const e = window.photoStudio;
      e.setTool(id);
      const { brushFor } = await import('/src/features/paint.ts');
      Object.assign(brushFor(id), { size: 30 });
    }, id);
    if (id === 'healing-brush') await canvasClick(page, 50, 75, ['Alt']);
    await canvasDrag(page, [[90, 75], [130, 75]], 12);
    const result = await alphas(page);
    expect(result.history).toBe(label);
    expect(result.right).toEqual([0]);
    expect(result.left).toEqual([255]);
  });
}

test('Magic Eraser fills locked transparency with the background color', async ({ page }) => {
  await lockedHalf(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.background = '#00ff00';
    e.setTool('magic-eraser');
  });
  await canvasClick(page, 50, 75);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers[0];
    const at = (x: number) => [...readRGBA(e.assets.tiles, l.pixels!, { x, y: 75, width: 1, height: 1 }).data];
    return { left: at(50), right: at(150), history: e.history.labels.at(-1) };
  });
  expect(result).toEqual({ left: [0, 255, 0, 255], right: [0, 0, 0, 0], history: 'Magic Eraser' });
});

test('Background Eraser explains that locked transparency stops it', async ({ page }) => {
  await lockedHalf(page);
  await page.evaluate(() => window.photoStudio.setTool('background-eraser'));
  const before = await page.evaluate(() => window.photoStudio.history.labels.length);
  await canvasDrag(page, [[50, 75], [90, 75]], 8);
  await expect(page.locator('#status')).toHaveText('Unlock transparent pixels to use the Background Eraser.');
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(before);
  expect((await alphas(page)).left).toEqual([255]);
});
