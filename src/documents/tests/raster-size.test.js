// @vitest-environment jsdom
import { it, expect, beforeAll, afterAll } from 'vitest';

// Pictures over the editing limits are redrawn smaller on insertion: at most 4,096 pixels a side and
// 16 megapixels. Rounding the scaled size can overshoot the pixel limit by a few pixels; the picture
// must then lose those pixels, not be scaled down a second time to a quarter of its area.
let rasterize, drawn;
const saved = {};
beforeAll(async () => {
  saved.Image = globalThis.Image; saved.create = URL.createObjectURL; saved.revoke = URL.revokeObjectURL; saved.createElement = document.createElement;
  URL.createObjectURL = () => 'blob:picture'; URL.revokeObjectURL = () => {};
  // A decoded picture of the size its name says ("8198x8090").
  globalThis.Image = class { set src(value) { this.url = value; } decode() { return Promise.resolve(); } };
  const createElement = document.createElement.bind(document);
  document.createElement = name => name !== 'canvas' ? createElement(name) : {
    width: 0, height: 0,
    getContext() { return { drawImage: (img, x, y, w, h) => { drawn = { w, h }; } }; },
    toBlob(done) { done({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }); },
  };
  ({ rasterize } = await import('../src/views/insert-tab.js'));
});
afterAll(() => { globalThis.Image = saved.Image; URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; document.createElement = saved.createElement; });
const sized = (width, height) => { const proto = globalThis.Image.prototype; Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => width }); Object.defineProperty(proto, 'naturalHeight', { configurable: true, get: () => height }); };

it('fits a large, nearly square picture within 16 megapixels without shrinking it twice', async () => {
  for (const [width, height] of [[8198, 8090], [3991, 4071], [8000, 8000], [12000, 3000], [5000, 4999]]) {
    sized(width, height);
    const result = await rasterize(new Blob(['x']), 4096, { pixels: 16000000 });
    expect(result.width * result.height, `${width}×${height}`).toBeLessThanOrEqual(16000000);
    expect(Math.max(result.width, result.height), `${width}×${height}`).toBeLessThanOrEqual(4096);
    // Within a pixel of the largest size that fits, keeping the proportions.
    const scale = Math.min(4096 / Math.max(width, height), Math.sqrt(16000000 / (width * height)));
    expect(Math.abs(result.width - width * scale), `${width}×${height}`).toBeLessThanOrEqual(2);
    expect(Math.abs(result.height - height * scale), `${width}×${height}`).toBeLessThanOrEqual(2);
    expect(drawn).toEqual({ w: result.width, h: result.height });
  }
});
