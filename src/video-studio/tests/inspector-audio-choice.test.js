import { it, expect, vi, afterEach } from 'vitest';
import { createInspector } from '../src/ui/inspector/index.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeTrack, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { fixture, clip } from './helpers.js';
const work = vi.hoisted(() => ({ jobs: [], delay: true }));
vi.mock('../src/media/audio-analysis.js', async original => ({
  ...await original(),
  decodeClipSound: async (_open, _asset, _clip, opts) => {
    const amplitude = .1 * (work.jobs.length + 1);
    if (work.delay) await new Promise((resolve, reject) => work.jobs.push({ resolve, reject, signal: opts.signal }));
    return { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => amplitude * Math.sin(i * .3))] };
  },
  detectBeats: () => ({ beats: [.1, .5], bpm: 150 }),
}));
const inspectors = [];
afterEach(() => {
  inspectors.splice(0).forEach(i => i.dispose());
  document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren();
  work.jobs = []; work.delay = true;
});
function setup() {
  const p = fixture(), a = clip('audio', 0, 1);
  a.beats = [200000, 800000];
  p.tracks.push(makeTrack('audio', { clips: [a] }));
  const store = new EditorStore(p), ctx = { store, library: {} }; ctx.actions = createActions(ctx); store.select(a.id);
  const inspector = createInspector(ctx); inspectors.push(inspector); document.body.append(inspector.el);
  return { store, inspector, id: a.id, get clip() { return findClip(store.project, a.id).clip; } };
}
const control = (x, name) => x.inspector.el.querySelector(`[aria-label="${name}"]`) || [...x.inspector.el.querySelectorAll('button')].find(b => b.textContent.trim() === name);
async function start(x, name) {
  const btn = control(x, name), count = work.jobs.length; btn.click();
  await vi.waitFor(() => expect(work.jobs).toHaveLength(count + 1)); return btn;
}
const settle = () => new Promise(r => setTimeout(r, 20));
const resetCases = [
  ['Normalize loudness', 'Reset Normalize loudness'], ['Measure', 'Reset Normalize loudness'],
  ['Reduce noise', 'Reset Reduce noise'], ['Learn noise again', 'Reset Reduce noise'], ['Detect beats', 'Clear'],
];
it.each(resetCases)('keeps %s cancelled after %s, with a fresh retry and undo', async (name, reset) => {
  const x = setup(), btn = await start(x, name), job = work.jobs[0];
  control(x, reset).click();
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length;
  const aborted = job.signal.aborted, idle = !btn.disabled;
  job.resolve(); await settle();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before);
  expect(x.store.history.undoStack).toHaveLength(history);
  expect(aborted).toBe(true); expect(idle).toBe(true); expect(document.querySelector('.toast.error')).toBeNull();
  work.delay = false; btn.click(); await vi.waitFor(() => expect(x.store.history.undoStack).toHaveLength(history + 1));
  const result = structuredClone(x.clip); x.store.undo(); expect(x.clip).not.toEqual(result); x.store.redo();
  expect(findClip(normalizeProject(x.store.projectForSave()), x.id).clip).toEqual(result);
});
it.each([['Measure', 'Normalize loudness', 'normalize'], ['Learn noise again', 'Reduce noise', 'denoise']])('keeps the effect off when switched off during %s', async (name, toggle, key) => {
  const x = setup(); x.store.update('Enable', () => { x.clip.audioFx = { [key]: { on: true } }; });
  const btn = await start(x, name); control(x, toggle).click();
  const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length;
  work.jobs[0].resolve(); await settle();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.clip.audioFx[key].on).toBe(false);
  expect(x.store.history.undoStack).toHaveLength(history); expect(work.jobs[0].signal.aborted).toBe(true); expect(btn.disabled).toBe(false);
});
it.each([['Normalize loudness', 'Measure'], ['Reduce noise', 'Learn noise again']])('replaces pending %s with newer %s without hiding its busy state', async (toggle, name) => {
  const x = setup(), old = await start(x, toggle), fresh = await start(x, name), before = JSON.stringify(x.store.projectForSave());
  work.jobs[0].resolve(); await settle();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(work.jobs[0].signal.aborted).toBe(true);
  expect(old.disabled).toBe(false); expect(fresh.disabled).toBe(true);
  expect(fresh.closest('.fx-section').querySelector('.fx-status').hidden).toBe(false);
  work.jobs[1].resolve(); await vi.waitFor(() => expect(fresh.disabled).toBe(false)); expect(x.store.history.undoStack).toHaveLength(1);
});
it('suppresses cancelled errors and lets retry start before the cancelled decoder settles', async () => {
  const x = setup(); await start(x, 'Measure'); control(x, 'Reset Normalize loudness').click();
  const fresh = await start(x, 'Measure'); work.jobs[0].reject(new Error('Old decode failure')); await settle();
  expect(fresh.disabled).toBe(true); expect(document.body.textContent).not.toContain('Old decode failure');
  work.jobs[1].resolve(); await vi.waitFor(() => expect(fresh.disabled).toBe(false)); expect(x.store.history.undoStack).toHaveLength(1);
});
it('keeps independent sections running and preserves target changes', async () => {
  const x = setup(), measure = await start(x, 'Measure'), noise = await start(x, 'Learn noise again');
  const target = control(x, 'Target loudness'); target.value = '-16'; target.dispatchEvent(new Event('change'));
  work.jobs[0].resolve(); work.jobs[1].resolve(); await vi.waitFor(() => expect(measure.disabled || noise.disabled).toBe(false));
  expect(work.jobs.every(j => !j.signal.aborted)).toBe(true); expect(x.clip.audioFx.normalize.target).toBe(-16);
  expect(x.clip.audioFx.normalize.on).toBe(true); expect(x.clip.audioFx.denoise.on).toBe(true); expect(x.store.history.undoStack).toHaveLength(3);
});
it.each([['Measure', 'Normalize loudness'], ['Learn noise again', 'Reduce noise']])('ignores %s finishing after the newer switch analysis has saved', async (name, toggle) => {
  const x = setup(); await start(x, name); const fresh = await start(x, toggle);
  work.jobs[1].resolve(); await vi.waitFor(() => expect(fresh.disabled).toBe(false));
  const before = JSON.stringify(x.store.projectForSave());
  work.jobs[0].resolve(); await settle();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(1);
  expect(work.jobs[0].signal.aborted).toBe(true);
  expect(document.querySelector('.toast.error')).toBeNull();
});
it.each([['Normalize loudness', 'normalize', { loudness: -20 }], ['Reduce noise', 'denoise', { profile: [-30] }]])('reset cancels a cached %s enable before it commits', async (name, key, cached) => {
  const x = setup(); x.clip.audioFx = { [key]: { on: false, ...cached } };
  const btn = control(x, name); btn.click(); control(x, `Reset ${name}`).click();
  const before = JSON.stringify(x.store.projectForSave()); await settle();
  expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(1);
  expect(work.jobs).toHaveLength(0); expect(btn.disabled).toBe(false);
});
it('cancelled completion does not steal focus from a newer control', async () => {
  const x = setup(); await start(x, 'Measure'); const reset = control(x, 'Reset Normalize loudness'); reset.click(); reset.focus();
  work.jobs[0].resolve(); await settle(); expect(document.activeElement).toBe(reset);
});
