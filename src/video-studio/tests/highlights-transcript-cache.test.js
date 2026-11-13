import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { mixdown, transcribeMix } from '../src/media/transcribe.js';
import { fixture, clip, onMain } from './helpers.js';
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(), transcribeMix: vi.fn() }));
const dialogs = [], reply = '{"highlights":[{"title":"First","start":20,"end":59}]}';
const words = prefix => Array.from({ length: 240 }, (_, i) => ({ text: `${prefix}${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 }));
const button = (d, text) => [...d.el.querySelectorAll('button')].find(b => b.textContent === text);
const again = d => button(d, 'Search again').click();
const select = (d, name, value) => { const el = d.el.querySelector(`[aria-label="${name}"]`); el.value = value; el.dispatchEvent(new Event('change')); };
beforeEach(() => { setPref('highlights', { language: 'es', target: 'here', captions: 'yellow-caption' }); mixdown.mockReset().mockResolvedValue(new Float32Array(16000)); transcribeMix.mockReset().mockResolvedValue(words('speech').map(w => ({ ...w, start: w.start / 1e6, end: w.end / 1e6 }))); });
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup() {
  const p = fixture(); p.assets.vid.duration = 200e6; onMain(p, clip('video', 0, 120)); p.transcript = { language: 'en', words: words('old') };
  const store = new EditorStore(p), chat = vi.fn(async () => reply), d = openHighlightsDialog({ store, library: {} }, { chat }); dialogs.push(d); return { store, chat, d };
}
it.each(['replacement', 'in-place words', 'undo', 'redo'])('searches current project words after %s', async kind => {
  const e = setup(); await e.d.search();
  e.store.update('Replace transcript', p => { p.transcript = { language: 'en', words: words('new') }; });
  if (kind === 'in-place words') e.store.update('Replace word', p => { p.transcript.words[20].text = 'changed20'; });
  if (kind === 'undo') { again(e.d); await e.d.search(); e.store.undo(); }
  if (kind === 'redo') { e.store.undo(); again(e.d); await e.d.search(); e.store.redo(); }
  again(e.d); await e.d.search();
  const expected = kind === 'undo' ? 'old20' : kind === 'in-place words' ? 'changed20' : 'new20';
  expect(e.chat.mock.calls.at(-1)[0]).toContain(expected); expect(e.d.found[0].excerpt).toContain(expected);
  await e.d.make(); const added = e.store.project.tracks.flatMap(t => t.clips).find(c => c.type === 'compound');
  expect(added.sequence.tracks.flatMap(t => t.clips).find(c => c.type === 'text').text).toContain(expected);
  expect(mixdown).not.toHaveBeenCalled(); expect(transcribeMix).not.toHaveBeenCalled();
});
it('refreshes project words after a failed highlight request', async () => {
  const e = setup(); vi.spyOn(console, 'error').mockImplementation(() => {}); e.chat.mockRejectedValueOnce(new Error('Try again'));
  await e.d.search(); e.store.update('Replace transcript', p => { p.transcript.words = words('new'); }); await e.d.search();
  expect(e.chat.mock.calls[1][0]).toContain('new20'); expect(transcribeMix).not.toHaveBeenCalled();
});
it.each(['clear before first search', 'clear after results', 'partial transcript'])('offers language before transcription on %s', async kind => {
  const e = setup(); if (kind !== 'clear before first search') { await e.d.search(); again(e.d); }
  const calls = e.chat.mock.calls.length;
  e.store.update('Clear transcript', p => { if (kind === 'partial transcript') p.transcript.words = words('short').slice(0, 19); else delete p.transcript; });
  await e.d.search();
  expect(e.d.el.dataset.step).toBe('options'); expect(e.d.el.querySelector('[aria-label="Spoken language"]')).not.toBeNull();
  expect(e.d.el.textContent).not.toContain('speech is not sent again'); expect(e.chat).toHaveBeenCalledTimes(calls); expect(mixdown).not.toHaveBeenCalled(); expect(transcribeMix).not.toHaveBeenCalled();
  select(e.d, 'Spoken language', 'fr'); await e.d.search();
  expect(transcribeMix).toHaveBeenCalledOnce(); expect(transcribeMix.mock.calls[0][2].language).toBe('fr'); expect(e.d.words[0].text).toBe('speech0');
  again(e.d); await e.d.search(); expect(transcribeMix).toHaveBeenCalledOnce();
});
it('keeps a search snapshot when a replacement arrives during selection', async () => {
  const e = setup(); let release; e.chat.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const run = e.d.search(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  e.store.update('Replace transcript', p => { p.transcript.words = words('new'); }); release(reply); await run;
  expect(e.d.found[0].excerpt).toContain('old20'); again(e.d); await e.d.search(); expect(e.d.found[0].excerpt).toContain('new20');
});
it('keeps unchanged project transcript searches free of audio reads and transcription', async () => {
  const e = setup(); await e.d.search(); again(e.d); select(e.d, 'How many', '3'); await e.d.search();
  expect(e.d.words[0].text).toBe('old0'); expect(e.chat).toHaveBeenCalledTimes(2); expect(mixdown).not.toHaveBeenCalled(); expect(transcribeMix).not.toHaveBeenCalled();
});
