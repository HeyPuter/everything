/**
 * Proxy encoding: converts a video into a small proxy with Mediabunny
 * (WebCodecs). Runs in the proxy worker (workers/proxy-worker.js), or on the
 * main thread where workers are unavailable.
 *
 * The picture is scaled so its short side is the plan's shortSide, rotation
 * from the file's metadata is applied to the frames, key frames come every
 * plan.keyFrameInterval seconds, and timestamps are kept as they are (no
 * shift to zero, no frame rate change), so a proxy frame at time t is the
 * original's frame at t. Sound is copied when the container allows it, else
 * re-encoded, because the preview plays a clip's sound from the same file.
 *
 * Mediabunny is passed in (mb) so tests can stand in fakes.
 */

/** Codecs to try, fastest to decode first, with their container. */
export const PROXY_CODECS = [
  { codec: 'avc', ext: 'mp4' },
  { codec: 'vp9', ext: 'webm' },
  { codec: 'vp8', ext: 'webm' },
  { codec: 'av1', ext: 'webm' },
];

export class ProxyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
  }
}

/** Output size for a display size: short side scaled to short (never enlarged), even numbers. */
export function proxySize(width, height, short) {
  const s = Math.min(width, height);
  if (!s || s <= short) return { width: Math.round(width / 2) * 2 || 2, height: Math.round(height / 2) * 2 || 2, scaled: false };
  const k = short / s;
  return { width: Math.max(2, Math.round((width * k) / 2) * 2), height: Math.max(2, Math.round((height * k) / 2) * 2), scaled: true };
}

/** First codec this browser can encode at the size: { codec, ext } or null. */
export async function pickCodec(mb, { width, height, bitrate }) {
  const found = await mb.getFirstEncodableVideoCodec(PROXY_CODECS.map((c) => c.codec), { width, height, bitrate });
  return PROXY_CODECS.find((c) => c.codec === found) || null;
}

/**
 * Encode a proxy of blob.
 *   plan       from model/proxy.js proxyPlan()
 *   open       async (ext) => WritableStream for the file (OPFS) or null to
 *              get a Blob back; called once the codec (and so the container) is known
 *   onProgress (0..1)
 *   signal     AbortSignal; aborting cancels the conversion
 * Resolves { ext, codec, width, height, blob? } (blob when open gave no stream).
 */
export async function generateProxy({ blob, plan, open, onProgress, signal, mb }) {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new ProxyError('This file has no picture.', 'no-video');
    if (!(await track.canDecode())) throw new ProxyError('This browser cannot decode this video.', 'decode');
    const [dw, dh] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
    const size = proxySize(dw, dh, plan.shortSide);
    const choice = await pickCodec(mb, { width: size.width, height: size.height, bitrate: plan.bitrate });
    if (!choice) throw new ProxyError('This browser cannot encode video.', 'encode');
    const writable = (await open?.(choice.ext)) || null;
    const target = writable ? new mb.StreamTarget(writable, { chunked: true }) : new mb.BufferTarget();
    const format = choice.ext === 'mp4' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat();
    const output = new mb.Output({ format, target });
    const audioTrack = plan.hasAudio ? await input.getPrimaryAudioTrack() : null;
    const conversion = await mb.Conversion.init({
      input,
      output,
      // Keep timestamps: without a trim start the conversion would shift the first frame to zero.
      trim: { start: 0 },
      video: {
        // Only the short side is given; the other follows the display aspect ratio.
        ...(size.scaled ? (dw >= dh ? { height: size.height } : { width: size.width }) : {}),
        codec: choice.codec,
        bitrate: plan.bitrate,
        keyFrameInterval: plan.keyFrameInterval,
        forceTranscode: true,
        // Bake rotation into the frames so the proxy shows upright everywhere.
        allowTransformationMetadata: false,
      },
      audio: audioTrack ? {} : { discard: true },
    });
    if (!conversion.isValid) throw new ProxyError('This video cannot be converted here.', 'invalid');
    // The preview plays a clip's sound from the same file, so a proxy without its sound is no use.
    if (audioTrack && !conversion.utilizedTracks.some((t) => t.type === 'audio')) {
      throw new ProxyError('The sound of this video cannot be kept in a proxy here.', 'audio');
    }
    const abort = () => conversion.cancel().catch(() => {});
    if (signal?.aborted) await abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (onProgress) conversion.onProgress = (p) => onProgress(Math.max(0, Math.min(1, p)));
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (signal?.aborted) throw new ProxyError('Canceled', 'canceled');
    const out = { ext: choice.ext, codec: choice.codec, width: size.width, height: size.height };
    if (!writable) out.blob = new Blob([target.buffer], { type: choice.ext === 'mp4' ? 'video/mp4' : 'video/webm' });
    return out;
  } finally {
    input.dispose?.();
  }
}

/**
 * Duration of a finished proxy, to check it against the original's. A
 * proxy whose length differs by more than tolerance seconds is rejected.
 */
export async function checkProxy(mb, blob, plan, tolerance) {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    if (plan.duration > 0 && Math.abs(duration - plan.duration) > tolerance) {
      throw new ProxyError(`The proxy is ${duration.toFixed(2)} s long but the video is ${plan.duration.toFixed(2)} s.`, 'duration');
    }
    return duration;
  } finally {
    input.dispose?.();
  }
}
