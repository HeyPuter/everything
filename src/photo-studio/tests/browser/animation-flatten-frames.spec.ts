// Flatten Frames Into Layers: one layer per frame holding that frame's
// composite, kept even when tile cleanup runs while frames render, and
// undo restores the document exactly.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('each frame becomes a layer of its composite; undo restores the document', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080', 'frames.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    // A small opaque square that moves from frame to frame.
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([200, 30, 30, 255], i);
    const grid = gridFromImage(e.assets.tiles, { width: 40, height: 40, data }, 10, 10);
    e.command('Square', (d) => void d.layers.push(newPixelLayer('Square', d, grid)));
  });
  await idle(page);
  await run(page, 'animation.create');
  for (const dx of [60, 120]) {
    await run(page, 'animation.new-frame');
    await page.evaluate(
      (dx) =>
        window.photoStudio.command('Move', (d) => {
          const l = d.layers.at(-1)!;
          l.transform.x += dx;
        }),
      dx,
    );
    await idle(page);
  }
  // Reference composites of each frame, and the document before flattening.
  const before = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { compositeFrame } = await import('/src/features/animation/render.ts');
    const { frameDocument } = await import('/src/model/animation.ts');
    const sums: number[] = [];
    for (let i = 0; i < e.doc.animation!.frames.length; i++) {
      const img = await compositeFrame(e, frameDocument(e.doc, i));
      let s = 0;
      for (let k = 0; k < img.data.length; k += 7) s += img.data[k] * ((k % 97) + 1);
      sums.push(s);
    }
    return { sums, json: JSON.stringify({ layers: e.doc.layers, animation: e.doc.animation }) };
  });
  expect(new Set(before.sums).size).toBe(3);
  // Tile cleanup runs while every frame renders.
  await page.evaluate(() => {
    const e = window.photoStudio;
    const r = e.renderer as unknown as { documentPixels: (...a: unknown[]) => Promise<unknown> };
    const original = r.documentPixels.bind(r);
    r.documentPixels = async (...a: unknown[]) => {
      const out = await original(...a);
      e.session.collectTiles();
      return out;
    };
  });
  await run(page, 'animation.flatten-frames');
  const after = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const frames = e.doc.layers.filter((l) => /^Frame \d$/.test(l.name));
    const sums = frames.map((l) => {
      const img = readRGBA(e.assets.tiles, (l as { pixels: never }).pixels, {
        x: 0,
        y: 0,
        width: e.doc.width,
        height: e.doc.height,
      });
      let s = 0;
      for (let k = 0; k < img.data.length; k += 7) s += img.data[k] * ((k % 97) + 1);
      return s;
    });
    return { names: frames.map((l) => l.name), sums, label: e.history.labels.at(-1) };
  });
  expect(after.names).toEqual(['Frame 1', 'Frame 2', 'Frame 3']);
  expect(after.sums).toEqual(before.sums);
  expect(after.label).toBe('Flatten Frames Into Layers');

  await run(page, 'edit.undo');
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        layers: window.photoStudio.doc.layers,
        animation: window.photoStudio.doc.animation,
      }),
    ),
  ).toBe(before.json);
  await run(page, 'edit.redo');
  expect(
    await page.evaluate(
      () => window.photoStudio.doc.layers.filter((l) => /^Frame \d$/.test(l.name)).length,
    ),
  ).toBe(3);
});
