import { test, expect } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, canvasDrag, compositePixel, openImage, openProject, run, selectRect, type Backend } from './helpers';

for (const backend of ['default', 'WebGL'] as Backend[])
  test(`a solid-color shape clips to the layer below (${backend})`, async ({ page }) => {
    await boot(page, backend);
    const doc = newDocument(200, 100, 'Clip');
    const base = layer('solid', 'Base', 60, 60);
    base.color = '#ff0000';
    base.transform.x = 10;
    base.transform.y = 10;
    doc.layers = [base];
    await openProject(page, doc, [], 'clip.photo');
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.color = '#0000ff';
      e.setTool('rect-shape');
    });
    await canvasDrag(page, [[40, 20], [120, 60]]);
    expect(await page.evaluate(() => window.photoStudio.layer?.kind)).toBe('vector');
    await run(page, 'layer.clipping-mask');
    expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, true]);
    // The shape shows inside the base only; the base shows around it.
    expect(await compositePixel(page, 50, 30)).toEqual([0, 0, 255, 255]);
    expect(await compositePixel(page, 20, 30)).toEqual([255, 0, 0, 255]);
    expect((await compositePixel(page, 100, 30))[3]).toBe(0);
    // A new color reaches the clipped shape.
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { setVectorColor } = await import('/src/color/vector.ts');
      e.editLayer('Color', (l) => setVectorColor(l, '#00ff00'));
    });
    expect(await compositePixel(page, 50, 30)).toEqual([0, 255, 0, 255]);
  });

// Releasing a layer in the middle of a clipping group used to leave the
// layers above it clipped to the released layer instead of the base.
test('Release Clipping Mask in the middle of a group releases the layers above too', async ({ page }) => {
  await boot(page);
  const doc = newDocument(100, 40, 'Release');
  const base = layer('solid', 'Base', 100, 40);
  base.color = '#ff0000';
  const c1 = layer('solid', 'C1', 20, 20);
  c1.color = '#00ff00';
  const c2 = layer('solid', 'C2', 20, 20);
  c2.color = '#0000ff';
  c2.transform.x = 30;
  const c3 = layer('solid', 'C3', 20, 20);
  c3.color = '#ffffff';
  c3.transform.x = 60;
  for (const l of [c1, c2, c3]) l.clipped = true;
  doc.layers = [base, c1, c2, c3];
  await openProject(page, doc, [], 'release.photo');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selected = e.doc.layers[2].id;
    e.update();
  });
  await run(page, 'layer.clipping-mask');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, true, false, false]);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Release Clipping Mask');
  // C3 still shows where it did, instead of being cut away by C2's shape.
  expect(await compositePixel(page, 70, 10)).toEqual([255, 255, 255, 255]);
  await run(page, 'edit.undo');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, true, true, true]);
});

// Layer via Copy above the base of a clipping group used to insert the piece
// unclipped, so the clipped layers clipped to the piece instead of the base.
test('Layer via Copy on the base of a clipping group joins the group', async ({ page }) => {
  await boot(page);
  const doc = newDocument(100, 40, 'Via');
  const back = layer('solid', 'Back', 100, 40);
  back.color = '#ffffff';
  doc.layers = [back];
  await openProject(page, doc, [], 'via.photo');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer, insertLayerAt } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < 1600; i++) data.set([255, 0, 0, 255], i * 4);
    const base = newPixelLayer('Base', e.doc, gridFromImage(e.assets.tiles, { width: 40, height: 40, data }, 0, 0));
    const clipped = layer('solid', 'Clipped', 100, 40);
    clipped.color = '#0000ff';
    clipped.clipped = true;
    e.command('Setup', (d) => {
      insertLayerAt(d.layers, 1, base);
      d.layers.push(clipped);
    });
    e.selected = base.id;
    e.update();
  });
  await selectRect(page, { x: 0, y: 0, width: 20, height: 40 });
  await run(page, 'layer.via-copy');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.name, !!l.clipped]))).toEqual([
    ['Back', false],
    ['Base', false],
    ['Base copy', true],
    ['Clipped', true],
  ]);
  // The clipped layer still covers the whole base, not only the copied piece.
  expect(await compositePixel(page, 30, 20)).toEqual([0, 0, 255, 255]);
});

// A clipped group in Pass Through mode drew its contents unclipped.
for (const backend of ['default', 'WebGL'] as Backend[])
  test(`a clipped Pass Through group stays inside its base (${backend})`, async ({ page }) => {
    await boot(page, backend);
    const doc = newDocument(60, 40, 'Pass');
    const base = layer('solid', 'Base', 20, 20);
    base.color = '#ff0000';
    base.transform.x = 10;
    base.transform.y = 10;
    const group = layer('group', 'Group', 60, 40);
    group.blend = 'pass through';
    group.clipped = true;
    const inner = layer('solid', 'Inner', 60, 40);
    inner.color = '#0000ff';
    group.children = [inner];
    doc.layers = [base, group];
    await openProject(page, doc, [], 'pass.photo');
    expect(await compositePixel(page, 15, 15)).toEqual([0, 0, 255, 255]);
    expect((await compositePixel(page, 2, 2))[3]).toBe(0);
  });

// Fill fades only the base layer's own pixels; its shape still clips. A base
// at Fill 0% used to hide its clipped layers (and a lower Fill faded them).
for (const backend of ['default', 'WebGL'] as Backend[])
  test(`clipped layers show inside a base with a low Fill, as the CPU reference composites them (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await openImage(page, 60, 40, '#ffffff', 'white.png');
    const result = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { layer } = await import('/src/model/document.ts');
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const { compositeRGBA8 } = await import('/src/imaging/blend/composite.ts');
      const solidImage = (w: number, h: number, rgba: number[]) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
        return { width: w, height: h, data };
      };
      const out: Record<string, number[][]> = {};
      for (const fill of [0, 0.5]) {
        const base = newPixelLayer('Base', e.doc, gridFromImage(e.assets.tiles, solidImage(20, 20, [255, 0, 0, 255]), 10, 10));
        base.fillOpacity = fill;
        const clipped = layer('solid', 'Clipped', 60, 40);
        clipped.color = '#3080c0';
        clipped.clipped = true;
        clipped.opacity = 0.6;
        clipped.blend = 'multiply';
        e.command('Layers', (d) => {
          d.layers = [d.layers[0], base, clipped];
        });
        const pixels = await e.renderer.documentPixels(e.doc, e.assets);
        const at = (x: number, y: number) => Array.from(pixels.slice((y * 60 + x) * 4, (y * 60 + x) * 4 + 4));
        // CPU reference for a pixel inside the base: base at its Fill, the
        // clipped layer over it, then the group over the white background.
        const group = solidImage(1, 1, [0, 0, 0, 0]);
        compositeRGBA8(group, solidImage(1, 1, [255, 0, 0, 255]), 'normal', fill);
        compositeRGBA8(group, solidImage(1, 1, [0x30, 0x80, 0xc0, 255]), 'multiply', 0.6);
        const expected = solidImage(1, 1, [255, 255, 255, 255]);
        compositeRGBA8(expected, group, 'normal', 1);
        out[fill] = [at(15, 15), Array.from(expected.data), at(2, 2)];
      }
      return out;
    });
    for (const [inside, expected, outside] of Object.values(result)) {
      for (let c = 0; c < 4; c++) expect(Math.abs(inside[c] - expected[c])).toBeLessThanOrEqual(2);
      expect(outside).toEqual([255, 255, 255, 255]);
    }
  });
