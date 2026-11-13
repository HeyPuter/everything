import { it, expect, vi, afterEach } from 'vitest';
import { transcriptPanel } from '../src/ui/panels/transcript.js';
import { mixdown } from '../src/media/transcribe.js';
import { EditorStore } from '../src/model/store.js';
import { addTimeline } from '../src/model/timelines.js';
import { createCompound } from '../src/model/compound.js';
import { fixture, clip, onMain } from './helpers.js';

vi.mock('../src/media/transcribe.js', async orig => ({ ...(await orig()), mixdown: vi.fn(async () => new Float32Array(16000)) }));
const panels = [];
afterEach(() => {
  panels.splice(0).forEach(p => p.dispose());
  delete globalThis.puter;
  delete globalThis.__vsFakeTranscript;
  document.body.replaceChildren();
  vi.clearAllMocks();
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; });return { promise, resolve }; };
const result = text => ({ words: [{ text, start: 0.1, end: 0.4 }] });
const button = (panel, label) => [...panel.el.querySelectorAll('button')].find(b => b.textContent === label);
function setup() {
  const p = fixture();
  const [source, other] = onMain(p, clip('video', 0, 1), clip('video', 1, 1));
  const compound = createCompound(p, [other.id]);
  const target = addTimeline(p);
  p.timelines.find(t => t.id === target).transcript = { language: 'fr', words: [{ text: 'Keep me', start: 0, end: 100000 }] };
  const store = new EditorStore(p), opts = { scope: 'all', language: 'en' };
  const ai = vi.fn();globalThis.puter = { ai: { speech2txt: ai } };
  const panel = transcriptPanel({ store, library: { backend: { kind: 'puter' } }, player: null, account: {} }, opts, () => {});
  panels.push(panel);document.body.append(panel.el);
  return { store, panel, ai, opts, target, source, compound, original: p.timelineId };
}

it.each(['timeline', 'compound'])('does not put a delayed transcript into another %s', async kind => {
  const { store, panel, ai, target, compound } = setup(), pending = deferred();
  ai.mockReturnValueOnce(pending.promise);
  button(panel, 'Transcribe').click();
  await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
  if (kind === 'timeline') store.openTimeline(target);else store.openCompound(compound.id);
  const expected = structuredClone(store.project.transcript);
  pending.resolve(result('Old audio'));
  await vi.waitFor(() => expect(button(panel, 'Transcribe')?.disabled ?? false).toBe(false));
  await new Promise(r => setTimeout(r, 0));
  expect(store.project.transcript).toEqual(expected);
  expect(document.body.textContent).not.toContain('Transcript ready');
});

it('cancels a context change before starting the speech request', async () => {
  const { store, panel, ai, target } = setup(), pending = deferred();
  mixdown.mockImplementationOnce(() => pending.promise);
  button(panel, 'Transcribe').click();store.openTimeline(target);
  pending.resolve(new Float32Array(16000));
  await new Promise(r => setTimeout(r, 0));
  expect(ai).not.toHaveBeenCalled();
});

it('uses the language chosen when transcription started', async () => {
  const { store, panel, ai, opts } = setup(), pending = deferred();
  ai.mockReturnValueOnce(pending.promise);
  button(panel, 'Transcribe').click();
  await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
  opts.language = 'fr';pending.resolve(result('Hello'));
  await vi.waitFor(() => expect(store.project.transcript).toBeTruthy());
  expect(store.project.transcript.language).toBe('en');
});

it('allows a new transcription immediately after cancelling and ignores the old completion', async () => {
  const { store, panel, ai } = setup(), old = deferred(), fresh = deferred();
  ai.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  button(panel, 'Transcribe').click();await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
  button(panel, 'Cancel').click();
  expect(button(panel, 'Transcribe').disabled).toBe(false);
  button(panel, 'Transcribe').click();await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(2));
  old.resolve(result('Old'));
  await new Promise(r => setTimeout(r, 0));
  expect(button(panel, 'Transcribe').disabled).toBe(true);
  fresh.resolve(result('New'));
  await vi.waitFor(() => expect(store.project.transcript?.words[0].text).toBe('New'));
});

it('does not revive an old job after switching away and back, or finish a newer job', async () => {
  const { store, panel, ai, target, original } = setup(), old = deferred(), fresh = deferred();
  ai.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  button(panel, 'Transcribe').click();await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
  store.openTimeline(target);store.openTimeline(original);
  expect(button(panel, 'Transcribe').disabled).toBe(false);
  button(panel, 'Transcribe').click();await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(2));
  old.resolve(result('Old'));
  await new Promise(r => setTimeout(r, 0));
  expect(button(panel, 'Transcribe').disabled).toBe(true);
  expect(store.project.transcript).toBeUndefined();
  fresh.resolve(result('New'));
  await vi.waitFor(() => expect(store.project.transcript?.words[0].text).toBe('New'));
});

it('keeps successful transcription through edits in the same timeline and makes it undoable', async () => {
  const { store, panel, ai } = setup(), pending = deferred();
  ai.mockReturnValueOnce(pending.promise);
  button(panel, 'Transcribe').click();await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
  store.update('Rename', p => { p.name = 'Renamed'; });
  pending.resolve(result('Hello'));
  await vi.waitFor(() => expect(store.project.transcript?.words[0].text).toBe('Hello'));
  expect(store.project.name).toBe('Renamed');
  store.undo();
  expect(store.project.transcript).toBeUndefined();
  expect(store.project.name).toBe('Renamed');
});

it.each(['preparing', 'transcribing'])('ignores work settling after disposal while %s', async stage => {
  const { store, panel, ai } = setup(), pending = deferred();
  if (stage === 'preparing') mixdown.mockImplementationOnce(() => pending.promise);
  else ai.mockReturnValueOnce(pending.promise);
  button(panel, 'Transcribe').click();
  if (stage === 'transcribing') await vi.waitFor(() => expect(ai).toHaveBeenCalledTimes(1));
  panel.dispose();
  pending.resolve(stage === 'preparing' ? new Float32Array(16000) : result('Old'));
  await new Promise(r => setTimeout(r, 0));
  expect(store.project.transcript).toBeUndefined();
  expect(ai).toHaveBeenCalledTimes(stage === 'preparing' ? 0 : 1);
});

it('ignores late progress and errors from cancelled preparation', async () => {
  const { panel } = setup(), old = deferred(), fresh = deferred();
  let oldProgress, freshProgress;
  mixdown.mockImplementationOnce((_p, _l, options) => { oldProgress = options.onProgress;return old.promise; });
  mixdown.mockImplementationOnce((_p, _l, options) => { freshProgress = options.onProgress;return fresh.promise; });
  button(panel, 'Transcribe').click();button(panel, 'Cancel').click();button(panel, 'Transcribe').click();
  freshProgress(0.2);oldProgress(0.9);old.resolve(Promise.reject(new Error('Old preparation failed')));
  await new Promise(r => setTimeout(r, 0));
  expect(panel.el.querySelector('[role="status"]').textContent).toBe('Preparing audio... 20%');
  expect(button(panel, 'Transcribe').disabled).toBe(true);
  expect(document.body.textContent).not.toContain('Old preparation failed');
  panel.dispose();fresh.resolve(new Float32Array(16000));
});
