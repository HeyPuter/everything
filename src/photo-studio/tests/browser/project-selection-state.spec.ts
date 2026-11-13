import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('opening a saved project does not turn a temporary selection into its bounding rectangle', async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const { applySelection } = await import('/src/model/selection.ts');
    const pixel = { width: 1, height: 1, data: new Uint8Array([255]) };
    const grid = writeRect(e.assets.tiles, writeRect(e.assets.tiles, emptyGrid(1), 4, 5, pixel), 12, 10, pixel);
    e.command('Select two pixels', (d) => {
      applySelection(d, grid);
      d.channels = [{ id: 'saved', name: 'Two pixels', grid }];
    });
    const { serialize } = await import('/src/model/serialization.ts');
    const { openFile } = await import('/src/features/files/open.ts');
    const blob = await serialize(e.doc, e.assets);
    await openFile(e, blob, 'selection.photo');
  });
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toBeNull();
  // An explicitly saved channel still carries the exact shape.
  await page.evaluate(() => { window.photoStudio.session.activeChannel = 'saved'; });
  await run(page, 'select.load-active-channel');
  expect(await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    return [4, 8, 12].map((x, i) => readMask(e.assets.tiles, e.doc.selectionMask!, { x, y: [5, 7, 10][i], width: 1, height: 1 }).data[0]);
  })).toEqual([255, 0, 255]);
});
