import { describe, it, expect } from 'vitest';
import { STEP, PPQ } from '../src/model/time.js';
import { createPattern, createNote } from '../src/model/project.js';
import { newProject } from '../src/model/demo.js';
import * as S from '../src/rack/steps.js';
import { matchPreset, presetsFor } from '../src/rack/editor.js';
import { adsrPoints } from '../src/rack/glyphs.js';
import { KEY_MAP } from '../src/rack/keyboard.js';
import { defaultParams } from '../src/instruments/catalog.js';

const step = (s, extra = {}) => createNote({ key: 60, pos: s * STEP, len: STEP, ...extra });

/** Deterministic 0..1 sequence for randomize tests. */
function rng(seed = 1) {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
}

describe('step counts', () => {
  it('follows the pattern length and the time signature', () => {
    const pat = createPattern(0);
    expect(S.stepCount(pat)).toBe(16);
    expect(S.stepCount(pat, [3, 4])).toBe(12);
    expect(S.stepCount({ ...pat, length: PPQ * 8 })).toBe(32);
    expect(S.stepCount({ ...pat, notes: { a: [step(20)] } })).toBe(32);
    expect(S.stepsPerBeat([4, 4])).toBe(4);
    expect(S.stepsPerBeat([6, 8])).toBe(2);
    expect(S.stepsPerBar([7, 8])).toBe(14);
  });

  it('resizes by whole bars within limits', () => {
    const pat = createPattern(0);
    expect(S.resizedBars(pat, [4, 4], 1)).toBe(2);
    expect(S.resizedBars(pat, [4, 4], -1)).toBe(1);
    expect(S.resizedBars({ ...pat, length: PPQ * 4 * S.MAX_BARS }, [4, 4], 1)).toBe(S.MAX_BARS);
  });
});

describe('fits the step model', () => {
  it('accepts one-step notes at the root on step boundaries', () => {
    expect(S.fitsSteps(undefined)).toBe(true);
    expect(S.fitsSteps([])).toBe(true);
    expect(S.fitsSteps([step(0), step(4, { vel: 0.3 })], 60)).toBe(true);
  });

  it('rejects off-grid, long, other-key and stacked notes', () => {
    expect(S.fitsSteps([createNote({ key: 60, pos: 5, len: STEP })], 60)).toBe(false);
    expect(S.fitsSteps([createNote({ key: 60, pos: 0, len: STEP * 2 })], 60)).toBe(false);
    expect(S.fitsSteps([step(0)], 62)).toBe(false);
    expect(S.fitsSteps([step(0), step(0)], 60)).toBe(false);
  });
});

describe('step states', () => {
  it('reports velocities and -1 for off steps', () => {
    const st = S.stepStates([step(1, { vel: 0.5 }), step(3)], 4);
    expect([...st].map((v) => Math.round(v * 100) / 100)).toEqual([-1, 0.5, -1, 0.78]);
    expect(S.onSteps([step(3), step(1), step(40)], 16)).toEqual([1, 3]);
  });
});

describe('pure step edits', () => {
  it('paints steps on and off, keeping untouched notes', () => {
    const a = [step(0, { vel: 0.4 })];
    const on = S.paintSteps(a, [0, 2, 3], true, 60);
    expect(S.onSteps(on)).toEqual([0, 2, 3]);
    expect(on[0]).toBe(a[0]); // existing note and velocity kept
    expect(S.paintSteps(on, [0, 2, 3], true)).toBe(on); // no change, same array
    const off = S.paintSteps(on, [2], false);
    expect(S.onSteps(off)).toEqual([0, 3]);
    expect(S.paintSteps(off, [9], false)).toBe(off);
  });

  it('writes new steps at the channel root key', () => {
    const notes = S.paintSteps([], [5], true, 48);
    expect(notes[0]).toMatchObject({ key: 48, pos: 5 * STEP, len: STEP });
  });

  it('fills every n steps', () => {
    expect(S.onSteps(S.fillSteps(16, 4))).toEqual([0, 4, 8, 12]);
    expect(S.onSteps(S.fillSteps(16, 8))).toEqual([0, 8]);
    expect(S.onSteps(S.fillSteps(8, 2, 60, 1))).toEqual([1, 3, 5, 7]);
  });

  it('shifts notes with wrap-around', () => {
    const n = [step(0), step(15)];
    expect(S.onSteps(S.shiftNotes(n, 1, 16))).toEqual([0, 1]);
    expect(S.onSteps(S.shiftNotes(n, -1, 16))).toEqual([14, 15]);
    // Off-grid notes shift too (piano-roll channels).
    const odd = [createNote({ key: 64, pos: 30, len: 50 })];
    expect(S.shiftNotes(odd, 1, 16)[0].pos).toBe(30 + STEP);
  });

  it('randomizes with a tasteful density favouring downbeats', () => {
    const r = rng(7);
    let down = 0;
    let off = 0;
    for (let i = 0; i < 200; i++) {
      const notes = S.randomSteps(16, { rng: r });
      for (const s of S.onSteps(notes)) {
        if (s % 4 === 0) down++;
        else off++;
      }
      expect(notes.length).toBeLessThan(16);
    }
    // Downbeats are a quarter of the steps but should get far more than a quarter of the hits.
    expect(down / (down + off)).toBeGreaterThan(0.4);
    const sparse = S.randomSteps(64, { rng: rng(3), density: 0 }).length;
    const dense = S.randomSteps(64, { rng: rng(3), density: 1 }).length;
    expect(dense).toBeGreaterThan(sparse);
  });

  it('sets step velocities only where a step is on', () => {
    const n = [step(2)];
    const v = S.setStepVelocity(n, 2, 0.25);
    expect(v[0].vel).toBe(0.25);
    expect(S.setStepVelocity(n, 3, 0.25)).toBe(n);
    expect(S.setStepVelocity(n, 2, 2)[0].vel).toBe(1);
  });

  it('copies notes with new ids and an optional key', () => {
    const n = [step(1)];
    const c = S.copyNotes(n, { key: 40 });
    expect(c[0].id).not.toBe(n[0].id);
    expect(c[0].key).toBe(40);
    expect(c[0].pos).toBe(n[0].pos);
  });
});

describe('project helpers', () => {
  it('edits a channel through setNotes and finds free inserts', () => {
    const p = newProject();
    const pat = p.patterns[0].id;
    const kick = p.channels[0];
    const next = S.editChannelNotes(p, pat, kick.id, (notes, ch) => S.fillSteps(16, 4, ch.root));
    expect(S.onSteps(next.patterns[0].notes[kick.id])).toEqual([0, 4, 8, 12]);
    expect(S.editChannelNotes(p, pat, 'missing', () => [])).toBe(p);
    expect(S.editChannelNotes(next, pat, kick.id, (n) => n)).toBe(next);
    // The starter kit uses inserts 1..4.
    expect(S.freeInsert(p)).toBe(5);
    expect(S.freeInsert(p, kick.id)).toBe(1);
  });
});

describe('editor helpers', () => {
  it('matches presets by their full parameter set', () => {
    expect(matchPreset('synth', defaultParams('synth'))?.name).toBe('Init');
    const acid = presetsFor('synth').find((x) => x.name === 'Acid Bass');
    expect(matchPreset('synth', { ...defaultParams('synth'), ...acid.params })).toBe(acid);
    expect(matchPreset('synth', { ...defaultParams('synth'), cutoff: 1234 })).toBe(null);
    expect(presetsFor('drum')[0].name).toBe('Init');
    expect(presetsFor('sampler')).toHaveLength(1);
  });

  it('lays out envelope shapes left to right inside the box', () => {
    const pts = adsrPoints({ attack: 10, decay: 300, sustain: 0.5, release: 400 }, 160, 48);
    expect(pts).toHaveLength(5);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0]).toBeGreaterThanOrEqual(pts[i - 1][0]);
    expect(pts.at(-1)[0]).toBeLessThanOrEqual(160);
    expect(pts[2][1]).toBe(pts[3][1]); // sustain holds
    const long = adsrPoints({ attack: 10000, decay: 10000, sustain: 1, release: 10000 }, 160, 48);
    expect(long.at(-1)[0]).toBeLessThanOrEqual(160);
  });

  it('maps two rows of computer keys an octave apart', () => {
    expect(KEY_MAP.KeyZ).toBe(0);
    expect(KEY_MAP.KeyQ).toBe(12);
    expect(KEY_MAP.Comma).toBe(KEY_MAP.KeyQ);
  });
});

describe('song mode step playhead', () => {
  it('maps the song position into the first playing clip of the pattern', async () => {
    const { createClip } = await import('../src/model/project.js');
    const p = newProject();
    const pat = p.patterns[0].id;
    const bar = PPQ * 4;
    const project = {
      ...p,
      clips: [
        createClip({ kind: 'pattern', track: 2, start: 0, len: bar * 2, ref: pat }),
        createClip({ kind: 'pattern', track: 0, start: bar, len: bar, offset: STEP * 4, ref: pat }),
        { ...createClip({ kind: 'pattern', track: 1, start: bar * 3, len: bar, ref: pat }), mute: true },
        createClip({ kind: 'pattern', track: 0, start: bar * 4, len: bar, ref: 'other' }),
      ],
    };
    expect(S.songStepAt(project, pat, STEP * 3)).toBe(3); // only the track 2 clip
    expect(S.songStepAt(project, pat, bar + STEP)).toBe(5); // track 0 wins, offset by 4 steps
    expect(S.songStepAt(project, pat, bar * 3 + STEP)).toBe(-1); // muted clip
    expect(S.songStepAt(project, pat, bar * 4)).toBe(-1); // another pattern
    expect(S.songStepAt(project, pat, bar * 2)).toBe(-1); // clip ends are exclusive
  });
});
