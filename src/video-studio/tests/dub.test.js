import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dubSegments, segmentText, fitSpeed, placeSpeech, makeDub, MAX_FIT_SPEED } from '../src/media/dub.js';
import { applyDub, openDubDialog, ORIGINAL_LEVELS } from '../src/ui/dub-dialog.js';
import { addClip, allClips } from '../src/model/timeline.js';
import { EditorStore } from '../src/model/store.js';
import { fixture, clip, onMain, s } from './helpers.js';

const cue = (start, end, text) => ({ start, end, text });

describe('dub planning', () => {
  it('joins captions of one sentence and splits at pauses and sentence ends', () => {
    const cues = [cue(0, 1.5, 'Hello and'), cue(1.6, 3, 'welcome back.'), cue(3.1, 4, 'Today we'), cue(6, 7, 'cook.')];
    expect(dubSegments(cues)).toEqual([
      { start: 0, end: 3, cues: [0, 1] },
      { start: 3.1, end: 4, cues: [2] },
      { start: 6, end: 7, cues: [3] },
    ]);
  });

  it('caps a segment length', () => {
    const cues = Array.from({ length: 10 }, (_, i) => cue(i * 2, i * 2 + 1.9, `part ${i}`));
    const segs = dubSegments(cues, { maxLength: 6 });
    expect(segs.every((g) => g.end - g.start <= 6)).toBe(true);
    expect(segs.flatMap((g) => g.cues)).toEqual(cues.map((_, i) => i));
  });

  it('builds a segment text from translated lines', () => {
    expect(segmentText({ cues: [0, 1, 2] }, ['Hola  y', '', 'bienvenidos.'])).toBe('Hola y bienvenidos.');
  });

  it('speeds speech up only as much as needed, within a limit', () => {
    expect(fitSpeed(2, 3)).toBe(1);
    expect(fitSpeed(3.3, 3)).toBe(1.1);
    expect(fitSpeed(10, 3)).toBe(MAX_FIT_SPEED);
    expect(fitSpeed(0, 3)).toBe(1);
  });

  it('places speech at segment starts with room until the next one', () => {
    const segs = [{ start: 0, end: 2, cues: [0] }, { start: 2.5, end: 4, cues: [1] }, { start: 9, end: 10, cues: [2] }];
    const out = placeSpeech(segs, [2.75, 2, 3], 12);
    expect(out).toEqual([{ start: 0, speed: 1.1 }, { start: s(2.5), speed: 1 }, { start: s(9), speed: 1 }]);
  });

  it('translates once and speaks each segment', async () => {
    const translate = vi.fn(async (lines) => lines.map((l) => l.toUpperCase()));
    const speak = vi.fn(async (t) => new Blob([t]));
    const progress = [];
    const out = await makeDub([cue(0, 1, 'a'), cue(1.1, 2, 'b.'), cue(5, 6, 'c')], { translate, speak, onProgress: (f) => progress.push(f) });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(out.lines).toEqual(['A', 'B.', 'C']);
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['A B.', 'C']);
    expect(out.speech).toHaveLength(2);
    expect(progress.at(-1)).toBe(1);
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    const speak = vi.fn(async () => {
      abort.abort();
      return new Blob(['x']);
    });
    await expect(makeDub([cue(0, 1, 'a.'), cue(3, 4, 'b')], { translate: async (l) => l, speak, signal: abort.signal })).rejects.toThrow('Cancelled');
    expect(speak).toHaveBeenCalledTimes(1);
  });
});

describe('applying a dub', () => {
  function project() {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 10));
    const caption = clip('text', 0, 2, { text: 'Hello', caption: true });
    addClip(p, caption, { ripple: false, linkOverlays: false });
    return { p, v, caption };
  }

  it('adds a named audio track, lowers the original and can translate captions', () => {
    const { p, v, caption } = project();
    const track = applyDub(p, { placed: [{ assetId: 'aud', name: 'Speech', start: s(1), speed: 1.2, duration: s(3) }], language: 'Spanish', original: 'lower', lines: ['Hola'], captionIds: [caption.id] });
    expect(track.name).toBe('Dub - Spanish');
    expect(track.kind).toBe('audio');
    expect(track.clips[0]).toMatchObject({ assetId: 'aud', start: s(1), speed: 1.2, duration: s(2.5) });
    expect(v.volume).toBe(ORIGINAL_LEVELS.lower);
    expect(caption.text).toBe('Hola');
  });

  it('keeps earlier dubs and the original when asked', () => {
    const { p, v, caption } = project();
    const first = applyDub(p, { placed: [{ assetId: 'aud', name: 'A', start: 0, speed: 1, duration: s(2) }], language: 'French', original: 'mute' });
    expect(v.volume).toBe(0);
    first.clips[0].volume = 1;
    applyDub(p, { placed: [{ assetId: 'aud', name: 'B', start: 0, speed: 1, duration: s(2) }], language: 'German', original: 'lower' });
    expect(first.clips[0].volume).toBe(1);
    expect(caption.text).toBe('Hello');
  });

  it('moves lines that still overlap to another track', () => {
    const { p } = project();
    applyDub(p, { placed: [{ assetId: 'aud', name: 'A', start: 0, speed: 1, duration: s(3) }, { assetId: 'aud', name: 'B', start: s(2), speed: 1, duration: s(2) }], language: 'Italian', original: 'keep' });
    const dubs = allClips(p).filter((c) => c.type === 'audio');
    expect(dubs).toHaveLength(2);
    expect(new Set(p.tracks.filter((t) => t.clips.some((c) => c.type === 'audio')).map((t) => t.id)).size).toBe(2);
  });
});

describe('dub dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('asks for captions first', () => {
    const p = fixture();
    const store = new EditorStore(p);
    expect(openDubDialog({ store }, { translate: async (l) => l })).toBeNull();
  });

  it('dubs end to end with injected AI', async () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    addClip(p, clip('text', 0, 2, { text: 'Hi there.', caption: true }), { ripple: false, linkOverlays: false });
    const store = new EditorStore(p);
    const imported = [];
    const actions = {
      importFiles: async (files) => files.map((f, i) => {
        const a = { id: `sp${i}`, kind: 'audio', name: f.name, duration: s(1.5), hasAudio: true };
        store.project.assets[a.id] = a;
        imported.push(a);
        return a;
      }),
    };
    const d = openDubDialog({ store, actions }, { translate: async (lines) => lines.map(() => 'Hola.'), speak: async () => new Blob(['x'], { type: 'audio/mpeg' }) });
    [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dub').click();
    await vi.waitFor(() => expect(d.el.isConnected).toBe(false));
    expect(imported).toHaveLength(1);
    const track = store.project.tracks.find((t) => t.name?.startsWith('Dub - '));
    expect(track.name).toBe('Dub - Spanish');
    expect(track.clips[0].assetId).toBe('sp0');
    expect(store.history.undoLabel).toBe('Dub into Spanish');
  });
});
