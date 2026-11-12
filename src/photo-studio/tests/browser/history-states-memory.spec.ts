// Lowering History States in Preferences dropped old steps but kept their
// pixels in memory until several more edits were made.
import { expect, test } from '@playwright/test';
import { boot } from './helpers';

test('lowering History States frees the pixels of the dropped steps at once', async ({ page }) => {
  await boot(page);
  const mb = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { applyPreferences } = await import('/src/features/preferences/apply.ts');
    const W = 1024, H = 1024;
    const image = (v: number) => {
      const data = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i++) data.set([v, v, v, 255], i * 4);
      return { width: W, height: H, data };
    };
    const doc = newDocument(W, H, 'Memory');
    doc.layers = [newPixelLayer('Layer', doc, gridFromImage(e.assets.tiles, image(10)))];
    e.history.reset(doc);
    e.hasDocument = true;
    e.update();
    // Six whole-layer edits, each with its own 4 MB of tiles.
    for (let i = 0; i < 6; i++) {
      const grid = gridFromImage(e.assets.tiles, image(40 + i * 30));
      e.command(`Fill ${i}`, (d) => (d.layers[0].pixels = grid));
    }
    e.session.collectTiles();
    const before = e.assets.tiles.bytes / 2 ** 20;
    const limit = e.preferences.historyStates;
    e.preferences.historyStates = 1;
    applyPreferences(e);
    const after = e.assets.tiles.bytes / 2 ** 20;
    e.preferences.historyStates = limit;
    applyPreferences(e);
    return { before, after, steps: e.history.labels.length };
  });
  expect(mb.steps).toBe(1);
  expect(mb.before).toBeGreaterThanOrEqual(28);
  // The opened state, the state before the last step and the current one.
  expect(mb.after).toBeLessThanOrEqual(12);
});
