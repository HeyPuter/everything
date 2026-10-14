// Pure note-list operations for the piano roll. Each takes a channel's note
// list (sorted by pos, then key, as model/edits.js keeps it) and returns a new
// list; the editor writes it back with edits.setNotes inside store.apply or a
// gesture preview. `ids` selects the notes an operation touches: a Set, an
// array, or null for every note.

import { uid, clamp } from '../lib/util.js';
import { snapRound, snapFloor } from '../model/time.js';
import { chordKeys } from './scales.js';

const toSet = (ids) => (ids === null || ids === undefined ? null : ids instanceof Set ? ids : new Set(ids));
const picker = (ids) => {
  const set = toSet(ids);
  return set ? (n) => set.has(n.id) : () => true;
};

export const sortNotes = (notes) => notes.slice().sort((a, b) => a.pos - b.pos || a.key - b.key);

// ------------------------------------------------------------------ lookups

const maxLenCache = new WeakMap();

/** Longest note length in a list (cached per list, lists are immutable). */
export function maxNoteLen(notes) {
  let v = maxLenCache.get(notes);
  if (v === undefined) {
    v = 0;
    for (const n of notes) if (n.len > v) v = n.len;
    maxLenCache.set(notes, v);
  }
  return v;
}

/** Index of the first note that may be visible from `tick` on (binary search on the sorted list). */
export function firstVisible(notes, tick) {
  const from = tick - maxNoteLen(notes);
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].pos < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The topmost (last drawn) note on `key` covering `tick`, or null. */
export function noteAt(notes, tick, key) {
  const start = firstVisible(notes, tick);
  let hit = null;
  for (let i = start; i < notes.length; i++) {
    const n = notes[i];
    if (n.pos > tick) break;
    if (n.key === key && tick >= n.pos && tick < n.pos + n.len) hit = n;
  }
  return hit;
}

/** Ids of notes overlapping the tick range [t0, t1) and key range [k0, k1]. */
export function notesInRect(notes, t0, t1, k0, k1) {
  const lo = Math.min(k0, k1);
  const hi = Math.max(k0, k1);
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  const out = [];
  for (let i = firstVisible(notes, a); i < notes.length; i++) {
    const n = notes[i];
    if (n.pos >= b) break;
    if (n.key >= lo && n.key <= hi && n.pos + n.len > a) out.push(n.id);
  }
  return out;
}

/** { start, end, lo, hi } of the picked notes (null when none). */
export function span(notes, ids = null) {
  const pick = picker(ids);
  let start = Infinity;
  let end = -Infinity;
  let lo = 128;
  let hi = -1;
  for (const n of notes) {
    if (!pick(n)) continue;
    if (n.pos < start) start = n.pos;
    if (n.pos + n.len > end) end = n.pos + n.len;
    if (n.key < lo) lo = n.key;
    if (n.key > hi) hi = n.key;
  }
  return hi < 0 ? null : { start, end, lo, hi };
}

/**
 * Hit zone of a pointer at `px` over a note drawn from x0 to x1 (px):
 * 'left' or 'right' edge, or 'body'. Short notes keep a body to grab; the
 * right edge wins on tiny notes so they can always be lengthened.
 */
export function hitZone(px, x0, x1, edge = 6) {
  const w = x1 - x0;
  const e = Math.min(edge, w / 3);
  if (px >= x1 - e) return 'right';
  if (w > edge * 2.5 && px <= x0 + e) return 'left';
  return 'body';
}

// ------------------------------------------------------------------ moves and sizes

/** Clamps a move so every picked note stays at pos >= 0 and keys in 0..127. */
export function clampMove(notes, ids, dPos, dKey) {
  const s = span(notes, ids);
  if (!s) return { dPos: 0, dKey: 0 };
  return { dPos: Math.max(dPos, -s.start) + 0, dKey: clamp(dKey, -s.lo, 127 - s.hi) + 0 };
}

export function moveNotes(notes, ids, dPos, dKey = 0) {
  if (!dPos && !dKey) return notes;
  const pick = picker(ids);
  const c = clampMove(notes, ids, dPos, dKey);
  return sortNotes(notes.map((n) => (pick(n) ? { ...n, pos: n.pos + c.dPos, key: n.key + c.dKey } : n)));
}

/** Copies the picked notes moved by (dPos, dKey); the originals stay. Returns the copies' ids. */
export function duplicateNotes(notes, ids, dPos = 0, dKey = 0) {
  const pick = picker(ids);
  const c = clampMove(notes, ids, dPos, dKey);
  const copies = notes.filter(pick).map((n) => ({ ...n, id: uid(6), pos: n.pos + c.dPos, key: n.key + c.dKey }));
  return { notes: sortNotes([...notes, ...copies]), ids: copies.map((n) => n.id) };
}

/** Changes the length of the picked notes by dLen, never below `minLen` (or their own length when shorter). */
export function resizeNotes(notes, ids, dLen, minLen = 1) {
  if (!dLen) return notes;
  const pick = picker(ids);
  return notes.map((n) => (pick(n) ? { ...n, len: Math.max(Math.min(minLen, n.len), n.len + dLen) } : n));
}

/** Moves the start of the picked notes by dStart and keeps their ends. */
export function resizeStart(notes, ids, dStart, minLen = 1) {
  if (!dStart) return notes;
  const pick = picker(ids);
  return sortNotes(
    notes.map((n) => {
      if (!pick(n)) return n;
      const end = n.pos + n.len;
      const pos = clamp(n.pos + dStart, 0, end - Math.min(minLen, n.len));
      return { ...n, pos, len: end - pos };
    }),
  );
}

export function transposeNotes(notes, ids, semitones) {
  return moveNotes(notes, ids, 0, semitones);
}

/** Sets fields on notes by id: `changes` maps id to a partial note. */
export function patchNotes(notes, changes) {
  let touched = false;
  const out = notes.map((n) => {
    const c = changes instanceof Map ? changes.get(n.id) : changes[n.id];
    if (!c) return n;
    touched = true;
    return { ...n, ...c };
  });
  return touched ? sortNotes(out) : notes;
}

// ------------------------------------------------------------------ slicing

/**
 * Cuts every note crossing `tick` (strictly inside it) that `filter(note)`
 * accepts into two. Returns the new list and the ids of the right halves.
 */
export function sliceNotes(notes, tick, filter = () => true) {
  const right = [];
  const out = [];
  for (const n of notes) {
    if (filter(n) && tick > n.pos && tick < n.pos + n.len) {
      out.push({ ...n, len: tick - n.pos });
      const r = { ...n, id: uid(6), pos: tick, len: n.pos + n.len - tick };
      right.push(r);
      out.push(r);
    } else out.push(n);
  }
  return right.length ? { notes: sortNotes(out), ids: right.map((r) => r.id) } : { notes, ids: [] };
}

// ------------------------------------------------------------------ tools

/**
 * Moves note starts (and/or ends) toward the grid by `strength` (0..1).
 * Moving starts keeps lengths unless ends are quantized too.
 */
export function quantizeNotes(notes, ids, { grid, strength = 1, starts = true, ends = false }) {
  if (!(grid > 0) || (!starts && !ends)) return notes;
  const pick = picker(ids);
  const s = clamp(strength, 0, 1);
  return sortNotes(
    notes.map((n) => {
      if (!pick(n)) return n;
      let pos = n.pos;
      let end = n.pos + n.len;
      if (starts) {
        const q = snapRound(n.pos, grid);
        pos = Math.max(0, Math.round(n.pos + (q - n.pos) * s));
        if (!ends) end = pos + n.len;
      }
      if (ends) {
        const q = snapRound(end, grid);
        end = Math.round(end + (q - end) * s);
      }
      if (end <= pos) end = pos + Math.max(1, Math.round(grid * s) || n.len);
      return pos === n.pos && end - pos === n.len ? n : { ...n, pos, len: end - pos };
    }),
  );
}

/**
 * Extends each picked note to the start of the next later note (any key,
 * picked notes only). The last ones extend to `end` when given.
 */
export function legatoNotes(notes, ids, end = null) {
  const pick = picker(ids);
  const picked = notes.filter(pick);
  const starts = [...new Set(picked.map((n) => n.pos))].sort((a, b) => a - b);
  const changes = new Map();
  for (const n of picked) {
    const next = starts.find((p) => p > n.pos);
    const target = next !== undefined ? next : end !== null && end > n.pos ? end : null;
    if (target !== null && target - n.pos !== n.len) changes.set(n.id, { len: target - n.pos });
  }
  return changes.size ? patchNotes(notes, changes) : notes;
}

/** Mirrors the picked notes in time inside their own span. */
export function reverseNotes(notes, ids) {
  const s = span(notes, ids);
  if (!s) return notes;
  const pick = picker(ids);
  return sortNotes(notes.map((n) => (pick(n) ? { ...n, pos: s.start + s.end - (n.pos + n.len) } : n)));
}

/** Mirrors the picked notes' pitches around the middle of their key range. */
export function flipNotes(notes, ids) {
  const s = span(notes, ids);
  if (!s) return notes;
  const pick = picker(ids);
  return sortNotes(notes.map((n) => (pick(n) ? { ...n, key: s.lo + s.hi - n.key } : n)));
}

/** Spreads velocities randomly by up to +-amount/2 around their value. `rng()` returns 0..1. */
export function randomizeVelocity(notes, ids, amount, rng = Math.random) {
  const pick = picker(ids);
  return notes.map((n) => (pick(n) ? { ...n, vel: Math.round(clamp(n.vel + (rng() - 0.5) * amount, 0.02, 1) * 1000) / 1000 } : n));
}

/**
 * Turns each picked note into a chord on its key (see scales.chordKeys).
 * Keys that already sound at the same position are not doubled. Returns the
 * new list and the ids of every note of the chords.
 */
export function chordize(notes, ids, chordId, opts = {}) {
  const pick = picker(ids);
  const picked = notes.filter(pick);
  if (!picked.length) return { notes, ids: [] };
  const taken = new Set(notes.map((n) => `${n.pos}:${n.key}`));
  const out = notes.filter((n) => !pick(n));
  const outIds = [];
  for (const n of picked) {
    const keys = chordKeys(n.key, chordId, opts);
    taken.delete(`${n.pos}:${n.key}`);
    for (const k of keys) {
      const tag = `${n.pos}:${k}`;
      if (taken.has(tag)) continue;
      taken.add(tag);
      const note = k === n.key ? n : { ...n, id: uid(6), key: k };
      out.push(note);
      outIds.push(note.id);
    }
  }
  return { notes: sortNotes(out), ids: outIds };
}

// ------------------------------------------------------------------ clipboard

/**
 * Copies the picked notes to a clipboard object. Positions are kept relative
 * to the grid cell of the first note, so pasting on the grid keeps their
 * offsets (swing, off-grid timing) intact.
 */
export function copyNotes(notes, ids, grid = 0) {
  const pick = picker(ids);
  const picked = notes.filter(pick);
  if (!picked.length) return null;
  const s = span(picked);
  const origin = grid > 0 ? snapFloor(s.start, grid) : s.start;
  return {
    notes: picked.map((n) => ({ key: n.key, pos: n.pos - origin, len: n.len, vel: n.vel, pan: n.pan ?? 0 })),
    length: s.end - origin,
  };
}

/** Clipboard notes placed at tick `at` with fresh ids. */
export function pasteNotes(clip, at, dKey = 0) {
  if (!clip) return [];
  return clip.notes.map((n) => ({ ...n, id: uid(6), pos: Math.max(0, at + n.pos), key: clamp(n.key + dKey, 0, 127) }));
}

/**
 * Copies the picked notes right after themselves: the offset is the
 * selection's span rounded out to the grid (bar-sized blocks stay in bars).
 */
export function duplicateAfter(notes, ids, grid = 0) {
  const s = span(notes, ids);
  if (!s) return { notes, ids: [], offset: 0 };
  let offset = s.end - s.start;
  if (grid > 0) {
    const a = snapFloor(s.start, grid);
    offset = Math.max(grid, Math.ceil((s.end - a) / grid) * grid);
  }
  const r = duplicateNotes(notes, ids, offset, 0);
  return { ...r, offset };
}

// ------------------------------------------------------------------ keyboard order

/** The note after (dir 1) or before (dir -1) `currentId` in time order, wrapping to null at the ends. */
export function stepNote(notes, currentId, dir = 1) {
  if (!notes.length) return null;
  const i = currentId ? notes.findIndex((n) => n.id === currentId) : -1;
  if (i < 0) return dir > 0 ? notes[0] : notes[notes.length - 1];
  const j = i + dir;
  return j >= 0 && j < notes.length ? notes[j] : null;
}
