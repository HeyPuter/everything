import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, makeClip } from '../src/model/project.js';

const runtime = vi.hoisted(() => ({ outputs: [], render: vi.fn(), dispose: vi.fn(), add: vi.fn(), people: vi.fn() }));
vi.mock('../src/engine/compositor.js', () => ({
  Compositor: class {
    resize() {}
    render() { return runtime.render(); }
    dispose() { runtime.dispose(); }
  },
}));
vi.mock('../src/engine/cutout.js', async (orig) => ({ ...(await orig()), ensureCutout: (...args) => runtime.people(...args) }));
vi.mock('mediabunny', async (orig) => ({
  ...(await orig()),
  canEncodeVideo: async () => true,
  BufferTarget: class { buffer = new ArrayBuffer(1); },
  Output: class {
    state = 'pending';
    constructor() { runtime.outputs.push(this); }
    addVideoTrack() {}
    setMetadataTags() {}
    async start() { this.state = 'started'; }
    async finalize() { this.state = 'finalized'; }
    async cancel() { this.state = 'canceled'; }
  },
  CanvasSource: class { async add() { runtime.add(); } close() {} },
}));

import { exportProject, renderFrames } from '../src/engine/exporter.js';
import { dropLut, getLut } from '../src/engine/luts.js';

beforeEach(() => {
  runtime.outputs.length = 0;
  runtime.render.mockReset().mockReturnValue(true);
  runtime.dispose.mockReset();
  runtime.add.mockReset();
  runtime.people.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

const CUBE = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const cases = ['video', 'frames'].flatMap((kind) => ['fonts', 'LUT', 'people models'].map((stage) => ({ kind, stage })));

describe('canceling export preparation', () => {
  it.each(cases)('stops $kind while $stage are still loading', async ({ kind, stage }) => {
    const p = createProject();
    const c = makeClip('text', { text: 'Waiting for resources', duration: 10000 });
    p.tracks[0].clips.push(c);
    const id = `cancel-preload-${kind}`;
    let finish;
    const read = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const library = {};
    const fonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    if (stage === 'fonts') Object.defineProperty(document, 'fonts', { configurable: true, value: { load: read } });
    if (stage === 'LUT') {
      c.grade = { lut: { id, intensity: 100 } };
      library.readLut = read;
    }
    if (stage === 'people models') runtime.people.mockImplementation(read);
    const controller = new AbortController();
    const frames = kind === 'frames' ? renderFrames(p, library, { width: 64, height: 36, fps: 30, signal: controller.signal }) : null;
    let outcome;
    const pending = (frames ? frames.next() : exportProject(p, library, { includeAudio: false }, { signal: controller.signal }))
      .then(() => { outcome = 'rendered'; }, (err) => { outcome = err.name; });
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      controller.abort();
      await vi.waitFor(() => expect(outcome).toBe('AbortError'), { timeout: 200, interval: 5 });
      for (const output of runtime.outputs) expect(output.state).toBe('canceled');
      expect(runtime.dispose).toHaveBeenCalledTimes(kind === 'frames' && stage === 'LUT' ? 0 : 1);
      // The shared load may still finish for a player or a later export.
      finish(stage === 'LUT' ? { text: CUBE, name: 'Shared color' } : true);
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runtime.render).not.toHaveBeenCalled();
      expect(runtime.add).not.toHaveBeenCalled();
      expect(runtime.people).toHaveBeenCalledTimes(stage === 'people models' ? 1 : 0);
      if (stage === 'LUT') expect(getLut(id)?.size).toBe(2);
    } finally {
      finish?.(stage === 'LUT' ? { text: CUBE, name: 'Shared color' } : true);
      await pending;
      await frames?.return();
      if (fonts) Object.defineProperty(document, 'fonts', fonts);
      else delete document.fonts;
      dropLut(id);
    }
  });
});
