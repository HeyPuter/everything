import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  groupWords, joinWords, wrapCaption, segmentsToWords, distributeText, speechRegions,
  parseSubtitles, toSrt, buildCaptionClips, captionCues, splitForTranscription, lineCharsFor, CAPTION_POSITIONS,
  mixdown,
} from '../src/media/transcribe.js';
import { captionsTab } from '../src/ui/panels/captions.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip, onMain, s } from './helpers.js';
import { createProject } from '../src/model/project.js';
import { TEXT_PRESETS } from '../src/model/catalog.js';

const W = (text, start, end) => ({ text, start, end });

// Decoding needs WebCodecs; the Generate test only needs a mix to hand on.
vi.mock('../src/media/transcribe.js', async (orig) => ({ ...(await orig()), mixdown: vi.fn(async () => new Float32Array(16000)) }));

describe('groupWords', () => {
  it('caps words per caption', () => {
    const words = 'one two three four five six seven'.split(' ').map((t, i) => W(t, i * 0.3, i * 0.3 + 0.25));
    const g = groupWords(words, { maxWords: 3, maxChars: 100, maxGap: 5 });
    expect(g.map((c) => c.text)).toEqual(['one two three', 'four five six', 'seven']);
    expect(g[0].start).toBe(0);
    expect(g[0].end).toBeCloseTo(0.85);
    expect(g[2].start).toBeCloseTo(1.8);
  });

  it('caps characters per caption', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta'].map((t, i) => W(t, i, i + 0.5));
    const g = groupWords(words, { maxWords: 10, maxChars: 11, maxGap: 5 });
    expect(g.map((c) => c.text)).toEqual(['alpha beta', 'gamma delta']);
  });

  it('starts a new caption after a long pause', () => {
    const g = groupWords([W('hi', 0, 0.2), W('there', 0.3, 0.5), W('later', 3, 3.4)], { maxWords: 10, maxGap: 1 });
    expect(g.map((c) => c.text)).toEqual(['hi there', 'later']);
  });

  it('ends captions at sentence ends and half-full commas', () => {
    const words = [W('Hello.', 0, 0.3), W('How', 0.4, 0.5), W('are', 0.5, 0.6), W('you,', 0.6, 0.8), W('friend?', 0.9, 1.2)];
    const g = groupWords(words, { maxWords: 6, maxGap: 5 });
    expect(g.map((c) => c.text)).toEqual(['Hello.', 'How are you,', 'friend?']);
  });

  it('attaches punctuation tokens and accepts the word field', () => {
    const g = groupWords([{ word: 'Yes', start: 0, end: 0.2 }, W(',', 0.2, 0.2), W('sure', 0.3, 0.5), W('.', 0.5, 0.5), W('ok', 1, 1.2)], { maxWords: 6 });
    expect(g.map((c) => c.text)).toEqual(['Yes, sure.', 'ok']);
    expect(g[0].end).toBe(0.5);
  });

  it('skips empty and invalid words and sorts by time', () => {
    const g = groupWords([W('b', 1, 1.2), W('', 0, 0), W('a', 0.5, 0.7), { text: 'x', start: 'nope', end: 1 }]);
    expect(g).toEqual([{ start: 0.5, end: 1.2, text: 'a b' }]);
    expect(groupWords([])).toEqual([]);
    expect(groupWords(null)).toEqual([]);
  });

  it('joins CJK without spaces', () => {
    expect(joinWords(['你', '好', 'world'])).toBe('你好 world');
  });
});

describe('wrapCaption', () => {
  it('splits long captions near the middle', () => {
    expect(wrapCaption('the quick brown fox jumps', 12)).toBe('the quick brown\nfox jumps');
    expect(wrapCaption('short', 12)).toBe('short');
    expect(wrapCaption('unbreakablewordthatislong', 5)).toBe('unbreakablewordthatislong');
  });

  it('gives fewer characters per line to narrow projects and big text', () => {
    const p = TEXT_PRESETS.find((x) => x.id === 'yellow-caption');
    expect(lineCharsFor(p, 1080)).toBeLessThan(lineCharsFor(p, 1920));
  });
});

describe('timing fallbacks', () => {
  it('spreads segment words over the segment', () => {
    const w = segmentsToWords([{ start: 1, end: 2, text: 'aa bb' }, { start: 5, end: 6, text: 'cc' }]);
    expect(w.map((x) => x.text)).toEqual(['aa', 'bb', 'cc']);
    expect(w[0].start).toBe(1);
    expect(w[1].end).toBeCloseTo(2);
    expect(w[2]).toEqual({ text: 'cc', start: 5, end: 6 });
  });

  it('spreads plain text over sound regions, skipping silence', () => {
    const w = distributeText('one two', [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
    expect(w[0].start).toBe(0);
    expect(w[1].start).toBeCloseTo(3);
    expect(w[1].end).toBeCloseTo(4);
  });

  it('finds the stretches of sound in a signal', () => {
    const sr = 1000;
    const s = new Float32Array(3 * sr);
    for (let i = 500; i < 1000; i++) s[i] = Math.sin(i);
    for (let i = 2000; i < 2600; i++) s[i] = Math.sin(i) * 0.5;
    const r = speechRegions(s, sr);
    expect(r).toHaveLength(2);
    expect(r[0].start).toBeCloseTo(0.45, 1);
    expect(r[0].end).toBeCloseTo(1.05, 1);
    expect(r[1].start).toBeCloseTo(1.95, 1);
    expect(speechRegions(new Float32Array(100), sr)).toEqual([]);
  });

  it('splits long mixes at quiet points with offsets', () => {
    const sr = 100;
    const s = new Float32Array(25 * sr).fill(0.5);
    s.fill(0, 9.3 * sr, 9.5 * sr);
    const pieces = splitForTranscription(s, sr, 10);
    expect(pieces.length).toBe(3);
    expect(pieces[0].offset).toBe(0);
    expect(pieces[1].offset).toBeGreaterThan(9.2);
    expect(pieces[1].offset).toBeLessThan(9.6);
    expect(pieces.reduce((n, p) => n + p.samples.length, 0)).toBe(s.length);
    for (const p of pieces) expect(p.samples.length).toBeLessThanOrEqual(10 * sr);
    expect(splitForTranscription(new Float32Array(10), sr, 10)).toHaveLength(1);
  });
});

describe('subtitle files', () => {
  it('parses SubRip', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>there</i>\r\n\r\n2\r\n00:00:03,250 --> 00:00:04,000\r\nTwo\r\nlines\r\n';
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello there' },
      { start: 3.25, end: 4, text: 'Two\nlines' },
    ]);
  });

  it('parses WebVTT with headers, settings, notes and short times', () => {
    const vtt = 'WEBVTT\nKind: captions\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.000 align:start position:10%\n<v Speaker>Hi &amp; bye</v>\n\n01:00:00.5 --> 01:00:01.000\nLate\n';
    expect(parseSubtitles(vtt)).toEqual([
      { start: 1, end: 2, text: 'Hi & bye' },
      { start: 3600.5, end: 3601, text: 'Late' },
    ]);
  });

  it('keeps text that only looks like markup, and drops real tags', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nif a < b and c > d\n\n2\n00:00:03,000 --> 00:00:04,000\n<font color="#ff0">One</font> <00:00:03.500><c.loud>two</c> <b>3</b> <3\n';
    expect(parseSubtitles(srt).map((c) => c.text)).toEqual(['if a < b and c > d', 'One two 3 <3']);
  });

  it('drops HTML left in converted subtitles and turns <br> into a line break', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nline one<br>line two<br/>three\n\n2\n00:00:03,000 --> 00:00:04,000\n<span style="color:red">Yellow</span> <em>text</em> <p>para</p>\n';
    expect(parseSubtitles(srt).map((c) => c.text)).toEqual(['line one\nline two\nthree', 'Yellow text para']);
  });

  it('round-trips captions with blank lines in them', () => {
    const cues = [{ start: 1, end: 2, text: 'First line\n\n  \nafter blank' }, { start: 3, end: 4, text: 'Second' }];
    expect(parseSubtitles(toSrt(cues))).toEqual([{ start: 1, end: 2, text: 'First line\nafter blank' }, { start: 3, end: 4, text: 'Second' }]);
  });

  it('skips broken cues', () => {
    expect(parseSubtitles('1\n00:00:02,000 --> 00:00:01,000\nbackwards\n\n2\nno timing\n\n3\n00:00:01,000 --> 00:00:02,000\n\n')).toEqual([]);
  });

  it('writes SubRip that parses back', () => {
    const cues = [{ start: 0, end: 1.234, text: 'First' }, { start: 3661.5, end: 3662, text: 'Second\nline' }, { start: 4000, end: 4001, text: '  ' }];
    const srt = toSrt(cues);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,234\nFirst\n\n2\n01:01:01,500 --> 01:01:02,000\nSecond\nline\n');
    expect(parseSubtitles(srt)).toEqual(cues.slice(0, 2));
  });
});

describe('buildCaptionClips', () => {
  it('makes non-overlapping caption text clips in microseconds', () => {
    const clips = buildCaptionClips([
      { start: 1, end: 2.2, text: 'b' },
      { start: 0, end: 1.5, text: 'a' },
      { start: 3, end: 3.05, text: 'short' },
      { start: 5, end: 6, text: '   ' },
    ], { presetId: 'yellow-caption', position: 'top' });
    expect(clips.map((c) => c.text)).toEqual(['a', 'b', 'short']);
    expect(clips[0].start).toBe(0);
    expect(clips[0].start + clips[0].duration).toBe(1_000_000);
    expect(clips[1].start).toBe(1_000_000);
    expect(clips[2].duration).toBe(400_000);
    for (const c of clips) {
      expect(c.type).toBe('text');
      expect(c.caption).toBe(true);
      expect(c.preset).toBe('yellow-caption');
      expect(c.style.color).toBe('#ffe14d');
      expect(c.transform.y).toBe(CAPTION_POSITIONS.top);
    }
  });

  it('shows cues that start together as one caption instead of a one-frame flash', () => {
    const clips = buildCaptionClips([
      { start: 1, end: 2, text: 'Speaker A' },
      { start: 1, end: 2.5, text: 'Speaker B says more' },
      { start: 3, end: 4, text: 'Next' },
    ], { lineChars: 12 });
    expect(clips.map((c) => [c.start / 1e6, c.duration / 1e6, c.text])).toEqual([[1, 1.5, 'Speaker A\nSpeaker B\nsays more'], [3, 1, 'Next']]);
  });

  it('applies an offset and wraps long lines', () => {
    const [c] = buildCaptionClips([{ start: 0, end: 1, text: 'one two three four' }], { offset: 2, lineChars: 8 });
    expect(c.start).toBe(2_000_000);
    expect(c.text).toBe('one two\nthree four');
    expect(c.preset).toBe('subtitle');
  });

  it('reads caption cues back from a project', () => {
    const p = createProject();
    const clips = buildCaptionClips([{ start: 0, end: 1, text: 'x' }, { start: 1, end: 2, text: 'y' }]);
    p.tracks.unshift({ id: 't1', kind: 'text', locked: false, hidden: false, muted: false, clips });
    expect(captionCues(p)).toEqual([{ start: 0, end: 1, text: 'x' }, { start: 1, end: 2, text: 'y' }]);
  });
});

describe('Generate captions in the Captions tab', () => {
  afterEach(() => {
    delete globalThis.puter;
    delete globalThis.__vsFakeTranscript;
    document.body.replaceChildren();
  });

  it('Generate adds captions from the speech', async () => {
    setPref('captionOpts', {});
    globalThis.puter = { ai: {} };
    globalThis.__vsFakeTranscript = async () => [W('Hello', 0.2, 0.5), W('there', 0.6, 0.9)];
    const p = fixture();
    onMain(p, clip('video', 0, 6));
    const store = new EditorStore(p);
    const ctx = { store, player: null, library: { backend: { kind: 'puter' } }, account: {} };
    ctx.actions = createActions(ctx);
    const tab = captionsTab(ctx);
    document.body.append(tab.el);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gen = [...tab.el.querySelectorAll('.cap-form button')].find((b) => b.textContent === 'Generate');
    gen.click();
    await vi.waitFor(() => expect(store.project.tracks.flatMap((t) => t.clips).filter((c) => c.caption)).toHaveLength(1));
    expect(store.project.tracks.flatMap((t) => t.clips).find((c) => c.caption).text).toBe('Hello there');
    expect(err).not.toHaveBeenCalled();
    expect(mixdown).toHaveBeenCalled();
    expect(gen.disabled).toBe(false);
    err.mockRestore();
    tab.dispose?.();
  });
});

describe('Transcript in the Captions tab', () => {
  afterEach(() => {
    delete globalThis.puter;
    delete globalThis.__vsFakeTranscript;
    document.body.replaceChildren();
  });

  it('keeps words on their media after a timeline edit', async () => {
    setPref('captionOpts', {});
    globalThis.puter = { ai: {} };
    globalThis.__vsFakeTranscript = async () => [W('Hello', 0.5, 1), W('there', 4.5, 5)];
    const p = fixture();
    const [first] = onMain(p, clip('video', 0, 4), clip('video', 4, 4, { in: s(4) }));
    const store = new EditorStore(p);
    const ctx = { store, player: null, library: { backend: { kind: 'puter' } }, account: {} };
    ctx.actions = createActions(ctx);
    const tab = captionsTab(ctx);
    document.body.append(tab.el);
    [...tab.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'Transcript').click();
    [...tab.el.querySelectorAll('button')].find((b) => b.textContent === 'Transcribe').click();
    await vi.waitFor(() => expect(tab.el.querySelectorAll('.tr-word')).toHaveLength(2));
    store.select(first.id);
    ctx.actions.deleteSelected();
    const words = [...tab.el.querySelectorAll('.tr-word')];
    expect(words.map((w) => w.textContent)).toEqual(['there']);
    words[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    words[0].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    expect(store.time).toBe(s(0.5));
    tab.dispose?.();
  });
});
