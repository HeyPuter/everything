import { it, expect, vi, afterEach } from 'vitest';
import { reframePlan } from '../src/ui/smart-actions.js';
import { makeClip } from '../src/model/project.js';
import { FRAME_SLACK } from '../src/lib/time.js';
const read = vi.hoisted(() => ({ times: [], dispose: vi.fn(), decode: true, onFrame: null }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], BlobSource: class {},
  Input: class { async getPrimaryVideoTrack() { return { canDecode: async () => read.decode }; } dispose() { read.dispose(); } },
  CanvasSink: class { async *canvasesAtTimestamps(times) { read.times.push(...times); for (const t of times) { read.onFrame?.(); yield { canvas: { t } }; } } },
}));
afterEach(() => { read.times = []; read.dispose.mockClear(); read.decode = true; read.onFrame = null; vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); }));
  vi.stubGlobal('OffscreenCanvas', class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(128) }) }; } });
  return makeClip('video', { freeze: true, in: 233333, duration: 4000000 });
}
it('reads the held video frame once and produces a stationary reframe plan', async () => {
  const c = setup();
  const plan = await reframePlan(c, { width: 1920, height: 1080 }, new Blob(['video']), { dstAR: 9 / 16 });
  expect(read.times).toHaveLength(1);
  expect(read.times[0]).toBeCloseTo(.233333 + FRAME_SLACK, 6);
  expect(plan.keys).toEqual([{ t: 0, x: 0, y: 0 }]);
  expect(plan.scale).toBeCloseTo((16 / 9) / (9 / 16));
  expect(read.dispose).toHaveBeenCalledOnce();
  expect(createImageBitmap).not.toHaveBeenCalled();
});

it.each(['canceled', 'unsupported'])('releases the held-frame decoder when %s', async mode => {
  const c = setup(), ac = new AbortController();
  if (mode === 'canceled') read.onFrame = () => ac.abort();
  else read.decode = false;
  const pending = reframePlan(c, { width: 1920, height: 1080 }, new Blob(['video']), { dstAR: 9 / 16, signal: ac.signal });
  if (mode === 'canceled') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  else await expect(pending).rejects.toThrow('can not be decoded');
  expect(read.dispose).toHaveBeenCalledOnce();
});
