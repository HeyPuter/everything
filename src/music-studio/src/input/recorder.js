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
    this.lastGrow = 0;
    this.stepHeld = 0;
    this.stepAdvance = 0;
    const engine = app.engine;
    engine.on('state', () => {
      if (!(engine.recording && engine.playing) && this.take.size) this.endTake();
    });
    engine.on('loop', () => {
      if (this.take.size) this.commitPass();
    });
    app.on('frame', () => this.frame());
  }

  get active() {
    const e = this.app.engine;
    return Boolean(e.recording && e.playing);
  }

  get stepEditing() {
    return Boolean(this.app.prefs.get('stepEditing')) && !this.app.engine.playing;
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
      this.take.set(id, { id, key, vel, pattern: pattern.id, channel, pos: tick, started: performance.now(), open: true, len: 0 });
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
    n.len = msToTicks(performance.now() - n.started, this.app.store.project.bpm);
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
      store.begin('Record notes');
      this.gesture = store.gesture;
    }
    const bpm = store.project.bpm;
    const quantize = Boolean(this.app.prefs.get('recordQuantize'));
    const now = performance.now();
    store.preview((base) => {
      let next = base;
      const groups = new Map();
      for (const n of this.take.values()) {
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
          const elapsed = n.open ? msToTicks(now - n.started, bpm) : n.len;
          const r = recordedNote(n.pos, elapsed, { patLen, grid: shared.grid, quantize });
          return { id: n.id, key: n.key, pos: r.pos, len: r.len, vel: n.vel, pan: 0 };
        });
        next = E.setNotes(next, pid, cid, [...kept, ...added]);
      }
      return next;
    });
  }

  frame() {
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
    if (store.gesture && store.gesture === this.gesture) store.commit();
    this.gesture = null;
    for (const [id, n] of [...this.take]) if (!n.open) this.take.delete(id);
  }

  endTake() {
    const now = performance.now();
    const bpm = this.app.store.project.bpm;
    for (const n of this.take.values()) {
      if (n.open) {
        n.open = false;
        n.len = msToTicks(now - n.started, bpm);
      }
    }
    if (this.take.size) this.write();
    const store = this.app.store;
    const count = this.takeTotal || this.take.size;
    this.takeTotal = 0;
    if (store.gesture && store.gesture === this.gesture) store.commit();
    this.gesture = null;
    this.take.clear();
    this.byKey.clear();
    if (count) this.app.notify?.(`Recorded ${count} note${count === 1 ? '' : 's'}`);
  }
}
