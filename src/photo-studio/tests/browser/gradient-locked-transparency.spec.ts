import { test, expect } from '@playwright/test';
import { boot, canvasDrag, layerPixel, openProject, tool } from './helpers';

// With the layer's transparency locked, the Gradient tool changes colors by
// its coverage and keeps alpha, as brushes and Edit > Fill do: a half-opaque
// black gradient over a half-transparent gray pixel lands half way to black.
test('gradient on a layer with locked transparency mixes by coverage alone', async ({ page }) => {
  await boot(page);
  await openProject(page, {
    version: 1,
    id: 'doc',
    name: 'Locked',
    width: 64,
    height: 48,
    selection: null,
    layers: [],
  });
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(64 * 48 * 4);
    for (let i = 0; i < 64 * 48; i++)
      data.set(i % 64 < 32 ? [200, 200, 200, 128] : [200, 200, 200, 255], i * 4);
    const l = newPixelLayer(
      'Soft',
      e.doc,
      gridFromImage(e.assets.tiles, { width: 64, height: 48, data }, 0, 0),
    );
    l.protection = { transparency: true, composite: false, position: false };
    e.doc.layers.push(l);
    e.selectLayer(l.id);
    e.color = '#000000';
    e.background = '#000000';
    const { effectsState } = await import('/src/features/effects/state.ts');
    effectsState.tool.opacity = 0.5;
    effectsState.tool.mode = 'normal';
    effectsState.tool.dither = false;
    e.update();
  });
  await tool(page, 'Gradient Tool');
  await canvasDrag(page, [
    [2, 24],
    [60, 24],
  ]);
  await expect
    .poll(() => page.evaluate(() => window.photoStudio.history.labels.at(-1)))
    .toBe('Gradient');
  // Half-transparent pixel: 200 moves half way to 0, alpha unchanged.
  const soft = await layerPixel(page, 10, 10);
  expect(soft[3]).toBe(128);
  expect(Math.abs(soft[0] - 100)).toBeLessThanOrEqual(1);
  // Opaque pixel: the same.
  const solid = await layerPixel(page, 50, 10);
  expect(solid[3]).toBe(255);
  expect(Math.abs(solid[0] - 100)).toBeLessThanOrEqual(1);
});
