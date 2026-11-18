import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

// A readback's pixels belong to its caller: the renderer's queue of
// readbacks keeps no reference to them once they are returned.
test('the renderer keeps no copy of the last readback', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#4080c0');
  const held = await page.evaluate(async () => {
    const e = window.photoStudio;
    const pixels = await e.renderer.documentPixels(e.doc, e.assets);
    const chain = (e.renderer as unknown as { exclusiveChain: Promise<unknown> }).exclusiveChain;
    return { length: pixels.length, chained: (await chain) === undefined ? null : 'pixels' };
  });
  expect(held).toEqual({ length: 300 * 200 * 4, chained: null });
});
