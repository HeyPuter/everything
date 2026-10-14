import { describe, it, expect } from 'vitest';
import * as N from '../src/pianoroll/notes.js';
import { chordKeys, scaleKeys, inScale, snapToScale, scaleMask, detectScale, scaleLabel } from '../src/pianoroll/scales.js';
import { generateRiff, mulberry32 } from '../src/pianoroll/riff.js';
import { computeLayout, regionAt, rowY, keyAtY, centerScrollY, describePos, describeLen, describeNote } from '../src/pianoroll/geometry.js';
import { parseKey, parseBST } from '../src/pianoroll/dialogs.js';
import { STEP, PPQ } from '../src/model/time.js';

const note = (id, key, pos, len = STEP, vel = 0.8) => ({ id, key, pos, len, vel, pan: 0 });
const strip = (list) => list.map(({ key, pos, len }) => [key, pos, len]);

describe('note lookups', () => {
  const notes = [note('a', 60, 0, 96), note('b', 62, 24), note('c', 64, 400), note('d', 60, 960, 24)];

  it('binary-searches the first visible note, accounting for the longest note', () => {
    expect(N.firstVisible(notes, 0)).toBe(0);
    expect(N.firstVisible(notes, 500)).toBe(3); // 500 - 96 = 404 > 400, so c cannot reach the view
    expect(N.firstVisible(notes, 450)).toBe(2);
    expect(N.firstVisible(notes, 2000)).toBe(4);
  });

  it('finds the note under a point', () => {
    expect(N.noteAt(notes, 50, 60)?.id).toBe('a');
    expect(N.noteAt(notes, 96, 60)).toBe(null); // end is exclusive
    expect(N.noteAt(notes, 30, 62)?.id).toBe('b');
    expect(N.noteAt(notes, 30, 61)).toBe(null);
  });

  it('selects notes overlapping a rectangle in any drag direction', () => {
    expect(N.notesInRect(notes, 0, 100, 60, 62).sort()).toEqual(['a', 'b']);
    expect(N.notesInRect(notes, 100, 0, 62, 60).sort()).toEqual(['a', 'b']);
    expect(N.notesInRect(notes, 90, 500, 64, 64)).toEqual(['c']);
  });

  it('hit-tests edges with a grabbable body on short notes', () => {
    expect(N.hitZone(198, 100, 200, 6)).toBe('right');
    expect(N.hitZone(102, 100, 200, 6)).toBe('left');
    expect(N.hitZone(150, 100, 200, 6)).toBe('body');
    // 9px note: no left edge, right third resizes, the rest moves.
    expect(N.hitZone(101, 100, 109, 6)).toBe('body');
    expect(N.hitZone(108, 100, 109, 6)).toBe('right');
  });

  it('measures the span of a selection', () => {
    expect(N.span(notes, ['a', 'c'])).toEqual({ start: 0, end: 424, lo: 60, hi: 64 });
    expect(N.span(notes, [])).toBe(null);
  });
});

describe('note edits', () => {
  const notes = [note('a', 60, 0, 48), note('b', 64, 48, 48), note('c', 67, 192, 96)];

  it('moves picked notes, clamped to the start and the key range', () => {
    const moved = N.moveNotes(notes, ['a', 'b'], 24, 2);
    expect(strip(moved)).toEqual([[62, 24, 48], [66, 72, 48], [67, 192, 96]]);
    expect(N.clampMove(notes, ['a'], -100, 0)).toEqual({ dPos: 0, dKey: 0 });
    expect(N.clampMove(notes, ['c'], 0, 100).dKey).toBe(60);
    expect(N.moveNotes(notes, null, 0, 0)).toBe(notes);
  });

  it('duplicates notes and returns the copies', () => {
    const r = N.duplicateNotes(notes, ['c'], 96, 0);
    expect(r.notes).toHaveLength(4);
    expect(r.ids).toHaveLength(1);
    expect(r.notes.find((n) => n.id === r.ids[0])).toMatchObject({ key: 67, pos: 288, len: 96 });
  });

  it('resizes ends and starts', () => {
    expect(strip(N.resizeNotes(notes, ['a', 'b'], 24, 24))).toEqual([[60, 0, 72], [64, 48, 72], [67, 192, 96]]);
    expect(N.resizeNotes(notes, ['a'], -100, 24).find((n) => n.id === 'a').len).toBe(24);
    const s = N.resizeStart(notes, ['c'], 48, 24);
    expect(s.find((n) => n.id === 'c')).toMatchObject({ pos: 240, len: 48 });
    expect(N.resizeStart(notes, ['c'], 500, 24).find((n) => n.id === 'c')).toMatchObject({ pos: 264, len: 24 });
  });

  it('slices notes crossing a tick', () => {
    const r = N.sliceNotes(notes, 240);
    expect(r.ids).toHaveLength(1);
    expect(strip(r.notes.filter((n) => n.key === 67))).toEqual([[67, 192, 48], [67, 240, 48]]);
    expect(N.sliceNotes(notes, 192).ids).toHaveLength(0); // on a boundary
    expect(N.sliceNotes(notes, 24, (n) => n.key === 64).ids).toHaveLength(0);
  });

  it('quantizes starts (keeping length), ends and partial strength', () => {
    const loose = [note('a', 60, 10, 30), note('b', 62, 50, 40)];
    expect(strip(N.quantizeNotes(loose, null, { grid: 24 }))).toEqual([[60, 0, 30], [62, 48, 40]]);
    expect(strip(N.quantizeNotes(loose, null, { grid: 24, starts: true, ends: true }))).toEqual([[60, 0, 48], [62, 48, 48]]);
    expect(strip(N.quantizeNotes(loose, ['a'], { grid: 24, strength: 0.5 }))).toEqual([[60, 5, 30], [62, 50, 40]]);
    expect(N.quantizeNotes(loose, null, { grid: 0 })).toBe(loose);
  });

  it('applies legato up to the next note start and the end', () => {
    const r = N.legatoNotes([note('a', 60, 0, 10), note('b', 64, 0, 10), note('c', 67, 96, 10)], null, 384);
    expect(strip(r)).toEqual([[60, 0, 96], [64, 0, 96], [67, 96, 288]]);
  });

  it('reverses in time and flips pitches within the selection', () => {
    expect(strip(N.reverseNotes(notes, null))).toEqual([[67, 0, 96], [64, 192, 48], [60, 240, 48]]);
    expect(N.flipNotes(notes, null).map((n) => n.key).sort()).toEqual([60, 63, 67]);
  });

  it('randomizes velocity deterministically with a seeded generator', () => {
    const a = N.randomizeVelocity(notes, null, 0.4, mulberry32(7)).map((n) => n.vel);
    const b = N.randomizeVelocity(notes, null, 0.4, mulberry32(7)).map((n) => n.vel);
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0.6);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('patches notes by id', () => {
    const r = N.patchNotes(notes, { a: { vel: 0.2 }, c: { pos: 0 } });
    expect(r[0].id === 'a' || r[0].id === 'c').toBe(true);
    expect(r.find((n) => n.id === 'a').vel).toBe(0.2);
    expect(N.patchNotes(notes, {})).toBe(notes);
  });

  it('steps through notes in time order for Tab', () => {
    expect(N.stepNote(notes, null, 1).id).toBe('a');
    expect(N.stepNote(notes, 'a', 1).id).toBe('b');
    expect(N.stepNote(notes, 'c', 1)).toBe(null);
    expect(N.stepNote(notes, null, -1).id).toBe('c');
  });
});

describe('clipboard', () => {
  it('keeps off-grid offsets relative to the grid cell of the first note', () => {
    const notes = [note('a', 60, 400, 24), note('b', 62, 430, 24)];
    const clip = N.copyNotes(notes, ['a', 'b'], 96);
    expect(clip.notes.map((n) => n.pos)).toEqual([16, 46]); // origin 384
    const pasted = N.pasteNotes(clip, 768);
    expect(pasted.map((n) => n.pos)).toEqual([784, 814]);
    expect(new Set(pasted.map((n) => n.id)).size).toBe(2);
    expect(pasted[0].id).not.toBe('a');
    expect(N.copyNotes(notes, [], 96)).toBe(null);
  });

  it('grows an explicit pattern length to cover notes past its end', () => {
    const pat = (length, notes) => ({ id: 'p', length, notes: { c: notes } });
    expect(N.lengthToFit(pat(768, [note('a', 60, 0, 96)]))).toBe(null);
    expect(N.lengthToFit(pat(null, [note('a', 60, 2000, 96)]))).toBe(null);
    expect(N.lengthToFit(pat(768, [note('a', 60, 700, 96)]))).toBe(1152);
    expect(N.lengthToFit(pat(384, [note('a', 60, 0, 1600)]), [3, 4])).toBe(1728);
  });

  it('pastes after the copied notes instead of stacking on them', () => {
    const notes = [note('a', 60, 0, 24), note('b', 62, 192, 192)];
    const clip = N.copyNotes(notes, ['a', 'b'], 96); // length 384
    expect(N.pasteTarget(notes, clip, 0, 96)).toBe(384);
    const once = [...notes, ...N.pasteNotes(clip, 384)];
    expect(N.pasteTarget(once, clip, 0, 96)).toBe(768);
    // Free spot or a partial overlap: paste where asked.
    expect(N.pasteTarget(notes, clip, 96, 96)).toBe(96);
    expect(N.pasteTarget([note('a', 60, 0, 24)], clip, 0, 96)).toBe(0);
  });

  it('duplicates a selection after itself in whole grid cells', () => {
    const notes = [note('a', 60, 0, 90), note('b', 62, 96, 200)];
    const r = N.duplicateAfter(notes, null, 384);
    expect(r.offset).toBe(384);
    expect(r.notes).toHaveLength(4);
    expect(r.notes.filter((n) => r.ids.includes(n.id)).map((n) => n.pos)).toEqual([384, 480]);
  });
});

describe('scales and chords', () => {
  it('knows scale membership', () => {
    expect(inScale(61, 0, 'major')).toBe(false);
    expect(inScale(69, 9, 'minor')).toBe(true);
    expect(scaleKeys(0, 'majorPentatonic', 60, 72)).toEqual([60, 62, 64, 67, 69, 72]);
    expect(snapToScale(61, 0, 'major')).toBe(60);
    expect(scaleMask(2, 'dorian').filter(Boolean)).toHaveLength(7);
    expect(scaleMask(0, null).every(Boolean)).toBe(true);
    expect(scaleLabel(6, 'dorian')).toBe('F# dorian');
  });

  it('builds chords with inversions', () => {
    expect(chordKeys(60, 'major')).toEqual([60, 64, 67]);
    expect(chordKeys(60, 'minor', { inversion: 1 })).toEqual([63, 67, 72]);
    expect(chordKeys(60, 'dom7', { inversion: 2 })).toEqual([67, 70, 72, 76]);
    expect(chordKeys(126, 'major')).toEqual([126]);
  });

  it('builds chords inside the scale', () => {
    // D in C major: D F A (minor), B: B D F (diminished).
    expect(chordKeys(62, 'scaleTriad', { scaleRoot: 0, scaleId: 'major' })).toEqual([62, 65, 69]);
    expect(chordKeys(71, 'scaleTriad', { scaleRoot: 0, scaleId: 'major' })).toEqual([71, 74, 77]);
    expect(chordKeys(57, 'scaleSeventh', { scaleRoot: 9, scaleId: 'minor' })).toEqual([57, 60, 64, 67]);
    expect(chordKeys(60, 'scaleTriad')).toEqual([60, 64, 67]); // no scale: major
  });

  it('chordizes selected notes without doubling keys', () => {
    const notes = [note('a', 60, 0), note('b', 64, 0), note('c', 72, 96)];
    const r = N.chordize(notes, ['a', 'c'], 'major');
    expect(strip(r.notes)).toEqual([[60, 0, 24], [64, 0, 24], [67, 0, 24], [72, 96, 24], [76, 96, 24], [79, 96, 24]]);
    expect(r.ids).toContain('a');
    expect(r.ids).toHaveLength(5);
  });

  it('detects the key of a melody', () => {
    const am = [57, 60, 64, 62, 60, 59, 57].map((k, i) => note(String(i), k, i * 96, 96));
    expect(detectScale(am)).toEqual({ root: 9, scale: 'minor' });
    const c = [60, 64, 67, 65, 62, 59, 60].map((k, i) => note(String(i), k, i * 96, 96));
    expect(detectScale(c)).toEqual({ root: 0, scale: 'major' });
    expect(detectScale([])).toBe(null);
  });
});

describe('riff generator', () => {
  const opts = { seed: 42, style: 'melody', root: 9, scale: 'minor', low: 60, range: 1, bars: 4, density: 0.5 };

  it('is deterministic for a seed and differs across seeds', () => {
    const a = strip(generateRiff(opts));
    expect(strip(generateRiff(opts))).toEqual(a);
    expect(strip(generateRiff({ ...opts, seed: 43 }))).not.toEqual(a);
    expect(a.length).toBeGreaterThan(4);
  });

  it('stays in the scale, the range and the requested bars for every style', () => {
    for (const style of ['melody', 'arpUp', 'arpDown', 'arpUpDown', 'bass', 'chords']) {
      for (const seed of [1, 2, 3, 99]) {
        const low = style === 'bass' ? 36 : 60;
        const notes = generateRiff({ ...opts, style, seed, low, range: 2, start: PPQ * 4 });
        expect(notes.length).toBeGreaterThan(0);
        for (const n of notes) {
          expect(inScale(n.key, 9, 'minor')).toBe(true);
          expect(n.pos).toBeGreaterThanOrEqual(PPQ * 4);
          expect(n.pos + n.len).toBeLessThanOrEqual(PPQ * 4 * 5);
          expect(n.vel).toBeGreaterThan(0);
          expect(n.vel).toBeLessThanOrEqual(1);
          expect(n.len).toBeGreaterThan(0);
        }
        for (let i = 1; i < notes.length; i++) expect(notes[i].pos >= notes[i - 1].pos).toBe(true);
        if (style !== 'chords') {
          expect(Math.min(...notes.map((n) => n.key))).toBeGreaterThanOrEqual(low - 0);
          expect(Math.max(...notes.map((n) => n.key))).toBeLessThanOrEqual(low + 24 + 7);
        }
      }
    }
  });

  it('busier density writes more notes', () => {
    let sparse = 0;
    let busy = 0;
    for (let seed = 1; seed <= 12; seed++) {
      sparse += generateRiff({ ...opts, seed, density: 0.1 }).length;
      busy += generateRiff({ ...opts, seed, density: 0.9 }).length;
    }
    expect(busy).toBeGreaterThan(sparse);
  });
});

describe('geometry', () => {
  const L = computeLayout({ w: 800, h: 500, lane: true, laneH: 80 });

  it('lays out regions and maps keys to rows', () => {
    expect(L.gridX).toBe(L.keysW);
    expect(L.gridY + L.gridH + L.sb + L.split + L.laneH).toBe(500);
    expect(regionAt(L, 10, 5)).toBe('corner');
    expect(regionAt(L, 300, 5)).toBe('ruler');
    expect(regionAt(L, 10, 100)).toBe('keys');
    expect(regionAt(L, 300, 100)).toBe('grid');
    expect(regionAt(L, 795, 100)).toBe('vscroll');
    expect(regionAt(L, 300, L.laneY + 10)).toBe('lane');
    expect(regionAt(L, 300, L.splitY + 1)).toBe('split');
    for (const key of [0, 60, 127]) expect(keyAtY(L, rowY(L, key, 14, 300) + 3, 14, 300)).toBe(key);
    const sy = centerScrollY(L, 60, 14);
    expect(Math.abs(rowY(L, 60, 14, sy) + 7 - (L.gridY + L.gridH / 2))).toBeLessThan(1);
    expect(computeLayout({ w: 800, h: 500, lane: false }).laneH).toBe(0);
  });

  it('describes positions and lengths for announcements', () => {
    expect(describePos(0)).toBe('bar 1 beat 1');
    expect(describePos(PPQ * 4 + PPQ * 2)).toBe('bar 2 beat 3');
    expect(describePos(STEP * 5)).toBe('bar 1 beat 2 step 2');
    expect(describePos(STEP + 5)).toBe('bar 1 beat 1 step 2 tick 5');
    expect(describeLen(STEP)).toBe('1 step long');
    expect(describeLen(PPQ * 2)).toBe('2 beats long');
    expect(describeLen(PPQ * 4)).toBe('1 bar long');
    expect(describeLen(12)).toBe('half a step long');
    expect(describeNote({ key: 60, pos: PPQ * 6, len: STEP })).toBe('C5 at bar 2 beat 3, 1 step long');
  });

  it('parses pitches and positions typed in the note popover', () => {
    expect(parseKey('C5')).toBe(60);
    expect(parseKey('f#4')).toBe(54);
    expect(parseKey('Bb3')).toBe(46);
    expect(parseKey('61')).toBe(61);
    expect(parseKey('H2')).toBe(null);
    expect(parseKey('200')).toBe(null);
    expect(parseBST('1:01:00')).toBe(0);
    expect(parseBST('2:03:05')).toBe(PPQ * 4 + STEP * 2 + 5);
    expect(parseBST('x')).toBe(null);
  });
});
