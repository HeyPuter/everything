import { test, expect } from '@playwright/test';
import { boot, canvasDrag, client, idle, openImage, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 120, '#808080', 'gray.png');
});

test('brush strokes stop at the canvas edge', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Paint', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.color = '#ff0000';
  });
  await idle(page);
  await tool(page, 'Brush Tool');
  // A 40 px brush dragged from inside the canvas well past its right edge.
  await page.evaluate(async () => {
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('brush'), { size: 40, hardness: 1, smoothing: 0 });
  });
  await canvasDrag(page, [[150, 60], [260, 60]]);
  const result = await page.evaluate(() => {
    const e = window.photoStudio;
    const l = e.doc.layers.at(-1)!;
    return { bounds: l.pixels!.bounds, x: l.pixels!.x, keys: Object.keys(l.pixels!.tiles) };
  });
  expect(result.bounds).not.toBeNull();
  // Paint reaches the edge but no pixels are stored beyond it.
  expect(result.x + result.bounds!.x + result.bounds!.width).toBe(200);
  expect(result.bounds!.y).toBeGreaterThanOrEqual(0);
  expect(result.keys).toEqual(['0,0']);
});

test('painting cannot edit the mask of a locked adjustment layer', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const l = layer('adjustment', 'Invert', e.doc.width, e.doc.height);
    l.adjustment = { kind: 'invert', params: {} };
    l.locked = true;
    e.command('Add adjustment', (d) => d.layers.push(l));
    e.selected = l.id;
  });
  await idle(page);
  await tool(page, 'Brush Tool');
  await canvasDrag(page, [[50, 60], [120, 60]]);
  expect(await page.evaluate(() => !!window.photoStudio.doc.layers.at(-1)!.maskGrid)).toBe(false);
  await expect(page.locator('#status')).toHaveText('Unlock this layer to edit its mask.');
});

test('the Art History Brush keeps locked transparency and stays on the canvas', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    // Opaque blue on the left half of the canvas only.
    const data = new Uint8ClampedArray(100 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([0, 0, 255, 255], i);
    const l = newPixelLayer('Half', e.doc, gridFromImage(e.assets.tiles, { width: 100, height: 120, data }));
    l.protection = { transparency: true, composite: false, position: false };
    e.command('New Layer', (d) => d.layers.push(l));
    // The brush paints from the oldest history state, which must hold the layer.
    e.history.reset(e.doc);
    e.selected = l.id;
  });
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    Object.assign(e.settings, { artArea: 200, artStyle: 'dab' });
    e.setTool('art-history');
  });
  await canvasDrag(page, [[90, 60], [190, 60]]);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers.at(-1)!;
    const alphaAt = (x: number, y: number) => readRGBA(e.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[3];
    return { right: [alphaAt(150, 60), alphaAt(190, 20), alphaAt(120, 100)], bounds: l.pixels!.bounds, history: e.history.labels.at(-1) };
  });
  expect(result.history).toBe('Art History Brush');
  expect(result.right).toEqual([0, 0, 0]);
  expect(result.bounds).toEqual({ x: 0, y: 0, width: 100, height: 120 });
});

test('the Pencil paints hard, aliased pixels', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Pencil', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('pencil'), { size: 5, smoothing: 0 });
  });
  await idle(page);
  await tool(page, 'Pencil Tool');
  await canvasDrag(page, [[20.3, 30.7], [140.6, 70.2]]);
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const data = readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 0, y: 0, width: 200, height: 120 }).data;
    return [...new Set(data.filter((_, i) => i % 4 === 3))].sort((a, b) => a - b);
  });
  expect(alpha).toEqual([0, 255]);
});

test('the airbrush builds up paint while the pointer rests', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Air', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.setForeground('#000000');
    e.setTool('brush');
    e.activeTool!.brush!.set(e, { size: 20, hardness: 1, flow: 0.1, airbrush: true, smoothing: 0 });
  });
  await idle(page);
  const at = await client(page, 100, 60);
  await page.mouse.move(...at);
  await page.mouse.down();
  // A single dab at 10% flow is alpha 26; resting adds a dab every 50 ms.
  await page.waitForTimeout(600);
  await page.mouse.up();
  await idle(page);
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    return readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 100, y: 60, width: 1, height: 1 }).data[3];
  });
  expect(alpha).toBeGreaterThan(60);
});
