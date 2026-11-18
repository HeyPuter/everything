import { test, expect } from '@playwright/test';
import { boot, compositePixel, idle, openImage, run } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Create Layers keeps layers clipped to the styled layer in its clipping group', async ({
  page,
}) => {
  await openImage(page, 120, 80, '#ffffff');
  // A gray patch with a red color overlay and a black outside stroke, and a
  // blue layer clipped to it.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const patch = (name: string, rgba: number[], x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
      return newPixelLayer(
        name,
        e.doc,
        gridFromImage(e.assets.tiles, { width: w, height: h, data }, x, y),
      );
    };
    const base = patch('Base', [128, 128, 128, 255], 20, 20, 40, 40);
    base.style = {
      enabled: true,
      colorOverlay: [{ enabled: true, blendMode: 'normal', opacity: 1, color: [255, 0, 0] }],
      stroke: [
        {
          enabled: true,
          blendMode: 'normal',
          opacity: 1,
          size: 4,
          position: 'outside',
          fill: { type: 'color', color: [0, 0, 0] },
        },
      ],
    } as never;
    const clip = patch('Clip', [0, 0, 255, 255], 0, 0, 40, 80);
    clip.clipped = true;
    e.command('Add', (d) => d.layers.push(base, clip));
    e.selectLayers([base.id]);
    e.update();
  });
  await idle(page);
  const before = [await compositePixel(page, 30, 40), await compositePixel(page, 50, 40)];
  expect(before).toEqual([
    [0, 0, 255, 255],
    [255, 0, 0, 255],
  ]);
  await run(page, 'layer.style-create-layers');
  const stack = await page.evaluate(() =>
    window.photoStudio.doc.layers.map((l) => `${l.name}${l.clipped ? ' (clipped)' : ''}`),
  );
  // The clipped layer still clips to Base: only clipped layers lie between them.
  const clipAt = stack.indexOf('Clip (clipped)');
  const baseAt = stack.indexOf('Base');
  expect(clipAt).toBeGreaterThan(baseAt);
  expect(stack.slice(baseAt + 1, clipAt).every((n) => n.endsWith('(clipped)'))).toBe(true);
  expect([await compositePixel(page, 30, 40), await compositePixel(page, 50, 40)]).toEqual(before);
});
