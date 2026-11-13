// Sample-accurate sequencer shared by the AudioWorklet and the offline render
// worker. It walks a compiled sequence (compile.js) block by block, queues
// note events into the core at their exact frame offsets, cuts sounding
// notes when playback wraps, evaluates automation at block/segment boundaries, plays the
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
import { automationValue } from '../automation/evaluate.js';
import { TempoMap } from './tempo.js';
import { AUDIO_TUNE, AUDIO_REVERSE, audioSourceAt, audioStepCuts } from './audio-rate.js';

const PPQ = 96;
const MAX_ACTIVE = 4096;
const SEQ_ID = 1;

export { automationValue } from '../automation/evaluate.js';

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
    this.resumePending = false;
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
    this.automationBoundaries = new Float64Array();
    this.output = null;
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
    this.lanes = seq.auto.map((l) => {
      let end = -Infinity;
      // End times need not be sorted: overlapping clips retain first-match
      // priority. Prefix maxima let seeks skip only fully expired prefixes.
      const ends = Float64Array.from(l.segs, (s) => (end = Math.max(end, s.end)));
      return { ...l, applied: prev.get(laneKey(l))?.applied || false, ends, cursor: -1, tick: NaN };
    });
    this.automationBoundaries = automationBoundaries(this.lanes);
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
    this.resumePending = false;
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
    this.resumePending = false;
    if (!this.countIn) this.#resumeAudio(this.pos, 0);
  }

  stop() {
    this.playing = false;
    this.countIn = 0;
    this.resumePending = false;
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
    const start = notes.sourceStart?.[i] ?? notes.start[i];
    if (tick === start) return notes.offset[i];
    const slot = notes.slot[i];
    return audioSourceAt({
      start, offset: notes.offset[i],
      lanes: this.audioMotionLanes.get(slot) || [], tempo: this.tempo,
      playbackRate: (values) => this.core.audioPlaybackRate?.(slot, values) ?? 1,
      sampleInfo: this.core.audioSampleInfo ? () => this.core.audioSampleInfo(slot) : undefined,
    }, tick);
  }

  #startAudio(notes, i, tick, offset, endOffset = null) {
    const source = this.#audioSource(notes, i, tick);
    if (source === null || (typeof source === 'number' && source < 0)) return;
    const id = this.nextId++ >>> 0;
    if (this.nextId > 0x7fffffff) this.nextId = SEQ_ID;
    if (typeof source === 'number') this.core.audioOn(notes.slot[i], id, source, notes.vel[i], offset);
    else this.core.audioAt(notes.slot[i], id, source.position, notes.vel[i], offset);
    if (endOffset !== null) this.core.noteOff(notes.slot[i], id, endOffset);
    else this.#addActive(notes.end[i], notes.slot[i], id, 1, notes.start[i], notes.key[i], notes.origin?.[i]);
  }

  /** Audio clips that span `tick` start from the middle. */
  #resumeAudio(tick, offset) {
    this.resumePending = false;
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
      const ke = this.#frameOf(n.end[i], s0);
      // A note shorter than a frame still gets its note-off after the note-on.
      const endOffset = ke < frames && ke > k ? f0 + ke : null;
      if (n.kind[i] === 1) this.#startAudio(n, i, n.start[i], off, endOffset);
      else {
        const id = this.nextId++ >>> 0;
        if (this.nextId > 0x7fffffff) this.nextId = SEQ_ID;
        this.core.noteOn(n.slot[i], id, n.key[i], n.vel[i], n.pan[i], off);
        if (endOffset !== null) this.core.noteOff(n.slot[i], id, endOffset);
        else this.#addActive(n.end[i], n.slot[i], id, n.kind[i], n.start[i], n.key[i], n.origin?.[i]);
      }
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
    // Tempo round trips can leave the first frame of a boundary a few
    // ulps below its tick. Match the scheduling tolerance at that frame.
    tick += 1e-9;
    for (const l of this.lanes) {
      const seg = automationSegment(l, tick);
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
    let done = 0;
    while (done < frames) {
      const left = frames - done;
      const n = this.playing && this.seq && this.automationBoundaries.length ? this.#framesToAutomation(left) : left;
      if (this.playing && this.seq) this.#advance(n);
      const out = this.core.process(n);
      if (!done && n === frames) return out;
      // The WASM output views are reused by each sub-block. Copy only when
      // a boundary actually splits this call; ordinary blocks stay zero-copy.
      if (!this.output || this.output.l.length < frames) this.output = { l: new Float32Array(frames), r: new Float32Array(frames) };
      this.output.l.set(out.l.subarray(0, n), done);
      this.output.r.set(out.r.subarray(0, n), done);
      done += n;
    }
    return this.output;
  }

  #framesToAutomation(limit) {
    const count = this.countIn > 0 ? Math.max(0, Math.ceil(this.countIn / this.tpf - 1e-6)) : 0;
    if (count >= limit) return limit;
    const end = this.#end();
    const tick = this.loop && this.pos >= end - 1e-9 ? this.seq.start : this.pos;
    const boundaries = this.automationBoundaries;
    let lo = 0, hi = boundaries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (boundaries[mid] <= tick + 1e-9) lo = mid + 1;
      else hi = mid;
    }
    const next = Math.min(boundaries[lo] ?? Infinity, tick < end ? end : Infinity);
    const n = Math.ceil(this.tempo.duration(tick, next) * this.rate - 1e-6);
    return Math.min(limit, count + Math.max(1, n));
  }

  #advance(frames) {
    const map = this.tempo;
    const rate = this.rate;
    let f = 0;
    if (this.resumePending) this.#resumeAudio(this.pos, 0);
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
      if (f >= frames) {
        // The last count-in frame is still silent. Resume on the next
        // render call; intervening edits, seeks, and stops can replace it.
        this.resumePending = true;
        return;
      }
      this.#resumeAudio(this.pos, f);
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
          this.core.setTempo(map.bpmAt(this.pos));
          this.#automate(this.pos);
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


/** First active segment, with constant work while staying in the same clip. */
function automationSegment(lane, tick) {
  let i = lane.cursor;
  if (!(i >= 0 && tick >= lane.tick && (i === lane.segs.length || lane.ends[i] > tick))) {
    let lo = 0, hi = lane.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lane.ends[mid] <= tick) lo = mid + 1;
      else hi = mid;
    }
    i = lane.cursor = lo;
  }
  lane.tick = tick;
  const seg = lane.segs[i];
  return seg && seg.start <= tick ? seg : null;
}


/** Effective lane boundaries, including rounded values on stepped curves. */
function automationBoundaries(lanes) {
  const cuts = new Set();
  for (const lane of lanes) {
    const local = new Set();
    let covered = -Infinity, previous = null;
    for (const seg of lane.segs) {
      const start = Math.max(seg.start, covered), end = seg.end;
      covered = Math.max(covered, end);
      if (end <= start) continue;
      let flat = true;
      for (let i = 3; i < seg.pts.length; i += 2) if (seg.pts[i] !== seg.pts[1]) { flat = false; break; }
      const value = flat ? fromNorm(lane.def, seg.pts[1]) : null;
      // A join between equal constant values needs no DSP boundary. Keep
      // lane-local cuts so this cannot erase another lane's real change.
      if (flat && previous?.end === start && previous.value === value) local.delete(start);
      else local.add(start);
      local.add(end);
      const cut = (t) => { if (t > start && t < end) local.add(t); };
      if (!flat) {
        for (let i = 0; i < seg.pts.length; i += 2) cut(seg.pts[i]);
        audioStepCuts(lane.def, seg, start, end, cut);
      }
      previous = flat ? { end, value } : null;
    }
    for (const t of local) cuts.add(t);
  }
  return Float64Array.from([...cuts].sort((a, b) => a - b));
}
