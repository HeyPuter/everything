// Sample-accurate sequencer shared by the AudioWorklet and the offline render
// worker. It walks a compiled sequence (compile.js) block by block, queues
// note events into the core at their exact frame offsets, cuts sounding
// notes when playback wraps, evaluates automation once per block, plays the
// metronome and a count-in bar, then renders the block.
//
// Time runs through the sequence's tempo map (engine/tempo.js): every event
// tick is converted to seconds and then to a frame, so notes, audio clip
// offsets, loop wraps, metronome clicks and the playhead follow tempo
// automation exactly. The core's tempo (tempo-synced delay times) is set to
// the tempo at the start of each block. The count-in bar plays at the tempo
// of the play position.
//
//   const seq = new Sequencer(core, sampleRate)
//   seq.setSequence(compiled); seq.play(tick, { countIn }); seq.block(128)
//   seq.pos (ticks), seq.playing, seq.counting, seq.wraps (count of loop wraps)
//
// With `loop: false` (offline renders) playback stops at the range end: the
// sounding notes are released and `ended` is set; blocks keep rendering the
// tails.

import { fromNorm } from '../lib/params.js';
import { curveShape } from '../automation/evaluate.js';
import { TempoMap } from './tempo.js';

const PPQ = 96;
const MAX_ACTIVE = 4096;
const SEQ_ID = 1;

/**
 * Automation points (Float64Array [tick, v, ...]) at `tick`, with optional
 * per-point segment curves `cs` (Float64Array, one tension per point; see
 * automation/evaluate.js, which this matches exactly).
 */
export function automationValue(pts, tick, cs = null) {
  const n = pts.length >> 1;
  if (!n) return 0;
  if (tick <= pts[0]) return pts[1];
  if (tick >= pts[(n - 1) * 2]) return pts[(n - 1) * 2 + 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid * 2] <= tick) lo = mid;
    else hi = mid;
  }
  const t0 = pts[lo * 2];
  const t1 = pts[hi * 2];
  const v0 = pts[lo * 2 + 1];
  const v1 = pts[hi * 2 + 1];
  return t1 > t0 ? v0 + (v1 - v0) * curveShape((tick - t0) / (t1 - t0), cs ? cs[lo] : 0) : v1;
}

function lowerBound(arr, n, v) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Sequencer {
  constructor(core, rate, { loop = true } = {}) {
    this.core = core;
    this.rate = rate;
    this.loop = loop;
    this.seq = null;
    this.playing = false;
    this.pos = 0;
    this.cursor = 0;
    this.wraps = 0;
    this.ended = false;
    this.metronome = false;
    this.countIn = 0; // ticks of count-in left
    this.countLen = 0;
    this.nextId = SEQ_ID;
    // Sounding sequenced notes: end tick, slot, id, kind, and the start tick
    // and key of the event that started them (to match them in a new sequence).
    this.aEnd = new Float64Array(MAX_ACTIVE);
    this.aSlot = new Int32Array(MAX_ACTIVE);
    this.aId = new Uint32Array(MAX_ACTIVE);
    this.aKind = new Uint8Array(MAX_ACTIVE);
    this.aStart = new Float64Array(MAX_ACTIVE);
    this.aKey = new Uint8Array(MAX_ACTIVE);
    this.active = 0;
    this.lanes = [];
    this.tempo = new TempoMap(120);
  }

  get counting() {
    return this.countIn > 0;
  }

  /** Tempo at the play position. */
  get bpm() {
    return this.tempo.bpmAt(this.pos);
  }

  /** Ticks per frame at the play position's tempo. */
  get tpf() {
    return (this.bpm * PPQ) / 60 / this.rate;
  }

  /** Frames between two ticks under the tempo map (fractional). */
  framesBetween(a, b) {
    return this.tempo.duration(a, b) * this.rate;
  }

  setSequence(seq) {
    this.seq = seq;
    this.tempo = new TempoMap(seq.tempo || seq.bpm || 120);
    this.core.setTempo(this.tempo.bpmAt(this.pos));
    // Lanes that disappear restore their parameters.
    const keep = new Set(seq.auto.map(laneKey));
    for (const l of this.lanes) if (l.applied && !keep.has(laneKey(l))) this.#restore(l);
    const prev = new Map(this.lanes.map((l) => [laneKey(l), l]));
    this.lanes = seq.auto.map((l) => ({ ...l, applied: prev.get(laneKey(l))?.applied || false }));
    if (this.playing) {
      if (this.loop && this.pos >= seq.end && !this.countIn) this.#jump(seq.start, 0);
      else {
        this.cursor = lowerBound(seq.notes.start, seq.notes.count, this.pos);
        this.#reconcile(seq);
      }
    }
  }

  /**
   * Keeps the sounding notes in step with an edited sequence: notes and audio
   * clips that are gone (deleted, muted, moved) are released now instead of at
   * their old end, the rest take their new end, and audio clips that now span
   * the playhead (unmuted, moved under it) start from the middle.
   */
  #reconcile(seq) {
    const n = seq.notes;
    for (let i = 0; i < this.active; ) {
      const j = findEvent(n, this.aStart[i], this.aSlot[i], this.aKind[i], this.aKey[i]);
      if (j < 0) {
        this.core.noteOff(this.aSlot[i], this.aId[i], 0);
        this.#removeActive(i);
        continue;
      }
      this.aEnd[i] = n.end[j];
      i++;
    }
    if (this.countIn) return;
    const pos = this.pos;
    for (let k = 0; k < seq.audio.length; k++) {
      const i = seq.audio[k];
      if (!(n.start[i] < pos && n.end[i] > pos)) continue;
      let sounding = false;
      for (let a = 0; a < this.active; a++) {
        if (this.aKind[a] === 1 && this.aSlot[a] === n.slot[i] && this.aStart[a] === n.start[i]) {
          sounding = true;
          break;
        }
      }
      if (sounding) continue;
      const id = this.nextId++ >>> 0;
      this.core.audioOn(n.slot[i], id, n.offset[i] + this.tempo.duration(n.start[i], pos), n.vel[i], 0);
      this.#addActive(n.end[i], n.slot[i], id, 1, n.start[i], n.key[i]);
    }
  }

  play(tick = 0, { countIn = false } = {}) {
    if (!this.seq) return;
    this.playing = true;
    this.ended = false;
    this.pos = this.#clampStart(tick);
    this.cursor = lowerBound(this.seq.notes.start, this.seq.notes.count, this.pos);
    const sig = this.seq.sig || [4, 4];
    this.countLen = countIn ? (PPQ * 4 * sig[0]) / sig[1] : 0;
    this.countIn = this.countLen;
    if (!this.countIn) this.#resumeAudio(this.pos, 0);
  }

  stop() {
    this.playing = false;
    this.countIn = 0;
    this.#releaseAll(0);
    for (const l of this.lanes) if (l.applied) this.#restore(l);
  }

  seek(tick) {
    if (!this.seq) {
      this.pos = tick;
      return;
    }
    this.#releaseAll(0);
    this.pos = this.playing ? this.#clampStart(tick) : tick;
    this.cursor = lowerBound(this.seq.notes.start, this.seq.notes.count, this.pos);
    if (this.playing && !this.countIn) this.#resumeAudio(this.pos, 0);
  }

  #clampStart(t) {
    const s = this.seq;
    if (this.loop && (t >= s.end || t < 0)) return s.start;
    return Math.max(0, t);
  }

  /** Audio clips that span `tick` start from the middle. */
  #resumeAudio(tick, offset) {
    const s = this.seq;
    const n = s.notes;
    for (let k = 0; k < s.audio.length; k++) {
      const i = s.audio[k];
      if (n.start[i] < tick && n.end[i] > tick) {
        const id = this.nextId++ >>> 0;
        const sec = n.offset[i] + this.tempo.duration(n.start[i], tick);
        this.core.audioOn(n.slot[i], id, sec, n.vel[i], offset);
        this.#addActive(n.end[i], n.slot[i], id, 1, n.start[i], n.key[i]);
      }
    }
  }

  #addActive(end, slot, id, kind, start, key) {
    if (this.active >= MAX_ACTIVE) {
      // Too many sounding notes: release the oldest.
      this.core.noteOff(this.aSlot[0], this.aId[0], 0);
      this.#removeActive(0);
    }
    const a = this.active++;
    this.aEnd[a] = end;
    this.aSlot[a] = slot;
    this.aId[a] = id;
    this.aKind[a] = kind;
    this.aStart[a] = start;
    this.aKey[a] = key;
  }

  #removeActive(i) {
    const last = --this.active;
    if (i !== last) {
      this.aEnd[i] = this.aEnd[last];
      this.aSlot[i] = this.aSlot[last];
      this.aId[i] = this.aId[last];
      this.aKind[i] = this.aKind[last];
      this.aStart[i] = this.aStart[last];
      this.aKey[i] = this.aKey[last];
    }
  }

  #releaseAll(offset) {
    for (let i = 0; i < this.active; i++) this.core.noteOff(this.aSlot[i], this.aId[i], offset);
    this.active = 0;
  }

  #jump(tick, offset) {
    this.#releaseAll(offset);
    this.pos = tick;
    this.cursor = lowerBound(this.seq.notes.start, this.seq.notes.count, tick);
    this.#resumeAudio(tick, offset);
  }

  /** Frame (from the frame at seconds s0) of the first frame at or after tick t. */
  #frameOf(t, s0) {
    const k = Math.ceil((this.tempo.seconds(t) - s0) * this.rate - 1e-6);
    return k > 0 ? k : 0;
  }

  /**
   * Queues the events of the `frames` frames starting at tick t0 (frame f0
   * in the block, s0 = tempo.seconds(t0)). An event lands on the first frame
   * at or after its tick; events that fall past the last frame wait for the
   * next call.
   */
  #events(t0, frames, f0, s0) {
    const n = this.seq.notes;
    // Note-offs first so a retriggered key never cuts its successor.
    for (let i = 0; i < this.active; ) {
      const k = this.#frameOf(this.aEnd[i], s0);
      if (k < frames) {
        this.core.noteOff(this.aSlot[i], this.aId[i], f0 + k);
        this.#removeActive(i);
      } else i++;
    }
    while (this.cursor < n.count) {
      const i = this.cursor;
      const k = this.#frameOf(n.start[i], s0);
      if (k >= frames) break;
      this.cursor++;
      const off = f0 + k;
      const id = this.nextId++ >>> 0;
      if (this.nextId > 0x7fffffff) this.nextId = SEQ_ID;
      if (n.kind[i] === 1) this.core.audioOn(n.slot[i], id, n.offset[i], n.vel[i], off);
      else this.core.noteOn(n.slot[i], id, n.key[i], n.vel[i], n.pan[i], off);
      const ke = this.#frameOf(n.end[i], s0);
      // A note shorter than a frame still gets its note-off after the note-on.
      if (ke < frames && ke > k) this.core.noteOff(n.slot[i], id, f0 + ke);
      else this.#addActive(n.end[i], n.slot[i], id, n.kind[i], n.start[i], n.key[i]);
    }
    if (this.metronome) this.#clicks(t0, frames, f0, s0);
  }

  /** Metronome clicks on the beats in the frames after tick t0 (at seconds s0). */
  #clicks(t0, frames, f0, s0) {
    const sig = this.seq.sig || [4, 4];
    const beat = (PPQ * 4) / sig[1];
    const bar = beat * sig[0];
    for (let b = Math.ceil(t0 / beat - 1e-6) * beat; ; b += beat) {
      const k = this.#frameOf(b, s0);
      if (k >= frames) break;
      const inBar = ((b % bar) + bar) % bar;
      this.core.click(inBar < 1e-6 || bar - inBar < 1e-6, f0 + k);
    }
  }

  /** Count-in clicks: count-in ticks at a constant tpf (ticks per frame). */
  #countClicks(t0, frames, f0, tpf) {
    const sig = this.seq.sig || [4, 4];
    const beat = (PPQ * 4) / sig[1];
    const bar = beat * sig[0];
    const t1 = t0 + frames * tpf;
    for (let b = Math.ceil(t0 / beat - 1e-6) * beat; b < t1; b += beat) {
      const k = Math.max(0, Math.ceil((b - t0) / tpf - 1e-6));
      if (k >= frames) break;
      const inBar = ((b % bar) + bar) % bar;
      this.core.click(inBar < 1e-6 || bar - inBar < 1e-6, f0 + k);
    }
  }

  #automate(tick) {
    for (const l of this.lanes) {
      let seg = null;
      for (const s of l.segs) {
        if (s.start <= tick && tick < s.end) {
          seg = s;
          break;
        }
      }
      if (!seg) {
        if (l.applied) this.#restore(l);
        continue;
      }
      const v = fromNorm(l.def, automationValue(seg.pts, tick, seg.cs));
      this.#apply(l.target, v);
      l.applied = true;
    }
  }

  #apply(t, v) {
    const c = this.core;
    switch (t.kind) {
      case 'param':
        c.automateParam(t.slot, t.index, v);
        break;
      case 'strip':
        c.automateStrip(t.slot, t.field, v);
        break;
      case 'track':
        c.automateTrack(t.track, t.field, v);
        break;
      case 'fx':
        c.automateFx(t.track, t.fx, t.index, v);
        break;
      case 'mix':
        c.automateMix(t.track, t.fx, v);
        break;
    }
  }

  #restore(l) {
    l.applied = false;
    const t = l.target;
    const c = this.core;
    switch (t.kind) {
      case 'param':
        c.restoreParam(t.slot, t.index);
        break;
      case 'strip':
        c.automateStrip(t.slot, t.field, null);
        break;
      case 'track':
        c.automateTrack(t.track, t.field, null);
        break;
      case 'fx':
        c.automateFx(t.track, t.fx, t.index, null);
        break;
      case 'mix':
        c.automateMix(t.track, t.fx, null);
        break;
    }
  }

  /** Sequences and renders `frames` frames; returns the core's output views. */
  block(frames) {
    if (this.playing && this.seq) this.#advance(frames);
    return this.core.process(frames);
  }

  #advance(frames) {
    const map = this.tempo;
    const rate = this.rate;
    let f = 0;
    // Count-in: clicks only, the playhead waits.
    if (this.countIn > 0) {
      const tpf = this.tpf;
      const c0 = this.countLen - this.countIn;
      const need = Math.max(0, Math.ceil(this.countIn / tpf - 1e-6));
      const fr = Math.min(frames, need);
      this.#countClicks(c0, fr, 0, tpf);
      this.countIn = fr === need ? 0 : this.countIn - fr * tpf;
      if (this.countIn > 0) return;
      f = fr;
      this.#resumeAudio(this.pos, Math.min(f, frames - 1));
      if (f >= frames) return;
    }
    this.core.setTempo(map.bpmAt(this.pos));
    this.#automate(this.pos);
    const s = this.seq;
    let guard = 0;
    while (f < frames && guard++ < 8) {
      const t0 = this.pos;
      const left = frames - f;
      if (t0 >= s.end - 1e-9) {
        // At or past the range end (also after a seek beyond it).
        if (this.loop) {
          this.wraps++;
          this.#jump(s.start, f);
          if (s.end <= s.start) break;
          continue;
        }
        this.#releaseAll(Math.min(f, frames - 1));
        this.pos = s.end;
        this.playing = false;
        this.ended = true;
        return;
      }
      const s0 = map.seconds(t0);
      const toEnd = Math.ceil((map.seconds(s.end) - s0) * rate - 1e-6);
      if (toEnd <= left) {
        // The range ends inside this block.
        this.#events(t0, toEnd, f, s0);
        f += toEnd;
        this.pos = s.end;
        if (f >= frames && this.loop) {
          // Wrap at the start of the next block.
          return;
        }
        continue;
      }
      this.#events(t0, left, f, s0);
      const t1 = map.ticks(s0 + left / rate);
      this.pos = t1 > t0 ? t1 : t0;
      f = frames;
    }
  }
}

/** Index of the event that starts at `start` on `slot` with this kind and key, or -1. */
function findEvent(n, start, slot, kind, key) {
  for (let j = lowerBound(n.start, n.count, start); j < n.count && n.start[j] === start; j++) {
    if (n.slot[j] === slot && n.kind[j] === kind && n.key[j] === key) return j;
  }
  return -1;
}

function laneKey(l) {
  const t = l.target;
  return `${t.kind}:${t.slot ?? t.track}:${t.fx ?? ''}:${t.index ?? t.field ?? ''}`;
}
