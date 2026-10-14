// Step sequencer model: pure helpers over a channel's notes in one pattern.
// A step is a sixteenth (STEP ticks). A channel "fits the step model" when
// every note starts on a step, lasts at most a step and plays the channel's
// root key; only then does the rack show its steps (otherwise a read-only
// piano-roll preview). Every edit here is pure: notes in, notes (or a
// project) out, so the rack, its menus and the tests share one source.

import { uid, clamp } from '../lib/util.js';
import { STEP, ticksPerBeat, ticksPerBar } from '../model/time.js';
import { patternLength, DEFAULT_KEY } from '../model/project.js';
import { setNotes, getNotes } from '../model/edits.js';

export const DEFAULT_VEL = 0.78;
export const MAX_BARS = 16;

/** Number of steps a pattern shows: its playback length in sixteenths (one bar minimum). */
export function stepCount(pattern, sig = [4, 4]) {
  return Math.max(1, Math.ceil(patternLength(pattern, sig) / STEP));
}

/** Steps in one beat of the time signature (4 in 4/4, 2 in 6/8). */
export function stepsPerBeat(sig = [4, 4]) {
  return Math.max(1, Math.round(ticksPerBeat(sig) / STEP));
}

export function stepsPerBar(sig = [4, 4]) {
  return Math.max(1, Math.round(ticksPerBar(sig) / STEP));
}

/** Whether every note sits on the step grid (start on a step, at most one step long, root key). */
export function fitsSteps(notes, root = DEFAULT_KEY) {
  if (!notes) return true;
  for (const n of notes) {
    if (n.pos % STEP !== 0 || n.len > STEP || n.key !== root) return false;
  }
  // Two notes on one step (same key) cannot be shown as one cell either.
  for (let i = 1; i < notes.length; i++) if (notes[i].pos === notes[i - 1].pos) return false;
  return true;
}

/**
 * Fills `out` (Float32Array of `count`) with each step's velocity, or -1 when
 * the step is off. Notes beyond the visible steps are ignored.
 */
export function stepStates(notes, count, out = new Float32Array(count)) {
  out.fill(-1);
  if (!notes) return out;
  for (const n of notes) {
    const s = Math.floor(n.pos / STEP);
    if (s >= 0 && s < count && out[s] < 0) out[s] = n.vel;
  }
  return out;
}

/** Indexes of the steps that are on. */
export function onSteps(notes, count = Infinity) {
  const set = new Set();
  for (const n of notes || []) {
    const s = Math.floor(n.pos / STEP);
    if (s < count) set.add(s);
  }
  return [...set].sort((a, b) => a - b);
}

const stepNote = (key, s, vel = DEFAULT_VEL) => ({ id: uid(6), key, pos: s * STEP, len: STEP, vel, pan: 0 });

/**
 * Turns the listed steps on or off. Steps already in the wanted state keep
 * their notes (and velocities); returns the same array when nothing changes.
 */
export function paintSteps(notes, steps, on, root = DEFAULT_KEY) {
  const list = notes || [];
  const want = new Set(steps);
  if (!want.size) return list;
  const has = new Set(list.map((n) => Math.floor(n.pos / STEP)));
  if (on) {
    const add = [...want].filter((s) => s >= 0 && !has.has(s));
    return add.length ? [...list, ...add.map((s) => stepNote(root, s))] : list;
  }
  const next = list.filter((n) => !want.has(Math.floor(n.pos / STEP)));
  return next.length === list.length ? list : next;
}

/** Sets the velocity of the notes starting in `step` (no-op if the step is off). */
export function setStepVelocity(notes, step, vel) {
  const v = clamp(vel, 0, 1);
  let touched = false;
  const next = (notes || []).map((n) => {
    if (Math.floor(n.pos / STEP) !== step || n.vel === v) return n;
    touched = true;
    return { ...n, vel: v };
  });
  return touched ? next : notes;
}

/** Steps on every `every` steps from `offset` across `count` steps (replaces the row). */
export function fillSteps(count, every, root = DEFAULT_KEY, offset = 0) {
  const out = [];
  for (let s = offset; s < count; s += Math.max(1, every)) out.push(stepNote(root, s));
  return out;
}

/** Rotates every note by `by` steps, wrapping within `count` steps. Works for any notes, not only steps. */
export function shiftNotes(notes, by, count) {
  const len = count * STEP;
  if (!notes?.length || !len || !by) return notes || [];
  const d = by * STEP;
  return notes.map((n) => {
    if (n.pos >= len) return n;
    return { ...n, pos: (((n.pos + d) % len) + len) % len };
  });
}

/**
 * A tasteful random row: downbeats are likely, off-beat sixteenths rare.
 * `density` 0..1 scales the odds; `rng` returns 0..1 (Math.random by default).
 * Velocities vary a little so the row breathes.
 */
export function randomSteps(count, { root = DEFAULT_KEY, density = 0.5, rng = Math.random, sig = [4, 4] } = {}) {
  const beat = stepsPerBeat(sig);
  const half = Math.max(1, beat / 2);
  const out = [];
  for (let s = 0; s < count; s++) {
    let p;
    if (s % (beat * (sig[0] || 4)) === 0) p = 0.7;
    else if (s % beat === 0) p = 0.5;
    else if (s % half === 0) p = 0.32;
    else p = 0.14;
    p = clamp(p * (0.4 + density * 1.2), 0, 0.95);
    if (rng() < p) {
      const accent = s % beat === 0 ? 0.1 : -0.08;
      out.push(stepNote(root, s, clamp(DEFAULT_VEL + accent + (rng() - 0.5) * 0.2, 0.25, 1)));
    }
  }
  return out;
}

/** Copies notes with fresh ids (paste between patterns or channels). */
export function copyNotes(notes, { key } = {}) {
  return (notes || []).map((n) => ({ ...n, id: uid(6), key: key ?? n.key }));
}

// ------------------------------------------------------------------ project wrappers

/** Applies `fn(notes, channel)` to a channel's notes in a pattern through setNotes. */
export function editChannelNotes(project, patternId, channelId, fn) {
  const ch = project.channels.find((c) => c.id === channelId);
  if (!ch) return project;
  const notes = getNotes(project, patternId, channelId);
  const next = fn(notes, ch);
  if (next === notes) return project;
  return setNotes(project, patternId, channelId, next);
}

/** Lowest mixer insert (1..) no channel routes to, or 0 when all are taken. */
export function freeInsert(project, exceptChannelId = null) {
  const used = new Set(project.channels.filter((c) => c.id !== exceptChannelId).map((c) => c.mixer));
  for (let i = 1; i < project.mixer.length; i++) if (!used.has(i)) return i;
  return 0;
}

/** Bars a pattern spans after adding `delta` bars (1..MAX_BARS). */
export function resizedBars(pattern, sig, delta) {
  const bar = ticksPerBar(sig);
  const bars = Math.round(patternLength(pattern, sig) / bar);
  return clamp(bars + delta, 1, MAX_BARS);
}

/**
 * The step of pattern `patternId` playing at song tick `pos`: from the first
 * unmuted clip of that pattern under the song playhead (lowest track, then
 * earliest start), mapped through the clip's start and offset. -1 when no
 * clip of the pattern plays there. Allocation-free (runs every frame).
 */
export function songStepAt(project, patternId, pos) {
  let best = null;
  for (const c of project.clips) {
    if (c.kind !== 'pattern' || c.ref !== patternId || c.mute || pos < c.start || pos >= c.start + c.len) continue;
    if (!best || c.track < best.track || (c.track === best.track && c.start < best.start)) best = c;
  }
  if (!best) return -1;
  return Math.floor((pos - best.start + (best.offset || 0)) / STEP);
}
