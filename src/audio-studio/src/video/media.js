// Video media in the app: opening a video file keeps its picture with the
// audio document made from its sound, inserting that document into a
// session puts the picture on the session's video track, and object URLs for
// the <video> elements that show it.

import { baseName } from '../audio/decode.js';
import { confirmDialog } from '../ui/dialog.js';
import { announce } from '../lib/dom.js';
import { maybeVideo, probeVideo, sniffFrameRate } from './probe.js';
import { addVideoSource, createVideoClip, setVideoClip, videoClip, videoPool, videoSourceFrames } from '../model/session-video.js';

/** AudioFile -> { blob, name, mime, width, height, duration, fps, path } of the video it came from. */
const docVideos = new WeakMap();

export function videoOfDoc(doc) {
  return (doc && docVideos.get(doc)) || null;
}

/** Remembers (or with null forgets) the picture an audio document came with. */
export function setVideoOfDoc(doc, info) {
  if (info) docVideos.set(doc, info);
  else docVideos.delete(doc);
}

/** Reads a video Blob's picture details; null when it has no picture this browser can show. */
export async function videoInfo(blob, name, { path = null, fallbackDuration = 0 } = {}) {
  const meta = await probeVideo(blob);
  if (!meta) return null;
  const fps = await sniffFrameRate(blob);
  return { blob, name, mime: blob.type || '', width: meta.width, height: meta.height, duration: meta.duration || fallbackDuration, fps, path };
}

/** OPEN_HOOKS entry: remembers the picture of a video file opened as audio. */
export async function rememberVideo(app, doc, blob, name, source) {
  if (doc?.kind !== 'audio' || !maybeVideo(name, blob.type)) return;
  try {
    const info = await videoInfo(blob, name, { path: source?.type === 'puter' ? source.path || null : null, fallbackDuration: doc.length / doc.sampleRate });
    if (info) setVideoOfDoc(doc, info);
  } catch (err) {
    console.warn('[video]', err);
  }
}

/** Pool source id for a document's video in a session, adding it once. */
export function linkVideo(session, info) {
  for (const src of videoPool(session).values()) if (src.blob === info.blob) return src.id;
  return addVideoSource(session, info);
}

/**
 * INSERT_HOOKS entry: when an inserted document came from a video, its
 * picture goes on the video track, lined up with the inserted audio clip.
 * A session holds one video; replacing it asks first.
 */
export async function insertVideoHook(app, session, state, inserted) {
  const hit = inserted.find((x) => x.clip && videoOfDoc(x.doc));
  if (!hit) return null;
  const info = videoOfDoc(hit.doc);
  const current = videoClip(state);
  const currentSrc = current && videoPool(session).get(current.sourceId);
  if (current && currentSrc?.blob === info.blob) return null;
  if (current) {
    const ok = await confirmDialog({
      title: 'Replace Video',
      message: `This session already shows the video "${current.name}". Replace it with "${baseName(info.name)}"? Its audio is inserted either way.`,
      confirm: 'Replace',
    });
    if (!ok) return null;
  }
  if (!app.documents.includes(session) || session.sampleRate !== state.sampleRate || !hit.doc.length) return null;
  const sourceId = linkVideo(session, info);
  const audioId = hit.clip.id;
  const full = videoSourceFrames(videoPool(session).get(sourceId), session.sampleRate);
  announce(`Video ${baseName(info.name)} added to the video track`);
  return (latest) => {
    // Source edits during the dialog can resize earlier sequential clips.
    // Follow the rebuilt audio placement instead of its pre-dialog bounds.
    const c = latest.clips.find((clip) => clip.id === audioId);
    if (!c) return latest;
    const length = c.offset === 0 && Number.isFinite(full) && Math.abs(full - c.length) < session.sampleRate ? full : c.length;
    return setVideoClip(latest, createVideoClip({ sourceId, name: baseName(info.name), start: c.start, offset: c.offset, length }));
  };
}

const urls = new WeakMap();

/** A cached object URL for a video source's Blob (null when offline). */
export function videoURL(src) {
  if (!src?.blob) return null;
  let url = urls.get(src.blob);
  if (!url) urls.set(src.blob, (url = URL.createObjectURL(src.blob)));
  return url;
}
