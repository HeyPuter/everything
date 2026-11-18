import { test, expect } from '@playwright/test';
import { boot, compositePixel, idle, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Adjustment dialogs preview a styled layer without recoloring its effects', async ({
  page,
}) => {
  await openImage(page, 120, 80, '#ffffff');
  // A red patch with a blue drop shadow 20 px to its right.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const l = newPixelLayer(
      'Patch',
      e.doc,
      gridFromImage(e.assets.tiles, { width: 40, height: 40, data }, 20, 20),
    );
    const shadow = {
      enabled: true,
      blendMode: 'normal',
      opacity: 1,
      color: [0, 0, 255],
      angle: 180,
    };
    l.style = {
      enabled: true,
      dropShadow: [
        {
          ...shadow,
          useGlobalLight: false,
          distance: 20,
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
  expect(await compositePixel(page, 70, 40)).toEqual([0, 0, 255, 255]);
  await start(page, 'adjust.hue-saturation');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  const hue = dialog.getByRole('spinbutton', { name: 'Hue value' });
  await hue.fill('180');
  await hue.press('Tab');
  // The canvas preview turns the patch cyan; the shadow keeps its color, as
  // it does once the adjustment is applied.
  const shown = () =>
    page.evaluate(async () => {
      const px = await window.photoStudio.renderer.pixels();
      const at = (x: number) => Array.from(px.slice((40 * 120 + x) * 4, (40 * 120 + x) * 4 + 4));
      return [at(30), at(70)];
    });
  await expect
    .poll(async () => (await shown())[0], { timeout: 30_000 })
    .toEqual([0, 255, 255, 255]);
  expect((await shown())[1]).toEqual([0, 0, 255, 255]);
  await dialog.locator('button.primary').click();
  await expect(page.locator('dialog.adj-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await compositePixel(page, 30, 40)).toEqual([0, 255, 255, 255]);
  expect(await compositePixel(page, 70, 40)).toEqual([0, 0, 255, 255]);
});
