// Pictures decoded for an export are let go once they are off screen for a while.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaFrames } from '../src/engine/exporter.js';
import { evaluate } from '../src/engine/scene.js';
import { fixture, clip, onMain, s } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('exporting a long slideshow', () => {
  it('keeps only a few decoded photos at a time and decodes one again when it comes back', async () => {
    const p = fixture();
    const photos = [];
    for (let i = 0; i < 30; i++) {
      p.assets[`ph${i}`] = { ...p.assets.img, id: `ph${i}`, name: `ph${i}.jpg` };
      photos.push(clip('image', i, 1, { assetId: `ph${i}` }));
    }
    // The first photo shows again at the end.
    photos.push(clip('image', 30, 1, { assetId: 'ph0' }));
    onMain(p, ...photos);
    let open = 0;
    let decoded = 0;
    let most = 0;
    vi.stubGlobal('createImageBitmap', async () => {
      decoded++;
      most = Math.max(most, ++open);
      return { width: 100, height: 100, close: () => open-- };
    });
    const media = new MediaFrames(p, { mediaBlob: async () => new Blob(['x']) });
    for (let t = 0.5; t < 31; t += 0.5) {
      const layers = evaluate(p, s(t));
      await media.prepare(layers);
      // The picture on screen is always there to draw.
      const shown = layers.find((l) => l.kind === 'media');
      expect(media.resolved.get(shown.clip.id)?.source).toBeTruthy();
      await media.sweep();
    }
    expect(most).toBeLessThanOrEqual(8);
    expect(decoded).toBe(31);
    await media.dispose();
    expect(open).toBe(0);
  });
});
