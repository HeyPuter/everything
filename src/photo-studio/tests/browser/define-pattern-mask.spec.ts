import { test, expect } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Define Pattern takes the visible pixels of a masked layer', async ({ page }) => {
  await openImage(page, 40, 20, '#ffffff');
  // A red layer whose mask hides its left half.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage, writeRect, emptyGrid } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 20 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const l = newPixelLayer(
      'Red',
      e.doc,
      gridFromImage(e.assets.tiles, { width: 40, height: 20, data }, 0, 0),
    );
    l.maskGrid = writeRect(e.assets.tiles, emptyGrid(1), 20, 0, {
      width: 20,
      height: 20,
      data: new Uint8Array(400).fill(255),
    });
    e.command('Add', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
    e.update();
  });
  await idle(page);
  await start(page, 'edit.define-pattern');
  await page.locator('#dialog[open] input[name=name]').fill('Half');
  await page.locator('#dialog[open] input[name=name]').press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.photoStudio.doc.patterns?.length ?? 0))
    .toBe(1);
  const px = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { documentPatternPixels } = await import('/src/model/fill-layer.ts');
    const p = documentPatternPixels(e.doc.patterns![0], e.assets.tiles)!;
    const at = (x: number) =>
      Array.from(p.tile.data.slice((10 * p.tile.width + x) * 4, (10 * p.tile.width + x) * 4 + 4));
    return [p.tile.width, at(5), at(30)];
  });
  expect(px[0]).toBe(40);
  expect((px[1] as number[])[3]).toBe(0);
  expect(px[2]).toEqual([255, 0, 0, 255]);
});
