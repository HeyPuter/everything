import { describe, it, expect } from 'vitest';
import { findFillers, findPauses, rangesForWords, removalOrder, wordAt, transcriptText, parseJsonArray, translateLines, anchorWords, transcriptWords } from '../src/media/transcript.js';
import { removeRange, mainTrack, addClip, setSpeed, detachAudio } from '../src/model/timeline.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { removeRanges } from '../src/ui/panels/transcript.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain, s, noOverlaps } from './helpers.js';

const W = (list) => list.map(([text, a, b]) => ({ text, start: s(a), end: s(b) }));

describe('transcript helpers', () => {
  const words = W([['So', 0, 0.3], ['um,', 0.4, 0.6], ['today', 0.7, 1.1], ['we', 3.2, 3.25], ['like', 3.3, 3.5], ['you', 3.6, 3.7], ['know', 3.7, 3.9], ['start', 4, 4.4]]);

  it('finds filler words, with soft fillers on request', () => {
    expect(findFillers(words)).toEqual([1]);
    expect(findFillers(words, { soft: true })).toEqual([1, 4, 5, 6]);
  });

  it('never cuts real words as fillers', () => {
    const say = (text) => text.split(' ').map((t, i) => ({ text: t, start: i, end: i + 0.5 }));
    const found = (text, language, soft = false) => {
      const w = say(text);
      return findFillers(w, { language, soft }).map((i) => w[i].text);
    };
    expect(found('Este video es muy bueno, eh, pues este es el mejor', 'es')).toEqual(['eh,']);
    expect(found('Este video es muy bueno, pues este', 'es', true)).toEqual(['Este', 'pues', 'este']);
    expect(found('O filme é muito bom, hum, é um tipo de filme', 'pt')).toEqual(['hum,']);
    expect(found('Il film è bello, cioè molto bello', 'it')).toEqual([]);
    expect(found('Er ist um acht Uhr, äh, gekommen', 'de')).toEqual(['äh,']);
    // Spoken language not chosen: English fillers only when it reads as English.
    expect(found('Er ist um acht Uhr, hmm, gekommen', 'auto')).toEqual(['hmm,']);
    expect(found('So um this is what we do, er, with the tool', 'auto')).toEqual(['um', 'er,']);
  });

  it('finds long pauses and leaves breathing room', () => {
    const p = findPauses(words, { minGap: s(1.2), pad: s(0.2) });
    expect(p).toEqual([{ start: s(1.3), end: s(3) }]);
  });

  it('turns words into cut ranges that stop halfway into the silence', () => {
    const r = rangesForWords(words, [1], { pad: s(0.06) });
    expect(r).toEqual([{ start: s(0.35), end: s(0.65) }]);
    // Neighbouring words merge into one range.
    expect(rangesForWords(words, [5, 6]).length).toBe(1);
  });

  it('orders removals from last to first and merges overlaps', () => {
    expect(removalOrder([{ start: 0, end: 5 }, { start: 10, end: 20 }, { start: 4, end: 6 }])).toEqual([{ start: 10, end: 20 }, { start: 0, end: 6 }]);
  });

  it('finds the word at a time and builds text', () => {
    expect(wordAt(words, s(0.5))).toBe(1);
    expect(wordAt(words, s(2))).toBe(-1);
    expect(transcriptText(words)).toBe('So um, today\n\nwe like you know start');
  });

  it('reads JSON arrays out of chat replies', () => {
    expect(parseJsonArray('Sure!\n```json\n["a", "b"]\n```', 2)).toEqual(['a', 'b']);
    expect(parseJsonArray({ message: { content: [{ text: '["x"]' }] } })).toEqual(['x']);
    expect(() => parseJsonArray('["a"]', 2)).toThrow();
  });

  it('translates in batches through an injected chat', async () => {
    const calls = [];
    const chat = async (prompt) => {
      calls.push(prompt);
      const arr = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      return JSON.stringify(arr.map((x) => x.toUpperCase()));
    };
    const out = await translateLines(['a', 'b', 'c'], 'Shouting', { chat, batch: 2 });
    expect(out).toEqual(['A', 'B', 'C']);
    expect(calls.length).toBe(2);
  });
});

describe('removeRange', () => {
  it('cuts a span from every unlocked track and closes the gap', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    const a = clip('audio', 0, 8);
    addClip(p, a, { ripple: false });
    p.markers.push({ id: 'm', time: s(7), color: '#ffffff', label: '' }, { id: 'n', time: s(3), color: '#ffffff', label: '' });
    p.range = { in: s(1), out: s(6) };
    p.transcript = { language: 'en', words: W([['a', 1, 2], ['b', 3, 3.5], ['c', 6, 7]]) };
    removeRange(p, s(2), s(5));
    const main = mainTrack(p);
    expect(main.clips.map((c) => [c.start / 1e6, c.duration / 1e6, c.in / 1e6])).toEqual([[0, 2, 0], [2, 3, 1]]);
    const audio = p.tracks.find((t) => t.kind === 'audio').clips;
    expect(audio.map((c) => [c.start / 1e6, c.duration / 1e6, c.in / 1e6])).toEqual([[0, 2, 0], [2, 3, 5]]);
    expect(p.markers.map((m) => m.time)).toEqual([s(4)]);
    expect(p.range).toEqual({ in: s(1), out: s(3) });
    expect(p.transcript.words.map((w) => w.text)).toEqual(['a', 'c']);
    expect(p.transcript.words[1].start).toBe(s(3));
  });

  it('can leave the gap and skips locked tracks', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 8));
    const a = clip('audio', 0, 8);
    addClip(p, a, { ripple: false });
    p.tracks.find((t) => t.kind === 'audio').locked = true;
    removeRange(p, s(2), s(4), { close: false });
    expect(mainTrack(p).clips.map((c) => [c.start / 1e6, c.duration / 1e6])).toEqual([[0, 2], [4, 4]]);
    expect(p.tracks.find((t) => t.kind === 'audio').clips[0].duration).toBe(s(8));
  });

  const layout = (track) => track.clips.map((c) => [c.start / 1e6, c.duration / 1e6, c.in / 1e6]);

  it('takes whole clips when a cut ends just past an edit point', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 2, { in: s(2) }), clip('video', 4, 2, { in: s(4) }));
    removeRange(p, s(1), s(2.01));
    expect(layout(mainTrack(p))).toEqual([[0, 1, 0], [1, 2, 2], [3, 2, 4]]);
  });

  it('takes whole clips when a cut starts just before an edit point', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2), clip('video', 2, 2, { in: s(2) }), clip('video', 4, 2, { in: s(4) }));
    removeRange(p, s(1.99), s(3));
    expect(layout(mainTrack(p))).toEqual([[0, 2, 0], [2, 1, 3], [3, 2, 4]]);
    removeRange(p, s(2.01), s(2.5));
    expect(layout(mainTrack(p))).toEqual([[0, 2, 0], [2, 0.5, 3.5], [2.5, 2, 4]]);
  });

  it('shaves slivers off other tracks so nothing overlaps after the cut', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    addClip(p, clip('audio', 0, 2.01), { ripple: false });
    addClip(p, clip('audio', 2.01, 3, { in: s(5) }), { ripple: false });
    addClip(p, clip('audio', 5.01, 1), { ripple: false });
    removeRange(p, s(2), s(5));
    expect(noOverlaps(p)).toBe(true);
    const audio = p.tracks.find((t) => t.kind === 'audio');
    expect(layout(audio)).toEqual([[0, 2, 0], [2.01, 1, 0]]);
  });

  it('keeps transcripts through normalization', () => {
    const p = fixture();
    p.transcript = { language: 'en', words: [{ text: ' hi ', start: 5, end: 9 }, { text: '', start: 1, end: 2 }, { text: 'x', start: 'a', end: 1 }] };
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.transcript).toEqual({ language: 'en', words: [{ text: 'hi', start: 5, end: 9 }] });
  });
});

describe('transcript words follow their media', () => {
  // Two 4 s clips of one recording; the words were heard at these timeline times.
  function talk() {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4, { in: s(4) }));
    const heard = W([['alpha', 0.5, 1], ['beta', 1.5, 2], ['gamma', 4.5, 5], ['delta', 5.5, 6]]);
    p.transcript = { language: 'en', words: anchorWords(p, heard) };
    return { p, a, b };
  }
  const placed = (p) => transcriptWords(p).map((w) => `${w.text}@${w.start / 1e6}`);

  it('anchors each word to the media and source time under it', () => {
    const { p } = talk();
    expect(p.transcript.words[2]).toMatchObject({ text: 'gamma', a: 'vid', s: s(4.5), e: s(5) });
    expect(placed(p)).toEqual(['alpha@0.5', 'beta@1.5', 'gamma@4.5', 'delta@5.5']);
  });

  it('follows a ripple delete, so cutting a word cuts that word', () => {
    const { p, a } = talk();
    const store = new EditorStore(p);
    const ctx = { store, player: null, library: {} };
    ctx.actions = createActions(ctx);
    store.select(a.id);
    ctx.actions.deleteSelected();
    expect(placed(store.project)).toEqual(['gamma@0.5', 'delta@1.5']);
    removeRanges(store, rangesForWords(transcriptWords(store.project), [0]), 'Cut word');
    expect(placed(store.project)).toEqual(['delta@0.88']);
    expect(mainTrack(store.project).clips.map((c) => [c.start / 1e6, c.duration / 1e6, c.in / 1e6])).toEqual([[0, 0.44, 4], [0.44, 2.94, 5.06]]);
  });

  it('follows moves, trims and speed changes', () => {
    const { p, a, b } = talk();
    // Swap the clips, then play the second half twice as fast.
    b.start = 0;
    a.start = s(4);
    mainTrack(p).clips.reverse();
    expect(placed(p)).toEqual(['gamma@0.5', 'delta@1.5', 'alpha@4.5', 'beta@5.5']);
    setSpeed(p, a.id, 2);
    expect(placed(p)).toEqual(['gamma@0.5', 'delta@1.5', 'alpha@4.25', 'beta@4.75']);
    a.in = s(1);
    a.duration = s(1);
    expect(placed(p)).toEqual(['gamma@0.5', 'delta@1.5', 'beta@4.25']);
  });

  it('keeps its words while the speech is muted, disabled or soloed away', () => {
    const { p, a, b } = talk();
    const all = ['alpha@0.5', 'beta@1.5', 'gamma@4.5', 'delta@5.5'];
    a.muted = true;
    b.disabled = true;
    expect(placed(p)).toEqual(all);
    a.muted = false;
    b.disabled = false;
    mainTrack(p).muted = true;
    expect(placed(p)).toEqual(all);
    mainTrack(p).muted = false;
    addClip(p, clip('audio', 0, 2), { ripple: false });
    p.tracks.find((t) => t.kind === 'audio').solo = true;
    expect(placed(p)).toEqual(all);
  });

  it('follows sound detached to its own clip, once', () => {
    const { p, b } = talk();
    const sound = detachAudio(p, b.id);
    sound.muted = true;
    expect(placed(p)).toEqual(['alpha@0.5', 'beta@1.5', 'gamma@4.5', 'delta@5.5']);
    sound.start = s(10);
    expect(placed(p)).toEqual(['alpha@0.5', 'beta@1.5', 'gamma@10.5', 'delta@11.5']);
  });

  it('places an hour of words over thousands of clips quickly', () => {
    // About what Remove silences leaves of an hour of speech.
    const p = fixture();
    p.assets.vid.duration = s(3600);
    const n = 3000;
    const len = s(3600) / n;
    onMain(p, ...Array.from({ length: n }, (_, i) => clip('video', (i * len) / 1e6, len / 1e6, { in: i * len })));
    const heard = Array.from({ length: 9000 }, (_, i) => ({ text: `w${i}`, start: i * 330_000, end: i * 330_000 + 300_000 }));
    p.transcript = { language: 'en', words: anchorWords(p, heard) };
    const t0 = performance.now();
    const words = transcriptWords(p);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(words).toHaveLength(9000);
    expect(words[4500]).toEqual({ text: 'w4500', start: 4500 * 330_000, end: 4500 * 330_000 + 300_000 });
  });

  it('survives saving and keeps older transcripts as they were', () => {
    const { p } = talk();
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.transcript.words[3]).toEqual({ text: 'delta', start: s(5.5), end: s(6), a: 'vid', s: s(5.5), e: s(6) });
    const old = fixture();
    onMain(old, clip('video', 0, 8));
    old.transcript = { language: 'en', words: W([['hi', 1, 2]]) };
    removeRange(old, s(0), s(0.5));
    expect(transcriptWords(old)).toEqual(W([['hi', 0.5, 1.5]]));
  });
});
