import { it, expect, vi, afterEach } from 'vitest';
import { createInspector } from '../src/ui/inspector/index.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { fixture, clip } from './helpers.js';
const work = vi.hoisted(() => ({ delayed: true, finish: null, fail: null, signal: null, reads: 0 }));
vi.mock('../src/media/audio-analysis.js', async original => ({
  ...await original(),
  decodeClipSound: async (_open, _asset, _clip, opts = {}) => {
    work.reads++; work.signal = opts.signal;
    if (work.delayed) await new Promise((r, j) => { work.finish = r; work.fail = j; });
    return { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => .2 * Math.sin(i * .3))] };
  },
  detectBeats: () => ({ beats: [.1, .5], bpm: 150 }),
}));
vi.mock('../src/engine/audio-mix.js', async original => ({
  ...await original(),
  renderAudio: async (_project, _library, opts) => {
    work.reads++; work.signal = opts.signal;
    if (work.delayed) await new Promise((r, j) => { work.finish = r; work.fail = j; });
    return { sampleRate: 8000, channels: [new Float32Array(8000).fill(.2)] };
  },
}));
const inspectors = [];
afterEach(() => {
  inspectors.splice(0).forEach(i => i.dispose());
  document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren();
  work.delayed = true; work.finish = work.fail = work.signal = null; work.reads = 0; vi.restoreAllMocks();
});
const controls = ['Normalize loudness', 'Measure', 'Reduce noise', 'Learn noise again', 'Detect beats', 'Lower under speech'];
const control = (x, name) => x.inspector.el.querySelector(`[role=switch][aria-label="${name}"]`) || [...x.inspector.el.querySelectorAll('button')].find(b => b.textContent.trim() === name);
function setup() {
  const p = fixture(), a = clip('audio', 0, 1), b = clip('audio', 2, 1);
  p.tracks.push(makeTrack('audio', { clips: [a, b] }));
  const store = new EditorStore(p), ctx = { store, library: {} };
  ctx.actions = createActions(ctx); store.select(a.id);
  const inspector = createInspector(ctx); inspectors.push(inspector); document.body.append(inspector.el);
  return { ctx, store, inspector, a: a.id, b: b.id };
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function start(x, name) {
  const btn = control(x, name); btn.click();
  await vi.waitFor(() => expect(work.finish).toBeTypeOf('function'));
  return btn;
}
it.each(controls)('cancels pending %s when its inspector is disposed', async name => {
  const x = setup(), before = JSON.stringify(x.store.projectForSave()), btn = await start(x, name);
  x.inspector.dispose(); const aborted = work.signal?.aborted; work.finish(); await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(aborted).toBe(true);
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(0);
  expect(document.querySelector('.toast.error')).toBeNull();
});
it.each(['selection', 'tab'])('cancels loudness analysis on %s change', async how => {
  const x = setup(), before = JSON.stringify(x.store.projectForSave()), btn = await start(x, 'Measure');
  if (how === 'selection') x.store.select(x.b); else x.inspector.showTab('speed');
  const aborted = work.signal?.aborted; work.finish(); await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(aborted).toBe(true); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0);
});
it.each(controls)('does not restart %s from a control belonging to a closed tab', async name => {
  const x = setup(), old = control(x, name), before = JSON.stringify(x.store.projectForSave());
  x.inspector.showTab('speed'); work.delayed = false; old.click(); await tick(); await tick();
  expect(work.reads).toBe(0); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(0);
});
it.each(['Normalize loudness', 'Measure'])('suppresses a late %s error after leaving the panel', async name => {
  const x = setup(), btn = await start(x, name); x.inspector.showTab('speed'); work.fail(new Error('Obsolete audio read'));
  await vi.waitFor(() => expect(btn.disabled).toBe(false)); expect(document.body.textContent).not.toContain('Obsolete audio read');
});
it.each(['Measure', 'Learn noise again', 'Detect beats', 'Lower under speech'])('allows fresh %s analysis after cancellation, with undo and reopening', async name => {
  const x = setup(), old = await start(x, name); x.inspector.showTab('speed'); work.finish(); await vi.waitFor(() => expect(old.disabled).toBe(false));
  expect(x.store.history.undoStack).toHaveLength(0);
  x.inspector.showTab('audio'); work.delayed = false; const btn = control(x, name); btn.click();
  await vi.waitFor(() => expect(x.store.history.undoStack).toHaveLength(1));
  const result = structuredClone(findClip(x.store.project, x.a).clip);
  x.store.undo(); expect(findClip(x.store.project, x.a).clip).not.toEqual(result);
  x.store.redo(); expect(findClip(normalizeProject(x.store.projectForSave()), x.a).clip).toEqual(result);
});
it.each(['Normalize loudness', 'Measure'])('keeps current %s errors visible and permits retry', async name => {
  const x = setup(), btn = await start(x, name); work.fail(new Error('Current audio read failed'));
  await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(document.body.textContent).toContain('Current audio read failed'); expect(x.store.history.undoStack).toHaveLength(0);
  work.delayed = false; btn.click(); await vi.waitFor(() => expect(x.store.history.undoStack).toHaveLength(1));
});
it('does not enable cached normalization after its panel closes', async () => {
  const x = setup(); findClip(x.store.project, x.a).clip.audioFx = { normalize: { on: false, target: -14, loudness: -20 } };
  const before = JSON.stringify(x.store.projectForSave()), btn = control(x, 'Normalize loudness');
  btn.click(); x.inspector.dispose(); await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(work.reads).toBe(0); expect(x.store.history.undoStack).toHaveLength(0);
});
