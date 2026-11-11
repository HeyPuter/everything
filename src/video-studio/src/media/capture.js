/**
 * Camera and screen capture for the Record dialog: device listing, opening
 * a camera (getUserMedia) or a screen/window/tab (getDisplayMedia), mixing
 * the screen's sound with a microphone, and a MediaRecorder wrapper that
 * picks a video container the browser can record (WebM in Chromium and
 * Firefox, MP4 in Safari).
 */

const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];

export const RESOLUTIONS = [
  { id: '720', label: '720p', width: 1280, height: 720 },
  { id: '1080', label: '1080p', width: 1920, height: 1080 },
  { id: '480', label: '480p', width: 854, height: 480 },
];

/** The first video container MediaRecorder supports here ('' lets the browser choose; null: none). */
export function videoRecorderMime(isSupported) {
  const test = isSupported || (typeof MediaRecorder !== 'undefined' ? (m) => MediaRecorder.isTypeSupported?.(m) : null);
  if (!test) return null;
  return VIDEO_MIME_CANDIDATES.find((m) => test(m)) || '';
}

export function extForVideoMime(mime) {
  return String(mime || '').includes('mp4') ? 'mp4' : 'webm';
}

export function cameraSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

export function screenSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined';
}

/** Cameras and microphones. Labels are only filled in after permission is granted. */
export async function listDevices() {
  const all = await globalThis.navigator?.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  const pick = (kind, name) => all.filter((d) => d.kind === kind).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${name} ${i + 1}` }));
  return { cameras: pick('videoinput', 'Camera'), mics: pick('audioinput', 'Microphone') };
}

export function openCamera({ cameraId = '', micId = '', audio = true, resolution = '720' } = {}) {
  const res = RESOLUTIONS.find((r) => r.id === resolution) || RESOLUTIONS[0];
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: cameraId ? { exact: cameraId } : undefined,
      width: { ideal: res.width },
      height: { ideal: res.height },
      frameRate: { ideal: 30 },
    },
    audio: audio ? { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true } : false,
  });
}

export function openMic(micId = '') {
  return navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true } });
}

/** Ask for a screen, window or tab. systemAudio asks to include its sound where the browser allows it. */
export function openScreen({ systemAudio = true } = {}) {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: systemAudio });
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * One stream with the video of `video` and all audio of `audioStreams`
 * mixed into a single track (MediaRecorder records only one audio track).
 * Returns { stream, close }.
 */
export function mixStreams(video, audioStreams = []) {
  const withAudio = audioStreams.filter((s) => s?.getAudioTracks().length);
  if (withAudio.length <= 1) {
    const tracks = [...video.getVideoTracks(), ...(withAudio[0]?.getAudioTracks().slice(0, 1) || [])];
    return { stream: new MediaStream(tracks), close() {} };
  }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new AC();
  const dest = ctx.createMediaStreamDestination();
  const sources = withAudio.map((s) => {
    const src = ctx.createMediaStreamSource(s);
    src.connect(dest);
    return src;
  });
  return {
    stream: new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]),
    close() {
      sources.forEach((s) => {
        try {
          s.disconnect();
        } catch {
          /* gone */
        }
      });
      ctx.close().catch(() => {});
    },
  };
}

/** What to tell the user when capture cannot start. what: 'camera' | 'screen'. */
export function captureErrorMessage(err, what = 'camera') {
  if (globalThis.isSecureContext === false) return 'Recording needs a secure (https) connection.';
  const thing = what === 'screen' ? 'Screen recording' : 'The camera';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return what === 'screen'
        ? 'Screen recording was cancelled or is blocked. Choose a screen, window or tab to share.'
        : 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return what === 'screen' ? 'Nothing was available to share.' : 'No camera was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return `${thing} is in use by another app or could not be started.`;
    case 'NotSupportedError':
    case 'TypeError':
      return what === 'screen' ? 'This browser cannot record the screen.' : 'This browser cannot use the camera.';
    default:
      return err?.message || (what === 'screen' ? "Couldn't start screen recording." : "Couldn't open the camera.");
  }
}

/** MediaRecorder wrapper for video: start(stream), then stop() resolves with the Blob. */
export class VideoRecorder {
  constructor() {
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.pausedFor = 0;
    this.pausedAt = 0;
  }

  start(stream, { videoBitsPerSecond = 6_000_000 } = {}) {
    const mime = videoRecorderMime();
    const opts = { videoBitsPerSecond, audioBitsPerSecond: 128000 };
    if (mime) opts.mimeType = mime;
    this.recorder = new MediaRecorder(stream, opts);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
    this.startedAt = performance.now();
    this.pausedFor = 0;
    this.pausedAt = 0;
    watchStop(this);
  }

  get state() {
    return this.recorder?.state || 'inactive';
  }

  pause() {
    if (this.recorder?.state !== 'recording') return;
    this.recorder.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    if (this.recorder?.state !== 'paused') return;
    this.recorder.resume();
    this.pausedFor += performance.now() - this.pausedAt;
    this.pausedAt = 0;
  }

  /** Seconds recorded (pauses excluded). */
  get elapsed() {
    if (!this.recorder) return 0;
    const now = this.pausedAt || performance.now();
    return Math.max(0, (now - this.startedAt - this.pausedFor) / 1000);
  }

  /** Resolves with what was recorded, also when the recorder already stopped by itself. */
  stop() {
    return finishRecorder(this, (rec) => (rec.mimeType || this.chunks[0]?.type || 'video/webm').split(';')[0]);
  }

  cancel() {
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') rec.stop();
    this.chunks = [];
  }
}

/**
 * Note when a recorder stops: the camera, screen or microphone it records
 * can end on its own (unplugged, sharing stopped, access revoked), and the
 * recorder then stops by itself. owner.onInterrupted() is called then.
 */
export function watchStop(owner) {
  const rec = owner.recorder;
  owner.stopping = false;
  owner.stopped = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }));
  rec.addEventListener('stop', () => {
    if (owner.recorder === rec && !owner.stopping) owner.onInterrupted?.();
  }, { once: true });
}

/** Stop a recorder (when it is still running) and resolve the Blob of what it recorded. */
export async function finishRecorder(owner, typeOf) {
  const rec = owner.recorder;
  if (!rec) return null;
  owner.stopping = true;
  if (rec.state !== 'inactive') rec.stop();
  await owner.stopped;
  const blob = new Blob(owner.chunks, { type: typeOf(rec) });
  owner.chunks = [];
  if (owner.recorder === rec) owner.recorder = null;
  return blob;
}
