import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

for (const multiple of [false, true]) test(`Duplicate Image keeps the ${multiple ? 'selected layers' : 'active layer'} available for editing`, async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#ff0000', 'original.png');
  const selected = await page.evaluate(async (multiple) => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const top = newPixelLayer('Top', e.doc);
    const bottom = e.doc.layers[0].id;
    e.command('Add layer', (d) => d.layers.push(top));
    const ids = multiple ? [top.id, bottom] : [bottom];
    e.selectLayers(ids);
    return ids;
  }, multiple);
  await start(page, 'image.duplicate');
  await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
  await idle(page);
  expect(await page.evaluate(() => [...window.photoStudio.selectedIds])).toEqual(selected);
  expect(await page.evaluate(() => window.photoStudio.doc.name)).toBe('original copy');
  if (!multiple) {
    await page.evaluate(() => window.photoStudio.setForeground('#00ff00'));
    await run(page, 'edit.fill-foreground');
    expect(await page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const original = e.sessions.find((s) => s.doc.name === 'original')!;
      const pixel = (s: typeof original) => [...readRGBA(s.assets.tiles, s.doc.layers[0].pixels!, { x: 0, y: 0, width: 1, height: 1 }).data];
      return { layers: e.doc.layers.length, original: pixel(original), copy: pixel(e.session) };
    })).toEqual({ layers: 2, original: [255, 0, 0, 255], copy: [0, 255, 0, 255] });
  }
});
