import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, type Backend } from './helpers';

// A new pixel layer whose tiles are already on the GPU (Layer via Copy,
// Duplicate, redo, a layer growing past its bounds) copies them between
// textures instead of uploading them again, and readbacks of other layer lists
// keep the canvas's textures. The composite must stay exactly the stored pixels.

/** Count texture uploads from now on (`window.__writes`). */
async function countWrites(page: Page) {
  await page.evaluate(() => {
    const r = window.photoStudio.renderer as unknown as {
      backend: { write: (...a: unknown[]) => void };
    };
    const w = window as unknown as { __writes: number; __wrapped?: boolean };
    w.__writes = 0;
    if (w.__wrapped) return;
    w.__wrapped = true;
    const write = r.backend.write.bind(r.backend);
    r.backend.write = (...a: unknown[]) => {
      w.__writes++;
      write(...a);
    };
  });
}
const writes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __writes: number }).__writes);
/** Pixels that differ between a render of the named layer alone and the CPU
 * read of its tiles over the canvas. */
const mismatch = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers.find((x) => x.name === name)!;
    const px = await e.renderer.documentPixels({ ...e.doc, layers: [l] }, e.assets);
    const ref = readRGBA(e.assets.tiles, l.pixels!, {
      x: 0,
      y: 0,
      width: e.doc.width,
      height: e.doc.height,
    }).data;
    let bad = 0;
    for (let i = 0; i < ref.length; i++) {
      const v = px instanceof Float32Array ? Math.round(px[i] * 255) : px[i];
      if (v !== ref[i]) bad++;
    }
    return bad;
  }, name);

for (const backend of ['default', 'WebGL'] as Backend[])
  for (const bits of [8, 16] as const)
    test(`copied layer textures keep the layer's pixels (${backend}, ${bits}-bit)`, async ({
      page,
    }) => {
      await boot(page, backend);
      await openImage(page, 1100, 800, '#ffffff');
      await page.evaluate(
        (bits) => window.photoStudio.command('Depth', (d) => void (d.bitsPerChannel = bits)),
        bits,
      );
      await idle(page);
      await countWrites(page);
      // A: 600 × 450 of noise at (300, 280), six tiles.
      await page.evaluate(async () => {
        const e = window.photoStudio;
        const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
        const { gridFromImage } = await import('/src/model/tiles.ts');
        const W = 600,
          H = 450;
        let seed = 11;
        const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
        const data = new Uint8ClampedArray(W * H * 4);
        for (let p = 0; p < W * H; p++) {
          for (let c = 0; c < 3; c++) data[p * 4 + c] = rnd();
          data[p * 4 + 3] = 255;
        }
        const a = newPixelLayer(
          'A',
          e.doc,
          gridFromImage(e.assets.tiles, { width: W, height: H, data }, 300, 280),
        );
        e.command('Add A', (d) => void d.layers.push(a));
      });
      await idle(page);
      expect(await writes(page)).toBe(6);
      expect(await mismatch(page, 'A')).toBe(0);

      // B shares A's tiles (Layer via Copy, Duplicate).
      await countWrites(page);
      await page.evaluate(async () => {
        const e = window.photoStudio;
        const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
        const a = e.doc.layers.find((l) => l.name === 'A')!;
        const b = newPixelLayer('B', e.doc, a.pixels!);
        e.command('Add B', (d) => void d.layers.push(b));
      });
      await idle(page);
      // Neither the copy nor the readbacks of single layers upload anything.
      expect(await mismatch(page, 'B')).toBe(0);
      expect(await mismatch(page, 'A')).toBe(0);
      await idle(page);
      expect(await writes(page)).toBe(0);

      // Undo removes B's texture; redo copies it from A again.
      await page.evaluate(() => window.photoStudio.runCommand('edit.undo'));
      await idle(page);
      await page.evaluate(() => window.photoStudio.runCommand('edit.redo'));
      await idle(page);
      expect(await writes(page)).toBe(0);
      expect(await mismatch(page, 'B')).toBe(0);

      // A grows up and left (a larger texture, its tiles at new places in it):
      // only the added tile is uploaded.
      await page.evaluate(async () => {
        const e = window.photoStudio;
        const { writeRect } = await import('/src/model/tiles.ts');
        const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
        const patch = new Uint8ClampedArray(40 * 30 * 4).fill(200);
        e.command('Grow', (d) => {
          const a = d.layers.find((l) => l.name === 'A')!;
          setLayerPixels(
            a,
            writeRect(e.assets.tiles, a.pixels!, 20, 20, { width: 40, height: 30, data: patch }),
            d,
          );
        });
      });
      await idle(page);
      expect(await writes(page)).toBe(1);
      expect(await mismatch(page, 'A')).toBe(0);
      expect(await mismatch(page, 'B')).toBe(0);
    });
