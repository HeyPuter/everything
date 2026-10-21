// The project's gallery cover: rendered on its own, never through the live preview.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/engine/exporter.js', async (orig) => {
  const real = await orig();
  return { ...real, renderStill: vi.fn(async () => ({ width: 480, height: 270, close() {} })) };
});

import { renderStill } from '../src/engine/exporter.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { fixture, clip, onMain } from './helpers.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('project cover', () => {
  let editor;
  let lib;
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    lib = new Library(memoryBackend());
    await lib.saveProject(p);
    editor = new Editor(root, { library: lib, project: p, account: {}, onExit() {}, onNewProject() {} });
    await settle();
    // Pretend the preview has WebGL; the cover must still not draw through it.
    Object.defineProperty(editor.ctx.player, 'supported', { get: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['jpeg'], { type: 'image/jpeg' })));
    renderStill.mockClear();
  });
  afterEach(() => {
    editor?.dispose();
    editor = null;
    vi.restoreAllMocks();
  });

  it('renders the cover frame on its own and leaves the preview where it is', async () => {
    const { store, player } = editor.ctx;
    store.seek(7_000_000);
    player.previewTime = 3_000_000; // hovering the timeline
    const render = vi.spyOn(player, 'renderFrame');
    const saved = vi.spyOn(lib, 'saveCover');
    await editor.saveCover();
    expect(renderStill).toHaveBeenCalledTimes(1);
    const [project, library, t, opts] = renderStill.mock.calls[0];
    expect(project).toBe(store.project);
    expect(library).toBe(lib);
    expect(t).toBe(1_000_000);
    expect(opts).toEqual({ maxWidth: 480 });
    expect(player.previewTime).toBe(3_000_000);
    expect(render).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith(store.project.id, expect.any(Blob));
  });

  it('uses the chosen cover time', async () => {
    editor.ctx.store.update('cover', (p) => {
      p.cover = { time: 4_500_000 };
    });
    await editor.saveCover();
    expect(renderStill.mock.calls[0][2]).toBe(4_500_000);
  });

  it('waits until playback stops', async () => {
    vi.useFakeTimers();
    try {
      const { player } = editor.ctx;
      player.playing = true;
      await editor.saveCover();
      expect(renderStill).not.toHaveBeenCalled();
      player.playing = false;
      await vi.advanceTimersByTimeAsync(4000);
      expect(renderStill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
