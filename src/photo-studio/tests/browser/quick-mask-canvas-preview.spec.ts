import { expect, test, type Page } from '@playwright/test';
import { boot, openImage, run } from './helpers';

async function preview(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    const image = document.querySelector('#overlay image')!;
    const bitmap = await createImageBitmap(await (await fetch(image.getAttribute('href')!)).blob());
    const canvas = new OffscreenCanvas(e.doc.width, e.doc.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = { width: bitmap.width, inside: context.getImageData(6, 6, 1, 1).data[3], outside: context.getImageData(12, 6, 1, 1).data[3] };
    bitmap.close();
    return result;
  });
}

test('Quick Mask previews use the current canvas dimensions through resize and undo', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 16, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { applySelection } = await import('/src/model/selection.ts');
    const { filledMask } = await import('/src/model/tiles.ts');
    const grid = filledMask(e.assets.tiles, { x: 4, y: 4, width: 4, height: 4 });
    e.command('Select', (d) => applySelection(d, grid));
  });
  await run(page, 'select.quick-mask');
  await expect.poll(() => preview(page), { timeout: 5000 }).toEqual({ width: 16, inside: 0, outside: 128 });
  await run(page, 'image.canvas-size', { params: { width: 32, height: 16, relative: false, anchor: [0, 0], color: 'white' } });
  await expect.poll(() => preview(page), { timeout: 5000 }).toEqual({ width: 32, inside: 0, outside: 128 });
  await run(page, 'edit.undo');
  await expect.poll(() => preview(page), { timeout: 5000 }).toEqual({ width: 16, inside: 0, outside: 128 });
  await run(page, 'edit.redo');
  await expect.poll(() => preview(page), { timeout: 5000 }).toEqual({ width: 32, inside: 0, outside: 128 });
});
