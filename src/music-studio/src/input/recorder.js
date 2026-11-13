// Recording live notes (typing keyboard, MIDI) into the current pattern, and
// step editing.
//
// While the engine records and plays, each note played lands in the current
// pattern for the channel it was played on, at the engine position mapped
// into the pattern (pattern mode wraps around the loop; song mode uses the
// clip of this pattern under the playhead, else wraps around the pattern
// length). Held notes grow while they sound. A take is one undo step; when
// the engine reports a loop, the pass is committed and a new step begins.
// With 'record quantize' on, starts and lengths snap to the piano roll grid.
//
// Step edit (Options > Step edit, while stopped): each note is inserted at
// the piano roll cursor with the snap length; the cursor advances once every
// key is released, so chords stack.
//
// The pure timing helpers at the top are what the tests cover.

import * as E from '../model/edits.js';
import { patternById, patternLength } from '../model/project.js';
import { PPQ, snapRound } from '../model/time.js';
import { uid } from '../lib/util.js';
import { shared, sharedEvents } from '../pianoroll/state.js';
import { playRange, tempoMap } from '../engine/compile.js';
import { advanceRecordingClock } from './recording-clock.js';

// ------------------------------------------------------------------ timing math

/** Ticks elapsed in `ms` milliseconds at `bpm`. */
export function msToTicks(ms, bpm) {
  return (ms / 1000) * (bpm / 60) * PPQ;
}

/**
 * Position inside a pattern for an engine position. Pattern mode wraps into
 * the pattern length. Song mode finds a clip of this pattern under `position`
 * and maps through its start and offset; otherwise wraps into the pattern.
 */
export function patternTick(position, { mode = 'pattern', patternId = null, patLen, clips = [] }) {
  const len = Math.max(1, patLen);
  const wrap = (t) => ((t % len) + len) % len;
  if (mode === 'song') {
    let clip = null;
    for (const c of clips) {
      if (c.kind === 'pattern' && c.ref === patternId && position >= c.start && position < c.start + c.len && !c.mute) clip = c;
    }
    if (clip) return wrap(position - clip.start + (clip.offset || 0));
  }
  return wrap(position);
}

/** The clip of `patternId` playing at `position` in song mode (null when none). */
export function clipAt(position, patternId, clips) {
  let clip = null;
  for (const c of clips) if (c.kind === 'pattern' && c.ref === patternId && position >= c.start && position < c.start + c.len) clip = c;
  return clip;
}

/**
 * Final position and length of a recorded note. `pos` is the pattern tick at
 * note on, `elapsed` the ticks it was held. With `grid` > 0 and quantize on,
 * the start rounds to the grid (wrapping to 0 at the pattern end) and the
 * length to whole grid cells (at least one). Lengths never run past the
 * pattern end, so recording does not grow the loop it is playing.
 */
export function recordedNote(pos, elapsed, { patLen, grid = 0, quantize = false, minLen = 6 }) {
  let p = Math.round(pos);
  let len = Math.max(minLen, Math.round(elapsed));
  if (quantize && grid > 0) {
    p = snapRound(p, grid);
    if (p >= patLen) p = 0;
    len = Math.max(grid, snapRound(len, grid));
  }
  if (patLen > 0 && p + len > patLen) len = Math.max(Math.min(len, patLen - p), 1);
  return { pos: p, len };
}

// ------------------------------------------------------------------ recorder

export class Recorder {
  constructor(app, live) {
    this.app = app;
    this.live = live;
    this.take = new Map(); // note id -> { id, key, vel, pattern, channel, pos, started, open, len }
    this.byKey = new Map(); // key -> note id (open notes)
    this.gesture = null;
    this.pending = false;
    this.finished = []; // completed passes waiting for another editing gesture
    this.lastGrow = 0;
    this.stepHeld = 0;
    this.stepAdvance = 0;
    this.clock = null;
    const engine = app.engine;
    engine.on('state', () => {
      if (!(engine.recording && engine.playing) && this.take.size) this.endTake();
      if (this.active) this.resetClock();
      else this.clock = null;
    });
    engine.on('loop', () => {
      if (this.take.size) this.commitPass();
    });
    app.on('frame', () => this.frame());
    app.store.on('view', () => this.resetClock());
    app.store.on('change', (p, prev, info) => {
      if (info?.source !== 'load') {
        if (p.bpm !== prev.bpm || p.automation !== prev.automation || p.clips !== prev.clips || p.tracks !== prev.tracks || p.loop !== prev.loop || p.sig !== prev.sig) this.resetClock();
        return;
      }
      this.finished = [];
      this.pending = false;
      this.take.clear();
      this.byKey.clear();
      this.gesture = null;
      this.takeTotal = 0;
      this.clock = null;
    });
  }

  get active() {
    const e = this.app.engine;
    return Boolean(e.recording && e.playing);
  }

  get stepEditing() {
    return Boolean(this.app.prefs.get('stepEditing')) && !this.app.engine.playing;
  }

  clockConfig() {
    const { store, engine } = this.app;
    return { map: tempoMap(store.project, engine.mode), range: engine.range?.() || playRange(store.project, engine.mode, store.view.pattern), tick: engine.position };
  }

  /** Elapsed musical ticks, excluding seeks and preserving earlier tempo segments. */
  readClock(now = performance.now()) {
    if (!this.clock) this.clock = { ...this.clockConfig(), at: now, elapsed: 0 };
    const c = this.clock;
    const next = advanceRecordingClock(c.map, c.tick, (now - c.at) / 1000, c.range);
    c.tick = next.tick;
    c.elapsed += next.elapsed;
    c.at = now;
    return c.elapsed;
  }

  resetClock() {
    if (!this.clock) return;
    this.readClock(); // finish the old tempo segment before reading the new map
    Object.assign(this.clock, this.clockConfig());
  }

  patternInfo() {
    const { store, engine } = this.app;
    const pattern = patternById(store.project, store.view.pattern) || store.project.patterns[0];
    const patLen = patternLength(pattern, store.project.sig);
    return { pattern, patLen, tick: patternTick(engine.position, { mode: engine.mode, patternId: pattern.id, patLen, clips: store.project.clips }) };
  }

  /** Called by the live input for every note on. Returns true when the note was recorded or step-edited. */
  noteOn(key, vel, channel) {
    if (!channel) return false;
    if (this.active) {
      const { pattern, tick } = this.patternInfo();
      const id = uid(6);
      this.take.set(id, { id, key, vel, pattern: pattern.id, channel, pos: tick, started: this.readClock(), open: true, len: 0 });
      this.byKey.set(key, id);
      this.takeTotal = (this.takeTotal || 0) + 1;
      this.write();
      return true;
    }
    if (this.stepEditing) {
      this.stepInsert(key, vel, channel);
      return true;
    }
    return false;
  }

  noteOff(key) {
    if (this.stepHeld > 0) {
      this.stepHeld--;
      if (this.stepHeld === 0 && this.stepAdvance) {
        shared.cursor.tick += this.stepAdvance;
        this.stepAdvance = 0;
        sharedEvents.emit('cursor');
      }
    }
    const id = this.byKey.get(key);
    if (!id) return;
    this.byKey.delete(key);
    const n = this.take.get(id);
    if (!n) return;
    n.open = false;
    n.len = this.readClock() - n.started;
    this.write();
  }

  stepInsert(key, vel, channel) {
    const { pattern } = this.patternInfo();
    const len = shared.grid > 0 ? shared.grid : 24;
    const pos = Math.max(0, Math.round(shared.cursor.tick));
    const note = { id: uid(6), key, pos, len, vel, pan: 0 };
    this.app.store.apply('Step edit note', (p) => E.addNotes(p, pattern.id, channel, [note]));
    this.stepHeld++;
    this.stepAdvance = len;
  }

  /** Applies every note of the take to the gesture's start state (one undo step). */
  write() {
    const store = this.app.store;
    if (store.gesture && store.gesture !== this.gesture) {
      this.pending = true; // another gesture is running (a drag); retry next frame
      return;
    }
    this.pending = false;
    if (!store.gesture) {
      this.flushFinished();
      store.begin('Record notes');
      this.gesture = store.gesture;
    }
    store.preview(this.editTake());
  }

  /** Captures this pass so a stopped take can be applied after another drag. */
  editTake(snapshot = false) {
    const quantize = Boolean(this.app.prefs.get('recordQuantize'));
    const grid = shared.grid;
    const now = this.readClock();
    const notes = snapshot ? [...this.take.values()].map((n) => ({ ...n })) : this.take.values();
    return (base) => {
      let next = base;
      const groups = new Map();
      for (const n of notes) {
        const k = `${n.pattern}|${n.channel}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      for (const list of groups.values()) {
        const { pattern: pid, channel: cid } = list[0];
        const pat = patternById(next, pid);
        if (!pat || !next.channels.some((c) => c.id === cid)) continue;
        const patLen = patternLength(pat, next.sig);
        const ids = new Set(list.map((n) => n.id));
        const kept = E.getNotes(next, pid, cid).filter((n) => !ids.has(n.id));
        const added = list.map((n) => {
          const elapsed = n.open ? now - n.started : n.len;
          const r = recordedNote(n.pos, elapsed, { patLen, grid, quantize });
          return { id: n.id, key: n.key, pos: r.pos, len: r.len, vel: n.vel, pan: 0 };
        });
        next = E.setNotes(next, pid, cid, [...kept, ...added]);
      }
      return next;
    };
  }

  flushFinished() {
    if (!this.app.store.gesture && this.finished.length) {
      for (const { edit, count } of this.finished.splice(0)) {
        this.app.store.apply('Record notes', edit);
        this.notifyTake(count);
      }
    }
  }

  frame() {
    this.flushFinished();
    if (this.pending && !this.app.store.gesture) this.write();
    if (!this.byKey.size || !this.active) return;
    const now = performance.now();
    if (now - this.lastGrow < 90) return;
    this.lastGrow = now;
    this.write();
  }

  /** Commits the loop pass; held notes carry on into the next step. */
  commitPass() {
    const store = this.app.store;
    if (this.take.size && store.gesture && store.gesture !== this.gesture) {
      this.finished.push({ edit: this.editTake(true), count: 0 });
    }
    if (store.gesture && store.gesture === this.gesture) store.commit();
    this.gesture = null;
    for (const [id, n] of [...this.take]) if (!n.open) this.take.delete(id);
    if (!this.take.size) this.pending = false;
  }

  endTake() {
    const now = this.readClock();
    for (const n of this.take.values()) {
      if (n.open) {
        n.open = false;
        n.len = now - n.started;
      }
    }
    const store = this.app.store;
    const count = this.takeTotal || this.take.size;
    if (this.take.size && store.gesture && store.gesture !== this.gesture) {
      this.finished.push({ edit: this.editTake(true), count });
    } else {
      if (this.take.size) this.write();
      if (store.gesture && store.gesture === this.gesture) store.commit();
      this.notifyTake(count);
    }
    this.takeTotal = 0;
    this.pending = false;
    this.gesture = null;
    this.take.clear();
    this.byKey.clear();
    this.clock = null;
  }

  notifyTake(count) {
    if (count) this.app.notify?.(`Recorded ${count} note${count === 1 ? '' : 's'}`);
  }
}
