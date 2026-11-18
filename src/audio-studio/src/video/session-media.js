// Saving and loading a session's video file. On Puter a video that is already
// stored there is referenced by its path; one opened from this device is
// written into the session's media folder on first save and referenced from
// then on. ZIP packages always carry the video. A video that cannot be found
// opens offline: the clip keeps its place and shows a placeholder strip.

import { addVideoSource, videoPool } from '../model/session-video.js';
import { videoInfo } from './media.js';
import * as puter from '../storage/puter.js';

const dirOf = (path) => path.slice(0, path.lastIndexOf('/'));

/** Writes the video returned by serializeSession (when it is not on Puter yet) next to the session. */
export async function saveSessionVideo(app, session, video, dir, { copy = false } = {}) {
  if (!video?.blob) return;
  const target = `${dir}/${video.file}`;
  app.setStatus('Saving video...');
  await puter.writeFile(target, video.blob);
  // From now on the session refers to the copy on Puter instead of writing it again.
  if (!copy) {
    const src = videoPool(session).get(video.id);
    if (src) src.path = target;
  }
}

const bytesCache = new WeakMap(); // Blob -> Uint8Array, read ahead for synchronous ZIP writing

/** Reads the session's video ahead; concurrent ZIP jobs supply their own cache. */
export async function prepareVideoBytes(session, bytes = bytesCache) {
  for (const src of videoPool(session).values()) {
    if (src.blob && !bytes.has(src.blob) && session.state.video?.sourceId === src.id) bytes.set(src.blob, new Uint8Array(await src.blob.arrayBuffer()));
  }
  return bytes;
}

/** ZIP entry for the video returned by serializeSession({ embedVideo: true }), or null when not read ahead. */
export function videoZipEntry(video, bytes = bytesCache) {
  const data = video?.blob && bytes.get(video.blob);
  if (!data) return null;
  bytes.delete(video.blob);
  return { name: video.file, data };
}

/**
 * Adds the video of a parsed session ("video" entry) to its video pool,
 * reading it by Puter path or through `loadMedia(entry, fileName)` like the
 * session's audio. Returns true when found, false when it is offline.
 */
export async function loadSessionVideo(session, entry, { source, loadMedia }) {
  let blob = null;
  let path = entry.path || null;
  try {
    if (entry.path && puter.sdk()) blob = await puter.readFile(entry.path);
    else if (entry.file) {
      blob = await loadMedia(entry, entry.file.split('/').pop());
      if (blob && source?.type === 'puter' && source.path) path = `${dirOf(source.path)}/${entry.file}`;
    }
  } catch {
    blob = null;
  }
  let info = null;
  if (blob) {
    // Files read back may carry no type (or the wrong one, from a ZIP).
    const typed = blob.type !== (entry.mime || '') ? new Blob([blob], { type: entry.mime || '' }) : blob;
    info = await videoInfo(typed, entry.name, { path, fallbackDuration: entry.duration || 0 }).catch(() => null);
  }
  const meta = { id: entry.id, name: entry.name || 'Video', mime: entry.mime || '', width: entry.width || 0, height: entry.height || 0, duration: entry.duration || 0, fps: entry.fps || 0, path };
  if (!info) {
    addVideoSource(session, { ...meta, blob: null, offline: true });
    return false;
  }
  addVideoSource(session, { ...meta, ...info, id: entry.id, name: meta.name, fps: info.fps || meta.fps, path });
  return true;
}
