// Track parameter changes from track headers, the Mixer and the keyboard all
// go through TrackControls so undo, automation and playback agree:
//  - stopped, no automation (or mode Off): changes the track's static value
//    (one undo step per knob gesture);
//  - stopped with automation in a reading mode: sets a keyframe at the playhead;
//  - playing in Write, Latch or Touch: records the moves into the automation
//    lane, heard live through graph overrides, committed as one undo step
//    when playback stops.

import { findTrack, updateTrack, setAutomation, writeEnvelopeRange, envelopeValue } from '../model/session-edits.js';

const RECORDING = new Set(['write', 'latch', 'touch']);

export class TrackControls {
  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    /** key `${trackId}:${param}` -> { trackId, param, segments: [{ t0, points }], value, lastT, done } */
    this.passes = new Map();
    /** Touch passes that ended before another touch of the same control in one playback. */
    this.finished = [];
    doc.overrides = {};
  }

  get playing() {
    return this.app.engine.playing && this.app.active === this.doc;
  }

  /** The value a control shows for a track parameter at `frame`. */
  value(track, param, frame = this.app.active === this.doc ? this.app.playhead : this.doc.cursor) {
    const o = this.doc.overrides[track.id];
    if (o && o[param] !== undefined) return o[param];
    const lane = track.automation?.[param];
    if (track.mode !== 'off' && lane && lane.length) return envelopeValue(lane, frame, track[param]);
    return track[param];
  }

  /** True when the parameter follows automation (controls show it as automated). */
  automated(track, param) {
    return track.mode !== 'off' && Boolean(track.automation?.[param]?.length);
  }

  /** phase: 'input' while dragging, 'change' when the gesture ends. */
  set(trackId, param, value, phase = 'change') {
    const doc = this.doc;
    const track = findTrack(doc.state, trackId);
    if (!track) return;
    if (this.playing && RECORDING.has(track.mode)) {
      this.#record(track, param, value, phase);
      return;
    }
    const lane = track.automation[param];
    if (track.mode !== 'off' && lane.length) {
      const t = Math.round(this.app.playhead);
      const near = Math.round(doc.sampleRate * 0.005);
      const points = [...lane.filter((p) => Math.abs(p.t - t) > near), { t, v: value }];
      doc.apply(param === 'pan' ? 'Pan Automation' : 'Volume Automation', setAutomation(doc.state, trackId, param, points), { coalesce: `auto:${trackId}:${param}` });
    } else {
      const label = param === 'pan' ? 'Track Pan' : 'Track Volume';
      doc.apply(label, updateTrack(doc.state, trackId, { [param]: value }), { coalesce: `${param}:${trackId}` });
    }
    if (phase === 'change') doc.endGesture();
  }

  /** Boolean track switches (mute, solo, arm, monitor) and other one-shot changes. */
  toggle(trackId, key, value) {
    const track = findTrack(this.doc.state, trackId);
    if (!track) return;
    const v = value ?? !track[key];
    const labels = { mute: 'Mute', solo: 'Solo', arm: 'Record Arm', monitor: 'Monitor Input', fxPower: 'Effects Power', invert: 'Invert Polarity' };
    let state = updateTrack(this.doc.state, trackId, { [key]: v });
    // Preferences > Multitrack: exclusive solo turns the other solos off.
    if (key === 'solo' && v && this.app.prefs.get('soloExclusive')) {
      for (const t of state.tracks) if (t.id !== trackId && t.solo) state = updateTrack(state, t.id, { solo: false });
    }
    this.doc.apply(`${labels[key] || 'Track'} ${v ? 'On' : 'Off'}`, state);
  }

  #record(track, param, value, phase) {
    const key = `${track.id}:${param}`;
    const t = Math.round(this.app.playhead);
    let pass = this.passes.get(key);
    if (!pass || pass.done) {
      if (pass) this.finished.push(pass);
      pass = { trackId: track.id, param, segments: [{ t0: t, points: [{ t, v: value }] }], value, lastT: t, done: false };
      this.passes.set(key, pass);
    } else {
      let seg = pass.segments[pass.segments.length - 1];
      if (t < pass.lastT) {
        // Loop playback wrapped: close this segment and start another.
        seg.points.push({ t: pass.lastT, v: pass.value });
        seg = { t0: t, points: [{ t, v: value }] };
        pass.segments.push(seg);
      } else {
        // Hold the previous value until now so the lane steps rather than ramps.
        if (t - pass.lastT > this.doc.sampleRate * 0.05) seg.points.push({ t: t - 1, v: pass.value });
        seg.points.push({ t, v: value });
      }
      pass.value = value;
      pass.lastT = t;
    }
    pass.seen = t;
    if (phase === 'change' && track.mode === 'touch') {
      pass.done = true;
      const o = { ...(this.doc.overrides[track.id] || {}) };
      delete o[param];
      this.doc.overrides[track.id] = o;
    } else {
      this.doc.overrides[track.id] = { ...(this.doc.overrides[track.id] || {}), [param]: value };
    }
    this.app.syncGraph();
    this.doc.emit('change', { kind: 'automation' });
  }

  /**
   * Follows the playhead during playback (`frame`). A loop jump closes the passes that hold a
   * value (Write, a latched control) at the loop end and continues them from the loop start, so
   * every pass played is written, also when nothing is touched after the jump.
   */
  follow(frame) {
    if (!this.passes.size) return;
    const loop = this.app.engine.range?.loop;
    const looping = loop && loop.end > loop.start;
    for (const pass of this.passes.values()) {
      if (pass.done) continue;
      const seen = pass.seen ?? pass.lastT;
      pass.seen = frame;
      if (frame >= seen) continue;
      // A jump from near the loop end to near its start is the loop wrapping (meters arrive a few
      // times a second); other jumps back are seeks, which continue from where they land.
      const near = this.doc.sampleRate * 0.5;
      const end = looping && loop.end - seen <= near ? Math.max(pass.lastT, loop.end - 1) : Math.max(pass.lastT, seen);
      const start = looping && frame >= loop.start && frame - loop.start <= near ? loop.start : frame;
      pass.segments[pass.segments.length - 1].points.push({ t: end, v: pass.value });
      pass.segments.push({ t0: start, points: [{ t: start, v: pass.value }] });
      pass.lastT = start;
    }
  }

  /** Starts Write passes for tracks in Write mode (called when playback starts). */
  begin() {
    if (!this.playing) return;
    for (const t of [...this.doc.state.tracks, this.doc.state.master]) {
      if (t.mode !== 'write') continue;
      for (const param of t.type === 'master' ? ['volume'] : ['volume', 'pan']) this.#record(t, param, this.value(t, param), 'input');
    }
  }

  /** Commits recorded automation as one undo step (called when playback stops). */
  commit(stopFrame) {
    if (!this.passes.size) return;
    let state = this.doc.state;
    // Earlier touches of a control first, so a later pass over the same time wins.
    for (const pass of [...this.finished, ...this.passes.values()]) {
      const track = findTrack(state, pass.trackId);
      if (!track) continue;
      let lane = track.automation[pass.param];
      const fallback = track[pass.param];
      pass.segments.forEach((seg, i) => {
        const last = i === pass.segments.length - 1;
        const end = last && !pass.done ? Math.max(pass.lastT, Math.round(stopFrame ?? pass.lastT)) : seg.points[seg.points.length - 1].t;
        const pts = seg.points.slice();
        if (last && !pass.done && end > pts[pts.length - 1].t) pts.push({ t: end, v: pass.value });
        // Outside the pass the lane keeps what it played (or the track's own value), rather than
        // ramping from the old points to the new ones.
        const before = seg.t0 > 0 ? [{ t: seg.t0 - 1, v: envelopeValue(lane, seg.t0 - 1, fallback) }] : [];
        const after = { t: end + 1, v: envelopeValue(lane, end + 1, fallback) };
        lane = writeEnvelopeRange(lane, seg.t0 - before.length, end + 1, [...before, ...pts, after]);
      });
      state = setAutomation(state, pass.trackId, pass.param, lane);
    }
    this.passes.clear();
    this.finished = [];
    this.doc.overrides = {};
    this.doc.apply('Write Automation', state);
    this.app.syncGraph();
  }
}
