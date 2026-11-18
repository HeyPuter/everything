import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Rasterize Layer Style keeps the layer and its effects outside the canvas', async ({
  page,
}) => {
  await openImage(page, 100, 60, '#ffffff');
  // A red patch half outside the left edge, with a blue overlay and a
  // green shadow 10 px to the right.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(60 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const l = newPixelLayer(
      'Patch',
      e.doc,
      gridFromImage(e.assets.tiles, { width: 60, height: 40, data }, -30, 10),
    );
    const shadow = {
      enabled: true,
      blendMode: 'normal',
      opacity: 1,
      color: [0, 255, 0],
      angle: 180,
    };
    l.style = {
      enabled: true,
      colorOverlay: [{ enabled: true, blendMode: 'normal', opacity: 1, color: [0, 0, 255] }],
      dropShadow: [
        {
          ...shadow,
          useGlobalLight: false,
          distance: 10,
          spread: 0,
          size: 0,
          knockout: true,
          antiAliased: false,
          noise: 0,
        },
      ],
    } as never;
    e.command('Add', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
    e.update();
  });
  await idle(page);
  const composite = () =>
    page.evaluate(async () => {
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      return Array.from((await compositeRGBA(window.photoStudio)).data);
    });
  const before = await composite();
  await run(page, 'layer.rasterize-style');
  expect(await page.evaluate(() => window.photoStudio.layer!.style)).toBeUndefined();
  expect(await composite()).toEqual(before);
  const at = (x: number, y: number) =>
    page.evaluate(
      async ([x, y]) => {
        const e = window.photoStudio;
        const { readRGBA } = await import('/src/model/tiles.ts');
        return Array.from(
          readRGBA(e.assets.tiles, e.layer!.pixels!, { x, y, width: 1, height: 1 }).data,
        );
      },
      [x, y] as const,
    );
  // Off-canvas content: the overlaid patch and the start of its shadow.
  expect(await at(-25, 30)).toEqual([0, 0, 255, 255]);
  expect(await at(25, 30)).toEqual([0, 0, 255, 255]);
  expect(await at(35, 30)).toEqual([0, 255, 0, 255]);
  expect(await page.evaluate(() => window.photoStudio.layer!.pixels!.bounds)).toEqual({
    x: -30,
    y: 10,
    width: 70,
    height: 40,
  });
});
