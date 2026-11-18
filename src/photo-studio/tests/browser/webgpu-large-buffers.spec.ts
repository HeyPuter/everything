import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

// Uploads and readbacks larger than the device's buffer limit (a 16 MP float
// image is 256 MB) go in bands of rows instead of losing the device. Here the
// limit is lowered to a few rows so a small image takes the banded path.
test('textures upload and read back in bands within the buffer limit', async ({ page }) => {
  await boot(page);
  test.skip(
    (await page.evaluate(() => window.photoStudio.renderer.name)) !== 'WebGPU',
    'WebGPU only',
  );
  await openImage(page, 301, 203, '#4080c0');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const r = e.renderer as unknown as { backend: Record<string, unknown> & { device: GPUDevice } };
    const backend = r.backend as unknown as {
      device: GPUDevice;
      floatTexture(w: number, h: number, d: Float32Array): unknown;
      texture(w: number, h: number, d: Uint8Array): unknown;
      readFloat(t: unknown): Promise<Float32Array>;
      read(t: unknown): Promise<Uint8Array>;
      destroy(t: unknown): void;
    };
    const W = 301,
      H = 203;
    const before = await e.renderer.documentPixels(e.doc, e.assets);
    const device = backend.device;
    const limits = { maxBufferSize: 5120 * 7 };
    // The largest buffer created and texture write made while limited.
    let largest = 0;
    const queue = new Proxy(device.queue, {
      get: (t, k) =>
        k === 'writeTexture'
          ? (dst: GPUTexelCopyTextureInfo, data: ArrayBufferView, ...rest: unknown[]) => {
              largest = Math.max(largest, data.byteLength);
              return (t.writeTexture as (...a: unknown[]) => void)(dst, data, ...rest);
            }
          : typeof Reflect.get(t, k) === 'function'
            ? Reflect.get(t, k).bind(t)
            : Reflect.get(t, k),
    });
    backend.device = new Proxy(device, {
      get: (t, k) =>
        k === 'limits'
          ? limits
          : k === 'queue'
            ? queue
            : k === 'createBuffer'
              ? (d: GPUBufferDescriptor) => {
                  largest = Math.max(largest, d.size);
                  return t.createBuffer(d);
                }
              : typeof Reflect.get(t, k) === 'function'
                ? Reflect.get(t, k).bind(t)
                : Reflect.get(t, k),
    });
    try {
      const after = await e.renderer.documentPixels(e.doc, e.assets);
      const floats = new Float32Array(W * H * 4).map((_, i) => (i % 97) / 96);
      const ft = backend.floatTexture(W, H, floats);
      const floatBack = await backend.readFloat(ft);
      backend.destroy(ft);
      const bytes = new Uint8Array(W * H * 4).map((_, i) => (i * 7) % 256);
      const bt = backend.texture(W, H, bytes);
      const byteBack = await backend.read(bt);
      backend.destroy(bt);
      const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
        a.length === b.length &&
        Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
      return {
        composite: same(before, after),
        floats: same(floats, floatBack),
        bytes: same(bytes, byteBack),
        largest,
      };
    } finally {
      backend.device = device;
    }
  });
  expect(result).toMatchObject({ composite: true, floats: true, bytes: true });
  expect(result.largest).toBeGreaterThan(0);
  expect(result.largest).toBeLessThanOrEqual(5120 * 7);
});
