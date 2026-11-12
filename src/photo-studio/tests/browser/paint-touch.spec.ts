import { test, expect } from '@playwright/test';
import { boot, client, idle } from './helpers';

test.use({ hasTouch: true });

// A touch tap has no hover before it, so tools that sample the color under
// the pointer must use the tap position.
for (const [id, label] of [
  ['color-replacement', 'Color Replacement'],
  ['background-eraser', 'Background Eraser'],
] as const) {
  test(`${label} samples the color under a touch tap`, async ({ page }) => {
    await boot(page);
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { newDocument } = await import('/src/model/document.ts');
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const doc = newDocument(200, 150, 'Touch');
      const data = new Uint8ClampedArray(200 * 150 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([220, 30, 30, 255], i);
      const layer = newPixelLayer('Red', doc, gridFromImage(e.assets.tiles, { width: 200, height: 150, data }));
      doc.layers = [layer];
      e.history.reset(doc);
      e.hasDocument = true;
      e.selected = layer.id;
      e.zoom = 2;
      e.pan = { x: 0, y: 0 };
      e.setForeground('#2040e0');
      e.update();
    });
    await idle(page);
    await page.evaluate((id) => {
      const e = window.photoStudio;
      e.setTool(id);
      e.updatePointerInfo(undefined);
    }, id);
    await page.touchscreen.tap(...(await client(page, 100, 75)));
    await idle(page);
    await expect.poll(() => page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe(label);
    const px = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      return [...readRGBA(e.assets.tiles, e.doc.layers[0].pixels!, { x: 100, y: 75, width: 1, height: 1 }).data];
    });
    if (id === 'background-eraser') expect(px[3]).toBe(0);
    else expect(px[2]).toBeGreaterThan(px[0]);
  });
}
