import { describe, it, expect, vi } from 'vitest';
import { lazyModel } from '../src/media/lazy-model.js';
import { createProject, makeClip } from '../src/model/project.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

// Export without WebGL: a compositor that draws nothing, and people models that failed to load.
vi.mock('../src/engine/compositor.js', () => ({
  Compositor: class {
    resize() {}
    render() {
      return true;
    }
    dispose() {}
  },
}));
const ensureCutout = vi.fn(async () => false);
vi.mock('../src/engine/cutout.js', async (orig) => ({ ...(await orig()), ensureCutout: (...a) => ensureCutout(...a) }));

describe('lazyModel', () => {
  it('stays failed for frames but loads again on retry', async () => {
    let fail = true;
    const create = vi.fn(async () => {
      if (fail) throw new Error('Failed to fetch');
      return { ok: true };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = lazyModel(create, 'Could not start.');
    const states = [];
    m.onChange((s) => states.push(s));
    expect(await m.ready()).toBe(false);
    expect(m.state()).toBe('failed');
    expect(m.error()).toBe('Failed to fetch');
    // Drawing a frame asks again; that must not fetch again.
    expect(await m.ready()).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await m.ready({ retry: true })).toBe(true);
    expect(m.state()).toBe('ready');
    expect(m.instance).toEqual({ ok: true });
    expect(states).toEqual(['loading', 'failed', 'loading', 'ready']);
    console.error.mockRestore();
  });
});

describe('exporting with people tools whose model failed', () => {
  function project() {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'image', name: 'p.png', width: 64, height: 64 };
    const c = makeClip('image', { assetId: 'a', duration: US });
    c.cutout = { feather: 25, shrink: 0, smooth: 40 };
    T.mainTrack(p).clips.push(c);
    return p;
  }

  it('stops with a clear message instead of leaving the people out', async () => {
    const { renderStill, renderFrames } = await import('../src/engine/exporter.js');
    const library = { mediaUrl: async () => '', mediaBlob: async () => new Blob([]) };
    await expect(renderStill(project(), library, 0)).rejects.toThrow(/people tools .* couldn't load/);
    expect(ensureCutout).toHaveBeenLastCalledWith(expect.anything(), { retry: true });
    const frames = renderFrames(project(), library, { width: 64, height: 64, fps: 10 });
    await expect(frames.next()).rejects.toThrow(/couldn't load/);
  });
});
