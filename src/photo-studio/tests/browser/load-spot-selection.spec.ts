import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const spot of [false, true]) for (const invert of [false, true]) {
  test(`Load Selection ${invert ? 'inverts' : 'loads'} ${spot ? 'spot ink' : 'alpha coverage'}`, async ({ page }) => {
    await boot(page);
    await openImage(page, 16, 12, '#ffffff');
    await page.evaluate(async (spot) => {
      const e = window.photoStudio;
      const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
      const grid = writeRect(e.assets.tiles, { ...emptyGrid(1), fill: spot ? 255 : 0 }, 2, 3, {
        width: 4, height: 5, data: new Uint8Array(20).fill(spot ? 0 : 255),
      });
      e.command('Add channel', (d) => { d.channels = [{ id: 'saved', name: 'Saved mask', grid, ...(spot ? { spot: true, color: '#ff0000' } : {}) }]; });
    }, spot);
    await start(page, 'select.load');
    const dialog = page.locator('dialog[open]');
    if (invert) await dialog.getByRole('checkbox', { name: 'Invert' }).check();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await idle(page);
    expect(await page.evaluate(async () => {
      const e = window.photoStudio;
      const { readMask } = await import('/src/model/tiles.ts');
      const { selectionGrid } = await import('/src/model/selection.ts');
      const grid = selectionGrid(e.doc, e.assets.tiles)!;
      const at = (x: number, y: number) => readMask(e.assets.tiles, grid, { x, y, width: 1, height: 1 }).data[0];
      return [at(3, 4), at(10, 8)];
    })).toEqual(invert ? [0, 255] : [255, 0]);
  });
}
