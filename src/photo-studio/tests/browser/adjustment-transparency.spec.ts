import { test, expect } from '@playwright/test';
import { boot, openImage, type Backend } from './helpers';

// Adjustment layers recolor what is below them without changing its
// coverage: over partly transparent pixels the alpha stays and the color is
// adjusted at full strength (opacity mixes toward the original color).
for (const backend of ['default', 'WebGL'] as Backend[])
  test(`adjustment layers keep the transparency below them (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await openImage(page, 16, 16, '#ffffff');
    const result = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const { layer } = await import('/src/model/document.ts');
      const W = 16,
        H = 16;
      const back = new Uint8ClampedArray(W * H * 4);
      const alphas = [255, 200, 128, 40, 0];
      for (let p = 0; p < W * H; p++)
        back.set([(p * 37) % 256, (p * 91) % 256, (p * 13) % 256, alphas[p % 5]], p * 4);
      const base = newPixelLayer(
        'B',
        e.doc,
        gridFromImage(e.assets.tiles, { width: W, height: H, data: back }, 0, 0),
      );
      const worst: number[] = [];
      for (const [opacity, clipped] of [
        [1, false],
        [0.5, false],
        [1, true],
      ] as const) {
        const a = layer('adjustment', 'Invert', W, H);
        a.adjustment = { kind: 'invert', params: {} };
        a.opacity = opacity;
        a.clipped = clipped;
        const px = await e.renderer.documentPixels(
          { ...e.doc, layers: [base, a] } as never,
          e.assets,
        );
        let d = 0;
        for (let p = 0; p < W * H; p++) {
          const ab = back[p * 4 + 3];
          d = Math.max(d, Math.abs(px[p * 4 + 3] - ab));
          if (ab < 20) continue;
          for (let c = 0; c < 3; c++) {
            const v = back[p * 4 + c];
            d = Math.max(d, Math.abs(px[p * 4 + c] - (v + (255 - 2 * v) * opacity)));
          }
        }
        worst.push(Math.round(d * 10) / 10);
      }
      return worst;
    });
    for (const d of result) expect(d).toBeLessThanOrEqual(1);
  });
