// WebM (Matroska subset) muxer for encoded VP8/VP9 frames, plus a WebCodecs-based video writer
// with a MediaRecorder fallback.

/** EBML variable-length size. */
export function ebmlSize(n: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    // all-ones values are reserved ("unknown size"), so the max is 2^(7*len) - 2
    if (n < Math.pow(2, 7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error('EBML size too large');
}

function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(out);
}

function uintBytes(v: number): Uint8Array {
  if (v === 0) return new Uint8Array([0]);
  const out: number[] = [];
  while (v > 0) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(out);
}

type Payload = Uint8Array | Uint8Array[];

function flat(p: Payload): Uint8Array[] {
  return Array.isArray(p) ? p : [p];
}

function size(parts: Uint8Array[]) {
  return parts.reduce((n, p) => n + p.length, 0);
}

export function element(id: number, payload: Payload): Uint8Array[] {
  const parts = flat(payload);
  return [idBytes(id), ebmlSize(size(parts)), ...parts];
}
const uintEl = (id: number, v: number) => element(id, uintBytes(v));
const strEl = (id: number, s: string) => element(id, new TextEncoder().encode(s));
function floatEl(id: number, v: number) {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  return element(id, new Uint8Array(b.buffer));
}

export interface EncodedFrame {
  data: Uint8Array;
  /** presentation time in milliseconds */
  time: number;
  key: boolean;
}

/** Build a complete WebM file from encoded frames. */
export function muxWebM(frames: EncodedFrame[], opts: { width: number; height: number; codec: 'V_VP8' | 'V_VP9'; duration: number }): Uint8Array[] {
  const header = element(0x1a45dfa3, [...uintEl(0x4286, 1), ...uintEl(0x42f7, 1), ...uintEl(0x42f2, 4), ...uintEl(0x42f3, 8), ...strEl(0x4282, 'webm'), ...uintEl(0x4287, 2), ...uintEl(0x4285, 2)]);
  const info = element(0x1549a966, [...uintEl(0x2ad7b1, 1000000), ...strEl(0x4d80, 'puter-3d'), ...strEl(0x5741, 'puter-3d'), ...floatEl(0x4489, opts.duration)]);
  const video = element(0xe0, [...uintEl(0xb0, opts.width), ...uintEl(0xba, opts.height)]);
  const track = element(0xae, [...uintEl(0xd7, 1), ...uintEl(0x73c5, 1), ...uintEl(0x9c, 0), ...strEl(0x86, opts.codec), ...uintEl(0x83, 1), ...video]);
  const tracks = element(0x1654ae6b, track);
  const clusters: Uint8Array[] = [];
  let cluster: Uint8Array[] = [];
  let clusterTime = 0;
  const flush = () => {
    if (!cluster.length) return;
    clusters.push(...element(0x1f43b675, [...uintEl(0xe7, clusterTime), ...cluster]));
    cluster = [];
  };
  for (const f of frames) {
    const t = Math.round(f.time);
    if (!cluster.length || f.key || t - clusterTime > 30000) {
      flush();
      clusterTime = t;
    }
    const rel = t - clusterTime;
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    head[1] = (rel >> 8) & 0xff;
    head[2] = rel & 0xff;
    head[3] = f.key ? 0x80 : 0;
    cluster.push(...element(0xa3, [head, f.data]));
  }
  flush();
  const segment = element(0x18538067, [...info, ...tracks, ...clusters]);
  return [...header, ...segment];
}

/** Writes frames (canvases) into a WebM video. */
export interface VideoWriter {
  addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, index: number): Promise<void>;
  finish(): Promise<Blob>;
}

/** Video bitrate (bits/s) for a frame size, rate and quality percentage (90 ≈ visually lossless-ish). */
export function videoBitrate(w: number, h: number, fps: number, quality = 90): number {
  const k = Math.pow(2, (Math.min(100, Math.max(0, quality)) - 90) / 15);
  return Math.min(80e6, Math.max(2.5e5, w * h * fps * 0.12 * k));
}

export async function createVideoWriter(width: number, height: number, fps: number, quality = 90): Promise<VideoWriter> {
  const w = Math.max(2, width & ~1),
    h = Math.max(2, height & ~1);
  const VE = (globalThis as unknown as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  if (VE) {
    const bitrate = videoBitrate(w, h, fps, quality);
    for (const [codec, id] of [
      ['vp09.00.10.08', 'V_VP9'],
      ['vp8', 'V_VP8'],
    ] as const) {
      const config: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps };
      try {
        const sup = await VE.isConfigSupported(config);
        if (!sup.supported) continue;
      } catch {
        continue;
      }
      return webCodecsWriter(VE, config, id, w, h, fps);
    }
  }
  return mediaRecorderWriter(w, h, fps, videoBitrate(w, h, fps, quality));
}

function webCodecsWriter(VE: typeof VideoEncoder, config: VideoEncoderConfig, codec: 'V_VP8' | 'V_VP9', w: number, h: number, fps: number): VideoWriter {
  const frames: EncodedFrame[] = [];
  let error: unknown = null;
  const enc = new VE({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, time: chunk.timestamp / 1000, key: chunk.type === 'key' });
    },
    error: (e) => (error = e),
  });
  enc.configure(config);
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const sctx = scratch.getContext('2d')!;
  let count = 0;
  return {
    async addFrame(canvas, index) {
      if (error) throw error;
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(canvas as CanvasImageSource, 0, 0);
      const frame = new VideoFrame(scratch, { timestamp: Math.round((index * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: count % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      count++;
      // keep the encoder queue bounded
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
    },
    async finish() {
      await enc.flush();
      enc.close();
      if (error) throw error;
      frames.sort((a, b) => a.time - b.time);
      const parts = muxWebM(frames, { width: w, height: h, codec, duration: (count * 1000) / fps });
      return new Blob(parts as BlobPart[], { type: 'video/webm' });
    },
  };
}

/** Fallback: re-time stored frames through a canvas stream at the target frame rate. */
function mediaRecorderWriter(w: number, h: number, fps: number, bitrate: number): VideoWriter {
  const stored: ImageBitmap[] = [];
  return {
    async addFrame(canvas) {
      stored.push(await createImageBitmap(canvas as ImageBitmapSource));
    },
    async finish() {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      const stream = c.captureStream(0);
      const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<void>((r) => (rec.onstop = () => r()));
      rec.start();
      for (const bmp of stored) {
        ctx.drawImage(bmp, 0, 0);
        track.requestFrame?.();
        await new Promise((r) => setTimeout(r, 1000 / fps));
        bmp.close();
      }
      rec.stop();
      await done;
      return new Blob(chunks, { type: 'video/webm' });
    },
  };
}
