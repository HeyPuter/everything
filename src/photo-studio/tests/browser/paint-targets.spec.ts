import { test, expect } from '@playwright/test';
import { boot, canvasDrag, client, idle, openImage, panel, redo, tool, undo } from './helpers';

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

test('Quick Mask strokes, entering and leaving are undoable steps', async ({ page }) => {
  // A layer edit before Quick Mask must survive undoing the mask strokes.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Kept', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
  });
  await idle(page);
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.activeTool!.brush!.set(e, { size: 20, smoothing: 0 });
    e.setForeground('#ffffff');
  });
  await canvasDrag(page, [[40, 60], [150, 60]]);
  const state = () =>
    page.evaluate(() => {
      const e = window.photoStudio;
      const q = e.settings.quickMask as { tiles: object } | undefined;
      return {
        last: e.history.labels.slice(-3),
        quick: q ? Object.keys(q.tiles).length : -1,
        pressed: document.querySelector('.quick-mask-button')!.getAttribute('aria-pressed'),
        layers: e.doc.layers.length,
      };
    });
  const painted = await state();
  expect(painted).toEqual({ last: ['New Layer', 'Edit in Quick Mask Mode', 'Brush Tool'], quick: 1, pressed: 'true', layers: 2 });
  await undo(page);
  expect(await state()).toMatchObject({ quick: 0, pressed: 'true', layers: 2 });
  await redo(page);
  expect(await state()).toEqual(painted);
  await undo(page);
  await undo(page);
  expect(await state()).toMatchObject({ quick: -1, pressed: 'false', layers: 2 });
  await redo(page);
  await redo(page);
  expect(await state()).toEqual(painted);
  // Leaving makes the selection; undoing it returns to the painted mask.
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  const left = await page.evaluate(() => ({ sel: window.photoStudio.doc.selection, last: window.photoStudio.history.labels.at(-1) }));
  expect(left.last).toBe('Quick Mask');
  expect(left.sel!.x).toBeLessThanOrEqual(40);
  await undo(page);
  expect(await state()).toEqual(painted);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toBeNull();
  // The History panel lists the steps.
  const history = await panel(page, 'History');
  await expect(history).toContainText('Edit in Quick Mask Mode');
  await expect(history).toContainText('Brush Tool');
});

for (const id of ['brush', 'healing-brush', 'spot-healing', 'quick-mask']) {
  test(`switching documents mid-stroke keeps the ${id} stroke in its own document`, async ({ page }) => {
    // beforeEach opened gray.png; open a second document.
    await openImage(page, 200, 120, '#404040', 'second.png');
    const show = (name: string) =>
      page.evaluate(async (name) => {
        const e = window.photoStudio;
        const s = e.sessions.find((x) => x.doc.name === name)!;
        await e.showView(e.viewsOf(s).at(-1)!);
      }, name);
    await show('gray');
    await idle(page);
    // A red bar under the stroke gives the healing tools something to change.
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { writeRect } = await import('/src/model/tiles.ts');
      const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
      const data = new Uint8ClampedArray(120 * 20 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([230, 20, 20, 255], i);
      const l = e.doc.layers[0];
      const grid = writeRect(e.assets.tiles, l.pixels!, 40, 50, { width: 120, height: 20, data });
      e.command('Red Bar', (d) => setLayerPixels(d.layers[0], grid, d));
    });
    await idle(page);
    const tool = id === 'quick-mask' ? 'brush' : id;
    await page.evaluate(async ({ id, tool }) => {
      const e = window.photoStudio;
      if (id === 'quick-mask') await e.runCommand('select.quick-mask');
      e.setTool(tool);
      e.activeTool!.brush?.set(e, { size: 20, smoothing: 0 });
      e.setForeground('#ffffff');
    }, { id, tool });
    await idle(page);
    if (id === 'healing-brush') {
      const src = await client(page, 20, 20);
      await page.keyboard.down('Alt');
      await page.mouse.click(...src);
      await page.keyboard.up('Alt');
      await idle(page);
    }
    const before = await page.evaluate(() => window.photoStudio.sessions.map((s) => s.history.labels.length));
    await page.mouse.move(...(await client(page, 40, 60)));
    await page.mouse.down();
    await page.mouse.move(...(await client(page, 100, 60)), { steps: 5 });
    // A second pointer (or a script) shows the other document mid-stroke.
    await show('second');
    await page.mouse.move(...(await client(page, 160, 60)), { steps: 5 });
    await page.mouse.up();
    await idle(page);
    const after = await page.evaluate(() =>
      window.photoStudio.sessions.map((s) => ({ name: s.doc.name, steps: s.history.labels.length, quick: !!s.doc.quickMask })),
    );
    // The stroke is one step in the first document; the second is untouched.
    expect(after[0]).toMatchObject({ name: 'gray', steps: before[0] + 1, quick: id === 'quick-mask' });
    expect(after[1]).toMatchObject({ name: 'second', steps: before[1], quick: false });
  });
}

test('the Blur tool builds up while scrubbing within one stroke', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    // Dark on the left half, light on the right.
    const data = new Uint8ClampedArray(200 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) data.set((i / 4) % 200 < 100 ? [20, 20, 20, 255] : [235, 235, 235, 255], i);
    const l = newPixelLayer('Edge', e.doc, gridFromImage(e.assets.tiles, { width: 200, height: 120, data }));
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.settings.blurStrength = 50;
    e.setTool('blur-tool');
    e.activeTool!.brush!.set(e, { size: 30, hardness: 0.8, smoothing: 0 });
  });
  await idle(page);
  const edge = () =>
    page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const d = readRGBA(e.assets.tiles, e.doc.layers.at(-1)!.pixels!, { x: 99, y: 60, width: 2, height: 1 }).data;
      return d[4] - d[0];
    });
  await canvasDrag(page, [[100, 30], [100, 90]], 20);
  const once = await edge();
  await undo(page);
  await canvasDrag(page, [[100, 30], [100, 90], [100, 30], [100, 90], [100, 30], [100, 90]], 20);
  const scrubbed = await edge();
  expect(once).toBeLessThan(215);
  expect(scrubbed).toBeLessThan(once - 30);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Blur Tool');
});

test('the Paint Bucket fills the Quick Mask beyond the selection it started from', async ({
  page,
}) => {
  // A selection of the left quarter becomes the Quick Mask.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { filledMask } = await import('/src/model/tiles.ts');
    const { commitSelectionMask } = await import('/src/features/selection.ts');
    const rect = { x: 0, y: 0, width: 50, height: 120 };
    commitSelectionMask(e, filledMask(e.assets.tiles, rect), 'replace', 'Select');
  });
  await idle(page);
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await tool(page, 'Paint Bucket Tool');
  await page.evaluate(() => window.photoStudio.setForeground('#ffffff'));
  // The gray image is one region: white fills the whole mask.
  const [cx, cy] = await client(page, 150, 60);
  await page.mouse.click(cx, cy);
  await idle(page);
  const value = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const q = e.doc.quickMask!;
    return readMask(e.assets.tiles, q, { x: 150, y: 60, width: 1, height: 1 }).data[0];
  });
  expect(value).toBe(255);
});

test('Invert in Quick Mask inverts the whole mask, not only the selection it started from', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { filledMask } = await import('/src/model/tiles.ts');
    const { commitSelectionMask } = await import('/src/features/selection.ts');
    const rect = { x: 0, y: 0, width: 50, height: 120 };
    commitSelectionMask(e, filledMask(e.assets.tiles, rect), 'replace', 'Select');
  });
  await idle(page);
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await page.evaluate(() => window.photoStudio.runCommand('adjust.invert'));
  await idle(page);
  const values = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const q = e.doc.quickMask!;
    const at = (x: number) =>
      readMask(e.assets.tiles, q, { x, y: 60, width: 1, height: 1 }).data[0];
    return [at(20), at(150)];
  });
  expect(values).toEqual([0, 255]);
});

test('Quick Mask hides the selection outline it was made from until it is left', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { filledMask } = await import('/src/model/tiles.ts');
    const { commitSelectionMask } = await import('/src/features/selection.ts');
    const rect = { x: 0, y: 0, width: 50, height: 120 };
    commitSelectionMask(e, filledMask(e.assets.tiles, rect), 'replace', 'Select');
  });
  await idle(page);
  const ants = page.locator('#overlay .marching.committed');
  await expect(ants).toHaveCount(1);
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  // The red film shows the selection; outlines of the old selection would go stale.
  await expect(ants).toHaveCount(0);
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await expect(ants).toHaveCount(1);
});

test('Shift-click draws a line only from a stroke in the same document', async ({ page }) => {
  // beforeEach opened gray.png: paint a dot near its top-left corner.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.setTool('brush');
    e.activeTool!.brush?.set(e, { size: 10, hardness: 1, smoothing: 0 });
    e.setForeground('#ffffff');
  });
  await idle(page);
  await canvasDrag(page, [[20, 20], [21, 20]]);
  await openImage(page, 200, 120, '#404040', 'second.png');
  // Shift-click in the second document has no earlier stroke to continue.
  const [cx, cy] = await client(page, 180, 100);
  await page.keyboard.down('Shift');
  await page.mouse.click(cx, cy);
  await page.keyboard.up('Shift');
  await idle(page);
  const pixel = (x: number, y: number) =>
    page.evaluate(
      async ([x, y]) => {
        const e = window.photoStudio;
        const { readRGBA } = await import('/src/model/tiles.ts');
        const g = e.doc.layers[0].pixels!;
        return Array.from(readRGBA(e.assets.tiles, g, { x, y, width: 1, height: 1 }).data);
      },
      [x, y] as const,
    );
  expect(await pixel(180, 100)).toEqual([255, 255, 255, 255]);
  // Halfway along a line from the first document's dot stays unpainted.
  expect(await pixel(100, 60)).toEqual([64, 64, 64, 255]);
});

test('a stroke whose pointer capture is lost is stored and ends the gesture', async ({ page }) => {
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.setTool('brush');
    e.activeTool!.brush!.set(e, { size: 20, hardness: 1, smoothing: 0 });
    e.setForeground('#ffffff');
  });
  await idle(page);
  const before = await page.evaluate(() => window.photoStudio.history.labels.length);
  await page.mouse.move(...(await client(page, 40, 60)));
  await page.mouse.down();
  await page.mouse.move(...(await client(page, 120, 60)), { steps: 5 });
  // The browser takes the capture away without a pointerup (the press may
  // never be released over the canvas).
  await page.evaluate(() => {
    const v = window.photoStudio.el('#viewport');
    const init = { pointerId: 1, pointerType: 'mouse', bubbles: true };
    v.dispatchEvent(new PointerEvent('lostpointercapture', init));
  });
  await page.waitForFunction(() => !window.photoStudio.toolBusy);
  await idle(page);
  const after = await page.evaluate(() => window.photoStudio.history.labels);
  expect(after.length).toBe(before + 1);
  expect(after.at(-1)).toBe('Brush Tool');
  await page.mouse.up();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(before + 1);
});

test('a stroke started while another is unfinished stores the first and stops its airbrush', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Air', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.setTool('brush');
    e.activeTool!.brush!.set(e, { size: 10, hardness: 1, airbrush: true, smoothing: 0 });
    // Track running intervals (the airbrush ticks every 50 ms).
    const live = new Set<number>();
    const set = window.setInterval.bind(window),
      clear = window.clearInterval.bind(window);
    (window as unknown as { liveTimers: Set<number> }).liveTimers = live;
    window.setInterval = ((f: () => void, ms?: number) => {
      const id = set(f, ms);
      if (ms === 50) live.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      live.delete(id!);
      clear(id);
    }) as typeof window.clearInterval;
  });
  await idle(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { canvasPoint } = await import('/src/app/pointer.ts');
    const at = (x: number, y: number) => {
      const [cx, cy] = e.clientPoint(x, y);
      const init = { clientX: cx, clientY: cy, pointerType: 'pen', pressure: 1 };
      return canvasPoint(e, new PointerEvent('pointerdown', init));
    };
    const t = e.activeTool!;
    // The first stroke's release never arrives (a second pointer took over).
    await t.pointerDown!(e, at(30, 30));
    await t.pointerDown!(e, at(150, 90));
    await t.pointerUp!(e, at(150, 90));
  });
  await idle(page);
  const state = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const g = e.doc.layers.at(-1)!.pixels!;
    const alpha = (x: number, y: number) =>
      readRGBA(e.assets.tiles, g, { x, y, width: 1, height: 1 }).data[3];
    return {
      strokes: e.history.labels.filter((l) => l === 'Brush Tool').length,
      first: alpha(30, 30),
      second: alpha(150, 90),
      timers: (window as unknown as { liveTimers: Set<number> }).liveTimers.size,
    };
  });
  expect(state).toEqual({ strokes: 2, first: 255, second: 255, timers: 0 });
});

test('Magic Wand, Grow and the Paint Bucket finish in the document they started in', async ({
  page,
}) => {
  // beforeEach opened gray.png (200 × 120); a second, larger document is opened later.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.settings.sampleAllLayers = true;
    // Hold the merged-image readback until the test lets it go.
    const r = e.renderer as unknown as { documentPixels: (...a: unknown[]) => Promise<unknown> };
    const original = r.documentPixels.bind(r);
    const w = window as unknown as { hold?: boolean; release?: () => void };
    r.documentPixels = async (...a: unknown[]) => {
      const result = await original(...a);
      if (w.hold) await new Promise<void>((done) => (w.release = done));
      return result;
    };
  });
  const gray = await page.evaluate(() => window.photoStudio.session.id);
  const second = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    // Its layer has the same id as gray.png's (as a duplicated image's would).
    const doc = newDocument(320, 240, 'Second');
    const layer = newPixelLayer('Copy', doc);
    layer.id = e.doc.layers[0].id;
    doc.layers = [layer];
    const s = e.newSession(doc);
    return s.id;
  });
  const show = (id: string) =>
    page.evaluate(async (id) => {
      const e = window.photoStudio;
      await e.switchSession(e.sessions.find((s) => s.id === id)!);
    }, id);
  const state = () =>
    page.evaluate(() =>
      window.photoStudio.sessions.map((s) => ({
        name: s.doc.name,
        steps: s.history.labels,
        sel: s.doc.selection,
      })),
    );
  const during = async (start: () => Promise<unknown>) => {
    await show(gray);
    await idle(page);
    await page.evaluate(() => ((window as unknown as { hold?: boolean }).hold = true));
    await start();
    await page.waitForFunction(() => !!(window as unknown as { release?: () => void }).release);
    await show(second);
    await page.evaluate(() => {
      const w = window as unknown as { hold?: boolean; release?: () => void };
      const go = w.release!;
      w.hold = false;
      w.release = undefined;
      go();
    });
    await page.waitForFunction(() => !window.photoStudio.toolBusy && !window.photoStudio.busy);
    await idle(page);
  };
  // The wand click lands on gray.png while its merged image is read.
  await page.evaluate(() => window.photoStudio.setTool('magic-wand'));
  await during(async () => {
    const [cx, cy] = await client(page, 100, 60);
    await page.mouse.click(cx, cy);
  });
  let s = await state();
  expect(s.find((d) => d.name === 'Second')!.steps).toEqual([]);
  expect(s.find((d) => d.name === 'gray')!.sel).toEqual({ x: 0, y: 0, width: 200, height: 120 });
  await during(() => page.evaluate(() => void window.photoStudio.runCommand('select.grow')));
  s = await state();
  expect(s.find((d) => d.name === 'Second')!.steps).toEqual([]);
  expect(s.find((d) => d.name === 'gray')!.steps.at(-1)).toBe('Grow');
  // The Paint Bucket does not fill the document shown when the fill is ready.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.setTool('bucket');
    e.setForeground('#ff0000');
  });
  await during(async () => {
    const [cx, cy] = await client(page, 100, 60);
    await page.mouse.click(cx, cy);
  });
  s = await state();
  expect(s.find((d) => d.name === 'Second')!.steps).toEqual([]);
  // Its fill computed for gray.png never reaches the same-id layer of the other image.
  expect(await page.locator('#status').textContent()).not.toMatch(/Missing pixel tile/);
});

test('a filter in Quick Mask edits the whole mask, not only the selection it started from', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { filledMask } = await import('/src/model/tiles.ts');
    const { commitSelectionMask } = await import('/src/features/selection.ts');
    const rect = { x: 0, y: 0, width: 50, height: 120 };
    commitSelectionMask(e, filledMask(e.assets.tiles, rect), 'replace', 'Select');
  });
  await idle(page);
  await page.evaluate(() => window.photoStudio.runCommand('select.quick-mask'));
  await idle(page);
  await page.evaluate(() =>
    window.photoStudio.runCommand('filter.apply.gaussian-blur', { params: { radius: 4 } }),
  );
  await idle(page);
  // The blur softens the mask edge on both sides of x = 50.
  const right = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const at = { x: 52, y: 60, width: 1, height: 1 };
    return readMask(e.assets.tiles, e.doc.quickMask!, at).data[0];
  });
  expect(right).toBeGreaterThan(20);
});
