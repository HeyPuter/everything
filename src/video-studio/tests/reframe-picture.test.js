import { it, expect, vi, afterEach } from 'vitest';
import { reframePlan, applyReframePlan } from '../src/ui/smart-actions.js';
import { evaluate } from '../src/engine/scene.js';
import { Compositor } from '../src/engine/compositor.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['clip', 'asset', 'ordinary'])('fills the frame when auto-reframing a picture with %s dimensions', async source => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 72, height: 42, close })));
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(128) }) }; } });
  const p = fixture(); p.settings.width = 72; p.settings.height = 128;
  const a = p.assets.img; a.width = 72; a.height = 42;
  const [c] = onMain(p, clip('image', 0, 4));
  const size = { width: 72, height: 40.5 };
  if (source === 'clip') { c.pictureSize = size; a.pictureSize = { width: 72, height: 60 }; }
  else if (source === 'asset') a.pictureSize = size;
  const plan = await reframePlan(c, a, new Blob(['picture']), { dstAR: 72 / 128 });
  applyReframePlan(c, plan);
  for (const project of [p, normalizeProject(p)]) {
    const layer = evaluate(project, 0)[0];
    const box = Compositor.prototype.layerBox.call({ projW: 72, projH: 128 }, layer, a);
    expect(box.h).toBeCloseTo(128);
    expect(box.w).toBeGreaterThanOrEqual(72);
    expect(box.cy - box.h / 2).toBeLessThanOrEqual(1e-6);
    expect(box.cy + box.h / 2).toBeGreaterThanOrEqual(128 - 1e-6);
  }
  expect(close).toHaveBeenCalledOnce();
});
