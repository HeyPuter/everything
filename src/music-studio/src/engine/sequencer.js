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
import { AUDIO_TUNE, AUDIO_REVERSE, audioStepCuts, integrateAudioRate } from './audio-rate.js';

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
  if (tick < pts[0]) return pts[1];
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
    this.free = false; // playing past a playlist loop toward the song end
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
    this.aOrigin = new Array(MAX_ACTIVE).fill(null);
    this.active = 0;
    this.lanes = [];
    this.audioMotionLanes = new Map();
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
    this.audioMotionLanes.clear();
    for (const lane of this.lanes) {
      const t = lane.target;
      if (!((t.kind === 'param' && (t.index === AUDIO_TUNE || t.index === AUDIO_REVERSE)) || (t.kind === 'strip' && t.field === 'pitch'))) continue;
      let list = this.audioMotionLanes.get(t.slot);
      if (!list) this.audioMotionLanes.set(t.slot, (list = []));
      list.push(lane);
    }
    if (this.playing) {
      if (this.loop && this.pos >= this.#end() && !this.countIn) this.#jump(seq.start, 0);
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
    const matched = new Set();
    const findEvent = eventMatcher(n, matched);
    for (let i = 0; i < this.active; ) {
      const j = findEvent(this.aStart[i], this.aSlot[i], this.aKind[i], this.aKey[i], this.aOrigin[i]);
      if (j < 0) {
        this.core.noteOff(this.aSlot[i], this.aId[i], 0);
        this.#removeActive(i);
        continue;
      }
      matched.add(j);
      this.aEnd[i] = n.end[j];
      i++;
    }
    if (this.countIn) return;
    const pos = this.pos;
    for (let k = 0; k < seq.audio.length; k++) {
      const i = seq.audio[k];
      if (!(n.start[i] < pos && n.end[i] > pos)) continue;
      if (matched.has(i)) continue;
      this.#startAudio(n, i, pos, 0);
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

  /**
   * Where playback wraps: the loop end, or the song end while playing past a
   * playlist loop (after a seek beyond it), which then joins the loop.
   */
  #end() {
    const s = this.seq;
    return this.free && s.outer > s.end ? s.outer : s.end;
  }

  #clampStart(t) {
    const s = this.seq;
    this.free = this.loop && t >= s.end && t < (s.outer ?? s.end);
    if (this.loop && (t >= this.#end() || t < 0)) {
      this.free = false;
      return s.start;
    }
    return Math.max(0, t);
  }

  #audioSource(notes, i, tick) {
    const slot = notes.slot[i], start = notes.start[i];
    const lanes = (this.audioMotionLanes.get(slot) || []).filter((l) => l.segs.some((s) => s.start < tick && s.end > start));
    const baseRate = this.core.audioPlaybackRate?.(slot) ?? 1;
    if (!lanes.length) return notes.offset[i] + this.tempo.duration(start, tick) * baseRate;
    let active = [];
    const valuesAt = (at) => {
      const values = {};
      for (const { lane, seg } of active) {
        const field = lane.target.kind === 'strip' ? 'pitch' : lane.target.index === AUDIO_REVERSE ? 'reverse' : 'tune';
        values[field] = fromNorm(lane.def, automationValue(seg.pts, at, seg.cs));
      }
      return values;
    };
    const rateAt = (seconds) => this.core.audioPlaybackRate?.(slot, valuesAt(this.tempo.ticks(seconds))) ?? 1;
    const changesDirection = lanes.some((l) => l.target.kind === 'param' && l.target.index === AUDIO_REVERSE) && typeof this.core.audioSampleInfo === 'function';
    const sample = changesDirection ? this.core.audioSampleInfo(slot) : null;
    if (changesDirection && !sample) return null;
    let position = 0;
    if (sample) {
      for (const lane of lanes) {
        const seg = lane.segs.find((s) => s.start <= start && start < s.end);
        if (seg) active.push({ lane, seg });
      }
      const reverse = (valuesAt(start).reverse ?? Number(sample.reverse)) >= 0.5;
      position = reverse ? sample.last - notes.offset[i] : notes.offset[i];
      if (position < 0 || position >= sample.duration) return null;
    }
    // Split at clip/point boundaries before integrating, so automation gaps,
    // overlapping clips and abrupt changes retain the sequencer's precedence.
    const cuts = new Set([start, tick]);
    const cut = (t) => { if (t > start && t < tick) cuts.add(t); };
    for (const lane of lanes) for (const seg of lane.segs) {
      cut(seg.start); cut(seg.end);
      for (let j = 0; j < seg.pts.length; j += 2) cut(seg.pts[j]);
      audioStepCuts(lane.def, seg, Math.max(start, seg.start), Math.min(tick, seg.end), cut);
    }
    for (const t of this.tempo.T) cut(t);
    const ticks = [...cuts].sort((a, b) => a - b);
    const times = ticks.map((t) => this.tempo.seconds(t));
    const cursors = lanes.map((lane) => ({ lane, next: 0 }));
    let distance = notes.offset[i];
    for (let j = 1; j < times.length; j++) {
      // Segment membership is fixed between the cuts. Walk the sorted lanes
      // once; the first unexpired segment retains overlap precedence.
      const mid = (ticks[j - 1] + ticks[j]) / 2;
      active = [];
      for (const cursor of cursors) {
        const { lane } = cursor;
        while (cursor.next < lane.segs.length && lane.segs[cursor.next].end <= mid) cursor.next++;
        const seg = lane.segs[cursor.next];
        if (seg && seg.start <= mid) active.push({ lane, seg });
      }
      const travel = active.length ? integrateAudioRate(rateAt, times[j - 1], times[j]) : (times[j] - times[j - 1]) * baseRate;
      if (sample) {
        const reverse = (valuesAt(mid).reverse ?? Number(sample.reverse)) >= 0.5;
        position += reverse ? -travel : travel;
        // A finished voice stays finished even if a later direction change
        // would bring its mathematical position back inside the source.
        if (position < 0 || position >= sample.duration) return null;
      } else distance += travel;
    }
    return sample ? { position } : distance;
  }

  #startAudio(notes, i, tick, offset) {
    const source = this.#audioSource(notes, i, tick);
    if (source === null) return;
    const id = this.nextId++ >>> 0;
    if (typeof source === 'number') this.core.audioOn(notes.slot[i], id, source, notes.vel[i], offset);
    else this.core.audioAt(notes.slot[i], id, source.position, notes.vel[i], offset);
    this.#addActive(notes.end[i], notes.slot[i], id, 1, notes.start[i], notes.key[i], notes.origin?.[i]);
  }

  /** Audio clips that span `tick` start from the middle. */
  #resumeAudio(tick, offset) {
    const s = this.seq;
    const n = s.notes;
    for (let k = 0; k < s.audio.length; k++) {
      const i = s.audio[k];
      if (n.start[i] < tick && n.end[i] > tick) {
        this.#startAudio(n, i, tick, offset);
      }
    }
  }

  #addActive(end, slot, id, kind, start, key, origin = null) {
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
    this.aOrigin[a] = origin;
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
      this.aOrigin[i] = this.aOrigin[last];
    }
    this.aOrigin[last] = null;
  }

  #releaseAll(offset) {
    for (let i = 0; i < this.active; i++) this.core.noteOff(this.aSlot[i], this.aId[i], offset);
    this.aOrigin.fill(null, 0, this.active);
    this.active = 0;
  }

  #jump(tick, offset) {
    this.free = false;
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
      else this.#addActive(n.end[i], n.slot[i], id, n.kind[i], n.start[i], n.key[i], n.origin?.[i]);
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
      const end = this.#end();
      if (t0 >= end - 1e-9) {
        // At or past the range end (also after a seek beyond it).
        if (this.loop) {
          this.wraps++;
          this.#jump(s.start, f);
          if (s.end <= s.start) break;
          continue;
        }
        this.#releaseAll(Math.min(f, frames - 1));
        this.pos = end;
        this.playing = false;
        this.ended = true;
        return;
      }
      const s0 = map.seconds(t0);
      const toEnd = Math.ceil((map.seconds(end) - s0) * rate - 1e-6);
      if (toEnd <= left) {
        // The range ends inside this block.
        this.#events(t0, toEnd, f, s0);
        f += toEnd;
        this.pos = end;
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

/** Lazy source lookup within each start-time group; each event is indexed once. */
function eventMatcher(n, matched) {
  const groups = new Map();
  return (start, slot, kind, key, origin) => {
    let group = groups.get(start);
    if (!group) {
      group = { next: lowerBound(n.start, n.count, start), sources: new Map() };
      groups.set(start, group);
    }
    const matches = (j) => !matched.has(j) && n.slot[j] === slot && n.kind[j] === kind && n.key[j] === key;
    for (const j of group.sources.get(origin) || []) if (matches(j)) return j;
    while (group.next < n.count && n.start[group.next] === start) {
      const j = group.next++;
      const source = n.origin?.[j] ?? null;
      let indices = group.sources.get(source);
      if (!indices) group.sources.set(source, (indices = []));
      indices.push(j);
      if (source === origin && matches(j)) return j;
    }
    return -1;
  };
}

function laneKey(l) {
  const t = l.target;
  return `${t.kind}:${t.slot ?? t.track}:${t.fx ?? ''}:${t.index ?? t.field ?? ''}`;
}
