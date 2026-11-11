import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

// A lost WebGL context or WebGPU device is re-created and the document drawn
// again from its tiles, without reloading the page.

const pixels = (page: Page) => page.evaluate(async () => Array.from(await window.photoStudio.renderer.documentPixels(window.photoStudio.doc, window.photoStudio.assets)));
const at = (px: number[], width: number, x: number, y: number) => px.slice((y * width + x) * 4, (y * width + x) * 4 + 4);
/** Paint a red square on a new layer so the frame has GPU sources. */
async function paintSquare(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    const l = layer('pixel', 'Square', e.doc.width, e.doc.height);
    const data = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 400; i++) data.set([255, 0, 0, 255], i * 4);
    setLayerPixels(l, gridFromImage(e.assets.tiles, { width: 20, height: 20, data }, 10, 10), e.doc);
    e.command('Square', (d) => void d.layers.push(l));
  });
  await idle(page);
}
const toast = (page: Page) => page.evaluate(() => (document.querySelector('#toast') as HTMLElement).hidden ? '' : document.querySelector('#toast')!.textContent);

test('WebGL: the compositor comes back after the context is lost and restored', async ({ page }) => {
  await boot(page, 'WebGL');
  await openImage(page, 64, 48, '#336699', 'gpu.png');
  await paintSquare(page);
  const before = await pixels(page);
  expect(at(before, 64, 15, 15)).toEqual([255, 0, 0, 255]);
  await page.evaluate(async () => {
    const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
    const ext = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    (window as unknown as { loseExt: WEBGL_lose_context }).loseExt = ext;
    const lost = new Promise((r) => canvas.addEventListener('webglcontextlost', r, { once: true }));
    ext.loseContext();
    await lost;
  });
  await page.evaluate(async () => {
    const canvas = document.querySelector('#canvas') as HTMLCanvasElement;
    const restored = new Promise((r) => canvas.addEventListener('webglcontextrestored', r, { once: true }));
    (window as unknown as { loseExt: WEBGL_lose_context }).loseExt.restoreContext();
    await restored;
  });
  await page.waitForFunction(() => !window.photoStudio.renderer.recovering);
  await idle(page);
  expect(await pixels(page)).toEqual(before);
  // Later edits draw as usual.
  await page.evaluate(() => window.photoStudio.command('Hide', (d) => void (d.layers[1].visible = false)));
  await idle(page);
  expect(at(await pixels(page), 64, 15, 15)).toEqual([0x33, 0x66, 0x99, 255]);
  expect(await toast(page)).not.toMatch(/reload/i);
});

test('WebGPU: the compositor comes back after the device is lost', async ({ page }) => {
  await boot(page, 'WebGPU');
  await openImage(page, 64, 48, '#336699', 'gpu.png');
  await paintSquare(page);
  const before = await pixels(page);
  const device = await page.evaluate(async () => {
    const backend = window.photoStudio.renderer.backend as unknown as { device: GPUDevice };
    const old = backend.device;
    old.destroy();
    await old.lost;
    return true;
  });
  expect(device).toBe(true);
  await page.waitForFunction(() => (window.photoStudio.renderer.backend as unknown as { device: GPUDevice }).device !== undefined && !window.photoStudio.renderer.recovering);
  await idle(page);
  expect(await pixels(page)).toEqual(before);
  await page.evaluate(() => window.photoStudio.command('Hide', (d) => void (d.layers[1].visible = false)));
  await idle(page);
  expect(at(await pixels(page), 64, 15, 15)).toEqual([0x33, 0x66, 0x99, 255]);
  expect(await toast(page)).not.toMatch(/reload/i);
});

test('WebGPU: says so when the device cannot be re-created', async ({ page }) => {
  await boot(page, 'WebGPU');
  await openImage(page, 64, 48, '#336699', 'gpu.png');
  await page.evaluate(async () => {
    Object.defineProperty(navigator.gpu, 'requestAdapter', { value: async () => null });
    const backend = window.photoStudio.renderer.backend as unknown as { device: GPUDevice };
    backend.device.destroy();
    await backend.device.lost;
  });
  await expect(page.locator('#toast')).toHaveText(/Save your project and reload/, { timeout: 15_000 });
  expect(await page.evaluate(() => !!window.photoStudio.renderer.recovering)).toBe(false);
});
