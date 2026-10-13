// Offline audio mixing: sums the clips of a mix plan (model/audio-timeline)
// into planar float channels, sample accurately. Times are rounded to whole
// samples at the output rate; sources are read at their own rate (linearly
// interpolated when it differs). Fades are linear ramps of the gain, the
// same shape the live playback schedules with Web Audio. Surround sources
// are folded down to stereo (`downmixGains`), as playback does too.
import { envelopeAt, type PlanItem } from '../../model/audio-timeline';

/** Decoded audio: planar channels at a sample rate. */
export type Pcm = { sampleRate: number; channels: Float32Array[] };

const h = Math.SQRT1_2; // -3 dB
/** Gain from each of `inputs` source channels into each of `outputs`
 * channels ([output][input]). Mono feeds every channel; stereo and other
 * sources at most as wide as the output map channel by channel. Wider
 * sources folded to stereo use the ITU-R BS.775 coefficients in the usual
 * channel orders: quad (L R SL SR), 5.0 (L R C SL SR), 5.1 (L R C LFE SL SR)
 * and 7.1 (L R C LFE and two surround pairs): center and surrounds at -3 dB,
 * the LFE dropped. Other layouts keep the first two channels as left and
 * right and feed every further channel to both sides at -3 dB. */
export function downmixGains(inputs: number, outputs: number): number[][] {
  const rows = Array.from({ length: outputs }, () => new Array<number>(inputs).fill(0));
  if (outputs !== 2 || inputs <= 2) {
    for (let c = 0; c < outputs; c++) rows[c][c % inputs] = 1;
    return rows;
  }
  const [l, r] = rows;
  const layouts: Record<number, [number[], number[]]> = {
    4: [[1, 0, h, 0], [0, 1, 0, h]],
    5: [[1, 0, h, h, 0], [0, 1, h, 0, h]],
    6: [[1, 0, h, 0, h, 0], [0, 1, h, 0, 0, h]],
    8: [[1, 0, h, 0, h, 0, h, 0], [0, 1, h, 0, 0, h, 0, h]],
  };
  const known = layouts[inputs];
  if (known) return known.map((row) => [...row]);
  l[0] = r[1] = 1;
  for (let k = 2; k < inputs; k++) l[k] = r[k] = h;
  return rows;
}

/** A source folded to `outputs` channels (unchanged when it is no wider). */
export function downmix(pcm: Pcm, outputs = 2): Pcm {
  const n = pcm.channels.length;
  if (n <= outputs) return pcm;
  const gains = downmixGains(n, outputs);
  const length = pcm.channels[0]?.length ?? 0;
  const channels = gains.map((row) => {
    const out = new Float32Array(length);
    row.forEach((g, k) => {
      if (!g) return;
      const src = pcm.channels[k];
      for (let i = 0; i < length; i++) out[i] += g * src[i];
    });
    return out;
  });
  return { sampleRate: pcm.sampleRate, channels };
}

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
  const gains = downmixGains(pcm.channels.length, out.length);
  for (let c = 0; c < out.length; c++)
    for (let k = 0; k < pcm.channels.length; k++)
      if (gains[c][k]) mixChannel(out[c], pcm.channels[k], item.gain * gains[c][k]);
  function mixChannel(dst: Float32Array, src: Float32Array, gain: number) {
    for (let i = first; i < last; i++) {
      let g = gain;
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
