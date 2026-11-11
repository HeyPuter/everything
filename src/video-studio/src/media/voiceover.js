/**
 * Microphone capture for voiceovers: device listing, a level meter fed by
 * an AnalyserNode, and a MediaRecorder wrapper that picks a container the
 * browser can record (WebM/Opus in Chromium and Firefox, MP4/AAC in Safari).
 */
import { watchStop, finishRecorder } from './capture.js';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

export function recorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
}

export function extForMime(mime) {
  const m = String(mime || '');
  if (m.includes('mp4')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

export function recordingSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

export async function listMicrophones() {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

export function openMicrophone({ deviceId, noiseSuppression = true, echoCancellation = true } = {}) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      noiseSuppression,
      echoCancellation,
      autoGainControl: true,
    },
  });
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** What to tell the user when the microphone cannot be opened. */
export function micErrorMessage(err) {
  if (!globalThis.isSecureContext) return 'Recording needs a secure (https) connection.';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another app or could not be started.';
    default:
      return err?.message || "Couldn't open the microphone.";
  }
}

/** Input level of a stream, 0..1, read on demand (no per-frame allocation). */
export class LevelMeter {
  constructor(stream) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.smoothed = 0;
  }

  /** Peak level with a quick attack and slow release, like a hardware meter. */
  level() {
    this.analyser.getFloatTimeDomainData(this.data);
    let peak = 0;
    for (let i = 0; i < this.data.length; i++) {
      const a = Math.abs(this.data[i]);
      if (a > peak) peak = a;
    }
    this.smoothed = peak > this.smoothed ? peak : this.smoothed * 0.92 + peak * 0.08;
    return Math.min(1, this.smoothed);
  }

  close() {
    try {
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    this.ctx.close().catch(() => {});
  }
}

/** MediaRecorder wrapper: start(stream), then stop() resolves with the Blob. */
export class VoiceRecorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  start(stream) {
    const mime = recorderMime();
    this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size) this.chunks.push(e.data);
    };
    // Timeslices keep memory steady and lose little if the tab crashes.
    this.recorder.start(1000);
    this.startedAt = performance.now();
    watchStop(this);
  }

  get recording() {
    return this.recorder?.state === 'recording';
  }

  /** Seconds since start. */
  get elapsed() {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Resolves with what was recorded, also when the recorder already stopped by itself (microphone unplugged). */
  stop() {
    return finishRecorder(this, (rec) => rec.mimeType || this.chunks[0]?.type || 'audio/webm');
  }

  cancel() {
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') rec.stop();
    this.chunks = [];
  }
}
