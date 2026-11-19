import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

/** A 320×240 document with two pixel layers showing the same random scene,
 * the top one shifted by (dx, dy). Returns the layer IDs bottom to top. */
async function shiftedLayers(page: Page, dx: number, dy: number) {
  return page.evaluate(
    async ({ dx, dy }) => {
      const draw = (ox: number, oy: number) => {
        const c = new OffscreenCanvas(320, 240);
        const g = c.getContext('2d')!;
        g.fillStyle = '#6a7d95';
        g.fillRect(0, 0, 320, 240);
        let s = 7;
        const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let i = 0; i < 160; i++) {
          g.fillStyle = `rgb(${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},${Math.floor(rand() * 255)})`;
          const x = rand() * 360 - 20 + ox,
            y = rand() * 280 - 20 + oy,
            r = 4 + rand() * 16;
          if (rand() < 0.5) g.fillRect(x - r, y - r * 0.6, 2 * r, 1.2 * r);
          else {
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fill();
          }
        }
        return g.getImageData(0, 0, 320, 240);
      };
      const e = window.photoStudio;
      const { openFile } = await import('/src/features/files/open.ts');
      const base = new OffscreenCanvas(320, 240);
      base.getContext('2d')!.putImageData(draw(0, 0), 0, 0);
      await openFile(e, await base.convertToBlob(), 'scene.png');
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const shifted = draw(dx, dy);
      const top = newPixelLayer('Shifted', e.doc, gridFromImage(e.assets.tiles, { width: 320, height: 240, data: shifted.data }));
      e.command('Add', (d) => d.layers.push(top));
      const ids = e.doc.layers.map((l) => l.id);
      e.selectLayers(ids);
      e.update();
      return ids;
    },
    { dx, dy },
  );
}

test('Auto-Align Layers moves a shifted layer back into register', async ({ page }) => {
  const ids = await shiftedLayers(page, 14, -9);
  await idle(page);
  await run(page, 'edit.auto-align', { params: { projection: 'auto' } });
  expect(await historyLabels(page)).toContain('Auto-Align Layers');
  // The top layer's content now lines up with the bottom layer.
  const diff = await page.evaluate(async (ids) => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const { findLayer } = await import('/src/model/document.ts');
    const a = findLayer(e.doc.layers, ids[0])!,
      b = findLayer(e.doc.layers, ids[1])!;
    const r = { x: 40, y: 40, width: 240, height: 160 };
    const pa = readRGBA(e.assets.tiles, a.pixels!, r).data,
      pb = readRGBA(e.assets.tiles, b.pixels!, r).data;
    let sum = 0,
      n = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (pb[i + 3] < 255) continue;
      sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      n++;
    }
    return { mean: sum / n / 3, covered: n };
  }, ids);
  expect(diff.covered).toBeGreaterThan(30000);
  expect(diff.mean).toBeLessThan(4);
});

test('Auto-Blend Layers adds focus masks to stacked layers', async ({ page }) => {
  await shiftedLayers(page, 0, 0);
  await idle(page);
  await run(page, 'edit.auto-blend', { params: { method: 'stack', seamless: false } });
  expect(await historyLabels(page)).toContain('Auto-Blend Layers');
  const masks = await page.evaluate(async () => {
    const e = window.photoStudio;
    return e.doc.layers.map((l) => !!l.maskGrid);
  });
  expect(masks).toEqual([true, true]);
});

test('Apply Image multiplies a layer into the target with a live preview', async ({ page }) => {
  // A white/gray background and a top layer holding a red square.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(120, 80);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 60, 80);
    g.fillStyle = '#808080';
    g.fillRect(60, 0, 60, 80);
    const { openFile } = await import('/src/features/files/open.ts');
    const e = window.photoStudio;
    await openFile(e, await c.convertToBlob(), 'base.png');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(120 * 80 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const red = newPixelLayer('Red', e.doc, gridFromImage(e.assets.tiles, { width: 120, height: 80, data }));
    red.visible = false;
    e.command('Add', (d) => d.layers.push(red));
    e.selectLayers([e.doc.layers[0].id]);
    e.update();
  });
  await idle(page);
  await start(page, 'image.apply-image');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Apply Image' })).toBeVisible();
  // Source: the red layer, blending Multiply (the default).
  await dialog.locator('fieldset.comp-source select').nth(1).selectOption({ label: 'Red' });
  await expect(dialog.locator('.adj-status')).toHaveText('', { timeout: 30_000 });
  await dialog.locator('button.primary').click();
  await expect(page.locator('dialog.adj-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toContain('Apply Image');
  const px = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers[0];
    const at = (x: number) => Array.from(readRGBA(e.assets.tiles, l.pixels!, { x, y: 40, width: 1, height: 1 }).data);
    return [at(10), at(100)];
  });
  expect(px[0]).toEqual([255, 0, 0, 255]);
  expect(px[1][0]).toBeGreaterThanOrEqual(127);
  expect(px[1][0]).toBeLessThanOrEqual(129);
  expect(px[1][1]).toBe(0);
});

test('Apply Image preserves the transparency of a layer whose transparency is locked', async ({
  page,
}) => {
  // Target: a layer with a red square on transparency and locked transparency;
  // source: an opaque blue layer.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(120, 80);
    const g = c.getContext('2d')!;
    g.fillStyle = '#0000ff';
    g.fillRect(0, 0, 120, 80);
    const { openFile } = await import('/src/features/files/open.ts');
    const e = window.photoStudio;
    await openFile(e, await c.convertToBlob(), 'blue.png');
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    const square = gridFromImage(e.assets.tiles, { width: 40, height: 40, data });
    const red = newPixelLayer('Red', e.doc, square);
    red.protection = { transparency: true, composite: false, position: false };
    red.transparencyProtected = true;
    e.command('Add', (d) => d.layers.push(red));
    e.selectLayers([red.id]);
    e.update();
  });
  await idle(page);
  await start(page, 'image.apply-image');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  const preserve = dialog.getByRole('checkbox', { name: 'Preserve transparency' });
  await expect(preserve).toBeChecked();
  await expect(preserve).toBeDisabled();
  await dialog.locator('fieldset.comp-source select').nth(1).selectOption({ label: 'Background' });
  await expect(dialog.locator('.adj-status')).toHaveText('', { timeout: 30_000 });
  await dialog.locator('button.primary').click();
  await expect(page.locator('dialog.adj-dialog[open]')).toHaveCount(0);
  await idle(page);
  const px = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.doc.layers.at(-1)!;
    const at = (x: number) =>
      Array.from(readRGBA(e.assets.tiles, l.pixels!, { x, y: 20, width: 1, height: 1 }).data);
    return [at(20), at(100)];
  });
  // Inside the square the color changes; outside it stays transparent.
  expect(px[0][3]).toBe(255);
  expect(px[1][3]).toBe(0);
});
