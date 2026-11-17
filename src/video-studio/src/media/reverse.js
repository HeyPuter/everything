/**
 * Reverse a video file (picture and sound) with WebCodecs. Frames are
 * decoded one keyframe group at a time from the end of the file and
 * re-encoded in reverse order; long groups are processed in slices so memory
 * stays bounded (at most SLICE decoded frames are held at once).
 */
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink, EncodedPacketSink, Output, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, VideoSampleSource, AudioSampleSource, VideoSample, AudioSample, QUALITY_HIGH,
  canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

const SLICE = 24;

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
export function reverseSlices(frames, n = SLICE) {
  const sorted = [...frames].sort((a, b) => a - b);
  const out = [];
  for (let i = sorted.length; i > 0; i -= n) out.push(sorted.slice(Math.max(0, i - n), i));
  return out;
}

/**
 * Returns a File with the reversed media. onProgress(0..1); signal aborts.
 */
export async function reverseFile(blob, name, { onProgress, signal } = {}) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const check = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  // What a cancel or a failure has to let go of: the output's encoders, and decoded frames held for a slice.
  let output = null;
  let finished = false;
  const open = new Set();
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error('This file has no video to reverse.');
    const duration = await input.computeDuration();
    const useMp4 = await canEncodeVideo('avc');
    const vCodec = useMp4 ? 'avc' : 'vp9';
    const aCodec = useMp4 ? 'aac' : 'opus';
    output = new Output({ format: useMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target: new BufferTarget() });
    const vSource = new VideoSampleSource({ codec: vCodec, bitrate: QUALITY_HIGH });
    output.addVideoTrack(vSource, { rotation: await video.getRotation?.().catch(() => 0) });
    let aSource = null;
    const audioOk = audio && (await audio.canDecode().catch(() => false)) && (await canEncodeAudio(aCodec).catch(() => false));
    if (audioOk) {
      aSource = new AudioSampleSource({ codec: aCodec, bitrate: QUALITY_HIGH });
      output.addAudioTrack(aSource);
    }
    await output.start();

    // Packet metadata gives keyframe positions without decoding anything.
    const packetSink = new EncodedPacketSink(video);
    const packets = [];
    for await (const p of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
      packets.push({ timestamp: p.timestamp, key: p.type === 'key' });
      if (packets.length % 500 === 0) check();
    }
    packets.sort((a, b) => a.timestamp - b.timestamp);
    const spans = keySpans(packets, duration);
    const totalFrames = packets.length || 1;
    const sink = new VideoSampleSink(video);
    let done = 0;
    for (let s = spans.length - 1; s >= 0; s--) {
      const span = spans[s];
      for (const slice of reverseSlices(span.frames)) {
        check();
        const lo = slice[0];
        const hi = slice[slice.length - 1];
        const held = [];
        // Decoding starts at the span's keyframe; only this slice's frames are kept.
        for await (const sample of sink.samples(span.start, span.end)) {
          if (sample.timestamp >= lo - 1e-6 && sample.timestamp <= hi + 1e-6) {
            held.push(sample);
            open.add(sample);
          } else sample.close();
          if (sample.timestamp > hi + 1e-6) break;
        }
        for (let i = held.length - 1; i >= 0; i--) {
          const sm = held[i];
          const d = sm.duration || 1 / 30;
          const out = new VideoSample(sm.toVideoFrame(), { timestamp: Math.max(0, duration - sm.timestamp - d), duration: d });
          try {
            await vSource.add(out);
          } finally {
            out.close();
          }
          sm.close();
          open.delete(sm);
          done++;
        }
        onProgress?.(Math.min(0.95, (done / totalFrames) * (audioOk ? 0.85 : 0.95)));
      }
    }
    vSource.close();

    if (audioOk) {
      const aSink = new AudioSampleSink(audio);
      const chans = [];
      let rate = 48000;
      let length = 0;
      for await (const sample of aSink.samples()) {
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
        return all.reverse();
      });
      const block = 8192;
      for (let off = 0; off < length; off += block) {
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
    await output.finalize();
    finished = true;
    onProgress?.(1);
    const base = name.replace(/\.[^.]+$/, '');
    const type = useMp4 ? 'video/mp4' : 'video/webm';
    return new File([output.target.buffer], `${base} (reversed).${useMp4 ? 'mp4' : 'webm'}`, { type });
  } finally {
    for (const sample of open) sample.close();
    // Cancelled or failed part way: the encoders are closed now, not whenever they are collected.
    if (output && !finished) await Promise.resolve().then(() => output.cancel()).catch(() => {});
    input.dispose();
  }
}
