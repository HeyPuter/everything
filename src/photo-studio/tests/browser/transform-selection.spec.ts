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

test('Flip and Rotate 90° with a selection turn only the selected pixels', async ({ page }) => {
  // The left half of the blue square, flipped across its own center.
  await selectRect(page, { x: 0, y: 20, width: 40, height: 30 });
  await run(page, 'edit.flip-horizontal');
  expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Flip Horizontal');
  // Lifted pixels span x 0–40 (red 0–20, blue 20–40); flipped, blue is on the left.
  expect(await layerPixel(page, 5, 30)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 35, 30)).toEqual([255, 0, 0, 255]);
  // Outside the selection nothing moved.
  expect(await layerPixel(page, 50, 30)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 100, 30)).toEqual([255, 0, 0, 255]);
  await undo(page);
  expect(await layerPixel(page, 5, 30)).toEqual([255, 0, 0, 255]);
  // A 40 x 30 area turned a quarter about its center becomes 30 x 40.
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await run(page, 'edit.rotate-cw');
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 25, y: 15, width: 30, height: 40 });
  expect(await layerPixel(page, 30, 17)).toEqual([0, 0, 255, 255]);
  expect((await layerPixel(page, 22, 30))[3]).toBe(0);
});

test.describe('Move tool with a selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => window.photoStudio.setTool('move'));
    await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  });
  test('dragging inside the selection moves the selected pixels', async ({ page }) => {
    await canvasDrag(
      page,
      [
        [40, 35],
        [140, 85],
      ],
      6,
      ['Alt'],
    );
    // Alt moved a copy: the original pixels stay.
    expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Duplicate Selection');
    expect(await layerPixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
    expect(await layerPixel(page, 130, 80)).toEqual([0, 0, 255, 255]);
    await undo(page);
    await canvasDrag(page, [
      [40, 35],
      [40, 105],
    ]);
    expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Move Selection');
    expect((await layerPixel(page, 30, 30))[3]).toBe(0);
    expect(await layerPixel(page, 30, 100)).toEqual([0, 0, 255, 255]);
    expect(await layerPixel(page, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 20, y: 90, width: 40, height: 30 });
    // The layer itself did not move.
    expect(await page.evaluate(() => window.photoStudio.layer!.transform)).toMatchObject({ x: 0, y: 0, width: 200, height: 150 });
    await undo(page);
    expect(await layerPixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
  });
  test('arrow keys nudge the selected pixels and Escape cancels a drag', async ({ page }) => {
    await page.locator('#viewport').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await idle(page);
    expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Nudge Selection');
    expect((await layerPixel(page, 25, 30))[3]).toBe(0);
    expect(await layerPixel(page, 65, 30)).toEqual([0, 0, 255, 255]);
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 30, y: 20, width: 40, height: 30 });
    const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
    const [sx, sy] = await page.evaluate(() => window.photoStudio.clientPoint(50, 35));
    const [tx, ty] = await page.evaluate(() => window.photoStudio.clientPoint(120, 100));
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps);
    expect(await layerPixel(page, 65, 30)).toEqual([0, 0, 255, 255]);
    expect(await page.evaluate(() => window.photoStudio.settings.hideSelectionEdges)).toBeFalsy();
  });
});

test('the preview of lifted pixels on a half-transparent layer matches the result', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.command('Opacity', (d) => (d.layers[0].opacity = 0.5)));
  await selectRect(page, { x: 20, y: 20, width: 40, height: 30 });
  await run(page, 'edit.free-transform');
  await sessionCall(page, 'nudge', 100, 0);
  await idle(page);
  // Over the red rest of the layer the moved blue covers it before the
  // layer's opacity applies: half-transparent blue, not a purple mix.
  const shown = await shownPixel(page, 140, 35);
  expect(shown[0]).toBeLessThan(10);
  expect(shown[2]).toBeGreaterThan(245);
  expect(Math.abs(shown[3] - 128)).toBeLessThan(3);
  await page.keyboard.press('Enter');
  await idle(page);
  const committed = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const img = await compositeRGBA(e);
    const i = (35 * img.width + 140) * 4;
    return Array.from(img.data.slice(i, i + 4));
  });
  expect(committed).toEqual(shown);
});
