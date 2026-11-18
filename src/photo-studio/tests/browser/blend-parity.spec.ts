import { test, expect } from '@playwright/test';
import { boot, openImage, type Backend } from './helpers';

// Every blend mode on the GPU (both backends) against the CPU reference in
// imaging/blend/modes.ts, with partial alpha on both layers, layer opacity and
// a pair of different colors with equal luma (Darker/Lighter Color ties).
for (const backend of ['default', 'WebGL'] as Backend[])
  test(`blend modes match the reference math (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await openImage(page, 32, 32, '#ffffff');
    const out = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const { blendPixel, blendModes } = await import('/src/imaging/blend/modes.ts');
      const { blends } = await import('/src/model/document.ts');
      const W = 32,
        H = 32;
      let seed = 7;
      const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
      const back = new Uint8ClampedArray(W * H * 4),
        src = new Uint8ClampedArray(W * H * 4);
      const alphas = [255, 255, 200, 128, 40, 0];
      for (let p = 0; p < W * H; p++) {
        for (let c = 0; c < 3; c++) {
          back[p * 4 + c] = rnd();
          src[p * 4 + c] = rnd();
        }
        back[p * 4 + 3] = alphas[p % 6];
        src[p * 4 + 3] = alphas[(p >> 3) % 6];
      }
      // An equal-luma pair (0.3 exactly in 8-bit codes).
      back.set([255, 0, 0, 255], 0);
      src.set([0, 92, 202, 255], 0);
      back.set([0, 92, 202, 255], 4);
      src.set([255, 0, 0, 255], 4);
      const b = newPixelLayer(
        'B',
        e.doc,
        gridFromImage(e.assets.tiles, { width: W, height: H, data: back }, 0, 0),
      );
      const s = newPixelLayer(
        'S',
        e.doc,
        gridFromImage(e.assets.tiles, { width: W, height: H, data: src }, 0, 0),
      );
      const rows: [string, number, number][] = [];
      for (let m = 0; m < blends.length; m++) {
        if (blends[m] === 'dissolve') continue;
        const doc = { ...e.doc, layers: [{ ...b }, { ...s, blend: blends[m], opacity: 0.8 }] };
        const px = await e.renderer.documentPixels(doc as never, e.assets);
        let worst = 0,
          at = -1;
        for (let p = 0; p < W * H; p++) {
          const ref = blendPixel(
            blendModes[m].id,
            Array.from(back.subarray(p * 4, p * 4 + 4), (v) => v / 255),
            Array.from(src.subarray(p * 4, p * 4 + 4), (v) => v / 255),
            0.8,
          );
          const a = px[p * 4 + 3] / 255;
          let d = Math.abs(a - ref[3]) * 255;
          if (ref[3] > 0.02)
            for (let c = 0; c < 3; c++)
              d = Math.max(
                d,
                Math.abs(px[p * 4 + c] / 255 - ref[c]) * 255 * Math.min(1, ref[3] * 4),
              );
          if (d > worst) {
            worst = d;
            at = p;
          }
        }
        rows.push([blends[m], Math.round(worst * 10) / 10, at]);
      }
      return rows;
    });
    for (const [mode, worst, at] of out)
      expect(worst, `${mode} at pixel ${at}`).toBeLessThanOrEqual(1);
  });
