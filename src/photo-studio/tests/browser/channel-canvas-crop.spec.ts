import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

for (const spot of [false, true]) for (const expand of [false, true]) {
  test(`${expand ? 'canvas expansion' : 'crop'} carries ${spot ? 'spot' : 'alpha'} channels with the image`, async ({ page }) => {
    await boot(page);
    await openImage(page, 32, 24, '#ffffff');
    await page.evaluate(async (spot) => {
      const e = window.photoStudio;
      const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
      const grid = writeRect(e.assets.tiles, { ...emptyGrid(1), fill: spot ? 255 : 0 }, 4, 6, {
        width: 8, height: 4, data: new Uint8Array(32).fill(spot ? 0 : 255),
      });
      e.command('Add channel', (d) => { d.channels = [{ id: 'saved', name: 'Saved mask', grid, ...(spot ? { spot: true, color: '#ff0000' } : {}) }]; });
      e.session.activeChannel = 'saved';
    }, spot);
    await run(page, 'select.load-active-channel');
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({ x: 4, y: 6, width: 8, height: 4 });
    await run(page, 'select.deselect');
    if (expand) await run(page, 'image.canvas-size', { params: { width: 64, height: 48, relative: false, anchor: [0.5, 0.5], color: 'white' } });
    else await page.evaluate(async () => {
      const { cropDocument } = await import('/src/model/document.ts');
      window.photoStudio.command('Crop', (d) => cropDocument(d, { x: 2, y: 3, width: 24, height: 16 }));
    });
    await run(page, 'select.load-active-channel');
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({ x: expand ? 20 : 2, y: expand ? 18 : 3, width: 8, height: 4 });
    expect(await page.evaluate(async (expand) => {
      const e = window.photoStudio;
      const { serialize, deserialize } = await import('/src/model/serialization.ts');
      const { readMask } = await import('/src/model/tiles.ts');
      const loaded = await deserialize(await serialize(e.doc, e.assets));
      const channel = loaded.document.channels![0];
      const at = (x: number, y: number) => readMask(loaded.assets.tiles, channel.grid, { x, y, width: 1, height: 1 }).data[0];
      return { spot: !!channel.spot, values: [at(expand ? 24 : 6, expand ? 20 : 5), at(8, 8)] };
    }, expand)).toEqual({ spot, values: spot ? [0, 255] : [255, 0] });
    await run(page, 'edit.undo');
    await run(page, 'edit.undo');
    await run(page, 'select.load-active-channel');
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({ x: 4, y: 6, width: 8, height: 4 });
  });
}
