/**
 * Offline audio mixdown: decodes every audible clip with Mediabunny,
 * resamples it for clip speed and the output rate, applies gain ramps (fades,
 * volume keyframes) and sums everything with a soft limiter. Used by the
 * exporter and by anything else that needs the project's sound as samples.
 *
 * Work happens in ~1 s chunks (mixChunks) so long projects never need one
 * giant buffer; renderAudio collects the chunks when a full buffer is wanted.
 */
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from 'mediabunny';
import { US } from '../lib/time.js';
import { projectDuration } from '../model/timeline.js';
import { loadDsp, mixRamp, resample, softClip, PeakLimiter } from '../media/dsp.js';
import { audibleClips, gainAt } from './scene.js';
import { ClipChain } from '../media/audio-fx.js';
import { WsolaStretcher, readLinear } from '../media/stretch.js';
import { chainSettings, needsStretch } from '../model/audio.js';
import { hasCurve, sourceMapper, maxSpeed } from '../model/speed-curve.js';

/** Gain ramp granularity in output samples (about 5 ms at 48 kHz). */
export const GAIN_BLOCK = 256;

/** Output samples over which a speed curve's read position is taken as linear. */
const CURVE_BLOCK = 32;

/**
 * Read count samples from src (len valid samples, src[0] at absolute source
 * sample winStart) where output index first + j reads absolute position
 * posAt(first + j): exact at block edges, linear within (speed curves).
 */
export function readCurve(src, len, winStart, posAt, first, count, out = new Float32Array(count)) {
  let a = posAt(first) - winStart;
  for (let j = 0; j < count; j += CURVE_BLOCK) {
    const n = Math.min(CURVE_BLOCK, count - j);
    const b = posAt(first + j + n) - winStart;
    readLinear(src, len, a, (b - a) / n, n, out.subarray(j, j + n));
    a = b;
  }
  return out;
}

const abortError = () => new DOMException('Export canceled', 'AbortError');

/**
 * Default source opener: one Mediabunny Input per asset. Each clip reads its
 * own stream from it, so two clips of one file decode independently.
 * Returns null when the file has no decodable audio.
 */
export function mediabunnyOpener(library) {
  return async (asset) => {
    const blob = await library.mediaBlob(asset);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) {
        input.dispose();
        return null;
      }
      return {
        sampleRate: track.sampleRate,
        async *read(startSec) {
          const sink = new AudioBufferSink(track);
          for await (const { buffer, timestamp } of sink.buffers(Math.max(0, startSec))) {
            const channels = [];
            for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
            yield { timestamp, sampleRate: buffer.sampleRate, channels };
          }
        },
        close: () => input.dispose(),
      };
    } catch (err) {
      input.dispose();
      throw err;
    }
  };
}

/**
 * A growable per-channel window of decoded source samples for one clip.
 * start is the source sample index of window[0].
 */
class SourceWindow {
  constructor() {
    this.channels = [];
    this.start = 0;
    this.length = 0;
    this.rate = 0;
    this.started = false;
  }

  get end() {
    return this.start + this.length;
  }

  _ensure(nch, cap) {
    if (this.channels.length && this.channels[0].length >= cap && this.channels.length >= nch) return;
    const size = Math.max(cap, (this.channels[0]?.length || 0) * 2, 4096);
    const next = [];
    for (let c = 0; c < Math.max(nch, this.channels.length); c++) {
      const a = new Float32Array(size);
      if (this.channels[c]) a.set(this.channels[c].subarray(0, this.length));
      next.push(a);
    }
    this.channels = next;
  }

  /** Place a decoded buffer at its timestamp (gaps become silence, overlaps overwrite). */
  put(chunk) {
    if (!this.started) {
      this.rate = chunk.sampleRate;
      this.start = Math.round(chunk.timestamp * this.rate);
      this.started = true;
    }
    const at = Math.round(chunk.timestamp * this.rate) - this.start;
    const n = chunk.channels[0]?.length || 0;
    if (at + n <= 0) return;
    const skip = Math.max(0, -at);
    const dst = Math.max(0, at);
    this._ensure(chunk.channels.length, dst + n - skip);
    if (dst > this.length) for (const ch of this.channels) ch.fill(0, this.length, dst);
    for (let c = 0; c < this.channels.length; c++) {
      const src = chunk.channels[Math.min(c, chunk.channels.length - 1)];
      this.channels[c].set(src.subarray(skip), dst);
    }
    this.length = Math.max(this.length, dst + n - skip);
  }

  /** Forget samples before source index keep (amortized compaction). */
  dropBefore(keep) {
    const k = Math.floor(keep) - this.start;
    if (k <= 0 || k < this.length / 2) return;
    const cut = Math.min(k, this.length);
    for (const ch of this.channels) ch.copyWithin(0, cut, this.length);
    this.start += cut;
    this.length -= cut;
  }
}

/**
 * Mix one clip into out (planar, frames samples starting at timeline time t0
 * in microseconds). win holds the clip's decoded source; the caller makes
 * sure it covers the needed range. Pure apart from mutating out.
 */
export function mixClipInto(out, t0, sampleRate, clip, win) {
  const frames = out[0].length;
  const end = clip.start + clip.duration;
  const usPerSample = US / sampleRate;
  const i0 = Math.max(0, Math.ceil((clip.start - t0) / usPerSample - 1e-9));
  const i1 = Math.min(frames, Math.ceil((end - t0) / usPerSample - 1e-9));
  if (i1 <= i0 || !win.started || !win.length) return;
  const curved = hasCurve(clip);
  const speed = clip.speed || 1;
  const step = (speed * win.rate) / sampleRate;
  // Source sample position (absolute) of output index i.
  const map = curved ? sourceMapper(clip) : null;
  const posAt = curved
    ? (i) => ((clip.in + map(t0 + i * usPerSample - clip.start)) / US) * win.rate
    : (i) => ((clip.in + (t0 + i * usPerSample - clip.start) * speed) / US) * win.rate;
  // Output samples whose source lies before the decoded window stay silent.
  let first = i0;
  const p0 = posAt(i0);
  if (p0 < win.start) {
    if (!curved) first = Math.min(i1, i0 + Math.ceil((win.start - p0) / step));
    else {
      // The read position only moves forward: binary search the first sample inside.
      let lo = i0;
      let hi = i1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (posAt(mid) < win.start) lo = mid + 1;
        else hi = mid;
      }
      first = lo;
    }
  }
  if (first >= i1) return;
  const count = i1 - first;
  const rel = Math.max(0, posAt(first) - win.start);
  const nOut = out.length;
  const nSrc = win.channels.length;
  const view = (c) => win.channels[c].subarray(0, win.length);
  // A speed curve reads at a varying rate; constant speed resamples in one go.
  const read = curved ? (c) => readCurve(view(c), win.length, win.start, posAt, first, count) : (c) => resample(view(c), rel, step, count);
  // Resampled source per output channel (mono sources feed both sides; stereo to mono averages).
  const sources = [];
  if (nOut === 1 && nSrc >= 2) {
    const a = read(0);
    const b = read(1);
    for (let i = 0; i < count; i++) a[i] = (a[i] + b[i]) * 0.5;
    sources.push(a);
  } else {
    let cache = null;
    for (let c = 0; c < nOut; c++) {
      const sc = Math.min(c, nSrc - 1);
      if (cache && cache.sc === sc) sources.push(cache.data);
      else {
        cache = { sc, data: read(sc) };
        sources.push(cache.data);
      }
    }
  }
  mixGainRamps(out, t0, usPerSample, clip, sources, first, i1);
}

/**
 * Add sources (per output channel, sources[c][0] is output index first) to
 * out[first..i1) with the clip's gain (volume, keyframes, fades) ramped per
 * block; runs of equal gain collapse into one call.
 */
function mixGainRamps(out, t0, usPerSample, clip, sources, first, i1) {
  const nOut = out.length;
  const tAt = (i) => t0 + i * usPerSample;
  let b = first;
  while (b < i1) {
    let e = Math.min(i1, b + GAIN_BLOCK);
    const g0 = gainAt(clip, tAt(b));
    let g1 = gainAt(clip, tAt(e - 1));
    if (g0 === g1) {
      while (e < i1) {
        const ne = Math.min(i1, e + GAIN_BLOCK);
        if (gainAt(clip, tAt(ne - 1)) !== g0) break;
        e = ne;
      }
      g1 = g0;
    }
    if (g0 !== 0 || g1 !== 0) {
      for (let c = 0; c < nOut; c++) mixRamp(out[c].subarray(b, e), sources[c].subarray(b - first, e - first), g0, g1);
    }
    b = e;
  }
}

/** Whether a clip goes through ClipStream (effects, or a speed change that keeps pitch). */
export function clipNeedsProcessing(clip) {
  return Boolean(chainSettings(clip)) || needsStretch(clip);
}

/**
 * Sequential processed sound of one clip at the output rate: source read
 * through the time-stretcher (pitch kept) or the resampler (pitch follows
 * speed), then the clip's effect chain (media/audio-fx.js, the same code
 * the preview worklet runs). Output index g is global: time origin + g
 * samples. The chain's latency is compensated by running it ahead.
 */
export class ClipStream {
  constructor(clip, sampleRate, origin) {
    this.clip = clip;
    this.sr = sampleRate;
    this.origin = origin;
    const s = chainSettings(clip);
    this.chain = s ? new ClipChain(s, sampleRate) : null;
    this.latency = this.chain?.latency || 0;
    this.stretch = needsStretch(clip) ? new WsolaStretcher(sampleRate) : null;
    this.map = sourceMapper(clip);
    this.curved = hasCurve(clip);
    this.rawEnd = null;
    this.buf = [new Float32Array(8192), new Float32Array(8192)];
    this.bufStart = 0;
    this.bufLen = 0;
  }

  /** Absolute source sample position (at the window's rate) for output index g. */
  posAt(g, win) {
    const c = this.clip;
    if (this.curved) return ((c.in + this.map(this.origin + (g * US) / this.sr - c.start)) / US) * win.rate;
    return ((c.in + (this.origin + (g * US) / this.sr - c.start) * (c.speed || 1)) / US) * win.rate;
  }

  /** Output samples past the requested range the source window must already hold. */
  get lookAhead() {
    return this.latency + (this.stretch ? this.stretch.lookAhead : 4);
  }

  _raw(g, n, win) {
    const nch = Math.min(2, win.channels.length);
    const view = (ch) => win.channels[Math.min(ch, nch - 1)];
    const read = (ch, pos, step, count, out) => readLinear(view(ch), win.length, pos - win.start, step, count, out);
    if (this.stretch) return this.stretch.generate(g, n, (x) => this.posAt(x, win), win.rate / this.sr, read, nch);
    if (this.curved) {
      // Pitch follows the curve: read at the varying rate.
      const pos = (x) => this.posAt(x, win);
      const L = readCurve(view(0), win.length, win.start, pos, g, n);
      return [L, nch > 1 ? readCurve(view(1), win.length, win.start, pos, g, n) : L.slice()];
    }
    const step = ((this.clip.speed || 1) * win.rate) / this.sr;
    const p = this.posAt(g, win);
    const L = read(0, p, step, n);
    return [L, nch > 1 ? read(1, p, step, n) : L.slice()];
  }

  _append(l, r, from) {
    // from: global index of l[0]; keep only indices >= bufStart.
    const skip = Math.max(0, this.bufStart - from);
    const m = l.length - skip;
    if (m <= 0) return;
    const at = from + skip - this.bufStart;
    if (at + m > this.buf[0].length) {
      let size = this.buf[0].length;
      while (size < at + m) size *= 2;
      this.buf = this.buf.map((b) => {
        const nb = new Float32Array(size);
        nb.set(b.subarray(0, this.bufLen));
        return nb;
      });
    }
    this.buf[0].set(l.subarray(skip), at);
    this.buf[1].set(r.subarray(skip), at);
    this.bufLen = at + m;
  }

  /** Processed stereo for global output indices [g, g + n). Calls must be sequential. */
  take(g, n, win) {
    if (this.rawEnd === null || g < this.bufStart || g > this.bufStart + this.bufLen) {
      this.rawEnd = g;
      this.bufStart = g;
      this.bufLen = 0;
      this.chain?.reset();
    }
    const want = g + n + this.latency;
    while (this.rawEnd < want) {
      const m = Math.min(4096, want - this.rawEnd);
      const [l, r] = this._raw(this.rawEnd, m, win);
      this.chain?.process(l, r, m);
      this._append(l, r, this.rawEnd - this.latency);
      this.rawEnd += m;
    }
    const off = g - this.bufStart;
    const L = this.buf[0].slice(off, off + n);
    const R = this.buf[1].slice(off, off + n);
    // Drop what was handed out.
    const used = off + n;
    for (const b of this.buf) b.copyWithin(0, used, this.bufLen);
    this.bufLen -= used;
    this.bufStart = g + n;
    return [L, R];
  }

  /** Earliest source sample (absolute) the stream may still read. */
  keepFrom(win) {
    if (this.rawEnd === null) return -Infinity;
    const back = this.stretch ? this.stretch.lookBehind * (win.rate / this.sr) : 0;
    return this.posAt(this.rawEnd, win) - back - 0.1 * win.rate * Math.max(1, maxSpeed(this.clip));
  }
}

/** Mix a clip through its ClipStream into out (as mixClipInto, for processed clips). */
function mixStreamInto(out, t0, gBase, sampleRate, clip, win, stream) {
  const frames = out[0].length;
  const usPerSample = US / sampleRate;
  const end = clip.start + clip.duration;
  const i0 = Math.max(0, Math.ceil((clip.start - t0) / usPerSample - 1e-9));
  const i1 = Math.min(frames, Math.ceil((end - t0) / usPerSample - 1e-9));
  if (i1 <= i0 || !win.started) return;
  const [L, R] = stream.take(gBase + i0, i1 - i0, win);
  let sources;
  if (out.length === 1) {
    for (let i = 0; i < L.length; i++) L[i] = (L[i] + R[i]) * 0.5;
    sources = [L];
  } else sources = out.map((_, c) => (c === 0 ? L : R));
  mixGainRamps(out, t0, usPerSample, clip, sources, i0, i1);
}

/**
 * Async generator of mixed planar chunks:
 *   { time (us, chunk start), frames, sampleRate, channels: Float32Array[] }
 * Options: start/end (us), sampleRate, channels, chunkSeconds, signal,
 * onProgress({ done, total }) in output frames, openSource (asset => source)
 * to replace the Mediabunny decoder (tests), onSkip(clip, reason).
 */
export async function* mixChunks(project, library, { start = 0, end, sampleRate = 48000, channels = 2, chunkSeconds = 1, signal, onProgress, openSource, onSkip } = {}) {
  await loadDsp();
  const stop = end ?? projectDuration(project);
  const total = Math.max(0, Math.round(((stop - start) * sampleRate) / US));
  const chunk = Math.max(GAIN_BLOCK, Math.round(chunkSeconds * sampleRate));
  const open = openSource || mediabunnyOpener(library);
  const clips = audibleClips(project)
    .map(({ clip }) => clip)
    .filter((c) => c.start < stop && c.start + c.duration > start && project.assets[c.assetId])
    .sort((a, b) => a.start - b.start);
  const sources = new Map(); // assetId -> Promise<source | null>
  const active = new Map(); // clipId -> { clip, win, iter, done }
  let nextClip = 0;
  const sourceFor = (asset) => {
    let s = sources.get(asset.id);
    if (!s) {
      s = open(asset).catch((err) => {
        onSkip?.(null, err);
        return null;
      });
      sources.set(asset.id, s);
    }
    return s;
  };
  const closeState = async (st) => {
    try {
      await st.iter?.return?.();
    } catch {
      /* the decoder may already be closed */
    }
  };
  // The limiter looks a few ms ahead: each chunk goes out once the next one is mixed.
  const limiter = new PeakLimiter(sampleRate);
  let held = null;
  const release = (next) => {
    const c = held;
    limiter.process(c.channels, next?.channels || null);
    for (const ch of c.channels) softClip(ch);
    onProgress?.({ done: c.done, total });
    held = next;
    return c.mixed;
  };
  try {
    for (let done = 0; done < total; ) {
      if (signal?.aborted) throw abortError();
      const frames = Math.min(chunk, total - done);
      const t0 = start + (done * US) / sampleRate;
      const t1 = start + ((done + frames) * US) / sampleRate;
      // Activate clips that start before this chunk ends.
      while (nextClip < clips.length && clips[nextClip].start < t1) {
        const clip = clips[nextClip++];
        if (clip.start + clip.duration <= t0) continue;
        const src = await sourceFor(project.assets[clip.assetId]);
        if (!src) {
          onSkip?.(clip, new Error('No decodable audio'));
          continue;
        }
        const from = (clip.in + sourceMapper(clip)(Math.max(0, t0 - clip.start))) / US;
        active.set(clip.id, { clip, win: new SourceWindow(), iter: src.read(Math.max(0, from - 0.05)), done: false });
      }
      const out = [];
      for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
      for (const [id, st] of active) {
        const { clip, win } = st;
        if (clip.start + clip.duration <= t0) {
          await closeState(st);
          active.delete(id);
          continue;
        }
        st.map ||= sourceMapper(clip);
        const lastT = Math.min(t1, clip.start + clip.duration);
        // Effects and pitch-kept speed changes go through a stream that reads ahead.
        if (st.stream === undefined) st.stream = clipNeedsProcessing(clip) ? new ClipStream(clip, sampleRate, start) : null;
        const ahead = st.stream ? ((st.stream.lookAhead * Math.max(1, maxSpeed(clip))) / sampleRate) * US : 0;
        // Source seconds needed up to the end of this chunk, plus one sample for interpolation.
        const needSec = (clip.in + st.map(lastT - clip.start) + ahead) / US;
        while (!st.done && (!win.started || win.end <= needSec * win.rate + 2)) {
          if (signal?.aborted) throw abortError();
          const r = await st.iter.next();
          if (r.done) st.done = true;
          else win.put(r.value);
        }
        if (st.stream) mixStreamInto(out, t0, done, sampleRate, clip, win, st.stream);
        else mixClipInto(out, t0, sampleRate, clip, win);
        const firstSec = (clip.in + st.map(Math.max(0, t1 - clip.start))) / US;
        if (win.started) win.dropBefore(Math.min(firstSec * win.rate - 4, st.stream ? st.stream.keepFrom(win) : Infinity));
      }
      done += frames;
      const mixed = { time: t0, frames, sampleRate, channels: out };
      if (!held) held = { mixed, channels: out, done };
      else yield release({ mixed, channels: out, done });
    }
    if (held) yield release(null);
  } finally {
    for (const st of active.values()) await closeState(st);
    active.clear();
    for (const s of sources.values()) {
      const src = await s.catch(() => null);
      src?.close?.();
    }
  }
}

/**
 * Mix the project's sound into planar buffers.
 * Returns { sampleRate, channels: Float32Array[] }.
 */
export async function renderAudio(project, library, { start = 0, end, sampleRate = 48000, channels = 2, onProgress, signal, openSource } = {}) {
  const stop = end ?? projectDuration(project);
  const total = Math.max(0, Math.round(((stop - start) * sampleRate) / US));
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(total));
  let at = 0;
  for await (const chunk of mixChunks(project, library, { start, end: stop, sampleRate, channels, onProgress, signal, openSource })) {
    for (let c = 0; c < channels; c++) out[c].set(chunk.channels[c], at);
    at += chunk.frames;
  }
  return { sampleRate, channels: out };
}

/** 44-byte RIFF/WAVE header for 16-bit PCM. */
export function wavHeader(frames, channels, sampleRate) {
  const bytes = frames * channels * 2;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, bytes, true);
  return new Uint8Array(buf);
}

/** Interleave planar float channels into little-endian 16-bit PCM. */
export function pcm16(planar) {
  const nch = planar.length;
  const frames = planar[0]?.length || 0;
  const out = new Int16Array(frames * nch);
  for (let c = 0; c < nch; c++) {
    const src = planar[c];
    for (let i = 0, j = c; i < frames; i++, j += nch) {
      const s = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
      out[j] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
  }
  // WAV is little-endian; so is every platform browsers run on, but be explicit if not.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    const v = new DataView(out.buffer);
    for (let i = 0; i < out.length; i++) v.setInt16(i * 2, out[i], true);
  }
  return out;
}

/** Encode planar float audio as a 16-bit PCM WAV Blob. */
export function encodeWav(planar, sampleRate) {
  const frames = planar[0]?.length || 0;
  return new Blob([wavHeader(frames, planar.length, sampleRate), pcm16(planar)], { type: 'audio/wav' });
}
