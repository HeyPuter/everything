// Extending before an audio clip's original start needs an inverse source
// position calculation. Keep this lazy: ordinary trims do not compile lanes.
import { compileAutomation, tempoMap } from '../engine/compile.js';
import { AUDIO_TUNE, AUDIO_REVERSE, audioPlaybackRate, audioSourceAt } from '../engine/audio-rate.js';
import { automationValue } from '../automation/evaluate.js';
import { fromNorm } from '../lib/params.js';

export function audioEditContext(project, sampleInfo) {
  const tempo = tempoMap(project);
  const slots = new Map(project.channels.map((ch, i) => [ch.id, i]));
  const lanes = new Map();
  for (const lane of compileAutomation(project, (id) => slots.get(id) ?? -1)) {
    const t = lane.target;
    if (!((t.kind === 'param' && (t.index === AUDIO_TUNE || t.index === AUDIO_REVERSE)) || (t.kind === 'strip' && t.field === 'pitch'))) continue;
    if (!lanes.has(t.slot)) lanes.set(t.slot, []);
    lanes.get(t.slot).push(lane);
  }
  return (clip) => {
    const slot = slots.get(clip.ref), ch = project.channels[slot];
    const anchor = clip.start - clip.offset + (clip.audioOffset ?? clip.offset);
    if (!ch) return null;
    const motion = lanes.get(slot) || [];
    const data = sampleInfo?.(ch.sample) || project.samples[ch.sample];
    const rate = Number.isFinite(data?.rate) && data.rate > 0 ? data.rate : 48000;
    const duration = data?.channels?.[0]?.length !== undefined ? data.channels[0].length / rate : data?.duration;
    const sample = duration > 0 ? { duration, last: Math.max(0, duration - 1 / rate), reverse: ch.params.reverse >= 0.5 } : null;
    const context = {
      start: anchor, offset: tempo.duration(clip.start - clip.offset, anchor),
      tempo, lanes: motion,
      playbackRate: (v) => audioPlaybackRate(v?.tune ?? ch.params.tune ?? 0, v?.pitch ?? ch.pitch ?? 0, project.masterPitch || 0),
      sampleInfo: () => sample,
    };
    const relative = (tick) => {
      const source = audioSourceAt(context, tick);
      if (source === null) return null;
      if (typeof source === 'number') return Number.isFinite(source) && source >= -1e-10 ? Math.max(0, source) : null;
      let reverse = sample.reverse;
      const lane = motion.find((l) => l.target.kind === 'param' && l.target.index === AUDIO_REVERSE);
      const seg = lane?.segs.find((s) => s.start <= tick && tick < s.end);
      if (seg) reverse = fromNorm(lane.def, automationValue(seg.pts, tick, seg.cs)) >= 0.5;
      return Math.max(0, reverse ? sample.last - source.position : source.position);
    };
    return {
      anchor, at: relative, duration: duration || 0, initialOffset: context.offset,
      offset: (start, seconds) => Math.max(0, start - tempo.ticks(tempo.seconds(start) - seconds)),
    };
  };
}

export function audioExtension(project, sampleInfo) {
  const prepare = audioEditContext(project, sampleInfo);
  return (clip, requested) => {
    const source = prepare(clip);
    if (!source) return { start: clip.start, offset: clip.offset, audioOffset: clip.audioOffset ?? clip.offset };
    const { anchor, at: relative } = source;
    let start = requested;
    let offset = relative(start);
    if (offset === null) {
      // Find the earliest whole song tick that still has source audio. The
      // backward history evaluator stops at the first exhausted boundary.
      let lo = start, hi = Math.min(clip.start, anchor);
      for (let i = 0; i < 64 && hi - lo > 1; i++) {
        const mid = Math.floor(lo + (hi - lo) / 2);
        if (mid === lo || mid === hi) break;
        if (relative(mid) === null) lo = mid;
        else hi = mid;
      }
      start = Math.ceil(hi);
      offset = relative(start) ?? source.initialOffset;
    }
    // Rebase at the extended start. Future pitch edits must not depend on
    // a source anchor later than the visible clip.
    const ticks = source.offset(start, offset);
    return { start, offset: ticks, audioOffset: ticks };
  };
}

/** Freeze a cropped clip's current media position before relocating it. */
export function audioSnapshot(project, sampleInfo) {
  const prepare = audioEditContext(project, sampleInfo);
  return (clip, start = clip.start) => {
    const source = prepare(clip);
    if (!source) return null;
    const seconds = source.at(clip.start) ?? Math.max(source.duration, source.initialOffset) + 1;
    const offset = source.offset(start, seconds);
    return { seconds, offset, audioOffset: offset };
  };
}
