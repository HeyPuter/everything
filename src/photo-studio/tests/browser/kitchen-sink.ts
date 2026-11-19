// A document that uses many features at once, for cross-feature tests:
// pixel layers with masks and Live Filters, Blend If, a styled shape, type on
// a path, an embedded object (flipped, so it carries a frame), a frame layer
// with placed content, an artboard, adjustment and fill layers, channels,
// patterns, paths, guides, annotations, comps, slices, frame animation,
// variables with a data set, text styles, global light and perspective planes.
import type { Page } from '@playwright/test';
import { canvasClick, idle, openImage, run, selectRect, start, tool } from './helpers';

export async function kitchenSink(page: Page) {
  await openImage(page, 320, 240, '#d8e0e8', 'sink.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { emptyGrid, gridFromImage, writeRect } = await import('/src/model/tiles.ts');
    const { rectKnots, closedPath, knot } = await import('/src/features/vector/geometry.ts');
    const { createFrame } = await import('/src/model/frame.ts');
    const { defaultDropShadow } = await import('/src/imaging/effects/types.ts');
    const fill = (w: number, h: number, rgb: number[]) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
      return { width: w, height: h, data };
    };
    const store = e.assets.tiles;
    const paint = newPixelLayer('Paint', e.doc, gridFromImage(store, fill(80, 60, [200, 60, 40]), 20, 20));
    paint.maskGrid = writeRect(store, { ...emptyGrid(1), fill: 255 }, 20, 20, { width: 20, height: 60, data: new Uint8Array(20 * 60).fill(64) });
    paint.blending = { ranges: { gray: { this: [0, 0, 255, 255], underlying: [10, 40, 255, 255] } } };
    const shape = layer('vector', 'Shape', 60, 40);
    shape.transform = { x: 120, y: 30, width: 60, height: 40, rotation: 0 };
    shape.vector = { mask: { paths: [closedPath(rectKnots(120, 30, 60, 40))] } as never, reference: { x: 120, y: 30, width: 60, height: 40 }, fill: { rgb: [0.15, 0.35, 0.8], space: 'srgb' } };
    shape.style = { dropShadow: [{ ...defaultDropShadow(), distance: 4, size: 4 }] };
    shape.vectorMask = { mask: { paths: [closedPath(rectKnots(110, 20, 50, 50))] } as never };
    const object = newPixelLayer('Object', e.doc, gridFromImage(store, fill(40, 30, [30, 160, 60]), 200, 30));
    const placed = newPixelLayer('Placed', e.doc, gridFromImage(store, fill(50, 50, [240, 200, 20]), 20, 140));
    const frame = createFrame(e.doc, { x: 20, y: 140, width: 40, height: 40 }, 'ellipse');
    frame.children = [placed];
    const sky = layer('solid', 'Sky', e.doc.width, e.doc.height);
    sky.color = '#336699';
    sky.opacity = 0.2;
    e.command('Kitchen sink', (d) => {
      d.layers.push(paint, shape, object, frame, sky);
      d.guides = [{ orientation: 'vertical', position: 160 }, { orientation: 'horizontal', position: 120 }];
      d.workPath = { paths: [{ open: true, operation: 'combine', fillRule: 'non-zero', knots: [knot(60, 220, 60, 220, 60, 160), knot(160, 160, 100, 160, 220, 160), knot(260, 220, 260, 160, 260, 220)] }] } as never;
      d.paths = [{ id: 'saved-path', name: 'Saved', mask: { paths: [closedPath(rectKnots(240, 150, 40, 30))] } as never }];
      d.annotations = {
        samplers: [{ x: 30, y: 30 }],
        counts: [{ id: 'c1', name: 'Group 1', color: '#ff0000', markerSize: 6, labelSize: 10, visible: true, points: [[50, 50], [70, 60]] }],
        notes: [{ id: 'n1', x: 100, y: 100, author: 'QA', text: 'Note', color: '#ffcc00', created: '2026-01-01T00:00:00.000Z' }],
      };
      d.slices = [{ id: 's1', name: 'Header', rect: { x: 0, y: 0, width: 320, height: 40 } }];
      d.perspectivePlanes = [[[10, 10], [100, 12], [98, 90], [12, 88]]];
      d.globalLight = { angle: 100, altitude: 35 };
      d.info = { title: 'Sink', author: 'QA' };
    });
    e.selectLayers([object.id]);
  });
  await idle(page);
  // Embedded object, mirrored (a frame on the instance).
  await run(page, 'layer.embed-convert');
  await run(page, 'edit.flip-horizontal');
  // Live Filters on the paint layer.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers([e.doc.layers.find((l) => l.name === 'Paint')!.id]);
  });
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.gaussian-blur', { params: { radius: 1.5 } });
  // Type on the work path.
  await page.evaluate(async () => {
    const { setActive } = await import('/src/features/vector/state.ts');
    setActive(window.photoStudio, 'work');
    window.photoStudio.update();
  });
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 60, 200);
  await page.keyboard.type('Along the path');
  await page.keyboard.press('Escape');
  await idle(page);
  // Adjustment layers, among them a spatial one.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { addAdjustmentLayer } = await import('/src/features/adjust/layers.ts');
    const { defaultAdjustment } = await import('/src/imaging/adjust/model.ts');
    addAdjustmentLayer(e, 'clarity-dehaze', { ...defaultAdjustment('clarity-dehaze'), params: { ...defaultAdjustment('clarity-dehaze').params, clarity: 40 } } as never);
    addAdjustmentLayer(e, 'grain', { ...defaultAdjustment('grain'), params: { ...defaultAdjustment('grain').params, amount: 30 } } as never);
    addAdjustmentLayer(e, 'relight');
    addAdjustmentLayer(e, 'levels');
  });
  await idle(page);
  // A channel, a pattern, comps, frames, variables, an artboard.
  await selectRect(page, { x: 200, y: 100, width: 60, height: 40 });
  await start(page, 'select.save');
  await page.locator('dialog[open]').getByRole('button', { name: 'OK' }).click();
  await idle(page);
  await run(page, 'select.deselect');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newLayerComp } = await import('/src/model/layer-comps.ts');
    const { createAnimation } = await import('/src/model/animation.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { createArtboard } = await import('/src/model/artboard.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const paint = e.doc.layers.find((l) => l.name === 'Paint')!;
    const text = e.doc.layers.find((l) => l.kind === 'text')!;
    const data = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    e.command('Setup', (d) => {
      d.patterns = [{ id: 'pat-1', name: 'Dots', width: 8, height: 8, grid: gridFromImage(e.assets.tiles, { width: 8, height: 8, data }) }];
      d.layerComps = [newLayerComp(d, 'All', { visibility: true, position: true, appearance: true })];
      d.animation = createAnimation(d);
      d.variables = {
        layers: { [paint.id]: { visibility: 'showPaint', pixel: { name: 'photo', method: 'fit', alignX: 0.5, alignY: 0.5, clip: true, bounds: { x: 20, y: 20, width: 80, height: 60 } } }, [text.id]: { text: 'caption' } },
        sets: [{ name: 'Data Set 1', values: { showPaint: true, photo: 'a.png', caption: 'Hello' } }],
      };
      const board = createArtboard(d, { x: 400, y: 0, width: 100, height: 100 });
      board.children = [newPixelLayer('On board', d, gridFromImage(e.assets.tiles, { width: 10, height: 10, data }, 420, 20))];
      d.layers.push(board);
    });
  });
  await idle(page);
  await run(page, 'animation.new-frame');
  // Frame 2 moves the paint layer.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Move', (d) => {
      const l = d.layers.find((x) => x.name === 'Paint')!;
      l.transform = { ...l.transform, x: l.transform.x + 12 };
    });
  });
  await idle(page);
}

/** The document as plain data: tile grids become their position and a hash
 * of their pixels, so equal documents compare equal across tile stores. */
export function documentDigest(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, readMask, gridDocBounds } = await import('/src/model/tiles.ts');
    const hash = (data: ArrayLike<number>) => {
      let h = 2166136261;
      for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
      return (h >>> 0).toString(16);
    };
    const isGrid = (v: unknown): v is import('/src/model/tiles.ts').TileGrid =>
      !!v && typeof v === 'object' && 'tiles' in v && 'channels' in v;
    const digest = (v: unknown): unknown => {
      if (isGrid(v)) {
        const b = gridDocBounds(v);
        // Reveal-all masks are unbounded: hash a generous area around the canvas.
        const r = b && b.width * b.height > 1e8 ? { x: -512, y: -512, width: e.doc.width + 1024, height: e.doc.height + 1024 } : b;
        const px = r ? (v.channels === 4 ? readRGBA(e.assets.tiles, v, r).data : readMask(e.assets.tiles, v, r).data) : [];
        return { grid: v.channels, fill: v.fill ?? 0, bounds: b, pixels: hash(px) };
      }
      if (Array.isArray(v)) return v.map(digest);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, digest(x)]));
      return v;
    };
    return digest(e.doc) as Record<string, unknown>;
  });
}
