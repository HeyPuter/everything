// The clip button under an adjustment layer's Properties works like
// Layer → Create/Release Clipping Mask.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, run } from './helpers';

test('the Properties clip button releases the clipped layers above, as the Layer menu does', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 32, 24);
  await run(page, 'layer.new-quick');
  const ids = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const adj = [1, 2].map((n) => {
      const l = layer('adjustment', `Invert ${n}`, 32, 24);
      l.adjustment = { kind: 'invert', params: {} };
      l.clipped = true;
      return l;
    });
    e.command('Add adjustments', (d) => d.layers.push(...adj));
    return adj.map((l) => l.id);
  });
  await panel(page, 'Properties');
  await page.evaluate((id) => window.photoStudio.selectLayer(id), ids[0]);
  await idle(page);
  const clipped = () => page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped));
  expect(await clipped()).toEqual([false, false, true, true]);
  await page.locator('#properties [data-adj="clip"]').click();
  await idle(page);
  // Releasing the lower one releases the one above too (it would clip to an adjustment).
  expect(await clipped()).toEqual([false, false, false, false]);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe(
    'Release Clipping Mask',
  );
});
