// Copy Layer Style / Paste Layer Style across documents.
import { expect, test } from '@playwright/test';
import { boot, compositePixel, idle, openImage, run } from './helpers';

test('a pasted pattern overlay brings its document pattern into the other document', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff', 'target.png');
  await openImage(page, 64, 64, '#ffffff', 'source.png');
  // In the source: a red document pattern used by a pattern overlay.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const grid = gridFromImage(e.assets.tiles, { width: 8, height: 8, data });
    const id = 'user-red-pattern';
    const l = e.doc.layers[0];
    e.command('Pattern style', (d) => {
      d.patterns = [{ id, name: 'Red', width: 8, height: 8, grid }];
      const x = d.layers.find((y) => y.id === l.id)!;
      x.style = {
        enabled: true,
        patternOverlay: {
          enabled: true,
          blendMode: 'normal',
          opacity: 1,
          patternId: id,
          scale: 1,
          linkWithLayer: true,
        },
      };
    });
    e.selectLayers([l.id]);
  });
  await idle(page);
  expect(await compositePixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  await run(page, 'layer.style-copy');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.switchSession(e.sessions.find((s) => s.doc.name.startsWith('target'))!);
    e.selectLayers([e.doc.layers[0].id]);
  });
  await run(page, 'layer.style-paste');
  expect(await page.evaluate(() => window.photoStudio.doc.patterns?.map((p) => p.id))).toEqual([
    'user-red-pattern',
  ]);
  expect(await compositePixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  // Undo takes the pattern away with the style.
  await run(page, 'edit.undo');
  expect(await page.evaluate(() => window.photoStudio.doc.patterns)).toBeUndefined();
});
