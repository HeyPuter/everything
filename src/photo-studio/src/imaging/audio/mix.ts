// Offline audio mixing: sums the clips of a mix plan (model/audio-timeline)
// into planar float channels, sample accurately. Times are rounded to whole
// samples at the output rate; sources are read at their own rate (linearly
// interpolated when it differs). Fades are linear ramps of the gain, the
// same shape the live playback schedules with Web Audio.
import { envelopeAt, type PlanItem } from '../../model/audio-timeline';

/** Decoded audio: planar channels at a sample rate. */
export type Pcm = { sampleRate: number; channels: Float32Array[] };

/** Mix `items` over timeline seconds [from, to) into `channels` channels at
 * `sampleRate`. `pcmOf` returns the decoded source of an item (an item whose
 * source is missing is silent). */
export function mixPlan(items: PlanItem[], pcmOf: (item: PlanItem) => Pcm | undefined, from: number, to: number, sampleRate: number, channels = 2): Float32Array[] {
  const total = Math.max(0, Math.round((to - from) * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(total));
  for (const item of items) {
    const pcm = pcmOf(item);
    if (!pcm?.channels.length) continue;
    mixItem(out, item, pcm, from, sampleRate);
  }
  return out;
}

function mixItem(out: Float32Array[], item: PlanItem, pcm: Pcm, from: number, sampleRate: number) {
  const total = out[0]?.length ?? 0;
  const at = Math.round((item.at - from) * sampleRate);
  const n = Math.round(item.length * sampleRate);
  const fi = Math.round(item.fadeIn * sampleRate),
    fo = Math.round(item.fadeOut * sampleRate);
  const first = Math.max(0, -at),
    last = Math.min(n, total - at);
  if (last <= first) return;
  const same = pcm.sampleRate === sampleRate;
  const srcLength = pcm.channels[0].length;
  const ratio = pcm.sampleRate / sampleRate;
  const src0 = same ? Math.round(item.offset * sampleRate) : item.offset * pcm.sampleRate;
  for (let c = 0; c < out.length; c++) {
    // Mono sources feed every channel; others map channel by channel.
    const src = pcm.channels[c % pcm.channels.length];
    const dst = out[c];
    for (let i = first; i < last; i++) {
      let g = item.gain;
      if (fi > 0 && i < fi) g *= i / fi;
      if (fo > 0 && i > n - fo) g *= (n - i) / fo;
      if (g === 0) continue;
      let v: number;
      if (same) {
        const j = src0 + i;
        if (j >= srcLength) break;
        v = j >= 0 ? src[j] : 0;
      } else {
        const p = src0 + i * ratio;
        const j = Math.floor(p);
        if (j >= srcLength) break;
        const a = j >= 0 ? src[j] : 0,
          b = j + 1 < srcLength ? src[j + 1] : 0;
        v = a + (b - a) * (p - j);
      }
      dst[at + i] += v * g;
    }
  }
}

/** Gain of an item at timeline second `t` (for previews and tests). */
export const itemGainAt = (item: PlanItem, t: number) => envelopeAt(item, t - item.at);

/** Largest absolute sample (for level checks). */
export function peakLevel(channels: Float32Array[]) {
  let m = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  return m;
}
