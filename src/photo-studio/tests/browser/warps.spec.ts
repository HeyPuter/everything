import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, compositePixel, historyLabels, idle, layerPixel, openFiles, panel, redo, run, tool, undo } from './helpers';

/** Open a 400 x 300 picture: dark vertical stripes every 40 px on light grey,
 * with a red square in the middle. */
async function openStripes(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(400, 300);
    const g = c.getContext('2d')!;
    g.fillStyle = '#d0d0d0';
    g.fillRect(0, 0, 400, 300);
    g.fillStyle = '#202020';
    for (let x = 0; x < 400; x += 40) g.fillRect(x, 0, 6, 300);
    g.fillStyle = '#c03020';
    g.fillRect(170, 120, 60, 60);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'stripes.png');
  });
  await idle(page);
}
const modal = (page: Page) => page.evaluate(() => (window.photoStudio.modal as unknown as Record<string, unknown> | undefined)?.constructor?.name ?? null);
const option = (page: Page, name: string) => page.locator('#tool-options').getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openStripes(page);
});

test('Pin Warp adds pins, bends the layer as one undo step and cancels cleanly', async ({ page }) => {
  await run(page, 'edit.pin-warp');
  await expect(page.locator('#tool-options')).toContainText('Pin Warp');
  await expect(page.locator('.pw-mesh')).toHaveCount(1);
  // Three pins: two hold the left and right, the middle one is dragged down.
  await canvasClick(page, 60, 150);
  await canvasClick(page, 340, 150);
  await canvasClick(page, 200, 150);
  await expect(page.locator('.pw-pin')).toHaveCount(3);
  await canvasDrag(page, [
    [200, 150],
    [200, 210],
  ]);
  // Alt-click deletes a pin; undo inside the session brings it back.
  await canvasClick(page, 60, 150, ['Alt']);
  await expect(page.locator('.pw-pin')).toHaveCount(2);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.locator('.pw-pin')).toHaveCount(3);
  // Escape leaves the layer untouched.
  const before = await layerPixel(page, 200, 160);
  await page.keyboard.press('Escape');
  await idle(page);
  expect(await modal(page)).toBeNull();
  expect(await historyLabels(page)).not.toContain('Pin Warp');
  expect(await layerPixel(page, 200, 160)).toEqual(before);

  await run(page, 'edit.pin-warp');
  await canvasClick(page, 60, 150);
  await canvasClick(page, 340, 150);
  await canvasClick(page, 200, 150);
  await canvasDrag(page, [
    [200, 150],
    [200, 210],
  ]);
  await option(page, 'Commit Pin Warp').click();
  await idle(page);
  expect(await modal(page)).toBeNull();
  expect((await historyLabels(page)).at(-1)).toBe('Pin Warp');
  // The red square moved down with the dragged pin.
  expect((await layerPixel(page, 200, 200))[0]).toBeGreaterThan(150);
  expect((await layerPixel(page, 200, 200))[1]).toBeLessThan(100);
  await undo(page);
  expect(await layerPixel(page, 200, 150)).toEqual([192, 48, 32, 255]);
});

/** A 120 x 160 picture: a vertical bar, red at the top and blue at the bottom. */
async function barCanvas(page: Page) {
  return page.evaluateHandle(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 160;
    const g = c.getContext('2d')!;
    g.fillStyle = '#d02020';
    g.fillRect(40, 0, 40, 80);
    g.fillStyle = '#2040d0';
    g.fillRect(40, 80, 40, 80);
    return c;
  });
}
/** Place a file through File > Place Embedded and the file picker. */
async function place(page: Page, name: string, mimeType: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  void page.evaluate(() => window.photoStudio.runCommand('file.place-embedded'));
  await (await chooser).setFiles({ name, mimeType, buffer });
  await page.waitForFunction((n) => window.photoStudio.layer?.name === n && !window.photoStudio.busy, name.replace(/\.[^.]+$/, ''));
  await idle(page);
}
const pinState = (page: Page) =>
  page.evaluate(() => {
    const e = window.photoStudio,
      l = e.layer!;
    return { kind: l.kind, contents: l.embed?.contents, pins: l.embed?.frame?.pins?.pins.length ?? 0, source: l.embed?.frame?.source, composite: l.embed ? e.doc.embeds?.[l.embed.contents]?.composite : undefined };
  });
async function pinBar(page: Page) {
  await run(page, 'edit.pin-warp');
  await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { ready?: boolean })?.ready);
  // The bar is centred on the 400 x 300 canvas: x 180..220, y 70..230.
  await canvasClick(page, 200, 90);
  await canvasClick(page, 200, 210);
  await canvasDrag(page, [
    [200, 210],
    [260, 200],
  ]);
  await page.keyboard.press('Enter');
  await idle(page);
}

test('Pin Warp keeps placed embedded objects editable through edits, history, saving and duplicates', async ({ page }) => {
  const png = Buffer.from(await (await barCanvas(page)).evaluate((c) => c.toDataURL('image/png').split(',')[1]), 'base64');
  await place(page, 'bar.png', 'image/png', png);
  expect((await pinState(page)).kind).toBe('image');
  await pinBar(page);
  let s = await pinState(page);
  expect(s).toMatchObject({ kind: 'image', pins: 2 });
  expect(s.source).toBe(s.composite);
  expect((await historyLabels(page)).at(-1)).toBe('Pin Warp');
  // The blue end swung to the right; the Layers and Properties panels say so.
  expect((await compositePixel(page, 250, 200)).slice(0, 3)).toEqual([32, 64, 208]);
  await expect(page.locator('#layers .layer-row.selected')).toContainText('pin warped');
  await panel(page, 'Properties');
  await expect(page.locator('.embed-properties')).toContainText('Pin warped, 2 pins');

  // Opening it again restores the pins; closing unchanged adds no step.
  await run(page, 'edit.pin-warp');
  await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { ready?: boolean })?.ready);
  await expect(page.locator('.pw-pin')).toHaveCount(2);
  await page.keyboard.press('Enter');
  await idle(page);
  expect((await historyLabels(page)).filter((l) => l === 'Pin Warp')).toHaveLength(1);

  // Undo and redo.
  await undo(page);
  expect((await pinState(page)).pins).toBe(0);
  expect((await compositePixel(page, 250, 200))[3]).toBe(255);
  expect((await compositePixel(page, 200, 200)).slice(0, 3)).toEqual([32, 64, 208]);
  await redo(page);
  expect((await pinState(page)).pins).toBe(2);

  // Edit Contents: invert the content, save; the warp re-renders over it.
  await run(page, 'layer.embed-edit');
  await run(page, 'adjust.invert');
  await page.locator('#viewport').focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions[0].history.labels.at(-1))).toBe('Edit Contents');
  await run(page, 'file.close');
  await expect.poll(async () => (await pinState(page)).source === (await pinState(page)).composite).toBe(true);
  await idle(page);
  s = await pinState(page);
  expect(s.pins).toBe(2);
  expect((await compositePixel(page, 250, 200)).slice(0, 3)).toEqual([223, 191, 47]);

  // Duplicate shares the contents and the pins come along.
  await run(page, 'layer.duplicate');
  const dup = await pinState(page);
  expect(dup.contents).toBe(s.contents);
  expect(dup.pins).toBe(2);

  // Save as .photo and open it again.
  const bytes = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize } = await import('/src/model/serialization.ts');
    return Array.from(new Uint8Array(await (await serialize(e.doc, e.assets)).arrayBuffer()));
  });
  await openFiles(page, { name: 'warped.photo', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  const reopened = await page.evaluate(() => window.photoStudio.doc.layers.filter((l) => l.embed?.frame?.pins).map((l) => l.embed!.frame!.pins!.pins.length));
  expect(reopened).toEqual([2, 2]);
  expect((await compositePixel(page, 250, 200)).slice(0, 3)).toEqual([223, 191, 47]);

  // Reset Transform drops the warp.
  await run(page, 'layer.embed-reset');
  expect((await pinState(page)).pins).toBe(0);
});

test('Pin Warp works on a placed PSD, and Perspective Warp keeps embedded objects as frames', async ({ page }) => {
  const psd = await (await barCanvas(page)).evaluate(async (c) => {
    const { writePsd } = await import('/tests/browser/psd-codec.ts');
    return Array.from(new Uint8Array(writePsd({ width: 120, height: 160, canvas: c, children: [{ name: 'Bar', canvas: c }] })));
  });
  await place(page, 'bar.psd', 'image/vnd.adobe.photoshop', Buffer.from(psd));
  expect((await pinState(page)).kind).toBe('image');
  await pinBar(page);
  expect(await pinState(page)).toMatchObject({ kind: 'image', pins: 2 });
  expect((await compositePixel(page, 250, 200)).slice(0, 3)).toEqual([32, 64, 208]);

  // Perspective Warp replaces the pins with a mesh frame, still embedded.
  await run(page, 'edit.perspective-warp');
  await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { ready?: boolean })?.ready);
  await canvasDrag(page, [
    [150, 60],
    [290, 240],
  ]);
  await option(page, 'Warp').click();
  await canvasDrag(page, [
    [290, 60],
    [250, 100],
  ]);
  await option(page, 'Commit Perspective Warp').click();
  await expect.poll(() => historyLabels(page).then((h) => h.at(-1))).toBe('Perspective Warp');
  await idle(page);
  const framed = await page.evaluate(() => {
    const l = window.photoStudio.layer!;
    return { kind: l.kind, mesh: !!l.embed?.frame?.mesh, pins: !!l.embed?.frame?.pins };
  });
  expect(framed).toEqual({ kind: 'image', mesh: true, pins: false });

  // Context Scale asks before rasterizing an embedded object.
  void page.evaluate(() => window.photoStudio.runCommand('edit.context-scale'));
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('Rasterize');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer!.kind)).toBe('image');
});

test('Context Scale narrows the layer while keeping detailed areas', async ({ page }) => {
  await run(page, 'edit.context-scale');
  await expect(page.locator('#tool-options')).toContainText('Context Scale');
  await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { smallOrders?: unknown })?.smallOrders);
  await canvasDrag(page, [
    [400, 150],
    [300, 150],
  ]);
  await expect(page.locator('#cs-w')).toHaveValue('300');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.photoStudio.modal);
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Context Scale');
  const t = await page.evaluate(() => window.photoStudio.layer!.transform);
  expect([t.width, t.height]).toEqual([300, 300]);
  // The red square survives at full width: seams went through the flat grey.
  const reds = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const row = readRGBA(e.assets.tiles, e.layer!.pixels!, { x: 0, y: 150, width: 300, height: 1 }).data;
    let n = 0;
    for (let x = 0; x < 300; x++) if (row[x * 4] > 150 && row[x * 4 + 1] < 100) n++;
    return n;
  });
  expect(reds).toBe(60);
});

test('Perspective Warp lays out planes and moves their corners', async ({ page }) => {
  await run(page, 'edit.perspective-warp');
  await expect(option(page, 'Warp')).toBeDisabled();
  await canvasDrag(page, [
    [100, 50],
    [300, 250],
  ]);
  await expect(page.locator('.pp-plane')).toHaveCount(1);
  await option(page, 'Warp').click();
  await canvasDrag(page, [
    [300, 50],
    [260, 90],
  ]);
  await option(page, 'Commit Perspective Warp').click();
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Perspective Warp');
  // The top-right corner pulled in: the canvas corner is now empty.
  expect((await layerPixel(page, 395, 5))[3]).toBe(0);
});

test('Warps split along a clicked line and merge back', async ({ page }) => {
  await run(page, 'edit.transform-warp');
  await run(page, 'edit.split-warp-vertical');
  await canvasClick(page, 120, 150);
  const size = () => page.evaluate(() => {
    const s = window.photoStudio.modal as unknown as { mesh: { cols: number; rows: number } };
    return [s.mesh.cols, s.mesh.rows];
  });
  expect(await size()).toEqual([7, 4]);
  await run(page, 'edit.remove-warp-split');
  await canvasClick(page, 121, 100);
  expect(await size()).toEqual([4, 4]);
});

test('Pin Warp on a shape layer rasterizes it only when committed', async ({ page }) => {
  await tool(page, 'Rectangle Tool');
  await canvasDrag(page, [
    [100, 80],
    [300, 220],
  ]);
  const before = await historyLabels(page);
  const kind = () => page.evaluate(() => window.photoStudio.layer!.kind);
  const start = async () => {
    void page.evaluate(() => window.photoStudio.runCommand('edit.pin-warp'));
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Rasterize');
    await dialog.getByRole('button', { name: 'Rasterize' }).click();
    await expect(page.locator('.pw-mesh')).toHaveCount(1);
  };
  // Cancelling gives the shape back, with nothing to redo.
  await start();
  await page.keyboard.press('Escape');
  await idle(page);
  expect(await modal(page)).toBeNull();
  expect(await kind()).toBe('vector');
  expect(await historyLabels(page)).toEqual(before);
  expect(await page.evaluate(() => window.photoStudio.history.canRedo)).toBe(false);
  // Committing is one undo step that rasterizes and bends.
  await start();
  await canvasClick(page, 120, 150);
  await canvasClick(page, 280, 150);
  await canvasDrag(page, [
    [280, 150],
    [280, 190],
  ]);
  await option(page, 'Commit Pin Warp').click();
  await idle(page);
  expect(await historyLabels(page)).toEqual([...before, 'Pin Warp']);
  expect(await kind()).toBe('pixel');
  await undo(page);
  expect(await kind()).toBe('vector');
  expect(await historyLabels(page)).toEqual(before);
});
