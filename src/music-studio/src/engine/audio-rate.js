// Configured audio-clip playback speed, shared by source-position seeking
// and waveform drawing. Tuning is in semitones; strip/master pitch in cents.
// The combined range matches AudioPlayer::render in wasm/engine/src/sampler.rs.
import { INSTRUMENTS } from '../instruments/catalog.js';
import { toNorm, fromNorm } from '../lib/params.js';
import { curveShape, automationValue } from '../automation/evaluate.js';

export const AUDIO_TUNE = INSTRUMENTS.audio.params.findIndex((p) => p.id === 'tune');
export const AUDIO_REVERSE = INSTRUMENTS.audio.params.findIndex((p) => p.id === 'reverse');

export function audioPlaybackRate(tune = 0, pitch = 0, master = 0) {
  const semitones = tune + (pitch + master) / 100;
  return 2 ** (Math.max(-96, Math.min(96, semitones)) / 12);
}

/** Boundaries where a stepped automation parameter changes its rounded value. */
export function audioStepCuts(def, seg, start, end, cut) {
  if (!def.step) return;
  const pts = seg.pts;
  for (let j = 0; j + 3 < pts.length; j += 2) {
    const a = pts[j], b = pts[j + 2], v0 = pts[j + 1], v1 = pts[j + 3];
    if (b <= start || a >= end || b <= a || v0 === v1) continue;
    for (let n = Math.floor(def.min / def.step); n < Math.ceil(def.max / def.step); n++) {
      const value = toNorm(def, (n + 0.5) * def.step);
      const fraction = (value - v0) / (v1 - v0);
      if (!(fraction > 0 && fraction < 1)) continue;
      let u = fraction;
      const curve = seg.cs?.[j / 2] || 0;
      if (curve) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2;
          if (curveShape(mid, curve) < fraction) lo = mid;
          else hi = mid;
        }
        u = (lo + hi) / 2;
      }
      const tick = a + (b - a) * u;
      if (tick > start && tick < end) cut(tick);
    }
  }
}

/** Integrate a playback rate over seconds, without stepping through audio frames. */
export function integrateAudioRate(rateAt, start, end) {
  const gauss = (a, b) => {
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    const delta = half / Math.sqrt(3);
    return half * (rateAt(mid - delta) + rateAt(mid + delta));
  };
  const refine = (a, b, whole, tolerance, depth) => {
    const mid = (a + b) / 2;
    const left = gauss(a, mid), right = gauss(mid, b);
    if (!depth || Math.abs(left + right - whole) <= tolerance) return left + right;
    return refine(a, mid, left, tolerance / 2, depth - 1) + refine(mid, b, right, tolerance / 2, depth - 1);
  };
  return refine(start, end, gauss(start, end), 1e-7, 16);
}

/** Source position after following a clip's pitch/direction history from its anchor. */
export function audioSourceAt({ start, offset, lanes: allLanes = [], tempo, playbackRate, sampleInfo }, tick) {
  const backwards = tick < start;
  const lo = Math.min(start, tick), hi = Math.max(start, tick);
  const lanes = allLanes.filter((l) => l.segs.some((s) => s.start < hi && s.end > lo));
  const baseRate = playbackRate();
  if (!lanes.length) return offset + tempo.duration(start, tick) * baseRate;
  let active = [];
  const valuesAt = (at) => {
    const values = {};
    for (const { lane, seg } of active) {
      const field = lane.target.kind === 'strip' ? 'pitch' : lane.target.index === AUDIO_REVERSE ? 'reverse' : 'tune';
      values[field] = fromNorm(lane.def, automationValue(seg.pts, at, seg.cs));
    }
    return values;
  };
  const rateAt = (seconds) => playbackRate(valuesAt(tempo.ticks(seconds)));
  const changesDirection = lanes.some((l) => l.target.kind === 'param' && l.target.index === AUDIO_REVERSE) && typeof sampleInfo === 'function';
  const sample = changesDirection ? sampleInfo() : null;
  if (changesDirection && !sample) return null;
  let position = 0;
  if (sample) {
    for (const lane of lanes) {
      const seg = lane.segs.find((s) => s.start <= start && start < s.end);
      if (seg) active.push({ lane, seg });
    }
    const reverse = (valuesAt(start).reverse ?? Number(sample.reverse)) >= 0.5;
    position = reverse ? sample.last - offset : offset;
    if (!backwards && (position < 0 || position >= sample.duration)) return null;
  }
  const cuts = new Set([start, tick]);
  const cut = (t) => { if (t > lo && t < hi) cuts.add(t); };
  for (const lane of lanes) for (const seg of lane.segs) {
    cut(seg.start); cut(seg.end);
    for (let j = 0; j < seg.pts.length; j += 2) cut(seg.pts[j]);
    audioStepCuts(lane.def, seg, Math.max(lo, seg.start), Math.min(hi, seg.end), cut);
  }
  for (const t of tempo.T) cut(t);
  const ticks = [...cuts].sort((a, b) => a - b);
  const times = ticks.map((t) => tempo.seconds(t));
  const cursors = lanes.map((lane) => ({ lane, next: 0 }));
  const history = backwards && sample ? [] : null;
  let distance = offset;
  for (let j = 1; j < times.length; j++) {
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
      const delta = reverse ? -travel : travel;
      if (backwards) history.push(delta);
      else {
        position += delta;
        // An exhausted voice cannot restart after a later direction change.
        if (position < 0 || position >= sample.duration) return null;
      }
    } else distance += backwards ? -travel : travel;
  }
  if (history) {
    let inside = position >= 0 && position < sample.duration;
    for (let j = history.length - 1; j >= 0; j--) {
      position -= history[j];
      const valid = position >= 0 && position < sample.duration;
      if (inside && !valid) return null;
      inside ||= valid;
    }
    if (position < 0 || position >= sample.duration) return null;
  }
  return sample ? { position } : distance;
}
