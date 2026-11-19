import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

// File → Print encodes the composite in the export worker and prints it from a
// hidden frame; the printed PNG is the 8-bit sRGB composite (converted before
// it is reduced to 8 bits, for 32-bit documents).
for (const bits of [8, 32] as const)
  test(`Print hands the browser the document as 8-bit sRGB (${bits}-bit)`, async ({ page }) => {
    await boot(page);
    await openImage(page, 300, 200, '#3366cc');
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const data = new Uint8ClampedArray(120 * 80 * 4);
      for (let i = 0; i < data.length; i += 4)
        data.set([((i / 4) % 120) * 2, 40, 200 - ((i / 4 / 120) | 0), 180], i);
      const l = newPixelLayer(
        'Ramp',
        e.doc,
        gridFromImage(e.assets.tiles, { width: 120, height: 80, data }, 50, 60),
      );
      e.command('Ramp', (d) => void d.layers.push(l));
    });
    if (bits === 32)
      await page.evaluate(() =>
        window.photoStudio.command('Deep', (d) => void (d.bitsPerChannel = 32)),
      );
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.bitsPerChannel ?? 8)).toBe(bits);
    const expected = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { documentSource, exportContext } = await import('/src/features/files/pipeline.ts');
      const { printPixels } = await import('/src/features/files/print-encode.ts');
      return Array.from(printPixels(await documentSource(e), exportContext(e.doc)));
    });
    // Watch for the print frame and read back the image it shows.
    const printed = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          new MutationObserver((records, observer) => {
            for (const r of records)
              for (const n of r.addedNodes)
                if (n instanceof HTMLIFrameElement) {
                  observer.disconnect();
                  n.contentWindow!.print = () => {};
                  n.addEventListener('load', async () => {
                    n.contentWindow!.print = () => {};
                    const img = n.contentDocument!.querySelector('img')!;
                    const blob = await (await fetch(img.src)).blob();
                    const bmp = await createImageBitmap(blob, {
                      premultiplyAlpha: 'none',
                      colorSpaceConversion: 'none',
                    });
                    const c = new OffscreenCanvas(bmp.width, bmp.height);
                    const g = c.getContext('2d')!;
                    g.drawImage(bmp, 0, 0);
                    resolve(Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data));
                  });
                }
          }).observe(document.body, { childList: true });
        }),
    );
    await page.evaluate(() => void window.photoStudio.runCommand('file.print'));
    const got = await printed;
    expect(got.length).toBe(expected.length);
    // Canvas decoding premultiplies nothing here, so only translucent pixels
    // could round; the ramp is 180/255 opaque over an opaque background.
    let worst = 0;
    for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - expected[i]));
    expect(worst).toBe(0);
  });
