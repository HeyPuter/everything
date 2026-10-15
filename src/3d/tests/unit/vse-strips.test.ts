import { describe, it, expect } from 'vitest';
import * as S from '../../src/sequencer/strips';
import { addFade, clearFade, keyValue, valueAt, crossfadeSounds } from '../../src/sequencer/fades';
import { subtitlesSrt, srtTime, parseSubtitles, parseTime } from '../../src/sequencer/subtitles';
import { changeEffectType, effectTypesFor, swapData } from '../../src/sequencer/stripdata';
import type { Strip } from '../../src/sequencer/types';

const ed = () => S.newSequenceEditor();
function add(e: ReturnType<typeof ed>, type: Strip['type'], channel: number, start: number, dur: number, name?: string) {
  const s = S.newStrip(type, S.uniqueName(e, name ?? S.STRIP_LABELS[type]), channel, start, dur);
  e.strips.push(s);
  return s;
}

describe('fades', () => {
  it('interpolates keys linearly and holds the ends', () => {
    const k: [number, number][] = [
      [10, 0],
      [20, 1],
    ];
    expect(keyValue(k, 0)).toBe(0);
    expect(keyValue(k, 15)).toBeCloseTo(0.5);
    expect(keyValue(k, 30)).toBe(1);
  });

  it('fades opacity in and out over the strip', () => {
    const e = ed();
    const c = add(e, 'COLOR', 1, 1, 100);
    expect(addFade(c, 'IN_OUT', 10, 1)).toBe(true);
    expect(c.keys!.blend_alpha).toEqual([
      [1, 0],
      [11, 1],
      [91, 1],
      [101, 0],
    ]);
    expect(valueAt(c, 'blend_alpha', 6)).toBeCloseTo(0.5);
    expect(valueAt(c, 'blend_alpha', 50)).toBe(1);
    // adding a fade again replaces the keys in its range
    addFade(c, 'IN', 20, 1);
    expect(c.keys!.blend_alpha!.filter((k) => k[0] <= 21)).toEqual([
      [1, 0],
      [21, 1],
    ]);
    expect(clearFade(c)).toBe(true);
    expect(valueAt(c, 'blend_alpha', 1)).toBe(1);
  });

  it('fades sound volume and follows the current frame', () => {
    const e = ed();
    const s = add(e, 'SOUND', 1, 1, 100);
    s.volume = 0.8;
    expect(addFade(s, 'CURSOR_TO', 0, 41)).toBe(true);
    expect(s.keys!.volume).toEqual([
      [1, 0],
      [41, 0.8],
    ]);
    expect(addFade(s, 'CURSOR_FROM', 0, 500)).toBe(false);
  });

  it('keys move with the strip', () => {
    const e = ed();
    const c = add(e, 'COLOR', 1, 1, 50);
    addFade(c, 'IN', 10, 1);
    S.translateStrip(c, 5);
    expect(c.keys!.blend_alpha![0][0]).toBe(6);
  });

  it('crossfades overlapping sounds', () => {
    const e = ed();
    const a = add(e, 'SOUND', 1, 1, 50, 'a');
    const b = add(e, 'SOUND', 2, 41, 50, 'b');
    expect(crossfadeSounds(a, b)).toBe(true);
    expect(valueAt(a, 'volume', 41)).toBe(1);
    expect(valueAt(a, 'volume', 51)).toBe(0);
    expect(valueAt(b, 'volume', 46)).toBeCloseTo(0.5);
    const c = add(e, 'SOUND', 3, 200, 10, 'c');
    expect(crossfadeSounds(a, c)).toBe(false);
  });
});

describe('subtitles', () => {
  it('formats SubRip times', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3723.5)).toBe('01:02:03,500');
  });

  it('writes text strips in time order', () => {
    const e = ed();
    const b = add(e, 'TEXT', 2, 49, 24, 'b');
    b.text = 'Second';
    const a = add(e, 'TEXT', 1, 1, 24, 'a');
    a.text = 'First\nline two';
    const m = add(e, 'TEXT', 1, 100, 10, 'muted');
    m.mute = true;
    expect(subtitlesSrt(e.strips, 24, 1)).toBe('1\n00:00:00,000 --> 00:00:01,000\nFirst\nline two\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond\n');
  });
});

describe('subtitle files', () => {
  it('reads SubRip and WebVTT cues', () => {
    expect(parseTime('01:02:03,500')).toBeCloseTo(3723.5);
    expect(parseTime('00:05.25')).toBeCloseTo(5.25);
    expect(parseTime('nope')).toBeNaN();
    const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>there</i>\r\nsecond line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n';
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello there\nsecond line' },
      { start: 3, end: 4, text: 'Bye' },
    ]);
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000 align:center\nOne\n';
    expect(parseSubtitles(vtt)).toEqual([{ start: 1, end: 2, text: 'One' }]);
  });

  it('round-trips through text strips', () => {
    const e = ed();
    const a = add(e, 'TEXT', 1, 25, 24, 'a');
    a.text = 'Line';
    const cues = parseSubtitles(subtitlesSrt(e.strips, 24, 1));
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Line' }]);
  });
});

describe('strip data edits', () => {
  it('changes effect types within the same input count', () => {
    expect(effectTypesFor('CROSS')).toContain('WIPE');
    expect(effectTypesFor('GLOW')).not.toContain('CROSS');
    expect(effectTypesFor('MOVIE')).toEqual([]);
    const e = ed();
    const x = add(e, 'CROSS', 3, 1, 10);
    changeEffectType(x, 'WIPE');
    expect(x.type).toBe('WIPE');
    expect(x.transition_type).toBe('SINGLE');
    const c = add(e, 'COLOR', 1, 1, 10);
    changeEffectType(c, 'TEXT');
    expect(c.text).toBe('Text');
    expect(c.color!.length).toBe(4);
  });

  it('swaps content between strips of the same kind', () => {
    const e = ed();
    const a = add(e, 'COLOR', 1, 1, 10, 'a');
    a.color = [1, 0, 0];
    const b = add(e, 'TEXT', 2, 50, 10, 'b');
    expect(swapData(a, b)).toBeNull();
    expect(a.type).toBe('TEXT');
    expect(b.color).toEqual([1, 0, 0]);
    expect([a.frame_start, b.frame_start]).toEqual([1, 50]);
    const s = add(e, 'SOUND', 3, 1, 10, 's');
    expect(swapData(a, s)).toMatch(/same kind/);
  });

  it('multicam is a still generator', () => {
    const m = S.newStrip('MULTICAM', 'm', 5, 1, 10);
    expect(S.isStill(m)).toBe(true);
    expect(m.multicam_source).toBe(1);
  });
});
