import { afterEach, expect, it, vi } from 'vitest';
import type { Editor } from '../src/editor';
import { newDocument } from '../src/model/document';
import { clearQueue, frameImage, onFrameRendered } from '../src/features/animation/render';

afterEach(() => vi.unstubAllGlobals());

it('finishes rendering a frame strip larger than 600 distinct frames', async () => {
  // Exercise the queue and eviction behavior without allocating real images
  // or invoking the GPU. The panel requests every frame after each render.
  vi.stubGlobal('ImageData', class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  const sizes: number[][] = [];
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width: number, height: number) { sizes.push([width, height]); }
    getContext() { return { putImageData() {}, drawImage() {} }; }
    async convertToBlob() { return new Blob(['pixel']); }
  });
  const doc = newDocument(2, 2);
  const e = { session: { id: 'capacity' }, assets: {}, renderer: { documentPixels: async () => new Uint8Array(16) } } as unknown as Editor;
  const count = 601;
  let rendered = 0, missing = count, finished = false;
  const refresh = () => {
    clearQueue();
    missing = 0;
    for (let i = 0; i < count; i++) if (!frameImage(e, doc, i, `capacity-${i}`)) missing++;
  };
  await new Promise<void>((resolve) => {
    onFrameRendered(() => {
      if (finished) return;
      rendered++;
      refresh();
      // Bound a broken eviction loop, so a regression cannot exhaust memory.
      if (missing === 0 || rendered > count) {
        finished = true;
        clearQueue();
        resolve();
      }
    });
    refresh();
  });
  expect(missing).toBe(0);
  expect(rendered).toBe(count);
});
