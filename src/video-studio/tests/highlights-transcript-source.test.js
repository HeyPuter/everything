import { afterEach, expect, it, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { addTrack, detachAudio } from '../src/model/timeline.js';
import { transcriptWords, anchorWords } from '../src/media/transcript.js';
import { openHighlightsDialog } from '../src/ui/highlights-dialog.js';
import { mixdown, transcribeMix } from '../src/media/transcribe.js';
import { wordsInClip } from '../src/media/highlights.js';
import { fixture, clip, onMain } from './helpers.js';
vi.mock('../src/media/transcribe.js', async original => ({ ...await original(), mixdown: vi.fn(async () => new Float32Array(16000)), transcribeMix: vi.fn(async () => rawWords('selected').map(w => ({ ...w, start: w.start / 1e6, end: w.end / 1e6 }))) }));
const rawWords = (prefix = 'source', n = 240) => Array.from({ length: n }, (_, i) => ({ text: `${prefix}${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500000, end: i * 500000 + 400000 }));
const dialogs = [], reply = '{"highlights":[{"title":"First","start":20,"end":59}]}';
afterEach(() => { dialogs.splice(0).forEach(d => d.close()); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); vi.clearAllMocks(); });
function setup({ legacy = false, sameAsset = false, start = 0, sourceIn = 0, duration = 120e6, speed = 1 } = {}) {
  const p = fixture(); p.assets.vid.duration = 300e6; p.assets.other = { ...p.assets.vid, id: 'other', hash: 'other-content', name: 'Other talk' };
  const base = clip('video', 0, 120); onMain(p, base); p.transcript = { words: legacy ? rawWords() : anchorWords(p, rawWords()) };
  const selected = clip('video', 0, 120, { assetId: sameAsset ? 'vid' : 'other', start, in: sourceIn, duration, speed }); addTrack(p, 'video').clips.push(selected); return { p, base, selected };
}
const localWords = (p, c) => wordsInClip(transcriptWords(p, { clip: c }), c);
it('does not reuse a different overlapping asset transcript', async () => {
  const { p, selected } = setup(), store = new EditorStore(p), chat = vi.fn(async () => reply), d = openHighlightsDialog({ store, library: {} }, { chat, clipId: selected.id }); dialogs.push(d);
  expect(d.el.querySelector('[aria-label="Spoken language"]')).not.toBeNull(); await d.search(); expect(transcribeMix).toHaveBeenCalledOnce(); expect(chat.mock.calls[0][0]).toContain('selected20'); expect(d.words[0].text).toBe('selected0');
});
it('uses only matching anchors from a mixed transcript', () => {
  const { p, selected } = setup(); p.transcript.words.push(...rawWords('selected').map(w => ({ ...w, a: 'other', s: w.start, e: w.end })));
  const words = localWords(p, selected); expect(words).toHaveLength(240); expect(words.every(w => w.text.startsWith('selected'))).toBe(true);
  expect(transcriptWords(p)).toHaveLength(480);
});
it('maps only the selected source range when the same asset overlaps at another in point', () => {
  const { p, selected } = setup({ sameAsset: true, sourceIn: 60e6, duration: 60e6 }); const words = localWords(p, selected); expect(words).toHaveLength(120); expect(words[0]).toMatchObject({ text: 'source120', start: 0, end: 400000 });
});
it('maps anchored words directly to a moved detached source', () => {
  const { p, base, selected } = setup({ sameAsset: true, start: 200e6, duration: 60e6, speed: 2 }); detachAudio(p, base.id); selected.audioDetached = true; selected.muted = true;
  const words = localWords(p, selected); expect(words).toHaveLength(240); expect(words[0]).toMatchObject({ text: 'source0', start: 0, end: 200000 });
});
it('maps speed-curve words like the same source placed alone', () => {
  const { p, selected } = setup({ sameAsset: true, duration: 60e6 }); selected.speedCurve = [{ t: 0, v: 1, k: 'linear' }, { t: 60e6, v: 2, k: 'linear' }];
  const expected = wordsInClip(transcriptWords({ ...p, tracks: [{ clips: [selected] }] }), selected); expect(localWords(p, selected)).toEqual(expected);
});
it('does not duplicate words from multiple copies of the selected asset', () => {
  const { p, selected } = setup({ sameAsset: true }); p.transcript.words.push(...p.transcript.words.map(w => ({ ...w, start: w.start + 200e6, end: w.end + 200e6 })));
  expect(localWords(p, selected)).toHaveLength(240);
});
it.each(['other asset', 'other range', 'muted other', 'nested other'])('does not trust legacy timing with overlapping %s', kind => {
  const { p, selected, base } = setup({ legacy: true, sameAsset: kind === 'other range', sourceIn: kind === 'other range' ? 30e6 : 0 });
  if (kind === 'muted other') base.muted = true;
  if (kind === 'nested other') { p.tracks.find(t => t.clips.includes(base)).clips = [clip('compound', 0, 120, { sequence: { tracks: [{ id: 'inside', kind: 'video', clips: [base] }] } })]; }
  expect(localWords(p, selected)).toEqual([]);
});
it.each(['single', 'same mapping', 'detached', 'non-overlap', 'silent overlay'])('retains unambiguous legacy reuse: %s', kind => {
  const { p, base, selected } = setup({ legacy: true, sameAsset: kind === 'same mapping' });
  let chosen = base;
  if (kind === 'single' || kind === 'detached') p.tracks = p.tracks.filter(t => !t.clips.includes(selected));
  if (kind === 'same mapping') chosen = selected;
  if (kind === 'detached') detachAudio(p, base.id);
  if (kind === 'non-overlap') selected.start = 200e6;
  if (kind === 'silent overlay') p.assets.other.hasAudio = false;
  expect(localWords(p, chosen)).toHaveLength(240);
});
it('keeps the normal project transcript cache separate from selected-clip placement', () => {
  const { p, selected } = setup(); const normal = transcriptWords(p); expect(localWords(p, selected)).toEqual([]); expect(transcriptWords(p)).toEqual(normal); expect(normal).toHaveLength(240);
});
it('reveals language before transcribing if reusable source coverage is replaced', async () => {
  const { p, selected } = setup({ sameAsset: true }), store = new EditorStore(p), chat = vi.fn(async () => reply), d = openHighlightsDialog({ store, library: {} }, { chat, clipId: selected.id }); dialogs.push(d);
  await d.search(); store.update('Replace transcript', p => { p.transcript.words = rawWords('other').map(w => ({ ...w, a: 'other', s: w.start, e: w.end })); }); [...d.el.querySelectorAll('button')].find(b => b.textContent === 'Search again').click(); await d.search();
  expect(d.el.querySelector('[aria-label="Spoken language"]')).not.toBeNull(); expect(chat).toHaveBeenCalledOnce(); expect(mixdown).not.toHaveBeenCalled();
});
