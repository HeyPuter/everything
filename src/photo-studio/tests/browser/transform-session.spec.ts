import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run, undo } from './helpers';

// Advanced transform sessions (Edit > Free Transform on pixel layers).

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Free Transform keeps the Live Filters of a pixel layer', async ({ page }) => {
  await openImage(page, 200, 150, '#808080');
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.box-blur', { params: { radius: 4 } });
  await run(page, 'edit.free-transform');
  await page.evaluate(() => (window.photoStudio.modal as unknown as { rotateBy(d: number): void }).rotateBy(30));
  await page.keyboard.press('Enter');
  await idle(page);
  const after = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridDocBounds } = await import('/src/model/tiles.ts');
    const l = e.layer!;
    return { label: e.history.labels.at(-1), filters: l.liveFilters?.length, source: l.liveSource && gridDocBounds(l.liveSource), pixels: gridDocBounds(l.pixels!) };
  });
  expect(after.label).toBe('Transform');
  expect(after.filters).toBe(1);
  // The source turned with the layer: its bounds grew like the result's.
  expect(after.source!.width).toBeGreaterThan(220);
  expect(after.pixels.width).toBeGreaterThan(220);
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.layer!.liveFilters?.length)).toBe(1);
});

test('View > Snap off lets a Free Transform move go anywhere', async ({ page }) => {
  await openImage(page, 400, 300, '#ffffff');
  // A 100 x 100 layer at (10, 10).
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const data = new Uint8ClampedArray(100 * 100 * 4).fill(200);
    const l = newPixelLayer('Square', e.doc, gridFromImage(e.assets.tiles, { width: 100, height: 100, data }, 10, 10));
    e.command('Square', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
  });
  await idle(page);
  const drag = async () => {
    await run(page, 'edit.free-transform');
    // Toward the canvas center (150, 100 would center the square at 200, 150): stop 1 px short.
    const [sx, sy] = await page.evaluate(() => window.photoStudio.clientPoint(60, 60));
    const [tx, ty] = await page.evaluate(() => window.photoStudio.clientPoint(199, 149));
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 5 });
    await page.mouse.up();
    const x = await page.evaluate(() => (window.photoStudio.modal as unknown as { quad: { x: number }[] }).quad[0].x);
    await page.keyboard.press('Escape');
    await idle(page);
    return x;
  };
  // Snapping pulls the square's center onto the canvas center…
  expect(await drag()).toBeCloseTo(150, 0);
  await run(page, 'view.snap');
  expect(await page.evaluate(() => window.photoStudio.transform.snapping)).toBe(false);
  // …and with View > Snap off it stays where it was dropped.
  expect(await drag()).toBeCloseTo(149, 0);
});
