import { test, expect } from '@playwright/test';
import { boot, openImage, panel, run, selectRect } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Histogram panel measures the image, a selection, a hovered level and a dragged range', async ({
  page,
}) => {
  // Left half black, right half white.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(100, 50);
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 50, 50);
    g.fillStyle = '#fff';
    g.fillRect(50, 0, 50, 50);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'halves.png');
  });
  const body = await panel(page, 'Histogram');
  const stat = (k: string) => body.locator(`[data-hs="${k}"]`);
  await expect(stat('pixels')).toHaveText('5,000');
  await expect(stat('mean')).toHaveText('127.50');
  await expect(stat('std')).toHaveText('127.50');
  await expect(body.locator('.histogram-clipping')).toHaveText(
    'Shadows clipped 50.0% · Highlights clipped 50.0%',
  );

  // Hovering the right edge reads the white level.
  const plot = body.locator('svg.histogram').first();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  await expect(stat('level')).toHaveText('255');
  await expect(stat('count')).toHaveText('2,500');
  await expect(stat('percentile')).toHaveText('100.00');

  // Dragging over the dark half measures only those levels.
  await page.mouse.move(box.x + 1, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect(stat('level')).toHaveText(/^0…12[78]$/);
  await expect(stat('count')).toHaveText('2,500');
  await expect(stat('mean')).toHaveText('0.00');
  await expect(stat('percentile')).toHaveText('50.00');

  // A selection limits the measurement to the selected pixels.
  await selectRect(page, { x: 0, y: 0, width: 50, height: 50 });
  await expect(stat('pixels')).toHaveText('2,500');
  await expect(body.locator('.histogram-scope')).toHaveText('Selection only');
  await expect(body.locator('.histogram-clipping')).toHaveText('Shadows clipped 100.0%');

  // The color overlay and the per-channel view draw every channel.
  await body.locator('select.histogram-channel').selectOption('colors');
  await expect(plot.locator('path')).toHaveCount(4);
  await body.getByRole('button', { name: 'Show each color channel' }).click();
  await expect(body.locator('.histogram-channels svg')).toHaveCount(3);
});

test('Histogram panel can measure the selected layer alone', async ({ page }) => {
  await openImage(page, 80, 40, '#404040');
  await selectRect(page, { x: 0, y: 0, width: 40, height: 40 });
  await run(page, 'layer.via-copy');
  await run(page, 'select.deselect');
  const body = await panel(page, 'Histogram');
  await expect(body.locator('[data-hs="pixels"]')).toHaveText('3,200');
  await body.locator('select.histogram-source').selectOption('layer');
  await expect(body.locator('[data-hs="pixels"]')).toHaveText('1,600');
  await expect(body.locator('[data-hs="mean"]')).toHaveText('64.00');
});
