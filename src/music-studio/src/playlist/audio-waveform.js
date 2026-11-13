// Cache section starting positions for automated audio. Pixel queries
// integrate only the sections they overlap, without replaying earlier history.
import { compileAutomation, tempoMap } from '../engine/compile.js';
import { AUDIO_TUNE, AUDIO_REVERSE, audioPlaybackRate, audioStepCuts, integrateAudioRate } from '../engine/audio-rate.js';
import { automationValue } from '../automation/evaluate.js';
import { fromNorm } from '../lib/params.js';

// Keep only the displayed snapshot: undo history must not retain a full
// set of integrated waveform paths for every intermediate edit.
let currentProject = null;
let currentMotion = null;
function motionFor(project) {
  if (project === currentProject) return currentMotion;
  const targets = new Set();
  for (const [id, a] of Object.entries(project.automation)) {
    if (a.target?.kind === 'channel' && ['pitch', 'tune', 'reverse'].includes(a.target.param)) targets.add(id);
  }
  const lanes = new Map();
  if (targets.size) {
    const channels = new Map(project.channels.map((ch, i) => [ch.id, i]));
    const clips = project.clips.filter((c) => c.kind === 'auto' && targets.has(c.ref));
    for (const lane of compileAutomation({ ...project, clips }, (id) => channels.get(id) ?? -1)) {
      const t = lane.target;
      if (!(t.kind === 'strip' && t.field === 'pitch') && !(t.kind === 'param' && (t.index === AUDIO_TUNE || t.index === AUDIO_REVERSE))) continue;
      const id = project.channels[t.slot].id;
      if (!lanes.has(id)) lanes.set(id, []);
      lanes.get(id).push(lane);
    }
  }
  currentProject = project;
  return (currentMotion = { lanes, paths: new WeakMap() });
}

/** Null keeps the inexpensive static waveform path. Otherwise query source ranges in seconds. */
export function audioWaveform(project, clip, channel, sample) {
  const cached = motionFor(project);
  const motion = cached.lanes.get(clip.ref);
  if (!motion?.length) return null;
  let samples = cached.paths.get(clip);
  if (!samples) cached.paths.set(clip, (samples = new WeakMap()));
  if (!samples.has(sample)) samples.set(sample, sourcePath(project, clip, channel, sample, motion));
  return samples.get(sample);
}

function sourcePath(project, clip, channel, sample, lanes) {
  const tempo = tempoMap(project);
  const start = clip.start - clip.offset + (clip.audioOffset ?? clip.offset);
  const end = clip.start + clip.len;
  if (!lanes.some((lane) => lane.segs.some((seg) => seg.end > start && seg.start < end))) return null;
  const cuts = new Set([start, end]);
  const cut = (t) => { if (t > start && t < end) cuts.add(t); };
  for (const lane of lanes) for (const seg of lane.segs) {
    if (seg.end <= start || seg.start >= end) continue;
    cut(seg.start); cut(seg.end);
    for (let j = 0; j < seg.pts.length; j += 2) cut(seg.pts[j]);
    audioStepCuts(lane.def, seg, Math.max(start, seg.start), Math.min(end, seg.end), cut);
  }
  for (const t of tempo.T) cut(t);
  const ticks = [...cuts].sort((a, b) => a - b);
  const cursors = lanes.map((lane) => ({ lane, next: 0 }));
  const activeAt = (tick) => {
    const active = [];
    for (const cursor of cursors) {
      const { lane } = cursor;
      while (cursor.next < lane.segs.length && lane.segs[cursor.next].end <= tick) cursor.next++;
      const seg = lane.segs[cursor.next];
      if (seg && seg.start <= tick) active.push({ lane, seg });
    }
    return active;
  };
  const valuesAt = (active, tick) => {
    const values = {};
    for (const { lane, seg } of active) {
      const field = lane.target.kind === 'strip' ? 'pitch' : lane.target.index === AUDIO_REVERSE ? 'reverse' : 'tune';
      values[field] = fromNorm(lane.def, automationValue(seg.pts, tick, seg.cs));
    }
    return values;
  };
  const initial = valuesAt(activeAt(start), start);
  const reverse = (initial.reverse ?? channel.params.reverse ?? 0) >= 0.5;
  const offset = tempo.duration(clip.start - clip.offset, start);
  let position = reverse ? Math.max(0, sample.duration - 1 / sample.rate) - offset : offset;
  const sections = [];
  for (let i = 1; i < ticks.length && position >= 0 && position < sample.duration; i++) {
    const a = ticks[i - 1], b = ticks[i], active = activeAt((a + b) / 2);
    const values = valuesAt(active, (a + b) / 2);
    const sign = (values.reverse ?? channel.params.reverse ?? 0) >= 0.5 ? -1 : 1;
    const rate = (v) => audioPlaybackRate(v.tune ?? channel.params.tune ?? 0, v.pitch ?? channel.pitch ?? 0, project.masterPitch || 0);
    const seconds = tempo.seconds(a), origin = position;
    // Tune and reverse are stepped; cuts above isolate each rounded value.
    const varying = active.some(({ lane, seg }) => lane.target.kind === 'strip' && automationValue(seg.pts, (2 * a + b) / 3, seg.cs) !== automationValue(seg.pts, (a + 2 * b) / 3, seg.cs));
    const fixedRate = rate(values);
    const at = varying
      ? (tick) => origin + sign * integrateAudioRate((time) => rate(valuesAt(active, tempo.ticks(time))), seconds, tempo.seconds(tick))
      : (tick) => origin + sign * fixedRate * tempo.duration(a, tick);
    position = at(b);
    sections.push({ start: a, end: b, at });
  }
  return (from, to) => {
    let lo = 0, hi = sections.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sections[mid].end <= from) lo = mid + 1;
      else hi = mid;
    }
    let min = Infinity, max = -Infinity;
    for (let i = lo; i < sections.length && sections[i].start < to; i++) {
      const section = sections[i];
      const a = section.at(Math.max(from, section.start)), b = section.at(Math.min(to, section.end));
      if (a < 0 || a >= sample.duration) break;
      min = Math.min(min, Math.max(0, Math.min(a, b)));
      max = Math.max(max, Math.min(sample.duration, Math.max(a, b)));
    }
    return max > min ? [min, max] : null;
  };
}
