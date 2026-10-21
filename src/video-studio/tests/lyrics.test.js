import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resample, isolateVocals, lyricLines, barTimes, lyricsFromClip, songClips, LYRIC_STYLE } from '../src/media/lyrics.js';
import { captionsTab } from '../src/ui/panels/captions.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeClip, makeTrack } from '../src/model/project.js';
import { setPref } from '../src/ui/prefs.js';
import { US } from '../src/lib/time.js';
import { fixture, clip, onMain } from './helpers.js';

const SR = 16000;
const W = (text, start, end) => ({ text, start, end });

/** A song: a centered 440 Hz "voice" from 0.5 s and a 1300 Hz "guitar" only on the left. */
function song(seconds = 1.5) {
  const n = Math.round(SR * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = i >= SR / 2 ? 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0;
    L[i] = v + 0.3 * Math.sin((2 * Math.PI * 1300 * i) / SR);
    R[i] = v;
  }
  return [L, R];
}

function level(x, f, from, to = x.length) {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    re += x[i] * Math.cos((2 * Math.PI * f * i) / SR);
    im += x[i] * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return (Math.hypot(re, im) / (to - from)) * 2;
}

describe('lyrics audio', () => {
  it('resamples to the speech rate', () => {
    const x = new Float32Array(48000).fill(0.5);
    const y = resample(x, 48000, 16000);
    expect(y.length).toBe(16000);
    expect(y[100]).toBeCloseTo(0.5, 5);
    expect(resample(x, 16000, 16000)).not.toBe(x);
    const up = resample(Float32Array.from([0, 1]), 8000, 16000);
    expect(up[1]).toBeCloseTo(0.5, 5);
  });

  it('keeps the centered voice, drops the side guitar, and stays in time', () => {
    const [L, R] = song();
    const v = isolateVocals([L, R], SR);
    expect(v.length).toBe(L.length);
    const from = Math.round(SR * 0.8);
    // The mono mix has the voice at half level (L+R)/2 plus the guitar at half level.
    expect(level(v, 440, from)).toBeGreaterThan(0.2);
    expect(level(v, 1300, from)).toBeLessThan(0.03);
    // Latency is taken out: almost nothing before the voice starts, the voice right after.
    expect(level(v, 440, Math.round(SR * 0.3), Math.round(SR * 0.45))).toBeLessThan(0.03);
    expect(level(v, 440, Math.round(SR * 0.6), Math.round(SR * 0.75))).toBeGreaterThan(0.15);
  });
});

describe('lyricLines', () => {
  it('ends lines at breaths and sentence ends, without trailing commas', () => {
    const words = [W('Hold', 0, 0.3), W('on,', 0.35, 0.6), W('hold', 1.3, 1.5), W('on.', 1.55, 1.8), W('Again', 1.9, 2.2)];
    const lines = lyricLines(words);
    expect(lines.map((l) => l.text)).toEqual(['Hold on', 'hold on', 'Again']);
    expect(lines[0].start).toBe(0);
    // Held a little past the last word but never into the next line.
    expect(lines[0].end).toBeCloseTo(1.2);
    expect(lines[1].end).toBeCloseTo(1.85);
    expect(lines[2].end).toBeCloseTo(2.8);
  });

  it('starts a new line on a bar once the line has a few words', () => {
    // Beats every 0.5 s; words every 0.25 s with no pauses.
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5);
    const words = Array.from({ length: 12 }, (_, i) => W(`w${i}`, i * 0.25, i * 0.25 + 0.2));
    const lines = lyricLines(words, { beats, maxWords: 20, maxChars: 200 });
    // Bars every 2 s: lines start at 0, 2 (word 8).
    expect(lines.map((l) => l.start)).toEqual([0, 2]);
    expect(lines[0].text.split(' ')).toHaveLength(8);
  });

  it('splits a full line where the singer leaves the most room', () => {
    const words = [W('one', 0, 0.2), W('two', 0.22, 0.4), W('three', 0.42, 0.6), W('four', 0.9, 1.1), W('five', 1.12, 1.3), W('six', 1.32, 1.5)];
    const lines = lyricLines(words, { maxWords: 5, pause: 5 });
    expect(lines.map((l) => l.text)).toEqual(['one two three', 'four five six']);
  });

  it('phases bars to the beat words start on', () => {
    const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
    expect(barTimes(beats, [W('a', 0.5, 0.6), W('b', 2.5, 2.6)])).toEqual([0.5, 2.5]);
    expect(barTimes([0, 1], [])).toEqual([]);
    expect(lyricLines([])).toEqual([]);
    expect(lyricLines(null)).toEqual([]);
  });
});

function project() {
  const p = fixture();
  const [v] = onMain(p, clip('video', 0, 6));
  const track = { ...makeTrack('audio'), clips: [] };
  // A song played from 2 s into its file, at double speed, starting at 1 s on the timeline.
  const music = makeClip('audio', { assetId: 'aud', start: 1 * US, duration: 4 * US, in: 2 * US, speed: 2, name: 'Song' });
  track.clips.push(music);
  p.tracks.push(track);
  return { p, v, music };
}

describe('lyricsFromClip', () => {
  it('lists song clips, music first', () => {
    const { p, v, music } = project();
    expect(songClips(p).map((s) => s.clip.id)).toEqual([music.id, v.id]);
  });

  it('isolates, transcribes and maps words through the clip timing', async () => {
    const { p, music } = project();
    const steps = [];
    const separate = vi.fn((channels) => channels[0]);
    const transcribe = vi.fn(async () => [W('Hello', 0.5, 1), W('world.', 1.1, 1.6), W('Late', 9, 9.5)]);
    const res = await lyricsFromClip(p, music.id, {
      decode: async () => ({ sampleRate: 48000, channels: song(3).map((c) => resample(c, SR, 48000)) }),
      separate,
      transcribe,
      beats: () => ({ beats: [0, 0.5, 1] }),
      onStep: (s, f) => !f && steps.push(s),
    });
    expect(steps).toEqual(['decode', 'isolate', 'transcribe', 'phrase']);
    expect(separate).toHaveBeenCalledOnce();
    expect(separate.mock.calls[0][1]).toBe(SR);
    expect(transcribe.mock.calls[0][1]).toBe(SR);
    expect(res.isolated).toBe(true);
    // Source 0.5 s plays at timeline 1 + 0.5 / 2 = 1.25 s; the word past the clip's end is dropped.
    expect(res.cues).toHaveLength(1);
    expect(res.cues[0].text).toBe('Hello world');
    expect(res.cues[0].start).toBeCloseTo(1.25);
    expect(res.cues[0].end).toBeLessThanOrEqual(5);
  });

  it('separates the singing and finds the beat off the main thread, and stops it on cancel', async () => {
    const workers = [];
    vi.stubGlobal('Worker', class {
      constructor(url) {
        this.url = String(url);
        this.terminated = false;
        workers.push(this);
      }
      postMessage(msg) {
        this.msg = msg;
      }
      terminate() {
        this.terminated = true;
      }
    });
    try {
      const { p, music } = project();
      const ac = new AbortController();
      const steps = [];
      const run = lyricsFromClip(p, music.id, {
        signal: ac.signal,
        decode: async () => ({ sampleRate: SR, channels: song(1) }),
        transcribe: async () => [W('La', 0.6, 0.9)],
        onStep: (st, f) => steps.push([st, f]),
      });
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      expect(workers[0].url).toMatch(/lyrics-worker\.js/);
      expect(workers[0].msg).toMatchObject({ op: 'isolate', sr: SR });
      workers[0].onmessage({ data: { progress: 0.5 } });
      expect(steps.at(-1)).toEqual(['isolate', 0.5]);
      workers[0].onmessage({ data: { ok: true, result: new Float32Array(SR) } });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(workers[0].terminated).toBe(true);
      expect(workers[1].msg).toMatchObject({ op: 'beats', sr: SR });
      ac.abort();
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(workers[1].terminated).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('works without workers', async () => {
    const { p, music } = project();
    expect(typeof Worker).toBe('undefined');
    const res = await lyricsFromClip(p, music.id, { decode: async () => ({ sampleRate: SR, channels: song(1.5) }), transcribe: async () => [W('La', 0.6, 0.9)] });
    expect(res).toMatchObject({ isolated: true, words: 1 });
  });

  it('skips isolation when asked and reports unreadable clips', async () => {
    const { p, music } = project();
    const separate = vi.fn();
    const res = await lyricsFromClip(p, music.id, {
      isolate: false,
      decode: async () => ({ sampleRate: SR, channels: song(1) }),
      separate,
      transcribe: async () => [],
      beats: () => null,
    });
    expect(separate).not.toHaveBeenCalled();
    expect(res).toEqual({ cues: [], isolated: false, words: 0 });
    await expect(lyricsFromClip(p, music.id, { decode: async () => null })).rejects.toThrow(/couldn't be read/);
    await expect(lyricsFromClip(p, 'nope', {})).rejects.toThrow(/song clip/);
  });
});

describe('Lyrics in the Captions tab', () => {
  let tab;
  let store;

  function mount({ signedIn = true, deps } = {}) {
    const { p, music } = project();
    store = new EditorStore(p);
    const ctx = { store, player: null, library: { backend: { kind: signedIn ? 'puter' : 'opfs' } }, account: { onSignIn: vi.fn() }, lyricsDeps: deps };
    ctx.actions = createActions(ctx);
    tab = captionsTab(ctx);
    document.body.append(tab.el);
    [...tab.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'Lyrics').click();
    return { ctx, music };
  }

  beforeEach(() => {
    setPref('captionOpts', {});
    globalThis.puter = { ai: {} };
  });

  afterEach(() => {
    tab?.dispose();
    tab?.el.remove();
    delete globalThis.puter;
    document.querySelectorAll('.dialog, dialog').forEach((d) => d.remove());
  });

  it('asks to sign in when signed out', () => {
    const { ctx } = mount({ signedIn: false });
    expect(tab.el.textContent).toMatch(/Sign in to create lyrics/);
    [...tab.el.querySelectorAll('button')].find((b) => b.textContent.includes('Sign in to Puter')).click();
    expect(ctx.account.onSignIn).toHaveBeenCalled();
  });

  it('creates lyric captions in a lyric look as one undo step', async () => {
    const transcribe = vi.fn(async () => [W('We', 0.2, 0.4), W('sing', 0.45, 0.8), W('loud', 0.85, 1.2), W('Tonight', 2.4, 2.9)]);
    const { music } = mount({ deps: { decode: async () => ({ sampleRate: SR, channels: song(3) }), transcribe, beats: () => null } });
    const select = tab.el.querySelector('.lyr-form select.select');
    expect(select.value).toBe(music.id);
    expect(tab.el.querySelector('.lyr-form [role=switch]').getAttribute('aria-checked')).toBe('true');
    const create = [...tab.el.querySelectorAll('button')].find((b) => b.textContent === 'Create lyrics');
    create.click();
    await vi.waitFor(() => expect(store.project.tracks.flatMap((t) => t.clips).filter((c) => c.caption)).toHaveLength(2));
    const caps = store.project.tracks.flatMap((t) => t.clips).filter((c) => c.caption).sort((a, b) => a.start - b.start);
    expect(caps.map((c) => c.text)).toEqual(['We sing loud', 'Tonight']);
    expect(caps.every((c) => c.captionStyle === LYRIC_STYLE)).toBe(true);
    expect(caps[0].animLoop?.id).toBe('karaoke');
    expect(caps[0].start).toBe(Math.round((1 + 0.1) * US));
    expect(store.history.undoLabel).toBe('Lyrics from music');
    store.undo();
    expect(store.project.tracks.flatMap((t) => t.clips).some((c) => c.caption)).toBe(false);
  });

  it('tells when there is no song to use', () => {
    mount({ deps: {} });
    store.update('Remove', (p) => {
      for (const t of p.tracks) t.clips = [];
    });
    expect(tab.el.querySelector('.lyr-empty').hidden).toBe(false);
    expect([...tab.el.querySelectorAll('button')].find((b) => b.textContent === 'Create lyrics').disabled).toBe(true);
  });
});
