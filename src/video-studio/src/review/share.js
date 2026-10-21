/**
 * Owner side of Share for review: render a review copy with the exporter,
 * save it in the owner's Puter files (video-studio/reviews/<project>/),
 * then publish it on the owner's review worker as a new version.
 */
import { exportProject, detectCapabilities, outputSize, CONTAINERS } from '../engine/exporter.js';
import { sliceProject } from '../model/slice.js';
import { projectDuration } from '../model/timeline.js';
import { ensureWorker, call } from './api.js';
import { randomId, cleanTitle } from './protocol.js';

/** Review copies: 720p H.264 MP4 at the project's frame rate, balanced quality, with sound. */
export const REVIEW_PRESET = Object.freeze({ resolution: 720, codec: 'avc', format: 'mp4', bitrate: 'balanced', video: true, includeAudio: true, audio: false });

/**
 * Export settings for a review copy. Never upscales past the project's own
 * short side; falls back to another codec the browser can encode.
 */
export function reviewSettings(project, caps = null, name = '') {
  const { width, height, fps } = project.settings;
  const s = { ...REVIEW_PRESET, name, fps: Number(fps) || 30, resolution: Math.min(REVIEW_PRESET.resolution, Math.max(144, Math.min(width, height))) };
  if (caps?.video?.length && !caps.video.includes('avc')) {
    const codec = caps.video.find((c) => c === 'vp9') || caps.video[0];
    s.codec = codec;
    s.format = Object.keys(CONTAINERS).find((f) => CONTAINERS[f].video.includes(codec)) || 'mp4';
  }
  return s;
}

/** The project (or its in/out range) to render, and the range it came from. */
export function reviewSource(project, scope = 'all') {
  const r = project.range;
  if (scope === 'range' && r && r.out > r.in) return { project: sliceProject(project, r.in, r.out), range: { in: r.in, out: r.out } };
  return { project, range: null };
}

/** Where a review copy is saved, relative to the app's folder. */
export function reviewFilePath(projectId, clientId, ext, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `video-studio/reviews/${projectId}/${stamp}-${clientId}.${ext}`;
}

/**
 * Render, save and publish. onPhase(phase, detail) reports progress:
 * 'server', 'render' ({ fraction }), 'save', 'publish'. Returns
 * { server, review, version }.
 */
export async function shareForReview({ puter, project, library, scope = 'all', title, signal, onPhase = () => {}, deps = {} }) {
  const d = { ensureWorker, call, exportProject, detectCapabilities, ...deps };
  onPhase('server');
  const server = await d.ensureWorker(puter, { progress: (text) => onPhase('server', { text }) });
  const { project: source, range } = reviewSource(project, scope);
  const duration = projectDuration(source);
  if (duration <= 0) throw new Error('Add something to the timeline first.');
  const size = outputSize(source.settings.width, source.settings.height, REVIEW_PRESET.resolution);
  const caps = await d.detectCapabilities({ ...size, fps: source.settings.fps || 30 }).catch(() => null);
  if (caps && !caps.video.length) throw new Error('This browser cannot encode video, so a review copy cannot be made here.');
  const settings = reviewSettings(source, caps, cleanTitle(title || project.name));
  onPhase('render', { fraction: 0 });
  const result = await d.exportProject(source, library, settings, { kind: 'video', signal, onProgress: (p) => onPhase('render', { fraction: p.fraction, preview: p.preview }) });
  try {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    onPhase('save', { bytes: result.blob.size });
    const clientId = randomId('pub');
    const ext = CONTAINERS[settings.format]?.ext || 'mp4';
    const item = await puter.fs.write(reviewFilePath(project.id, clientId, ext), result.blob, { overwrite: false, dedupeName: true, createMissingParents: true });
    if (signal?.aborted) {
      // Cancelled while saving: nothing is published, and the copy isn't left behind.
      await puter.fs.delete(item.path).catch(() => {});
      throw new DOMException('Canceled', 'AbortError');
    }
    onPhase('publish');
    const video = { path: item.path, mime: CONTAINERS[settings.format]?.mime || 'video/mp4', fps: settings.fps, duration: result.duration, width: result.width, height: result.height, range };
    // Which of the project's timelines it shows, so the editor maps comments onto that one.
    if (project.timelineId) video.timelineId = project.timelineId;
    const input = { op: 'review.publish', clientId, projectId: project.id, title: cleanTitle(title || project.name), video };
    let published;
    try {
      published = await d.call(puter, server, input);
    } catch (err) {
      // The publish is keyed by clientId, so one retry after a lost answer is safe.
      if (err.status) throw err;
      published = await d.call(puter, server, input);
    }
    return { server, review: published.review, version: published.version };
  } finally {
    result.release?.();
  }
}
