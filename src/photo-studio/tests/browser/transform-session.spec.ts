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
