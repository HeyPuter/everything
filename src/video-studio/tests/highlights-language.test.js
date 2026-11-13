import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { mixdown, transcribeMix } from '../src/media/transcribe.js';
import { fixture, clip, onMain } from './helpers.js';

vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(), transcribeMix: vi.fn() }));
const dialogs = [], reply = '{"highlights":[{"title":"First","start":20,"end":59}]}';
const words = (prefix = 'auto') => Array.from({ length: 240 }, (_, i) => ({ text: `${prefix}${i}${i % 10 === 9 ? '.' : ''}`, start: i * .5, end: i * .5 + .4 }));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const select = (d, name, value) => { const el = d.el.querySelector(`[aria-label="${name}"]`); el.value = value; el.dispatchEvent(new Event('change')); };
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
const again = d => button(d, 'Search again').click();
beforeEach(() => { mixdown.mockReset().mockResolvedValue(new Float32Array(16000)); transcribeMix.mockReset().mockImplementation(async (_mix, _rate, { language }) => words(language)); });
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup({ language = 'auto', transcript = false } = {}) {
  setPref('highlights', { language, target: 'here', captions: 'yellow-caption' });
  const p = fixture(); p.assets.vid.duration = 200e6; onMain(p, clip('video', 0, 120));
  if (transcript) p.transcript = { language: 'en', words: words('project').map(w => ({ ...w, start: w.start * 1e6, end: w.end * 1e6 })) };
  const store = new EditorStore(p), chat = vi.fn(async () => reply), d = openHighlightsDialog({ store, library: {} }, { chat }); dialogs.push(d);
  return { d, store, chat };
}
it.each([['auto', 'es'], ['es', 'en'], ['es', 'auto']])('transcribes again when language changes from %s to %s', async (from, to) => {
  const e = setup({ language: from }); await e.d.search(); again(e.d); select(e.d, 'Spoken language', to); await e.d.search();
  expect(transcribeMix.mock.calls.map(c => c[2].language)).toEqual([from, to]); expect(mixdown).toHaveBeenCalledTimes(2); expect(e.d.found[0].excerpt).toContain(`${to}20`);
  await e.d.make(); const added = e.store.project.tracks.flatMap(t => t.clips).find(c => c.type === 'compound');
  expect(added.sequence.tracks.flatMap(t => t.clips).find(c => c.type === 'text').text).toContain(`${to}20`);
});
it.each(['same language', 'count', 'length'])('reuses transcription when changing %s', async kind => {
  const e = setup({ language: 'es' }); await e.d.search(); again(e.d);
  if (kind === 'same language') select(e.d, 'Spoken language', 'es');
  if (kind === 'count') select(e.d, 'How many', '3');
  if (kind === 'length') select(e.d, 'Length of each', 'medium');
  await e.d.search(); expect(transcribeMix).toHaveBeenCalledOnce(); expect(mixdown).toHaveBeenCalledOnce(); expect(e.chat).toHaveBeenCalledTimes(2); expect(e.d.words[0].text).toBe('es0');
});
it('reuses a successful transcription after the highlight selection request fails', async () => {
  const e = setup({ language: 'es' }); vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockRejectedValueOnce(new Error('Selection failed'));
  await e.d.search(); await e.d.search(); expect(transcribeMix).toHaveBeenCalledOnce(); expect(e.chat).toHaveBeenCalledTimes(2); expect(e.d.found[0].excerpt).toContain('es20');
});
it('retries the new language after transcription fails', async () => {
  const e = setup(); vi.spyOn(console, 'error').mockImplementation(() => {}); await e.d.search(); again(e.d); select(e.d, 'Spoken language', 'es'); transcribeMix.mockRejectedValueOnce(new Error('Speech failed'));
  await e.d.search(); expect(e.d.el.dataset.step).toBe('options'); await e.d.search();
  expect(transcribeMix.mock.calls.map(c => c[2].language)).toEqual(['auto', 'es', 'es']); expect(e.d.words[0].text).toBe('es0');
});
it('keeps the prior successful language available when a replacement fails', async () => {
  const e = setup(); vi.spyOn(console, 'error').mockImplementation(() => {}); await e.d.search(); again(e.d); select(e.d, 'Spoken language', 'es'); transcribeMix.mockRejectedValueOnce(new Error('Speech failed'));
  await e.d.search(); select(e.d, 'Spoken language', 'auto'); await e.d.search();
  expect(transcribeMix.mock.calls.map(c => c[2].language)).toEqual(['auto', 'es']); expect(e.d.words[0].text).toBe('auto0');
});
it('does not accept a canceled replacement transcription and retries its language', async () => {
  const e = setup(), pending = defer(); await e.d.search(); again(e.d); select(e.d, 'Spoken language', 'es'); transcribeMix.mockReturnValueOnce(pending.promise);
  const run = e.d.search(); await Promise.resolve(); await Promise.resolve(); button(e.d, 'Stop')?.click(); pending.resolve(words('es')); await run; await e.d.search();
  expect(transcribeMix.mock.calls.map(c => c[2].language)).toEqual(['auto', 'es', 'es']); expect(e.d.words[0].text).toBe('es0');
});
it('does not replace an explicit language with a project transcript arriving between searches', async () => {
  const e = setup(); await e.d.search(); again(e.d); select(e.d, 'Spoken language', 'es');
  e.store.update('New transcript', p => { p.transcript = { language: 'en', words: words('other').map(w => ({ ...w, start: w.start * 1e6, end: w.end * 1e6 })) }; });
  await e.d.search(); expect(transcribeMix.mock.calls.map(c => c[2].language)).toEqual(['auto', 'es']); expect(e.d.words[0].text).toBe('es0');
});
it('honors the visible language choice if a project transcript arrives before the first search', async () => {
  const e = setup({ language: 'es' });
  e.store.update('New transcript', p => { p.transcript = { language: 'en', words: words('other').map(w => ({ ...w, start: w.start * 1e6, end: w.end * 1e6 })) }; });
  await e.d.search(); expect(transcribeMix).toHaveBeenCalledOnce(); expect(e.d.words[0].text).toBe('es0');
});
it('continues reusing the project transcript when the dialog offers that mode', async () => {
  const e = setup({ language: 'es', transcript: true }); expect(e.d.el.querySelector('[aria-label="Spoken language"]')).toBeNull(); await e.d.search(); again(e.d); select(e.d, 'How many', '3'); await e.d.search();
  expect(transcribeMix).not.toHaveBeenCalled(); expect(mixdown).not.toHaveBeenCalled(); expect(e.chat).toHaveBeenCalledTimes(2); expect(e.d.words[0].text).toBe('project0');
});
