import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, layerPixel, openImage } from './helpers';

// Each painting tool's options bar shows the controls that change what it
// does, and those controls work.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 120, '#808080', 'gray.png');
});

/** A new pixel layer filled with one color, selected. */
async function filledLayer(page: Page, rgba: [number, number, number, number]) {
  await page.evaluate(async (rgba) => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(e.doc.width * e.doc.height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    const l = newPixelLayer(
      'Paint',
      e.doc,
      gridFromImage(e.assets.tiles, { width: e.doc.width, height: e.doc.height, data }),
    );
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
  }, rgba);
  await idle(page);
}
async function setTool(
  page: Page,
  id: string,
  brush: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  await page.evaluate(
    async ({ id, brush, settings }) => {
      const e = window.photoStudio;
      Object.assign(e.settings, settings);
      e.setTool(id);
      // The app's own module instance holds the brush (not a test import).
      const b = e.activeTool?.brush?.get(e);
      if (b) Object.assign(b, { smoothing: 0 }, brush);
      e.options();
    },
    { id, brush, settings },
  );
  await idle(page);
}
const optionIds = (page: Page) =>
  page.locator('#tool-options').evaluate((el) => [...el.querySelectorAll('[id]')].map((n) => n.id));

test('tools show only the brush controls that apply to them', async ({ page }) => {
  await setTool(page, 'dodge');
  let ids = await optionIds(page);
  expect(ids).not.toContain('brush-mode');
  expect(ids).not.toContain('brush-opacity');
  expect(ids).not.toContain('brush-flow');
  expect(ids).toContain('tone-exposure');
  // The Sponge has one Mode and one Flow (its own), plus Vibrance.
  await setTool(page, 'sponge');
  expect(await page.locator('#tool-options select').count()).toBe(1);
  expect(await page.locator('#tool-options').getByText('Flow').count()).toBe(1);
  await expect(page.locator('#sponge-vibrance')).toBeChecked();
  // Blur offers the focus modes only and has no opacity.
  await setTool(page, 'blur-tool');
  expect(await page.locator('#brush-mode option:not([disabled])').allTextContents()).toEqual([
    'Normal',
    'Darken',
    'Lighten',
    'Hue',
    'Saturation',
    'Color',
    'Luminosity',
  ]);
  ids = await optionIds(page);
  expect(ids).not.toContain('brush-opacity');
  // Color Replacement offers the color modes, Color by default.
  await setTool(page, 'color-replacement');
  expect(await page.locator('#brush-mode option').allTextContents()).toEqual([
    'Hue',
    'Saturation',
    'Color',
    'Luminosity',
  ]);
  await expect(page.locator('#brush-mode')).toHaveValue('color');
  // The Pencil has no hardness or flow; the Brush has an angle field.
  await setTool(page, 'pencil');
  ids = await optionIds(page);
  expect(ids).not.toContain('brush-hardness');
  expect(ids).not.toContain('brush-flow');
  expect(ids).toContain('pencil-auto-erase');
  await setTool(page, 'brush');
  await page.locator('#brush-angle').fill('30');
  await page.locator('#brush-angle').dispatchEvent('change');
  expect(
    await page.evaluate(
      () =>
        (
          window.photoStudio.activeTool!.brush!.get(window.photoStudio) as unknown as {
            angle: number;
          }
        ).angle,
    ),
  ).toBe(30);
});

test('number keys set the exposure of the Dodge tool', async ({ page }) => {
  await setTool(page, 'dodge');
  await page.locator('#viewport').hover();
  await page.keyboard.press('3');
  await expect(page.locator('#tone-exposure')).toHaveValue('30');
});

test('the Pencil with Auto Erase paints the background color over the foreground color', async ({
  page,
}) => {
  await filledLayer(page, [255, 0, 0, 255]);
  await page.evaluate(() => {
    window.photoStudio.setForeground('#ff0000');
    window.photoStudio.setBackground('#0000ff');
  });
  await setTool(page, 'pencil', { size: 6 }, { pencilAutoErase: true });
  await canvasDrag(page, [
    [40, 60],
    [80, 60],
  ]);
  expect(await layerPixel(page, 60, 60)).toEqual([0, 0, 255, 255]);
  // A stroke that starts on another color paints the foreground.
  await canvasDrag(page, [
    [60, 60],
    [60, 90],
  ]);
  expect(await layerPixel(page, 60, 80)).toEqual([255, 0, 0, 255]);
});

test('the Eraser in Block mode erases a hard square', async ({ page }) => {
  await filledLayer(page, [0, 200, 0, 255]);
  await setTool(page, 'eraser', { size: 20 }, { eraserMode: 'block' });
  await expect(page.locator('#brush-hardness')).toHaveCount(0);
  await expect(page.locator('#brush-opacity')).toHaveCount(0);
  await canvasClick(page, 100, 60);
  // The square's corners are erased fully; just outside it nothing is.
  expect((await layerPixel(page, 91, 51))[3]).toBe(0);
  expect((await layerPixel(page, 108, 68))[3]).toBe(0);
  expect((await layerPixel(page, 88, 60))[3]).toBe(255);
});

test('Erase to History restores the history source instead of erasing', async ({ page }) => {
  // The history source is the opened state: the gray image layer.
  await setTool(page, 'brush', { size: 30, hardness: 1 });
  await page.evaluate(() => window.photoStudio.setForeground('#ff00ff'));
  await canvasDrag(page, [
    [60, 60],
    [140, 60],
  ]);
  expect(await layerPixel(page, 100, 60)).toEqual([255, 0, 255, 255]);
  await setTool(
    page,
    'eraser',
    { size: 30, hardness: 1 },
    { eraserMode: 'brush', eraseToHistory: true },
  );
  await canvasDrag(page, [
    [60, 60],
    [140, 60],
  ]);
  expect(await layerPixel(page, 100, 60)).toEqual([128, 128, 128, 255]);
});

test('Alt-click with the Brush picks the foreground color without painting', async ({ page }) => {
  await filledLayer(page, [10, 120, 230, 255]);
  await setTool(page, 'brush');
  const before = await page.evaluate(() => window.photoStudio.history.labels.length);
  await canvasClick(page, 50, 50, ['Alt']);
  await expect.poll(() => page.evaluate(() => window.photoStudio.color)).toBe('#0a78e6');
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(before);
});

test('the Paint Bucket fills in a blend mode and with a pattern', async ({ page }) => {
  await filledLayer(page, [128, 128, 128, 255]);
  await page.evaluate(() => window.photoStudio.setForeground('#ff0000'));
  await setTool(page, 'bucket', {}, { bucketMode: 'multiply', bucketSource: 'foreground' });
  await expect(page.locator('#bucket-mode')).toHaveValue('multiply');
  await canvasClick(page, 100, 60);
  const px = await layerPixel(page, 100, 60);
  expect(px[0]).toBeGreaterThan(120);
  expect(px[0]).toBeLessThan(136);
  expect(px[1]).toBeLessThan(4);
  // Pattern fills take the current pattern's pixels.
  await setTool(
    page,
    'bucket',
    {},
    { bucketMode: 'normal', bucketSource: 'pattern', contiguous: false },
  );
  await expect(page.locator('[data-bucket-pattern]')).toBeVisible();
  const expected = await page.evaluate(async () => {
    const { currentPattern } = await import('/src/features/effects/state.ts');
    const t = currentPattern(window.photoStudio)!.tile;
    const at = (x: number, y: number) => {
      const i = ((y % t.height) * t.width + (x % t.width)) * 4;
      return [...t.data.slice(i, i + 4)];
    };
    return [at(3, 5), at(10, 2)];
  });
  await canvasClick(page, 100, 60);
  const a = await layerPixel(page, 3, 5);
  const b = await layerPixel(page, 10, 2);
  if (expected[0][3] === 255) expect(a).toEqual(expected[0]);
  if (expected[1][3] === 255) expect(b).toEqual(expected[1]);
});

test('Blur in Darken mode never lightens and Smudge Finger Painting lays down the foreground', async ({
  page,
}) => {
  // Black and white stripes.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const w = e.doc.width,
      h = e.doc.height;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        data.set(x % 4 < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * w + x) * 4);
    const l = newPixelLayer(
      'Stripes',
      e.doc,
      gridFromImage(e.assets.tiles, { width: w, height: h, data }),
    );
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
  });
  await idle(page);
  await setTool(
    page,
    'blur-tool',
    { size: 30, hardness: 1, mode: 'darken' },
    { blurStrength: 100 },
  );
  await canvasDrag(page, [
    [60, 60],
    [140, 60],
  ]);
  const dark = await layerPixel(page, 100, 60);
  const light = await layerPixel(page, 102, 60);
  expect(dark.slice(0, 3)).toEqual([0, 0, 0]);
  expect(light[0]).toBeLessThan(255);
  await page.evaluate(() => window.photoStudio.setForeground('#00ff00'));
  await setTool(
    page,
    'smudge-tool',
    { size: 20, hardness: 1, mode: 'normal' },
    { smudgeStrength: 100, fingerPainting: true },
  );
  await canvasDrag(page, [
    [40, 100],
    [80, 100],
  ]);
  const g = await layerPixel(page, 41, 100);
  expect(g[1]).toBeGreaterThan(g[0] + 60);
});

test('Color Replacement in Luminosity mode keeps the hue and takes the foreground brightness', async ({
  page,
}) => {
  await filledLayer(page, [200, 40, 40, 255]);
  await page.evaluate(() => window.photoStudio.setForeground('#202020'));
  await setTool(
    page,
    'color-replacement',
    { size: 30, hardness: 1, mode: 'luminosity' },
    { replaceSampling: 'once' },
  );
  await canvasDrag(page, [
    [60, 60],
    [140, 60],
  ]);
  const px = await layerPixel(page, 100, 60);
  expect(px[0]).toBeGreaterThan(px[1] + 20);
  expect(px[0]).toBeLessThan(120);
});

test('Erase to History and the History Brush restore transparency of the history source', async ({
  page,
}) => {
  // The opened state: gray on the left half, transparent on the right.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const doc = newDocument(200, 120, 'Half');
    const data = new Uint8ClampedArray(100 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([128, 128, 128, 255], i);
    const grid = gridFromImage(e.assets.tiles, { width: 100, height: 120, data });
    const layer = newPixelLayer('Half', doc, grid);
    doc.layers = [layer];
    e.history.reset(doc);
    e.selected = layer.id;
    e.update();
  });
  await idle(page);
  for (const [tool, settings] of [
    ['eraser', { eraserMode: 'brush', eraseToHistory: true }],
    ['history-brush', {}],
  ] as const) {
    await setTool(page, 'brush', { size: 30, hardness: 1 });
    await page.evaluate(() => window.photoStudio.setForeground('#ff00ff'));
    await canvasDrag(page, [
      [60, 60],
      [140, 60],
    ]);
    expect(await layerPixel(page, 120, 60)).toEqual([255, 0, 255, 255]);
    await setTool(page, tool, { size: 30, hardness: 1, opacity: 1, flow: 1 }, settings);
    await canvasDrag(page, [
      [60, 60],
      [140, 60],
    ]);
    expect(await layerPixel(page, 80, 60), tool).toEqual([128, 128, 128, 255]);
    expect((await layerPixel(page, 120, 60))[3], tool).toBe(0);
  }
});

test('the brush outline follows a zoom made while the pointer rests', async ({ page }) => {
  await setTool(page, 'brush', { size: 40, hardness: 1 });
  await page.mouse.move(...(await page.evaluate(() => window.photoStudio.clientPoint(100, 60))));
  const radius = () => page.locator('#screen-overlay ellipse.brush-cursor').getAttribute('rx');
  const zoom = await page.evaluate(() => window.photoStudio.zoom);
  expect(Number(await radius())).toBeCloseTo(20 * zoom, 3);
  // A pinch or Ctrl+wheel zooms without moving the pointer.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.zoomAt(e.zoom * 2, 300, 300);
  });
  expect(Number(await radius())).toBeCloseTo(40 * zoom, 3);
});

test('Dodge with Protect Tones brightens highlights without clipping or shifting their hue', async ({
  page,
}) => {
  await filledLayer(page, [230, 200, 180, 255]);
  await setTool(
    page,
    'dodge',
    { size: 30, hardness: 1 },
    { toneRange: 'highlights', toneExposure: 50, protectTones: true },
  );
  await canvasClick(page, 100, 60);
  const [r, g, b] = await layerPixel(page, 100, 60);
  // Brighter, but no channel blown out and the color ratios kept.
  expect(g).toBeGreaterThan(205);
  expect(r).toBeLessThan(255);
  expect(Math.abs(r / g - 230 / 200)).toBeLessThan(0.02);
  expect(Math.abs(b / g - 180 / 200)).toBeLessThan(0.02);
});

test('Alt-click loads the Mixer Brush with the paint under it, kept for the next stroke', async ({
  page,
}) => {
  await filledLayer(page, [255, 0, 0, 255]);
  await page.evaluate(() => window.photoStudio.setForeground('#0000ff'));
  // Load and Clean after each stroke stay on (the defaults).
  await setTool(page, 'mixer-brush', { size: 10 }, { mixerSolidOnly: true });
  await canvasClick(page, 100, 60, ['Alt']);
  await expect(page.locator('#mixer-load-menu span').first()).toHaveAttribute(
    'style',
    /background:\s*#ff0000/,
  );
});
