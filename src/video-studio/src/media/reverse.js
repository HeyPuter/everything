/**
 * Reverse a video file (picture and sound) with WebCodecs.
 *
 * Reversal needs the frames in reverse presentation order, but a decoder only
 * yields them forward. The robust way -- and the only one that does not stall on
 * real footage -- is to decode the whole clip once, hold the decoded frames, and
 * feed them back to the encoder last-first. That is a single sequential decode
 * pass (no seeking, no B-frame reorder games) over the source, so it behaves the
 * same on a one-keyframe, B-frame-heavy clip as on any other.
 *
 * The earlier design sought each frame group by timestamp range
 * (`sink.samples(start, end)`). mediabunny refuses to upper-bound that range for
 * B-frame streams (see its own comment in media-sink.js), so every range seek
 * decoded from the keyframe all the way to the end of the file and, on a single
 * long GOP, hung the decoder. Decoding once up front sidesteps all of that.
 *
 * Memory is bounded by a guard: a clip is reversed in one pass only when its
 * decoded footprint fits; beyond that we ask for a shorter segment rather than
 * risk an out-of-memory tab crash.
 */
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink, EncodedPacketSink, Output, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, VideoSampleSource, AudioSampleSource, VideoSample, AudioSample, QUALITY_HIGH,
  canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

const EPS = 1e-6;
/** A decode pass that does not advance for this long is a stall, not a slow clip. */
const DECODE_TIMEOUT = 120_000;
/**
 * Rates encoders actually accept, tried after the file's own rate. 32 kHz is
 * common in generated footage and is refused by AAC, which is how a short clip
 * can fail on its sound before its picture is even touched.
 */
const AUDIO_RATES = [48000, 44100];
/** Decoded footprint we are willing to hold for a one-pass reversal. */
const MAX_DECODE_BYTES = 15 * 1024 * 1024 * 1024;

const stallMessage = 'Decoding stalled. Cancel and try a shorter clip.';

/**
 * Never hang on a capability probe: if the browser does not answer in time, take
 * the fallback. A wrong guess fails with an error the user can read; a hang
 * leaves them staring at the dialog.
 */
async function probeOr(fn, fallback, ms = 8000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(fn()).catch(() => fallback),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Give a step a deadline so a stall becomes a readable error. */
async function withDeadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Group packet timestamps into [start, end) spans that begin at key packets. */
export function keySpans(packets, duration) {
  const spans = [];
  let cur = null;
  for (const p of packets) {
    if (p.key || !cur) {
      if (cur) cur.end = p.timestamp;
      cur = { start: p.timestamp, end: duration, frames: [] };
      spans.push(cur);
    }
    cur.frames.push(p.timestamp);
  }
  return spans;
}

/** Split a span's frame times into slices of at most n frames, last slice first. */
export function reverseSlices(frames, n = 24) {
  const sorted = [...frames].sort((a, b) => a - b);
  const out = [];
  for (let i = sorted.length; i > 0; i -= n) out.push(sorted.slice(Math.max(0, i - n), i));
  return out;
}

/**
 * Merge keyframe spans into runs that can each be decoded in one pass while
 * holding at most `limit` frames. Kept for callers/tests that reason about GOP
 * structure; the one-pass reverser no longer depends on it.
 */
export function decodeRuns(spans, limit = 24) {
  const runs = [];
  let cur = null;
  for (const span of spans) {
    if (span.frames.length > limit) {
      if (cur) { runs.push(cur); cur = null; }
      runs.push({ start: span.start, end: span.end, frames: [...span.frames] });
      continue;
    }
    if (cur && cur.frames.length + span.frames.length <= limit) {
      cur.frames.push(...span.frames);
      cur.end = span.end;
      continue;
    }
    if (cur) runs.push(cur);
    cur = { start: span.start, end: span.end, frames: [...span.frames] };
  }
  if (cur) runs.push(cur);
  return runs;
}

/** How many decoded frames may be held at once: a memory budget, not a count. */
export function sliceBudget(width, height) {
  return Math.max(12, Math.min(240, Math.floor((180 * 1024 * 1024) / Math.max(1, width * height * 3))));
}

/**
 * Audio settings to offer an encoder, most faithful first: the file's own rate
 * with its own channel count, then the same channels at a rate encoders accept,
 * then fewer channels. Resampling is near-lossless, so a rate change is offered
 * before a channel change; the first setting the environment accepts wins.
 */
export function audioCandidates(sampleRate, numberOfChannels) {
  const rates = [...new Set([sampleRate, ...AUDIO_RATES].filter((r) => Number.isFinite(r) && r > 0))];
  const counts = [...new Set([numberOfChannels, 2, 1].filter((c) => Number.isFinite(c) && c > 0))];
  const out = [];
  for (const channels of counts) {
    for (const rate of rates) out.push({ sampleRate: rate, numberOfChannels: channels });
  }
  return out;
}

/** Track length, metadata-only. skipLiveWait: a "live" file would never end. */
function trackDuration(video, input) {
  return video.computeDuration({ skipLiveWait: true }).catch(
    () => input.computeDuration(undefined, { skipLiveWait: true }),
  );
}

/**
 * Ask the environment which audio settings it will encode, using this track's
 * real rate and channel count. The encoder is configured from the samples it is
 * handed, so a rate that is merely common -- 32 kHz -- has to be caught here
 * and replaced, or the whole reversal fails on its soundtrack.
 */
async function planAudio(audio, codec) {
  if (!audio) return null;
  if (!(await probeOr(() => audio.canDecode(), false))) return null;
  const [sampleRate, numberOfChannels] = await Promise.all([
    probeOr(() => audio.getSampleRate(), 0, 2000),
    probeOr(() => audio.getNumberOfChannels(), 0, 2000),
  ]);
  for (const candidate of audioCandidates(sampleRate, numberOfChannels)) {
    if (await probeOr(() => canEncodeAudio(codec, candidate), false)) return candidate;
  }
  return null;
}

/**
 * Build the audio source, pinning it to the planned rate and channel count.
 * Pinning matters even when nothing needs converting: a decoder is free to emit
 * a rate that differs from the file's metadata, and that rate is what the
 * encoder would otherwise be configured with.
 */
function makeAudioSource(codec, plan) {
  return new AudioSampleSource({
    codec,
    bitrate: QUALITY_HIGH,
    transform: { sampleRate: plan.sampleRate, numberOfChannels: plan.numberOfChannels },
  });
}

/** Metadata-only look at a file: its length, its size, and where keyframes are. */
async function readMap(blob, signal) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('This file has no video to reverse.');
    const duration = await trackDuration(video, input);
    const [width, height] = await Promise.all([
      probeOr(() => video.getDisplayWidth(), 1920, 2000),
      probeOr(() => video.getDisplayHeight(), 1080, 2000),
    ]);
    const packets = [];
    for await (const p of new EncodedPacketSink(video).packets(undefined, undefined, { metadataOnly: true, skipLiveWait: true })) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      packets.push({ timestamp: p.timestamp, key: p.type === 'key' });
    }
    packets.sort((a, b) => a.timestamp - b.timestamp);
    return { packets, duration, width, height };
  } finally {
    input.dispose();
  }
}

/**
 * Decode every frame of a video track once, in presentation order.
 *
 * Uses the software decoder by default. Some GPU H.264 decoders hang -- rather
 * than error -- on single-GOP, B-frame-heavy streams (the exact shape of the
 * footage that triggered this feature's original stall). The software path is
 * reliable across browsers and, on a 5-second clip, costs only a second or two.
 * If even the software decoder stalls we abort with a readable error instead of
 * hanging forever. As a last resort we retry on the GPU decoder.
 *
 * @returns {Promise<import('mediabunny').VideoSample[]>}
 */
async function decodeAllFrames(video, { check, onProgress, est }) {
  const decodeOnce = async (decoderOptions, label) => {
    const sink = new VideoSampleSink(video, decoderOptions);
    const frames = [];
    let lastProgress = Date.now();
    let decoded = 0;
    for await (const sample of sink.samples(undefined, undefined, { skipLiveWait: true })) {
      check();
      if (Date.now() - lastProgress > DECODE_TIMEOUT) {
        for (const f of frames) f.close();
        const err = new Error(stallMessage);
        err.stalled = true;
        throw err;
      }
      lastProgress = Date.now();
      frames.push(sample);
      decoded++;
      onProgress?.(0.05 + 0.45 * (decoded / est), 'reading');
    }
    return frames;
  };
  try {
    onProgress?.(0.05, 'software');
    return await decodeOnce({ hardwareAcceleration: 'prefer-software' }, 'software');
  } catch (e) {
    if (e?.stalled) {
      onProgress?.(0.05, 'reading');
      return await decodeOnce(undefined, 'hardware');
    }
    throw e;
  }
}

/** Reverse a source by decoding it once and feeding the frames back last-first. */
async function reverseSource(blob, name, { onProgress, signal, totalFrames = 0 } = {}) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const check = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error('This file has no video to reverse.');
    const duration = await trackDuration(video, input);
    if (!(duration > 0)) throw new Error("Couldn't read the length of this video.");
    // A codec this browser cannot decode would leave the decoder waiting for
    // frames that never come, so say so before starting instead.
    const decodable = await probeOr(() => video.canDecode(), true, 5000);
    if (!decodable) throw new Error("This browser can't decode this video's codec, so it can't be reversed.");
    const [width, height] = await Promise.all([
      probeOr(() => video.getDisplayWidth(), 1920, 2000),
      probeOr(() => video.getDisplayHeight(), 1080, 2000),
    ]);
    const useMp4 = await probeOr(() => canEncodeVideo('avc', { width, height }), true);
    const aCodec = useMp4 ? 'aac' : 'opus';
    const output = new Output({
      format: useMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const vSource = new VideoSampleSource({ codec: useMp4 ? 'avc' : 'vp9', bitrate: QUALITY_HIGH });
    output.addVideoTrack(vSource, { rotation: await probeOr(() => video.getRotation?.(), 0, 2000) });
    let aSource = null;
    const aPlan = await planAudio(audio, aCodec);
    if (aPlan) {
      aSource = makeAudioSource(aCodec, aPlan);
      output.addAudioTrack(aSource);
    }
    await withDeadline(output.start(), 30_000, 'The encoder would not start.');

    // One sequential decode pass over the whole clip. Some GPU H.264 decoders
    // hang (not merely slow) on single-GOP, B-frame-heavy streams; if a hardware
    // attempt stalls we fall back to the software decoder, which handles them.
    onProgress?.(0.05, 'reading');
    const frames = await decodeAllFrames(video, { check, onProgress, est: totalFrames || 1 });

    // Feed backwards: the last decoded frame becomes the first output frame.
    // Output timestamp = duration - t - d, so output timestamps come out ascending.
    onProgress?.(0.5, 'video');
    const total = frames.length || 1;
    for (let i = frames.length - 1; i >= 0; i--) {
      check();
      const sm = frames[i];
      const d = sm.duration || 1 / 30;
      const out = new VideoSample(sm.toVideoFrame(), {
        timestamp: Math.max(0, duration - sm.timestamp - d),
        duration: d,
      });
      await vSource.add(out);
      out.close();
      sm.close();
      onProgress?.(0.5 + 0.4 * (total - i) / total, 'video');
    }
    vSource.close();

    if (aSource) {
      onProgress?.(0.9, 'audio');
      const aSink = new AudioSampleSink(audio);
      const chans = [];
      let rate = 48000;
      let length = 0;
      for await (const sample of aSink.samples(undefined, undefined, { skipLiveWait: true })) {
        check();
        rate = sample.sampleRate;
        const n = sample.numberOfFrames;
        for (let c = 0; c < sample.numberOfChannels; c++) {
          const plane = new Float32Array(n);
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          (chans[c] ||= []).push(plane);
        }
        length += n;
        sample.close();
      }
      const nCh = chans.length;
      const joined = chans.map((parts) => {
        const all = new Float32Array(length);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        // reverse() works in place, so this both reverses and keeps one copy.
        return all.reverse();
      });
      // The per-decode planes are dead weight once joined; drop them before the
      // copy above is walked, or a long clip holds its soundtrack twice.
      chans.length = 0;
      const block = 8192;
      for (let off = 0; off < length && nCh > 0; off += block) {
        check();
        const n = Math.min(block, length - off);
        const data = new Float32Array(n * nCh);
        for (let c = 0; c < nCh; c++) data.set(joined[c].subarray(off, off + n), c * n);
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: nCh, sampleRate: rate, timestamp: off / rate });
        await aSource.add(sample);
        sample.close();
      }
      aSource.close();
    }
    onProgress?.(0.97, 'finishing');
    await output.finalize();
    onProgress?.(1, 'done');
    const base = name.replace(/\.[^.]+$/, '');
    return new File(
      [output.target.buffer],
      `${base} (reversed).${useMp4 ? 'mp4' : 'webm'}`,
      { type: useMp4 ? 'video/mp4' : 'video/webm' },
    );
  } finally {
    input.dispose();
  }
}

/**
 * Returns a File with the reversed media. onProgress(0..1, stage); signal aborts.
 * Stages: 'duration', 'reading', 'video', 'audio', 'finishing', 'done'.
 */
export async function reverseFile(blob, name, { onProgress, signal } = {}) {
  onProgress?.(0, 'duration');
  const map = await readMap(blob, signal);
  // One-pass reversal holds every decoded frame at once. Refuse clips whose
  // footprint would blow the tab's memory instead of crashing it.
  const estFrameBytes = Math.ceil(map.width * map.height * 1.5);
  const estTotal = map.packets.length * estFrameBytes;
  if (estTotal > MAX_DECODE_BYTES) {
    throw new Error('This clip is too long to reverse in one pass; split it into shorter segments first.');
  }
  return reverseSource(blob, name, { onProgress, signal, totalFrames: map.packets.length });
}
