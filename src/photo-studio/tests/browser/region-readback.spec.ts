import { test, expect, type Page } from '@playwright/test';
import { boot, idle, menu, openImage, type Backend } from './helpers';

// Reading back a rectangle of the composite gives exactly that part of the
// full readback, so previews read only what they show.

/** A 300 × 200 document with a noise layer over part of it. */
async function noiseDocument(page: Page, bits: number) {
  await openImage(page, 300, 200, '#3366cc');
  await page.evaluate(async (bits) => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    let seed = 3;
    const data = new Uint8ClampedArray(260 * 170 * 4);
    for (let i = 0; i < data.length; i++)
      data[i] = (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const l = newPixelLayer(
      'Noise',
      e.doc,
      gridFromImage(e.assets.tiles, { width: 260, height: 170, data }, 21, 13),
    );
    e.command('Noise', (d) => {
      d.layers.push(l);
      d.bitsPerChannel = bits as 8 | 16 | 32;
    });
  }, bits);
  await idle(page);
}

for (const backend of ['default', 'WebGL'] as Backend[])
  for (const bits of [8, 32])
    test(`a rectangle readback matches the full composite (${backend}, ${bits}-bit)`, async ({
      page,
    }) => {
      await boot(page, backend);
      await noiseDocument(page, bits);
      const out = await page.evaluate(async () => {
        const e = window.photoStudio;
        const full = await e.renderer.documentPixels(e.doc, e.assets);
        const W = e.doc.width;
        let worst = 0;
        for (const r of [
          { x: 0, y: 0, width: 300, height: 200 },
          { x: 37, y: 11, width: 101, height: 77 },
          { x: 299, y: 199, width: 1, height: 1 },
          { x: 0, y: 150, width: 300, height: 50 },
        ]) {
          const part = await e.renderer.documentPixels(e.doc, e.assets, r);
          if (part.length !== r.width * r.height * 4 || part.constructor !== full.constructor)
            return -1;
          for (let y = 0; y < r.height; y++)
            for (let i = 0; i < r.width * 4; i++)
              worst = Math.max(
                worst,
                Math.abs(part[y * r.width * 4 + i] - full[((r.y + y) * W + r.x) * 4 + i]),
              );
        }
        return worst;
      });
      expect(out).toBe(0);
    });

test('Image Size previews the middle of the image from a small readback', async ({ page }) => {
  await boot(page);
  await noiseDocument(page, 16);
  const expected = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const img = await compositeRGBA(e);
    // Preview (100%): 168 × 168 around the middle (the canvas is 300 × 200).
    const out: number[] = [];
    for (let y = 16; y < 184; y++)
      for (let x = 66; x < 234; x++)
        out.push(...img.data.subarray((y * 300 + x) * 4, (y * 300 + x) * 4 + 4));
    const reads: number[] = [];
    const read = e.renderer.documentPixels.bind(e.renderer);
    e.renderer.documentPixels = (doc, assets, rect) => {
      reads.push(rect ? rect.width * rect.height : doc.width * doc.height);
      return read(doc, assets, rect);
    };
    (window as unknown as { __reads: number[] }).__reads = reads;
    return out;
  });
  await menu(page, 'Image', 'Image Size…');
  const canvas = page.locator('dialog[open] .is-preview canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __reads: number[] }).__reads.length))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const got = await canvas.evaluate((c: HTMLCanvasElement) =>
        Array.from(c.getContext('2d')!.getImageData(0, 0, 168, 168).data),
      );
      let worst = 0;
      for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - expected[i]));
      return worst;
    })
    .toBe(0);
  // Only the region around the view was read, not the whole image.
  const reads = await page.evaluate(() => (window as unknown as { __reads: number[] }).__reads);
  expect(Math.max(...reads)).toBeLessThan(300 * 200);
  await page.keyboard.press('Escape');
});
