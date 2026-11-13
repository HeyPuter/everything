import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

const operations = [
  { kind: 'crop', point: [6, 5] },
  { kind: 'expand', point: [24, 20] },
  { kind: 'rotate', point: [16, 8] },
  { kind: 'flip', point: [24, 8] },
  { kind: 'resize', point: [16, 16] },
  { kind: 'upscale', point: [16, 16] },
] as const;

for (const { kind, point } of operations) {
  test(`${kind} carries Quick Mask coverage and its preview with the image`, async ({ page }) => {
    await boot(page);
    await openImage(page, 32, 24, '#ffffff');
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { filledMask } = await import('/src/model/tiles.ts');
      const { applySelection } = await import('/src/model/selection.ts');
      const mask = filledMask(e.assets.tiles, { x: 4, y: 6, width: 8, height: 4 });
      e.command('Select', (d) => applySelection(d, mask));
    });
    await run(page, 'select.quick-mask');
    if (kind === 'crop') await page.evaluate(async () => {
      const { cropDocument } = await import('/src/model/document.ts');
      window.photoStudio.command('Crop', (d) => cropDocument(d, { x: 2, y: 3, width: 24, height: 16 }));
    });
    else if (kind === 'expand') await run(page, 'image.canvas-size', { params: { width: 64, height: 48, relative: false, anchor: [0.5, 0.5], color: 'white' } });
    else if (kind === 'rotate') await run(page, 'image.rotate-cw');
    else if (kind === 'flip') await run(page, 'image.flip-horizontal');
    else if (kind === 'resize') await page.evaluate(async () => {
      const { resampleDocument } = await import('/src/features/transform/image-size.ts');
      resampleDocument(window.photoStudio, 64, 48, 'nearest');
    });
    else await run(page, 'image.upscale', { params: { percent: 200, detail: 0, ai: false } });
    await idle(page);
    const coverage = await page.evaluate(async ([x, y]) => {
      const e = window.photoStudio;
      const { readMask } = await import('/src/model/tiles.ts');
      const at = (x: number, y: number) => readMask(e.assets.tiles, e.doc.quickMask!, { x, y, width: 1, height: 1 }).data[0];
      return [at(x, y), at(8, 8)];
    }, point);
    expect(coverage).toEqual([255, 0]);
    await expect.poll(() => page.evaluate(async ([x, y]) => {
      const e = window.photoStudio;
      const image = document.querySelector('#overlay image')!;
      const bitmap = await createImageBitmap(await (await fetch(image.getAttribute('href')!)).blob());
      const canvas = new OffscreenCanvas(e.doc.width, e.doc.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return [context.getImageData(x, y, 1, 1).data[3], context.getImageData(8, 8, 1, 1).data[3]];
    }, point), { timeout: 5000 }).toEqual([0, 128]);
    await run(page, 'edit.undo');
    expect(await page.evaluate(async () => {
      const { gridDocBounds } = await import('/src/model/tiles.ts');
      return gridDocBounds(window.photoStudio.doc.quickMask!);
    })).toEqual({ x: 4, y: 6, width: 8, height: 4 });
  });
}
