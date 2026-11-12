import { test, expect } from '@playwright/test';
import { boot, idle, openFiles, run, type Backend } from './helpers';

// Clarity & Dehaze and Grain adjustment layers render on the GPU with filter
// passes. The composite must match the CPU reference (src/imaging/adjust/
// spatial.ts) on both compositor backends, and the destructive command must
// produce the same pixels.
for (const backend of ['default', 'WebGL'] as Backend[]) {
  test(`spatial adjustment layers match the CPU reference (${backend})`, async ({ page }) => {
    await boot(page, backend);
    // A hazy scene: a color gradient with stripes, partly transparent at the top.
    await page.evaluate(async () => {
      // Wide enough that the reduced planes use a factor of 3.
      const w = 2100,
        h = 160;
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d')!;
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const base = 50 + (150 * x) / w + ((x >> 3) & 1 ? 14 : -14) + (y >> 4) * 3;
          const haze = 0.45;
          img.data[i] = base * 1.15 + (235 - base * 1.15) * haze;
          img.data[i + 1] = base + (235 - base) * haze;
          img.data[i + 2] = base * 0.7 + (235 - base * 0.7) * haze;
          img.data[i + 3] = y < 20 ? 0 : 255;
        }
      g.putImageData(img, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const { openFile } = await import('/src/features/files/open.ts');
      await openFile(window.photoStudio, blob, 'scene.png');
    });
    await idle(page);
    const engine = await page.evaluate(() => window.photoStudio.renderer.name);
    if (backend === 'WebGL') expect(engine).toBe('WebGL2');

    const compare = (spec: { kind: string; params: Record<string, number> }) =>
      page.evaluate(async (spec) => {
        const e = window.photoStudio;
        const { applyAdjustment } = await import('/src/imaging/adjust/engine.ts');
        const { addAdjustmentLayer } = await import('/src/features/adjust/layers.ts');
        const base = (await e.renderer.documentPixels(e.doc, e.assets)) as Uint8Array;
        const src = { width: e.doc.width, height: e.doc.height, data: new Uint8ClampedArray(base) };
        const adj = { kind: spec.kind, params: spec.params } as never;
        const want = applyAdjustment(src, adj, undefined, undefined, { x: 0, y: 0, docWidth: e.doc.width, docHeight: e.doc.height });
        const id = addAdjustmentLayer(e, spec.kind as never, adj);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await e.renderer.settle();
        const got = (await e.renderer.documentPixels(e.doc, e.assets)) as Uint8Array;
        let max = 0,
          sum = 0,
          changed = 0;
        for (let i = 0; i < got.length; i++) {
          const d = Math.abs(got[i] - want.data[i]);
          max = Math.max(max, d);
          sum += d;
          if (want.data[i] !== base[i]) changed++;
        }
        // Remove the layer again for the next comparison.
        e.command('Delete', (d) => (d.layers = d.layers.filter((l) => l.id !== id)));
        return { max, mean: sum / got.length, changed };
      }, spec);

    const clarity = await compare({ kind: 'clarity-dehaze', params: { clarity: 70, dehaze: 0 } });
    expect(clarity.changed).toBeGreaterThan(10000);
    expect(clarity.mean).toBeLessThan(0.05);
    expect(clarity.max).toBeLessThanOrEqual(1);
    await idle(page);
    const dehaze = await compare({ kind: 'clarity-dehaze', params: { clarity: 30, dehaze: 60 } });
    expect(dehaze.changed).toBeGreaterThan(10000);
    expect(dehaze.mean).toBeLessThan(0.05);
    expect(dehaze.max).toBeLessThanOrEqual(2);
    await idle(page);
    const fog = await compare({ kind: 'clarity-dehaze', params: { clarity: 0, dehaze: -50 } });
    expect(fog.changed).toBeGreaterThan(10000);
    expect(fog.mean).toBeLessThan(0.05);
    expect(fog.max).toBeLessThanOrEqual(1);
    await idle(page);
    const grain = await compare({ kind: 'grain', params: { amount: 70, size: 30, roughness: 60, color: 40 } });
    expect(grain.changed).toBeGreaterThan(10000);
    expect(grain.mean).toBeLessThan(0.05);
    expect(grain.max).toBeLessThanOrEqual(1);
    await idle(page);

    // The destructive command applies the CPU reference to the layer.
    const before = await page.evaluate(async () => {
      const e = window.photoStudio;
      return Array.from((await e.renderer.documentPixels(e.doc, e.assets)) as Uint8Array);
    });
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { applyToLayer } = await import('/src/features/pixels.ts');
      const { adjustInWorker } = await import('/src/features/adjust/worker-client.ts');
      await applyToLayer(e, 'Grain', (image, rect) =>
        adjustInWorker(image, { kind: 'grain', params: { amount: 70, size: 30, roughness: 60, color: 40 } }, { x: rect.x, y: rect.y, docWidth: e.doc.width, docHeight: e.doc.height }),
      );
    });
    await idle(page);
    const applied = await page.evaluate(async (before) => {
      const e = window.photoStudio;
      const { grain } = await import('/src/imaging/adjust/spatial.ts');
      const src = { width: e.doc.width, height: e.doc.height, data: new Uint8ClampedArray(before) };
      const want = grain(src, { amount: 70, size: 30, roughness: 60, color: 40 });
      const got = (await e.renderer.documentPixels(e.doc, e.assets)) as Uint8Array;
      let max = 0;
      for (let i = 0; i < got.length; i++) max = Math.max(max, Math.abs(got[i] - want.data[i]));
      return max;
    }, before);
    expect(applied).toBeLessThanOrEqual(1);
    await run(page, 'edit.undo');
  });
}

// 32-bit documents keep values above 1 (no top clamp) through the filter passes.
for (const backend of ['default', 'WebGL'] as Backend[]) {
  test(`spatial adjustment layers in a 32-bit document (${backend})`, async ({ page }) => {
    await boot(page, backend);
    const bytes = await page.evaluate(async () => {
      const { newDocument, layer } = await import('/src/model/document.ts');
      const { Assets } = await import('/src/model/assets.ts');
      const { serialize } = await import('/src/model/serialization.ts');
      const w = 400,
        h = 120;
      const doc = newDocument(w, h, 'HDR'),
        assets = new Assets();
      doc.bitsPerChannel = 32;
      const data = new Float32Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = 0.3 + (1.5 * x) / w + ((x >> 3) & 1 ? 0.06 : -0.06);
          data.set([v * 1.1, v, v * 0.75, 1], i);
        }
      const image = layer('image', 'HDR pixels', w, h);
      image.asset = await assets.addRaster({ width: w, height: h, data });
      doc.layers = [image];
      return Array.from(new Uint8Array(await (await serialize(doc, assets)).arrayBuffer()));
    });
    await openFiles(page, { name: 'HDR.photo', mimeType: 'application/x-photo-editor', buffer: Buffer.from(bytes) });
    const result = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { clarityDehazeFloat, grainFloat } = await import('/src/imaging/adjust/spatial.ts');
      const { addAdjustmentLayer } = await import('/src/features/adjust/layers.ts');
      const base = (await e.renderer.documentPixels(e.doc, e.assets)) as Float32Array;
      const w = e.doc.width,
        h = e.doc.height;
      const cd = { clarity: 50, dehaze: 40 },
        gr = { amount: 60, size: 20, roughness: 40, color: 30 };
      const want = grainFloat(clarityDehazeFloat(base, w, h, cd, Math.max(w, h), false), w, h, gr, 0, 0, false);
      addAdjustmentLayer(e, 'clarity-dehaze', { kind: 'clarity-dehaze', params: cd });
      addAdjustmentLayer(e, 'grain', { kind: 'grain', params: gr });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await e.renderer.settle();
      const got = (await e.renderer.documentPixels(e.doc, e.assets)) as Float32Array;
      let max = 0,
        over = 0;
      for (let i = 0; i < got.length; i++) {
        max = Math.max(max, Math.abs(got[i] - want[i]));
        if ((i & 3) !== 3 && got[i] > 1.05) over++;
      }
      return { max, over, float: got instanceof Float32Array };
    });
    expect(result.float).toBe(true);
    expect(result.over).toBeGreaterThan(1000);
    expect(result.max).toBeLessThan(2e-3);
  });
}

test('the Clarity & Dehaze dialog previews a masked layer as OK applies it', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(64, 48);
    const g = c.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 64, 0);
    gr.addColorStop(0, '#ff0000');
    gr.addColorStop(0.5, '#00ff00');
    gr.addColorStop(1, '#0000ff');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 48);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'masked.png');
  });
  await idle(page);
  // A layer mask that shows only part of the layer.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { filledMask } = await import('/src/model/tiles.ts');
    e.command('Add Mask', (d) => (d.layers[0].maskGrid = filledMask(e.assets.tiles, { x: 10, y: 10, width: 30, height: 20 })));
    const { adjustmentDialog } = await import('/src/features/adjust/dialog.ts');
    void adjustmentDialog(e, 'clarity-dehaze', { clarity: 50, dehaze: 30 });
  });
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  // The document on screen (the preview while the dialog is open), or the stored one.
  const pixels = async (shown: boolean) =>
    page.evaluate(async (shown) => {
      const e = window.photoStudio as unknown as { lastDoc?: unknown; doc: unknown; renderer: { settle(): Promise<void> } };
      await e.renderer.settle();
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      return Array.from((await compositeRGBA(window.photoStudio, (shown ? (e.lastDoc ?? e.doc) : e.doc) as never)).data);
    }, shown);
  const original = (await pixels(false)).join();
  await expect.poll(async () => (await pixels(true)).join() !== original).toBe(true);
  const preview = await pixels(true);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('dialog.adj-dialog[open]')).toHaveCount(0);
  await idle(page);
  const applied = await pixels(true);
  let max = 0;
  for (let i = 0; i < applied.length; i++) max = Math.max(max, Math.abs(applied[i] - preview[i]));
  expect(max).toBeLessThanOrEqual(2);
});
