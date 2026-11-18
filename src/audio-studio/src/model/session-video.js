// The video track of a multitrack session: at most one video clip, shown in
// a lane above the audio tracks and in the Video panel. It never plays
// through the mixer, so mixdowns, bounces and exports ignore it.
//
// state.video: { id, sourceId, name, start, offset, length, locked } or
// absent, in frames at the session rate like audio clips: the clip shows the
// media from `offset` for `length` frames, starting at timeline frame `start`.
//
// Video media live in a pool of their own (videoPool(session)), keyed by
// source id: { id, name, blob, mime, width, height, duration (seconds or 0),
// fps (or 0), path (Puter path when the file is there), offline }. Like the
// audio pool it only grows, so undo can bring back a replaced video.

import { uid } from './session-edits.js';
import { safeFileName } from './session-io.js';

export function createVideoClip(o = {}) {
  return {
    id: o.id || uid('v'),
    sourceId: o.sourceId,
    name: o.name || 'Video',
    start: Math.max(0, Math.round(o.start || 0)),
    offset: Math.max(0, Math.round(o.offset || 0)),
    length: Math.max(1, Math.round(o.length || 1)),
    locked: Boolean(o.locked),
  };
}

/** The session's video clip, or null. */
export function videoClip(state) {
  return state?.video || null;
}

/** Timeline frame where the video clip ends (0 without one). */
export function videoEnd(state) {
  const v = videoClip(state);
  return v ? v.start + v.length : 0;
}

/** Sets (or with null removes) the video clip. */
export function setVideoClip(state, clip) {
  if (!clip) {
    if (!state.video) return state;
    const { video, ...rest } = state;
    return rest;
  }
  return { ...state, video: createVideoClip(clip) };
}

export function updateVideoClip(state, patch) {
  const v = videoClip(state);
  if (!v) return state;
  const next = { ...v, ...(typeof patch === 'function' ? patch(v) : patch) };
  return Object.keys(next).every((k) => next[k] === v[k]) ? state : { ...state, video: createVideoClip(next) };
}

/** Moves the video clip by `dt` frames (not before the session start). Locked clips stay. */
export function moveVideoClip(state, dt) {
  const v = videoClip(state);
  if (!v || v.locked) return state;
  const start = Math.max(0, Math.round(v.start + dt));
  return start === v.start ? state : updateVideoClip(state, { start });
}

/**
 * Trims the video clip's 'in' or 'out' edge to timeline `frame`, within the
 * media (`sourceLength` frames; Infinity when unknown) and at least one frame long.
 */
export function trimVideoClip(state, edge, frame, sourceLength = Infinity) {
  const v = videoClip(state);
  if (!v || v.locked) return state;
  frame = Math.round(frame);
  if (edge === 'in') {
    const minStart = Math.max(0, v.start - v.offset);
    const s = Math.max(minStart, Math.min(v.start + v.length - 1, frame));
    const d = s - v.start;
    return d ? updateVideoClip(state, { start: s, offset: v.offset + d, length: v.length - d }) : state;
  }
  const maxEnd = Number.isFinite(sourceLength) ? v.start + Math.max(1, sourceLength - v.offset) : Infinity;
  const e = Math.max(v.start + 1, Math.min(maxEnd, frame));
  return updateVideoClip(state, { length: e - v.start });
}

/** Media time (seconds) the video clip shows at timeline `frame`, or null outside the clip. */
export function videoTimeAt(clip, frame, rate) {
  if (!clip || frame < clip.start || frame >= clip.start + clip.length) return null;
  return (clip.offset + frame - clip.start) / rate;
}

/**
 * One step of keeping a playing <video> in step with the playhead: `current`
 * is the element's time and `target` where it should be (seconds). Returns
 * { seek } to jump (far off, or stopped and not on the frame), { rate } to
 * nudge the playback speed so small drift closes gently, or null.
 */
export function syncStep({ current, target, playing, fps = 0, maxDrift = 0.3, tolerance = 0.03 }) {
  const d = current - target;
  const ad = Math.abs(d);
  if (!playing) return ad > (fps > 0 ? 0.5 / fps : 0.02) ? { seek: target } : null;
  if (ad > maxDrift) return { seek: target, rate: 1 };
  if (ad <= tolerance) return { rate: 1 };
  // Catch up over about half a second, never faster or slower than 10 %.
  return { rate: Math.max(0.9, Math.min(1.1, 1 - d * 2)) };
}

/**
 * Thumbnail tiles for the visible part of a video clip in a lane: tiles are
 * `tileWidth` px wide, anchored at the clip start, and each shows the media at
 * the tile's start. Times are rounded to a power-of-two step near the tile
 * duration so thumbnails stay reusable while zooming within a factor of two.
 * Returns { tiles: [{ x, time }], step }.
 */
export function thumbnailTiles({ clip, viewStart, fpp, width, tileWidth, rate, duration = 0, max = 400 }) {
  if (!clip || !(fpp > 0) || !(tileWidth > 0)) return { tiles: [], step: 0 };
  const tileFrames = tileWidth * fpp;
  const viewEnd = viewStart + width * fpp;
  const end = Math.min(viewEnd, clip.start + clip.length);
  const first = Math.max(0, Math.floor((viewStart - clip.start) / tileFrames));
  const last = Math.ceil((end - clip.start) / tileFrames);
  const tileSec = tileFrames / rate;
  const step = Math.max(1 / 32, Math.pow(2, Math.floor(Math.log2(tileSec))));
  const lastTime = duration > 0 ? Math.max(0, duration - 1 / 60) : Infinity;
  const tiles = [];
  for (let k = first; k < last && tiles.length < max; k++) {
    const f = k * tileFrames;
    const raw = (clip.offset + f) / rate;
    tiles.push({ x: (clip.start + f - viewStart) / fpp, time: Math.min(lastTime, Math.round(raw / step) * step) });
  }
  return { tiles, step };
}

// ------------------------------------------------------------------- pool

const pools = new WeakMap();

/** The session's video media pool (Map source id -> source). */
export function videoPool(session) {
  let pool = pools.get(session);
  if (!pool) pools.set(session, (pool = new Map()));
  return pool;
}

export function addVideoSource(session, { id = uid('vsrc'), name, blob = null, mime = '', width = 0, height = 0, duration = 0, fps = 0, path = null, offline = false }) {
  videoPool(session).set(id, { id, name, blob, mime: mime || blob?.type || '', width, height, duration, fps, path, offline: offline || !blob });
  return id;
}

/** The pool entry the session's video clip shows, or null. */
export function videoSourceOf(session, state = session.state) {
  const v = videoClip(state);
  return v ? videoPool(session).get(v.sourceId) || null : null;
}

/** Media length of a video source in session frames (Infinity when unknown). */
export function videoSourceFrames(src, rate) {
  return src?.duration > 0 && Number.isFinite(src.duration) ? Math.round(src.duration * rate) : Infinity;
}

const MIME_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v' };

/** File extension to save a video source under. */
export function videoExtension(src) {
  const m = /\.([a-z0-9]{2,4})$/i.exec(src?.name || '');
  return m ? m[1].toLowerCase() : MIME_EXT[(src?.mime || '').split(';')[0]] || 'mp4';
}

/**
 * The session file's "video" entry and the media to write for it. A video
 * already stored on Puter is referenced by its path; otherwise (or with
 * `embed`, for ZIP packages) it is written into the session's media folder.
 * Returns null without a video clip.
 */
export function serializeVideo(session, { folder, embed = false, taken = new Set(), mediaPath } = {}) {
  const v = videoClip(session.state);
  const src = v && videoPool(session).get(v.sourceId);
  if (!src) return null;
  const entry = { id: src.id, name: src.name, mime: src.mime || '', width: src.width || 0, height: src.height || 0, duration: Number.isFinite(src.duration) ? src.duration || 0 : 0, fps: src.fps || 0 };
  let media = null;
  if (src.path && !embed) entry.path = src.path;
  else {
    const base = safeFileName(src.name || 'Video');
    const ext = videoExtension(src);
    let file = `${base}.${ext}`;
    for (let i = 2; taken.has(file.toLowerCase()); i++) file = `${base} ${i}.${ext}`;
    entry.file = mediaPath?.(src.id, src, `${folder}/${file}`) ?? `${folder}/${file}`;
    media = { id: src.id, file: entry.file, blob: src.blob };
  }
  return { entry, media };
}

/** The video clip of parsed session data when its media entry is present, else null. */
export function parseVideoClip(raw, entry) {
  if (!raw || typeof raw !== 'object' || !entry || raw.sourceId !== entry.id) return null;
  return createVideoClip(raw);
}
