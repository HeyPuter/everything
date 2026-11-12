import { test, expect, type Page } from '@playwright/test';
import { boot, canvasDrag, idle, layerPixel, openImage, redo, run, selectRect, undo } from './helpers';

// Free Transform and the transform modes with an active selection lift the
// selected pixels of a pixel layer and transform just them.

/** RGBA of the document as shown (with the session's preview) at a point. */
const shownPixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      const img = await compositeRGBA(e, e.displayDoc);
      const i = (y * img.width + x) * 4;
      return Array.from(img.data.slice(i, i + 4));
    },
    [x, y] as const,
  );
// The running session is the editor's modal edit (read through the editor so
// the page's own module instance is used).
type Session = import('../../src/features/transform/session').TransformSession;
const session = (page: Page) =>
  page.evaluate(() => {
    const s = window.photoStudio.modal as Session | undefined;
    return s?.target ? { kind: s.target.kind, float: !!(s.target.kind === 'layer' && s.target.float), rect: s.rect } : undefined;
  });
const sessionCall = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    async ({ fn, args }) => {
      const s = window.photoStudio.modal as unknown as Record<string, (...a: unknown[]) => unknown>;
      s[fn](...args);
    },
    { fn, args },
  );
/** Draw a blue square onto the red layer so moved pixels can be told apart. */
async function paintSquare(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Paint', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 20, y: 20, width: 40, height: 30 });
      for (let i = 0; i < img.data.length; i += 4) img.data.set([0, 0, 255, 255], i);
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 20, 20, img), d);
    });
  });
  await idle(page);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150, '#ff0000');
  await paintSquare(page);
});

test('Free Transform with a selection moves only the selected pixels, as one undo step', async ({ page }) => {
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await run(page, 'edit.free-transform');
  expect(await session(page)).toEqual({ kind: 'layer', float: true, rect: { x: 20, y: 20, width: 40, height: 30 } });
  // Drag the lifted pixels by (100, 50); Alt keeps them off snap targets.
  await canvasDrag(
    page,
    [
      [40, 35],
      [140, 85],
    ],
    6,
    ['Alt'],
  );
  // The preview shows the hole and the moved pixels; the layer is unchanged.
  expect(await shownPixel(page, 140, 85)).toEqual([0, 0, 255, 255]);
  expect((await shownPixel(page, 30, 30))[3]).toBeLessThan(255);
  expect(await layerPixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await session(page)).toBeFalsy();
  expect((await layerPixel(page, 30, 30))[3]).toBe(0);
  expect(await layerPixel(page, 130, 80)).toEqual([0, 0, 255, 255]);
  // Pixels outside the selection stay where they were.
  expect(await layerPixel(page, 5, 5)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 120, y: 70, width: 40, height: 30 });
  expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Transform');
  await undo(page);
  expect(await layerPixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 130, 80)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 20, y: 20, width: 40, height: 30 });
  await redo(page);
  expect(await layerPixel(page, 130, 80)).toEqual([0, 0, 255, 255]);
});

test('a scaled selection on the Background layer leaves the background color behind', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { makeBackground } = await import('/src/model/housekeeping.ts');
    e.command('Make Background', (d) => makeBackground(d.layers[0]));
    e.setBackground('#00ff00');
  });
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await run(page, 'edit.transform-scale');
  expect((await session(page))?.float).toBe(true);
  // Twice the size about the top-left corner.
  await page.evaluate(async () => {
    const s = window.photoStudio.modal as Session;
    s.setReference({ x: 0, y: 0 });
    s.setParams({ ...s.params, sx: 2, sy: 2 });
  });
  await page.keyboard.press('Enter');
  await idle(page);
  // The scaled square covers (20, 20)–(100, 80); outside it the hole is gone
  // under it and the rest of the layer is untouched.
  expect(await layerPixel(page, 90, 70)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 110, 70)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 20, y: 20, width: 80, height: 60 });
  // Moving the selection away shows the background color in the hole.
  await selectRect(page, { x: 20, y: 20, width: 80, height: 60 });
  await run(page, 'edit.free-transform');
  await sessionCall(page, 'nudge', 0, 70);
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await layerPixel(page, 30, 30)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 30, 100)).toEqual([0, 0, 255, 255]);
  // The Background layer stays opaque.
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].background)).toBe(true);
});

test('cancelling a floating selection changes nothing and frees its tiles', async ({ page }) => {
  await selectRect(page, { x: 10, y: 10, width: 60, height: 50 });
  const before = await page.evaluate(() => {
    const e = window.photoStudio;
    e.session.collectTiles();
    return { doc: e.doc, tiles: e.assets.tiles.size, steps: e.history.labels.length };
  });
  await run(page, 'edit.free-transform');
  await sessionCall(page, 'rotateBy', 30);
  await idle(page);
  await page.keyboard.press('Escape');
  await idle(page);
  await idle(page);
  const after = await page.evaluate((steps) => {
    const e = window.photoStudio;
    return { steps: e.history.labels.length - steps, tiles: e.assets.tiles.size };
  }, before.steps);
  expect(after).toEqual({ steps: 0, tiles: before.tiles });
  expect(await layerPixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
});

test('a skewed floating selection previews and commits; an empty selection is refused', async ({ page }) => {
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await run(page, 'edit.transform-skew');
  await page.evaluate(async () => {
    const s = window.photoStudio.modal as Session;
    s.setParams({ ...s.params, skewX: 30, x: s.params.x + 100 });
  });
  await idle(page);
  await page.waitForTimeout(200);
  await idle(page);
  // The middle of the moved square is blue in the preview; the hole is not.
  expect(await shownPixel(page, 140, 35)).toEqual([0, 0, 255, 255]);
  expect((await shownPixel(page, 25, 35))[3]).toBeLessThan(255);
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await layerPixel(page, 140, 35)).toEqual([0, 0, 255, 255]);
  expect((await layerPixel(page, 25, 35))[3]).toBe(0);

  // A selection over transparent pixels only has nothing to lift.
  await selectRect(page, { x: 20, y: 20, width: 10, height: 10 });
  await run(page, 'edit.free-transform');
  expect(await session(page)).toBeFalsy();
  await expect(page.locator('#status')).toContainText('selected area is empty');
});

test('Transform Again repeats the transform on the selected pixels', async ({ page }) => {
  await selectRect(page, { x: 20, y: 20, width: 20, height: 30 });
  await run(page, 'edit.free-transform');
  await sessionCall(page, 'nudge', 0, 40);
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 20, y: 60, width: 20, height: 30 });
  // The other half of the square moves the same way; the first half stays.
  await selectRect(page, { x: 40, y: 20, width: 20, height: 30 });
  await run(page, 'edit.transform-again');
  expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Transform Again');
  expect(await layerPixel(page, 50, 70)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 30, 70)).toEqual([0, 0, 255, 255]);
  expect((await layerPixel(page, 50, 30))[3]).toBe(0);
  expect(await layerPixel(page, 70, 70)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 40, y: 60, width: 20, height: 30 });
});
