import { describe, it, expect, vi, afterEach } from 'vitest';
import { fitImageForVision } from '../src/ui/ai-attachments.js';

describe('pictures attached to the AI assistant', () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    delete globalThis.createImageBitmap;
    globalThis.Image = realImage;
    vi.restoreAllMocks();
  });

  /** A browser stand-in: pictures of the given size, decoded by createImageBitmap (recorded). */
  function browser(width, height) {
    const decodes = [];
    globalThis.createImageBitmap = vi.fn(async (blob, opts = {}) => {
      decodes.push(opts);
      return { width: opts.resizeWidth ?? width, height: opts.resizeHeight ?? height, close: vi.fn() };
    });
    globalThis.Image = class {
      set src(v) {
        this.naturalWidth = width;
        this.naturalHeight = height;
        queueMicrotask(() => this.onload?.());
      }
    };
    // Every drawing comes out as a small JPEG.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, fillRect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb, type) => cb(new Blob(['x'], { type })));
    return decodes;
  }

  it('decodes a big photo at the size it is sent, not at full size', async () => {
    const decodes = browser(8000, 6000);
    const fit = await fitImageForVision(new Blob(['jpg'], { type: 'image/jpeg' }), 'image/jpeg');
    expect(fit).toMatchObject({ width: 8000, height: 6000, mediaType: 'image/jpeg' });
    expect(decodes).toHaveLength(1);
    expect(decodes[0]).toMatchObject({ imageOrientation: 'from-image', resizeWidth: 1568, resizeHeight: 1176, resizeQuality: 'high' });
  });

  it('decodes a picture that already fits as it is', async () => {
    const decodes = browser(1200, 800);
    const blob = new Blob(['png'], { type: 'image/png' });
    const fit = await fitImageForVision(blob, 'image/png');
    expect(fit.blob).toBe(blob);
    expect(decodes).toEqual([{ imageOrientation: 'from-image' }]);
  });
});
