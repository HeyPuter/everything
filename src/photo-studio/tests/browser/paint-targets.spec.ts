import { test, expect } from '@playwright/test';
import { boot, canvasDrag, client, idle, openImage, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 120, '#808080', 'gray.png');
});

test('brush strokes stop at the canvas edge', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Paint', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.color = '#ff0000';
  });
  await idle(page);
  await tool(page, 'Brush Tool');
  // A 40 px brush dragged from inside the canvas well past its right edge.
  await page.evaluate(async () => {
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('brush'), { size: 40, hardness: 1, smoothing: 0 });
  });
  await canvasDrag(page, [[150, 60], [260, 60]]);
  const result = await page.evaluate(() => {
    const e = window.photoStudio;
    const l = e.doc.layers.at(-1)!;
    return { bounds: l.pixels!.bounds, x: l.pixels!.x, keys: Object.keys(l.pixels!.tiles) };
  });
  expect(result.bounds).not.toBeNull();
  // Paint reaches the edge but no pixels are stored beyond it.
  expect(result.x + result.bounds!.x + result.bounds!.width).toBe(200);
  expect(result.bounds!.y).toBeGreaterThanOrEqual(0);
  expect(result.keys).toEqual(['0,0']);
});

test('painting cannot edit the mask of a locked adjustment layer', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const l = layer('adjustment', 'Invert', e.doc.width, e.doc.height);
    l.adjustment = { kind: 'invert', params: {} };
    l.locked = true;
    e.command('Add adjustment', (d) => d.layers.push(l));
    e.selected = l.id;
  });
  await idle(page);
  await tool(page, 'Brush Tool');
  await canvasDrag(page, [[50, 60], [120, 60]]);
  expect(await page.evaluate(() => !!window.photoStudio.doc.layers.at(-1)!.maskGrid)).toBe(false);
  await expect(page.locator('#status')).toHaveText('Unlock this layer to edit its mask.');
});

test('the Art History Brush keeps locked transparency and stays on the canvas', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    // Opaque blue on the left half of the canvas only.
    const data = new Uint8ClampedArray(100 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([0, 0, 255, 255], i);
    const l = newPixelLayer('Half', e.doc, gridFromImage(e.assets.tiles, { width: 100, height: 120, data }));
    l.protection = { transparency: true, composite: false, position: false };
    e.command('New Layer', (d) => d.layers.push(l));
    // The brush paints from the oldest history state, which must hold the layer.
    e.history.reset(e.doc);
    e.selected = l.id;
  });
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    Object.assign(e.settings, { artArea: 200, artStyle: 'dab' });
    e.setTool('art-history');
  });
  await canvasDrag(page, [[90, 60], [190, 60]]);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers.at(-1)!;
    const alphaAt = (x: number, y: number) => readRGBA(e.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[3];
    return { right: [alphaAt(150, 60), alphaAt(190, 20), alphaAt(120, 100)], bounds: l.pixels!.bounds, history: e.history.labels.at(-1) };
  });
  expect(result.history).toBe('Art History Brush');
  expect(result.right).toEqual([0, 0, 0]);
  expect(result.bounds).toEqual({ x: 0, y: 0, width: 100, height: 120 });
});

test('the Pencil paints hard, aliased pixels', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Pencil', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('pencil'), { size: 5, smoothing: 0 });
  });
  await idle(page);
  await tool(page, 'Pencil Tool');
  await canvasDrag(page, [[20.3, 30.7], [140.6, 70.2]]);
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const data = readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 0, y: 0, width: 200, height: 120 }).data;
    return [...new Set(data.filter((_, i) => i % 4 === 3))].sort((a, b) => a - b);
  });
  expect(alpha).toEqual([0, 255]);
});

test('the airbrush builds up paint while the pointer rests', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Air', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.setForeground('#000000');
    e.setTool('brush');
    e.activeTool!.brush!.set(e, { size: 20, hardness: 1, flow: 0.1, airbrush: true, smoothing: 0 });
  });
  await idle(page);
  const at = await client(page, 100, 60);
  await page.mouse.move(...at);
  await page.mouse.down();
  // A single dab at 10% flow is alpha 26; resting adds a dab every 50 ms.
  await page.waitForTimeout(600);
  await page.mouse.up();
  await idle(page);
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    return readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 100, y: 60, width: 1, height: 1 }).data[3];
  });
  expect(alpha).toBeGreaterThan(60);
});

test('a light pen stroke with smoothing ends at the pen’s pressure', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Pen', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.setForeground('#000000');
    e.setTool('brush');
    e.activeTool!.brush!.set(e, { size: 40, hardness: 1, flow: 1, smoothing: 0.6, dynamics: { pressureSize: true } });
  });
  await idle(page);
  const cdp = await page.context().newCDPSession(page);
  const pen = (type: string, x: number, y: number, force: number) =>
    cdp.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x, y, button: force || type !== 'mouseMoved' ? 'left' : 'none', buttons: force ? 1 : 0, clickCount: 1, pointerType: 'pen', force });
  const [x0, y] = await client(page, 20, 60),
    [x1] = await client(page, 160, 60);
  await pen('mouseMoved', x0, y, 0);
  await pen('mousePressed', x0, y, 0.2);
  for (let i = 1; i <= 30; i++) await pen('mouseMoved', x0 + ((x1 - x0) * i) / 30, y, 0.2);
  await pen('mouseReleased', x1, y, 0);
  await idle(page);
  // Painted height of the stroke at several columns.
  const heights = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const d = readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 0, y: 0, width: 200, height: 120 }).data;
    return [80, 150, 158].map((x) => {
      let n = 0;
      for (let y = 0; y < 120; y++) if (d[(y * 200 + x) * 4 + 3] > 128) n++;
      return n;
    });
  });
  expect(heights[0]).toBe(8);
  expect(heights[1]).toBe(8);
  expect(heights[2]).toBeLessThanOrEqual(8);
});

test('Escape cancels a Quick Mask stroke and its preview', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.setTool('brush');
    e.activeTool!.brush!.set(e, { size: 20, smoothing: 0 });
    e.setForeground('#ffffff');
  });
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (err) => errors.push(err.message));
  await page.mouse.move(...(await client(page, 40, 60)));
  await page.mouse.down();
  await page.mouse.move(...(await client(page, 150, 60)), { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await idle(page);
  const state = await page.evaluate(() => {
    const e = window.photoStudio;
    e.overlay();
    return { preview: 'quickMaskPreview' in e.settings, tiles: Object.keys((e.settings.quickMask as { tiles: object }).tiles).length };
  });
  expect(state).toEqual({ preview: false, tiles: 0 });
  expect(errors).toEqual([]);
});

test('the Smudge tool drags color along the stroke', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    // Red on the left half, white on the right.
    const data = new Uint8ClampedArray(200 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) data.set((i / 4) % 200 < 100 ? [220, 30, 30, 255] : [255, 255, 255, 255], i);
    const l = newPixelLayer('Smudge', e.doc, gridFromImage(e.assets.tiles, { width: 200, height: 120, data }));
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.settings.smudgeStrength = 100;
    e.setTool('smudge-tool');
    e.activeTool!.brush!.set(e, { size: 20, hardness: 0.8, smoothing: 0 });
  });
  await idle(page);
  await canvasDrag(page, [[90, 60], [170, 60]], 20);
  const green = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const row = readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 0, y: 60, width: 200, height: 1 }).data;
    return [120, 160, 190].map((x) => row[x * 4 + 1]);
  });
  // Red reaches the end of the stroke; beyond it the white is untouched.
  expect(green).toEqual([30, 30, 255]);
});

test('painting refuses a layer inside a hidden group', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const inner = newPixelLayer('Inner', e.doc);
    const group = layer('group', 'Hidden Group', e.doc.width, e.doc.height);
    group.visible = false;
    group.children = [inner];
    e.command('New Group', (d) => d.layers.push(group));
    e.selected = inner.id;
  });
  await idle(page);
  const before = await page.evaluate(() => window.photoStudio.history.labels.length);
  await tool(page, 'Brush Tool');
  await canvasDrag(page, [[50, 60], [120, 60]]);
  await expect(page.locator('#status')).toHaveText('The target layer is in a hidden group. Show the group to paint on it.');
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(before);
});

test('Quick Mask stays with the document it was turned on in', async ({ page }) => {
  // beforeEach opened gray.png; open a second document and turn Quick Mask on there.
  await openImage(page, 300, 100, '#404040', 'second.png');
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  const show = (name: string) =>
    page.evaluate(async (name) => {
      const e = window.photoStudio;
      const s = e.sessions.find((x) => x.doc.name === name)!;
      await e.showView(e.viewsOf(s).at(-1)!);
    }, name);
  const state = () =>
    page.evaluate(() => ({
      doc: window.photoStudio.doc.name,
      quickMask: !!window.photoStudio.settings.quickMask,
      pressed: document.querySelector('.quick-mask-button')!.getAttribute('aria-pressed'),
    }));
  await show('gray');
  await idle(page);
  expect(await state()).toEqual({ doc: 'gray', quickMask: false, pressed: 'false' });
  await show('second');
  await idle(page);
  expect(await state()).toEqual({ doc: 'second', quickMask: true, pressed: 'true' });
  // Leaving it in the second document never turns the first into a selection.
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await show('gray');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels.includes('Quick Mask'))).toBe(false);
});
