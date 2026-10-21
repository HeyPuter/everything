import { describe, it, expect } from 'vitest';
import { findFillers, findPauses, rangesForWords, removalOrder, wordAt, transcriptText, parseJsonArray, translateLines } from '../src/media/transcript.js';
import { removeRange, mainTrack, addClip } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain, s, noOverlaps } from './helpers.js';

const W = (list) => list.map(([text, a, b]) => ({ text, start: s(a), end: s(b) }));

describe('transcript helpers', () => {
  const words = W([['So', 0, 0.3], ['um,', 0.4, 0.6], ['today', 0.7, 1.1], ['we', 3.2, 3.25], ['like', 3.3, 3.5], ['you', 3.6, 3.7], ['know', 3.7, 3.9], ['start', 4, 4.4]]);

  it('finds filler words, with soft fillers on request', () => {
    expect(findFillers(words)).toEqual([1]);
    expect(findFillers(words, { soft: true })).toEqual([1, 4, 5, 6]);
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
