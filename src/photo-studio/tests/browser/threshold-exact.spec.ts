import { test, expect } from '@playwright/test';
import { boot, idle, start, type Backend } from './helpers';

// Threshold compares each pixel's luma with its edge on the GPU, as the CPU
// does: an adjustment layer and the dialog's preview give only black and
// white, the same pixels OK writes. (102, 102, 206) has luma 109.51, a hundredth
// of a level above the edge of level 110; a tabulated step used to give 83.
async function openTestImage(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const W = 64,
      H = 48;
    const data = new Uint8ClampedArray(W * H * 4);
    let s = 9;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24;
    for (let i = 0; i < W * H; i++) {
      // Grays and colors around the edge, then anything.
      const near = i % 2 === 0;
      const g = near ? 104 + (rnd() % 12) : rnd();
      data.set([near ? g : rnd(), g, near ? g + (rnd() % 5) - 2 : rnd(), 255], i * 4);
    }
    data.set([102, 102, 206, 255], 0);
    const c = new OffscreenCanvas(W, H);
    c.getContext('2d')!.putImageData(new ImageData(data, W), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'edge.png');
  });
  await idle(page);
}

for (const backend of ['default', 'WebGL'] as Backend[])
  test(`Threshold on the GPU matches the exact result (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await openTestImage(page);
    const layer = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { layer } = await import('/src/model/document.ts');
      const { readRGBA } = await import('/src/model/tiles.ts');
      const { applyAdjustment } = await import('/src/imaging/adjust/index.ts');
      const base = e.doc.layers[0];
      const src = readRGBA(e.assets.tiles, base.pixels!, { x: 0, y: 0, width: 64, height: 48 });
      const adj = layer('adjustment', 'Threshold', 64, 48);
      adj.adjustment = { kind: 'threshold', params: { level: 110 } };
      const px = await e.renderer.documentPixels({ ...e.doc, layers: [base, adj] }, e.assets);
      const ref = applyAdjustment(src, { kind: 'threshold', params: { level: 110 } } as never);
      let wrong = 0,
        gray = 0;
      for (let i = 0; i < px.length; i++) {
        const v = px instanceof Float32Array ? Math.round(px[i] * 255) : px[i];
        if (v !== ref.data[i]) wrong++;
        if (v % 255) gray++;
      }
      return { first: Array.from(px.subarray(0, 4)), wrong, gray };
    });
    expect(layer).toEqual({ first: [255, 255, 255, 255], wrong: 0, gray: 0 });

    // The dialog's live preview shows what OK applies.
    await start(page, 'adjust.threshold', { initial: { level: 110 } });
    const dialog = page.locator('dialog.adj-dialog[open]');
    await expect(dialog).toBeVisible();
    const preview = async () =>
      page.evaluate(async () => {
        const r = window.photoStudio.renderer;
        await r.settle();
        return Array.from(await r.rawPixels(), (v) => (v <= 1 && v % 1 ? Math.round(v * 255) : v));
      });
    await expect.poll(async () => (await preview()).slice(0, 4)).toEqual([255, 255, 255, 255]);
    const shown = await preview();
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toHaveCount(0);
    await idle(page);
    const applied = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      return Array.from(
        readRGBA(e.assets.tiles, e.doc.layers[0].pixels!, { x: 0, y: 0, width: 64, height: 48 })
          .data,
      );
    });
    let differ = 0;
    for (let i = 0; i < applied.length; i++) if (applied[i] !== shown[i]) differ++;
    expect(differ).toBe(0);
  });
