import { it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip } from '../src/model/timeline.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { fixture, clip } from './helpers.js';

const work = vi.hoisted(() => ({ delay: 0 }));
vi.mock('../src/media/audio-analysis.js', async original => ({
  ...await original(),
  decodeClipSound: async (_open, asset) => {
    const rate = 8000, data = new Float32Array(6 * rate);
    const delay = asset.id === 'recorder' ? work.delay : 0;
    let seed = 3;
    for (const t of [.5, 1.3, 1.7, 2.9, 3.4]) {
      for (let i = 0; i < 400; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[Math.round((t + delay) * rate) + i] = ((seed / 0x7fffffff) * 2 - 1) * Math.exp(-i / 80);
      }
    }
    return { sampleRate: rate, channels: [data] };
  },
}));

afterEach(() => {
  document.querySelectorAll('.dialog-close').forEach(b => b.click());
  document.querySelector('.toasts')?.replaceChildren();
  document.body.replaceChildren();
  work.delay = 0;
  vi.restoreAllMocks();
});

function setup(refStart, movStart, delay = 0) {
  work.delay = delay;
  const p = fixture();
  p.assets.recorder = { ...p.assets.aud, id: 'recorder' };
  const ref = clip('audio', refStart, 6);
  const mov = clip('audio', movStart, 6, { assetId: 'recorder' });
  p.tracks.push(makeTrack('audio', { clips: [ref] }), makeTrack('audio', { clips: [mov] }));
  const store = new EditorStore(p);
  store.select([ref.id, mov.id]);
  const ctx = { store, library: {} };
  ctx.actions = createActions(ctx);
  return { ctx, store, ref: ref.id, mov: mov.id };
}

it.each([[0, 0, 0], [3, 2, 1]])('does not dirty already aligned clips at %s and %s seconds with %s seconds of source offset', async (ref, mov, delay) => {
  const x = setup(ref, mov, delay), before = JSON.stringify(x.store.projectForSave());
  await x.ctx.actions.syncBySound();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(0);
  expect(x.store.revision).toBe(0);
  expect(x.store.dirty).toBe(false);
  expect(document.querySelector('.toast.success')).toBeNull();
  expect(document.body.textContent).toContain('already aligned');
});

it('keeps a real sync undoable without adding another undo step when repeated', async () => {
  const x = setup(0, 4);
  await x.ctx.actions.syncBySound();
  expect(findClip(x.store.project, x.mov).clip.start).toBe(0);
  expect(x.store.history.undoStack).toHaveLength(1);
  const before = JSON.stringify(x.store.projectForSave()), revision = x.store.revision;
  document.querySelector('.toasts')?.replaceChildren();
  await x.ctx.actions.syncBySound();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(1);
  expect(x.store.revision).toBe(revision);
  expect(document.body.textContent).toContain('already aligned');
  x.store.undo();
  expect(findClip(x.store.project, x.mov).clip.start).toBe(4000000);
  x.store.redo();
  expect(findClip(normalizeProject(x.store.projectForSave()), x.mov).clip.start).toBe(0);
});
