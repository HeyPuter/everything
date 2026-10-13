// Sound for Render Video (loaded on first use): the timeline's clips mixed
// offline at 48 kHz stereo (gains, fades, mute and solo applied, sample
// accurate), encoded to Opus with WebCodecs for the WebM writer, written as
// a WAV file, or played into a recording stream for the real-time fallback.
import type { Editor } from '../../editor';
import type { PhotoDocument } from '../../model/document';
import { audioPlan } from '../../model/audio-timeline';
import { mixPlan } from '../../imaging/audio/mix';
import { encodeWav } from '../../imaging/codecs/wav';
import { opusPreSkip, type WebmAudio, type WebmFrame } from '../../imaging/codecs/webm';
import { loadAll, mixRate } from './audio-media';

export const outputRate = mixRate;
const channels = 2;

/** True when the document's timeline has clips that sound. */
export const hasSound = (doc: PhotoDocument) => audioPlan(doc).length > 0;

/** Mix timeline seconds [from, from + seconds) of `doc`. */
export async function mixDocument(e: Editor, doc: PhotoDocument, from: number, seconds: number): Promise<Float32Array[]> {
  const plan = audioPlan(doc);
  e.message('Mixing audio…');
  const pcm = await loadAll(e.session, plan.map((p) => p.source));
  return mixPlan(plan, (p) => pcm.get(p.source.asset), from, from + seconds, outputRate, channels);
}

export function wavBlob(mix: Float32Array[]) {
  return new Blob([encodeWav(mix, outputRate)], { type: 'audio/wav' });
}

const config: AudioEncoderConfig = { codec: 'opus', sampleRate: outputRate, numberOfChannels: channels, bitrate: 160_000 };
export async function canEncodeOpus() {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    return !!(await AudioEncoder.isConfigSupported(config)).supported;
  } catch {
    return false;
  }
}

/** Encode a mix to Opus packets for the WebM writer. */
export async function encodeOpus(e: Editor, mix: Float32Array[]): Promise<WebmAudio> {
  const frames: WebmFrame[] = [];
  let head: Uint8Array | undefined;
  let failure: unknown;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, timestampMs: chunk.timestamp / 1000, key: true });
      const d = meta?.decoderConfig?.description;
      if (d && !head) head = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d as ArrayBuffer).slice();
    },
    error: (err) => (failure = err),
  });
  encoder.configure(config);
  const n = mix[0].length;
  const block = outputRate;
  for (let i = 0; i < n && !failure; i += block) {
    if (i % (block * 10) === 0) e.message(`Encoding audio: ${Math.round((i / n) * 100)}%…`);
    const len = Math.min(block, n - i);
    const data = new Float32Array(len * channels);
    for (let c = 0; c < channels; c++) data.set(mix[c].subarray(i, i + len), c * len);
    const chunk = new AudioData({ format: 'f32-planar', sampleRate: outputRate, numberOfFrames: len, numberOfChannels: channels, timestamp: Math.round((i / outputRate) * 1e6), data });
    encoder.encode(chunk);
    chunk.close();
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  frames.sort((a, b) => a.timestampMs - b.timestampMs);
  // The encoder's identification header gives the decoder delay (Opus
  // encoders look 312 samples ahead at 48 kHz when it is not reported).
  const preSkip = head ? opusPreSkip(head) : 312;
  return { codec: 'A_OPUS', sampleRate: outputRate, channels, frames, preSkip, ...(head && opusPreSkip(head) ? { codecPrivate: head } : {}) };
}

/** Sound for the real-time recording fallback: the mix plays into the
 * recorded stream only while a frame is shown, so it stays in step with
 * frames that take longer than real time to render. */
export class RecorderSound {
  private ctx = new AudioContext({ sampleRate: outputRate });
  private dest = this.ctx.createMediaStreamDestination();
  private src = this.ctx.createBufferSource();
  readonly track: MediaStreamTrack;
  constructor(mix: Float32Array[]) {
    const buffer = this.ctx.createBuffer(channels, Math.max(1, mix[0].length), outputRate);
    mix.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    this.src.buffer = buffer;
    this.src.connect(this.dest);
    this.track = this.dest.stream.getAudioTracks()[0];
  }
  async start() {
    await this.ctx.suspend();
    this.src.start(0);
  }
  /** Let `seconds` of sound through. */
  async play(seconds: number) {
    await this.ctx.resume();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await this.ctx.suspend();
  }
  close() {
    this.track.stop();
    void this.ctx.close();
  }
}
