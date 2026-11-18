import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, idle, layerPixel, panel, tool } from './helpers';

// A white layer with a red square at (20..40, 20..40).
async function setup(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const doc = newDocument(300, 200, 'Clone');
    const data = new Uint8ClampedArray(300 * 200 * 4);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 300; x++) data.set(x >= 20 && x < 40 && y >= 20 && y < 40 ? [220, 20, 30, 255] : [255, 255, 255, 255], (y * 300 + x) * 4);
    const layer = newPixelLayer('Photo', doc, gridFromImage(e.assets.tiles, { width: 300, height: 200, data }));
    doc.layers = [layer];
    e.history.reset(doc);
    e.hasDocument = true;
    e.selected = layer.id;
    e.zoom = 2;
    e.pan = { x: 0, y: 0 };
    e.update();
  });
  await idle(page);
  await tool(page, 'Clone Stamp Tool');
  await page.evaluate(async () => {
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('clone-stamp'), { size: 6, hardness: 1, smoothing: 0, opacity: 1, flow: 1 });
  });
}

test('Clone Source panel offset and scale drive the Clone Stamp', async ({ page }) => {
  await boot(page);
  await setup(page);
  await page.evaluate(() => window.photoStudio.runCommand('window.panel.clone-source'));
  const body = await panel(page, 'Clone Source');
  const offsetX = body.getByRole('spinbutton', { name: 'Offset X' });
  await expect(offsetX).toBeDisabled();

  // Alt-click sets source 1 at the red square's center.
  await canvasClick(page, 30, 30, ['Alt']);
  await expect(body.locator('.cs-slot').first()).toHaveClass(/set/);
  await expect(offsetX).toBeEnabled();

  // A typed offset places the clone 100 px right and 50 px down of the source.
  await offsetX.fill('100');
  await offsetX.press('Enter');
  const offsetY = body.getByRole('spinbutton', { name: 'Offset Y' });
  await offsetY.fill('50');
  await offsetY.press('Enter');
  await canvasClick(page, 130, 80);
  expect(await layerPixel(page, 130, 80)).toEqual([220, 20, 30, 255]);
  // The panel keeps showing the offset in use.
  await expect(offsetX).toHaveValue('100');

  // Scaling by 200% (linked) doubles the cloned square around the anchor.
  const width = body.getByRole('spinbutton', { name: 'Width scale' });
  await width.fill('200');
  await width.press('Enter');
  await expect(body.getByRole('spinbutton', { name: 'Height scale' })).toHaveValue('200');
  // (146, 80) reads (38, 30) when scaled (red) but (46, 30) unscaled (white).
  await canvasClick(page, 146, 80);
  expect(await layerPixel(page, 146, 80)).toEqual([220, 20, 30, 255]);
  await canvasClick(page, 170, 80);
  expect(await layerPixel(page, 170, 80)).toEqual([255, 255, 255, 255]);
  const labels = await page.evaluate(() => window.photoStudio.history.labels);
  expect(labels.filter((l) => l === 'Clone Stamp').length).toBe(3);
});

test('Sources are kept per slot and the overlay follows the pointer', async ({ page }) => {
  await boot(page);
  await setup(page);
  await page.evaluate(() => window.photoStudio.runCommand('window.panel.clone-source'));
  const body = await panel(page, 'Clone Source');
  await canvasClick(page, 30, 30, ['Alt']);
  await body.locator('.cs-slot').nth(2).click();
  await canvasClick(page, 250, 150, ['Alt']);
  const points = await page.evaluate(async () => {
    const { cloneState } = await import('/src/features/clone-source/state.ts');
    return cloneState.sources.map((s) => s?.point ?? null);
  });
  expect(points[0]).toEqual([30, 30]);
  expect(points[2]).toEqual([250, 150]);
  await body.getByRole('checkbox', { name: 'Show Overlay' }).check();
  const [cx, cy] = await page.evaluate(() => window.photoStudio.clientPoint(100, 100));
  await page.mouse.move(cx, cy);
  await expect(page.locator('#overlay .clone-overlay image')).toHaveCount(1);
  await idle(page);
});

test('A source set while its document was the only one open clones into another document', async ({
  page,
}) => {
  await boot(page);
  await setup(page);
  expect(await page.evaluate(() => window.photoStudio.sessions.length)).toBe(1);
  await canvasClick(page, 30, 30, ['Alt']);
  // Open a second, white document and clone the red square into it.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument } = await import('/src/model/document.ts');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    await e.switchSession(e.newSession(newDocument(300, 200, 'Target')));
    const data = new Uint8ClampedArray(300 * 200 * 4).fill(255);
    const grid = gridFromImage(e.assets.tiles, { width: 300, height: 200, data });
    const layer = newPixelLayer('White', e.doc, grid);
    e.command('Add White', (d) => d.layers.push(layer));
    e.selected = layer.id;
    e.zoom = 2;
    e.pan = { x: 0, y: 0 };
    e.update();
  });
  await idle(page);
  await canvasClick(page, 150, 100);
  expect(await layerPixel(page, 150, 100)).toEqual([220, 20, 30, 255]);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toContain('Clone Stamp');
});
