// The slide show as a video file or an animated GIF. Slides are drawn on a
// canvas with their transitions and timings, then encoded: with WebCodecs
// where the browser has it (faster than real time, muxed here into MP4 or
// WebM), else recorded in real time with MediaRecorder.

import { WebmMuxer } from "./webm-muxer.js";
import { Mp4Muxer } from "./mp4-muxer.js";
import { GifEncoder } from "./gif-encoder.js";
import { createCanvas, rasterize } from "./render.js";
import { drawTransition, showTimeline } from "./transition-frames.js";

export const VIDEO_RESOLUTIONS = [
  ["720", "HD (720p)", 720],
  ["1080", "Full HD (1080p)", 1080],
  ["2160", "Ultra HD (4K)", 2160],
];
const FPS = 30;
// A still slide is re-sent this often, so players can seek within it.
const HOLD_STEP_MS = 1000;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
export function videoSize(height, aspect) {
  return { width: even(height * aspect), height: even(height) };
}

function avcCodec(width, height) {
  const pixels = width * height;
  // Level 3.1, 4.0, 5.1 by frame size; High profile first, then Main and
  // Constrained Baseline for encoders without it.
  const level = pixels <= 921600 ? "1f" : pixels <= 2228224 ? "28" : "33";
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4240${level}`];
}
function vpCodecs(width, height) {
  const pixels = width * height;
  const level = pixels <= 921600 ? "31" : pixels <= 2228224 ? "41" : "51";
  return [`vp09.00.${level}.08`, "vp8"];
}
const bitrate = (width, height) =>
  Math.round(Math.min(40e6, Math.max(2e6, width * height * 4)));

async function supportedConfig(container, width, height) {
  if (typeof VideoEncoder === "undefined") return null;
  const codecs =
    container === "mp4" ? avcCodec(width, height) : vpCodecs(width, height);
  for (const codec of codecs) {
    const config = {
      codec,
      width,
      height,
      bitrate: bitrate(width, height),
      framerate: FPS,
      latencyMode: "quality",
      ...(container === "mp4" ? { avc: { format: "avc" } } : {}),
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch {}
  }
  return null;
}

const RECORDER_TYPES = {
  mp4: ["video/mp4;codecs=avc1", "video/mp4"],
  webm: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
};
function recorderType(container) {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    RECORDER_TYPES[container].find((t) => MediaRecorder.isTypeSupported(t)) ||
    null
  );
}

// Which formats this browser can write: { mp4, webm } each "fast" (WebCodecs),
// "realtime" (MediaRecorder) or null.
export async function videoSupport(width = 1280, height = 720) {
  const out = {};
  for (const container of ["mp4", "webm"])
    out[container] = (await supportedConfig(container, width, height))
      ? "fast"
      : recorderType(container)
        ? "realtime"
        : null;
  return out;
}

const abortError = () => new DOMException("Export cancelled.", "AbortError");
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

// Draws the frames of the show in order. `emit(canvas, timeMs, durationMs,
// key)` receives each; slides are drawn once and transitions frame by frame.
async function playShow({
  slides,
  width,
  height,
  options,
  fps,
  emit,
  signal,
  progress,
  holdStep = HOLD_STEP_MS,
}) {
  const timeline = showTimeline(
    slides.map((s) => s.transition),
    options,
  );
  const total = timeline.reduce((n, e) => n + e.transition + e.hold, 0);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let previous = null;
  for (const [i, slide] of slides.entries()) {
    if (signal?.aborted) throw abortError();
    const picture = await rasterize(slide.src, width, height);
    const entry = timeline[i];
    const step = 1000 / fps;
    let t = entry.start;
    if (previous && entry.transition > 0) {
      for (let f = 0; f * step < entry.transition; f++) {
        if (signal?.aborted) throw abortError();
        drawTransition(
          context,
          previous,
          picture,
          slide.transition,
          (f * step) / entry.transition,
        );
        await emit(canvas, t, step, f === 0);
        t += step;
        progress?.(t / total);
      }
      t = entry.start + entry.transition;
    }
    context.drawImage(picture, 0, 0, width, height);
    const end = entry.start + entry.transition + entry.hold;
    let first = true;
    while (t < end - 0.5) {
      const span = Math.min(holdStep, end - t);
      await emit(canvas, t, span, first);
      first = false;
      t += span;
      progress?.(t / total);
      if (signal?.aborted) throw abortError();
    }
    previous = picture;
  }
  return total;
}

async function encodeFast({
  container,
  config,
  slides,
  options,
  signal,
  progress,
}) {
  const { width, height } = config;
  let muxer = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (!muxer) {
        if (container === "mp4") {
          const avcC = metadata?.decoderConfig?.description;
          if (!avcC) {
            failure = new Error(
              "The video encoder gave no H.264 configuration.",
            );
            return;
          }
          muxer = new Mp4Muxer({
            width,
            height,
            avcC:
              avcC instanceof ArrayBuffer
                ? new Uint8Array(avcC)
                : new Uint8Array(avcC.buffer, avcC.byteOffset, avcC.byteLength),
          });
        } else
          muxer = new WebmMuxer({
            codec: config.codec === "vp8" ? "V_VP8" : "V_VP9",
            width,
            height,
          });
      }
      muxer.addFrame(data, chunk.timestamp / 1000, chunk.type === "key");
    },
    error(e) {
      failure = e;
    },
  });
  encoder.configure(config);
  try {
    const total = await playShow({
      slides,
      width,
      height,
      options,
      fps: FPS,
      signal,
      progress,
      async emit(canvas, time, duration, key) {
        if (failure) throw failure;
        while (encoder.encodeQueueSize > 4) await nextTask();
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round(time * 1000),
          duration: Math.round(duration * 1000),
        });
        encoder.encode(frame, { keyFrame: key });
        frame.close();
      },
    });
    await encoder.flush();
    if (failure) throw failure;
    if (!muxer) throw new Error("The video encoder produced no frames.");
    return muxer.finish(total);
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

async function encodeRealtime({
  type,
  width,
  height,
  slides,
  options,
  signal,
  progress,
}) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: bitrate(width, height),
  });
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start(1000);
  const started = performance.now();
  try {
    await playShow({
      slides,
      width,
      height,
      options,
      fps: FPS,
      signal,
      progress,
      holdStep: 1000 / 10,
      async emit(frame, time) {
        // Wait until the moment this frame belongs to, so the recording
        // keeps the show's timing.
        const wait = started + time - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        context.drawImage(frame, 0, 0);
      },
    });
  } finally {
    recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
    await stopped;
  }
  return new Blob(parts, { type: type.split(";")[0] });
}

// Encodes the show. Resolves to a Blob of the container asked for.
export async function exportVideo({
  container = "mp4",
  height = 1080,
  aspect,
  slides,
  options = {},
  signal,
  progress,
}) {
  const size = videoSize(height, aspect);
  const config = await supportedConfig(container, size.width, size.height);
  const mime = container === "mp4" ? "video/mp4" : "video/webm";
  if (config) {
    const bytes = await encodeFast({
      container,
      config,
      slides,
      options,
      signal,
      progress,
    });
    return new Blob([bytes], { type: mime });
  }
  const type = recorderType(container);
  if (!type)
    throw new Error(
      container === "mp4"
        ? "This browser cannot make MP4 videos. Choose WebM instead."
        : "This browser cannot make videos.",
    );
  return encodeRealtime({ type, ...size, slides, options, signal, progress });
}

// The show as an animated GIF: `fps` frames a second through transitions.
export async function exportGif({
  width,
  aspect,
  slides,
  options = {},
  fps = 12,
  loop = true,
  signal,
  progress,
}) {
  const height = Math.max(2, Math.round(width / aspect));
  const gif = new GifEncoder(width, height, { loop: loop ? 0 : null });
  await playShow({
    slides,
    width,
    height,
    options,
    fps,
    signal,
    progress,
    holdStep: 60000,
    async emit(canvas, _time, duration) {
      const data = canvas
        .getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, width, height).data;
      gif.addFrame(data, duration);
      await nextTask();
    },
  });
  return new Blob([gif.finish()], { type: "image/gif" });
}
