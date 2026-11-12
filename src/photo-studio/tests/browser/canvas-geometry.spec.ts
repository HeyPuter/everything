// Canvas operations (Image Size, Rotate, Crop, Trim, Reveal All) on documents
// that use several features at once: document-space geometry stored outside
// the layers' pixels must follow the canvas, and the result must still save.
import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, idle, openImage, run, selectRect, start, tool } from './helpers';

/** A red 40 × 20 pixel layer at (20, 30) with a vector mask, a saved path,
 * a work path, guides, a sampler, a pixel variable, frame offsets and a comp. */
async function fixture(page: Page) {
  await openImage(page, 300, 200, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 20 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const red = newPixelLayer('Red', e.doc, gridFromImage(e.assets.tiles, { width: 40, height: 20, data }, 20, 30));
    const knot = (x: number, y: number) => ({ linked: false, points: [x, y, x, y, x, y] });
    const rect = (x: number, y: number, w: number, h: number) =>
      ({ paths: [{ open: false, operation: 'combine', fillRule: 'non-zero', knots: [knot(x, y), knot(x + w, y), knot(x + w, y + h), knot(x, y + h)] }] }) as never;
    red.vectorMask = { mask: rect(20, 30, 30, 20) };
    e.command('Fixture', (d) => {
      d.layers.push(red);
      d.paths = [{ id: 'p1', name: 'Path 1', mask: rect(100, 10, 10, 10) }];
      d.workPath = rect(200, 150, 10, 10);
      d.guides = [{ orientation: 'vertical', position: 50 }, { orientation: 'horizontal', position: 20 }];
      d.annotations = { samplers: [{ x: 10, y: 20 }] };
      d.variables = { layers: { [red.id]: { pixel: { name: 'img', method: 'fit', alignX: 0.5, alignY: 0.5, clip: true, bounds: { x: 20, y: 30, width: 40, height: 20 } } } }, sets: [] };
    });
    e.selectLayers([red.id]);
  });
  await idle(page);
}
const knots = (m: { paths: { knots: { points: number[] }[] }[] } | undefined) => m?.paths[0].knots.map((k) => k.points.slice(2, 4).map((v) => Math.round(v * 1000) / 1000));
const state = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridDocBounds } = await import('/src/model/tiles.ts');
    const d = e.doc;
    const red = d.layers.find((l) => l.name === 'Red')!;
    return {
      size: [d.width, d.height],
      red: gridDocBounds(red.liveSource ?? red.pixels!),
      vectorMask: red.vectorMask?.mask,
      path: d.paths?.[0].mask,
      workPath: d.workPath,
      guides: d.guides,
      samplers: d.annotations?.samplers,
      bounds: d.variables?.layers[red.id].pixel?.bounds,
      live: red.liveFilters?.length,
    };
  });
/** Save to .photo and read it back; returns an error message or ''. */
const reopenError = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    try {
      await deserialize(await serialize(e.doc, e.assets));
      return '';
    } catch (error) {
      return String(error);
    }
  });

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Image Size keeps Live Filters, and the project reopens', async ({ page }) => {
  await openImage(page, 200, 150, '#3366aa');
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.gaussian-blur', { params: { radius: 2 } });
  await page.evaluate(async () => {
    const { resampleDocument } = await import('/src/features/transform/image-size.ts');
    resampleDocument(window.photoStudio, 100, 75, 'bicubic');
  });
  await idle(page);
  const l = await page.evaluate(() => {
    const l = window.photoStudio.doc.layers[0];
    return { filters: l.liveFilters?.map((f) => f.id), source: !!l.liveSource };
  });
  expect(l).toEqual({ filters: ['gaussian-blur'], source: true });
  expect(await reopenError(page)).toBe('');
});

test('Rotate Canvas carries paths, masks, guides, variables, frame offsets, comps and Live Filters', async ({ page }) => {
  await fixture(page);
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.gaussian-blur', { params: { radius: 1 } });
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newLayerComp } = await import('/src/model/layer-comps.ts');
    e.command('Comp', (d) => void (d.layerComps = [newLayerComp(d, 'Here', { visibility: true, position: true, appearance: false })]));
    // Move the layer 10 px right of where the comp captured it.
    e.command('Move', (d) => {
      const l = d.layers.find((x) => x.name === 'Red')!;
      l.transform = { ...l.transform, x: l.transform.x + 10 };
    });
  });
  await run(page, 'animation.create');
  await page.evaluate(() => {
    const e = window.photoStudio;
    const red = e.doc.layers.find((l) => l.name === 'Red')!;
    e.command('Offset', (d) => void (d.animation!.frames[0].layers[red.id].dx = 5));
  });
  await idle(page);
  await run(page, 'image.rotate-cw');
  // 90° clockwise on a 300 × 200 canvas: (x, y) → (200 − y, x).
  const s = await state(page);
  expect(s.size).toEqual([200, 300]);
  expect(s.red).toEqual({ x: 150, y: 30, width: 20, height: 40 });
  expect(knots(s.vectorMask)).toEqual([[170, 30], [170, 60], [150, 60], [150, 30]]);
  expect(knots(s.path)).toEqual([[190, 100], [190, 110], [180, 110], [180, 100]]);
  expect(knots(s.workPath)).toEqual([[50, 200], [50, 210], [40, 210], [40, 200]]);
  expect(s.guides).toEqual([{ orientation: 'horizontal', position: 50 }, { orientation: 'vertical', position: 180 }]);
  // A sampler names a pixel: pixel (10, 20) lands on pixel (199 − 20, 10).
  expect(s.samplers?.map((p) => [p.x, p.y].map(Math.round))).toEqual([[179, 10]]);
  expect(s.bounds).toEqual({ x: 150, y: 20, width: 20, height: 40 });
  expect(s.live).toBe(1);
  const offset = await page.evaluate(() => {
    const d = window.photoStudio.doc;
    const red = d.layers.find((l) => l.name === 'Red')!;
    const f = d.animation!.frames[0].layers[red.id];
    return [f.dx, f.dy];
  });
  expect(offset.map((v) => Math.round(v))).toEqual([0, 5]);
  // The comp put the layer 10 px left of here; on the turned canvas that is 10 px up.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { applyLayerComp } = await import('/src/model/layer-comps.ts');
    e.command('Apply Comp', (d) => void applyLayerComp(d, d.layerComps![0]));
  });
  await idle(page);
  expect((await state(page)).red).toEqual({ x: 150, y: 20, width: 20, height: 40 });
  expect(await reopenError(page)).toBe('');
});

test('Image Size keeps comp positions of moved pixel layers', async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newLayerComp } = await import('/src/model/layer-comps.ts');
    // A committed move shifts the tile origin of the pixel layer.
    e.command('Move', (d) => {
      const l = d.layers.find((x) => x.name === 'Red')!;
      l.transform = { ...l.transform, x: l.transform.x + 30 };
    });
    e.command('Comp', (d) => void (d.layerComps = [newLayerComp(d, 'Here', { visibility: true, position: true, appearance: false })]));
    const { resampleDocument } = await import('/src/features/transform/image-size.ts');
    resampleDocument(e, 600, 400, 'nearest');
  });
  await idle(page);
  const before = (await state(page)).red;
  expect(before).toEqual({ x: 100, y: 60, width: 80, height: 40 });
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { applyLayerComp } = await import('/src/model/layer-comps.ts');
    e.command('Apply Comp', (d) => void applyLayerComp(d, d.layerComps![0]));
  });
  await idle(page);
  // The comp was captured where the layer is: applying it does not move it.
  expect((await state(page)).red).toEqual(before);
  const s = await state(page);
  expect(s.bounds).toEqual({ x: 40, y: 60, width: 80, height: 40 });
  expect(s.guides).toEqual([{ orientation: 'vertical', position: 100 }, { orientation: 'horizontal', position: 40 }]);
});

test('Crop, Trim and Reveal All move guides and variable bounds with the canvas', async ({ page }) => {
  await fixture(page);
  await selectRect(page, { x: 10, y: 10, width: 200, height: 150 });
  await run(page, 'image.crop');
  let s = await state(page);
  expect(s.size).toEqual([200, 150]);
  expect(s.guides).toEqual([{ orientation: 'vertical', position: 40 }, { orientation: 'horizontal', position: 10 }]);
  expect(s.bounds).toEqual({ x: 10, y: 20, width: 40, height: 20 });
  expect(knots(s.path)?.[0]).toEqual([90, 0]);

  // Reveal All grows the canvas to the cropped background and to a layer
  // moved past its top left corner.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Move', (d) => {
      const l = d.layers.find((x) => x.name === 'Red')!;
      l.transform = { ...l.transform, x: -20, y: -10 };
    });
  });
  await idle(page);
  await run(page, 'image.reveal-all');
  s = await state(page);
  expect(s.size).toEqual([310, 200]);
  expect(s.guides).toEqual([{ orientation: 'vertical', position: 60 }, { orientation: 'horizontal', position: 20 }]);
  expect(s.bounds).toEqual({ x: 30, y: 30, width: 40, height: 20 });

  // Trim to the red layer alone (background hidden); the guide left of it goes.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Hide and move', (d) => {
      d.layers[0].visible = false;
      const l = d.layers.find((x) => x.name === 'Red')!;
      l.transform = { ...l.transform, x: 50, y: 40 };
    });
  });
  await run(page, 'image.trim');
  s = await state(page);
  expect(s.size).toEqual([40, 20]);
  expect(s.guides).toEqual([{ orientation: 'vertical', position: 10 }]);
  expect(s.bounds).toEqual({ x: -20, y: -10, width: 40, height: 20 });
});

/** The flattened document as plain numbers. */
async function composite(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    await e.renderer.settle();
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const img = await compositeRGBA(e);
    return { width: img.width, height: img.height, data: Array.from(img.data) };
  });
}
type Image = Awaited<ReturnType<typeof composite>>;
/** An image turned 90° clockwise. */
function turned(a: Image): Image {
  const width = a.height,
    height = a.width,
    data = new Array<number>(a.data.length);
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++)
      for (let k = 0; k < 4; k++) data[(x * width + (a.height - 1 - y)) * 4 + k] = a.data[(y * a.width + x) * 4 + k];
  return { width, height, data };
}
const differing = (a: Image, b: Image) => a.data.filter((v, i) => Math.abs(v - b.data[i]) > 2).length;

test('Rotate Canvas turns group masks, shapes and embedded objects exactly', async ({ page }) => {
  await openImage(page, 240, 160, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { emptyGrid, gridFromImage, writeRect } = await import('/src/model/tiles.ts');
    const { rectKnots, closedPath } = await import('/src/features/vector/geometry.ts');
    const data = new Uint8ClampedArray(240 * 160 * 4);
    for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) data.set([x, y, 128, 255], (y * 240 + x) * 4);
    const ramp = newPixelLayer('Ramp', e.doc, gridFromImage(e.assets.tiles, { width: 240, height: 160, data }));
    ramp.opacity = 0.4;
    const blue = new Uint8ClampedArray(30 * 50 * 4);
    for (let i = 0; i < blue.length; i += 4) blue.set([0, 0, 255, 255], i);
    const object = newPixelLayer('Object', e.doc, gridFromImage(e.assets.tiles, { width: 30, height: 50, data: blue }, 150, 20));
    const shape = layer('vector', 'Shape', 50, 30);
    shape.transform = { x: 20, y: 20, width: 50, height: 30, rotation: 0 };
    shape.vector = { mask: { paths: [closedPath(rectKnots(20, 20, 50, 30))] } as never, reference: { x: 20, y: 20, width: 50, height: 30 }, fill: { rgb: [0.8, 0.1, 0.1], space: 'srgb' } };
    const group = layer('group', 'Group', 240, 160);
    group.children = [shape];
    // The group's mask hides its left 40 columns.
    group.maskGrid = writeRect(e.assets.tiles, { ...emptyGrid(1), fill: 255 }, 0, 0, { width: 40, height: 160, data: new Uint8Array(40 * 160) });
    e.command('Fixture', (d) => d.layers.push(ramp, group, object));
    e.selectLayers([object.id]);
  });
  await idle(page);
  await run(page, 'layer.embed-convert');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.kind))).toEqual(['pixel', 'pixel', 'group', 'image']);
  const before = await composite(page);
  await run(page, 'image.rotate-cw');
  const after = await composite(page);
  expect([after.width, after.height]).toEqual([160, 240]);
  expect(differing(turned(before), after)).toBe(0);
});

test('Image Size scales layer effects with the image', async ({ page }) => {
  await openImage(page, 200, 160, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { defaultDropShadow } = await import('/src/imaging/effects/types.ts');
    const data = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([0, 120, 255, 255], i);
    const l = newPixelLayer('Square', e.doc, gridFromImage(e.assets.tiles, { width: 40, height: 40, data }, 60, 50));
    l.style = { enabled: true, dropShadow: [{ ...defaultDropShadow(), distance: 20, size: 6, opacity: 1 }] };
    e.command('Square', (d) => d.layers.push(l));
  });
  await idle(page);
  const before = await composite(page);
  await page.evaluate(async () => {
    const { resampleDocument } = await import('/src/features/transform/image-size.ts');
    resampleDocument(window.photoStudio, 100, 80, 'bilinear');
  });
  await idle(page);
  const after = await composite(page);
  // Compare with the original averaged down 2 × 2: the shadow keeps its place.
  const half = after.data.map((_, i) => {
    const p = i >> 2, k = i & 3, x = (p % 100) * 2, y = Math.floor(p / 100) * 2;
    let s = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += before.data[((y + dy) * 200 + x + dx) * 4 + k];
    return s / 4;
  });
  expect(after.data.filter((v, i) => Math.abs(v - half[i]) > 30).length).toBeLessThan(400);
});

test('changing the resolution keeps type the same size in pixels', async ({ page }) => {
  await openImage(page, 200, 100, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 20, 60);
  await page.keyboard.type('Text');
  await page.keyboard.press('Escape');
  await idle(page);
  const inkWidth = () =>
    page.evaluate(async () => {
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      const img = await compositeRGBA(window.photoStudio);
      let x0 = img.width, x1 = -1;
      for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4] < 128) (x0 = Math.min(x0, i % img.width)), (x1 = Math.max(x1, i % img.width));
      return x1 - x0;
    });
  const before = await inkWidth();
  // Image Size without resampling: only the resolution changes.
  await start(page, 'image.image-size');
  const dialog = page.locator('dialog[open]');
  await dialog.locator('#is-resample').uncheck();
  await dialog.locator('#is-res').fill('144');
  await dialog.locator('#is-res').dispatchEvent('input');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.resolution?.horizontalResolution)).toBe(144);
  expect(await inkWidth()).toBe(before);
  // Resampling to twice the pixels at twice the resolution doubles the type once.
  await page.evaluate(async () => {
    const { resampleDocument } = await import('/src/features/transform/image-size.ts');
    resampleDocument(window.photoStudio, 400, 200, 'bilinear', 288);
  });
  await idle(page);
  expect(Math.abs((await inkWidth()) - before * 2)).toBeLessThanOrEqual(3);
});

test('Reveal All includes the corners of rotated layers', async ({ page }) => {
  await openImage(page, 100, 100, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 40 * 4).fill(255);
    const l = newPixelLayer('Square', e.doc, gridFromImage(e.assets.tiles, { width: 40, height: 40, data }, 0, 30));
    e.command('Square', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
  });
  await idle(page);
  await run(page, 'layer.embed-convert');
  // Turned 45° about its center (20, 50): corners reach 20 − 28.3 on the left.
  await page.evaluate(() => window.photoStudio.editLayer('Rotate', (l) => void (l.transform = { ...l.transform, rotation: 45 })));
  await run(page, 'image.reveal-all');
  expect(await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height])).toEqual([109, 100]);
});

test('Rotate Canvas turns imported pixel masks with their layers', async ({ page }) => {
  await openImage(page, 240, 160, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { identityMaskMatrix } = await import('/src/model/pixel-mask.ts');
    const data = new Uint8ClampedArray(60 * 40 * 4);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) data.set([x * 4, y * 6, 160, 255], (y * 60 + x) * 4);
    const l = newPixelLayer('Masked', e.doc, gridFromImage(e.assets.tiles, { width: 60, height: 40, data }, 100, 40));
    // A mask as PSD files bring it: the left 30 columns show, the rest is hidden.
    const asset = await e.assets.addCoverage({ width: 30, height: 40, data: new Uint8Array(1200).fill(255) });
    l.pixelMask = { asset, bounds: { x: 100, y: 40, width: 30, height: 40 }, reference: { ...l.transform }, matrix: identityMaskMatrix(), defaultColor: 0, positionRelativeToLayer: false, fromVectorData: false };
    e.command('Masked', (d) => d.layers.push(l));
  });
  await idle(page);
  const before = await composite(page);
  await run(page, 'image.rotate-cw');
  const after = await composite(page);
  expect(differing(turned(before), after)).toBe(0);
});
