// A session's media pool is outside Undo. A file replaced by another session
// needs independent source ids so Revert never changes media used by history.
import { uid, remapClipSources } from './session-edits.js';
import { addVideoSource, videoPool } from './session-video.js';

const imports = new WeakMap();
const videoKey = (src) => JSON.stringify([src.name, src.mime, src.width, src.height, src.duration, src.fps, src.offline, src.path]);
const audioKey = (src) => JSON.stringify([src.name, src.sampleRate, src.offline, src.frames, src.channelCount]);
const freshId = (prefix, pool) => {
  let id;
  do { id = uid(prefix); } while (pool.has(id));
  return id;
};

/** Capture the state and immutable media selected for upload, before awaiting it. */
export function captureSavedSession(doc, state, media, video, dir) {
  const src = state.video && videoPool(doc).get(state.video.sourceId);
  return {
    state,
    media: media.map((m) => {
      const source = doc.pool.get(m.id);
      return { ...m, name: source.name, offline: source.offline, frames: source.frames, channelCount: source.channelCount, path: dir === undefined ? source.path : `${dir}/${m.file}` };
    }),
    video: src ? { ...src, path: video && dir !== undefined ? `${dir}/${video.file}` : src.path } : null,
  };
}

/** Snapshot the media referenced by a state, including loaded and offline sources. */
export function captureSessionState(doc, state = doc.state) {
  const used = new Set(state.clips.flatMap((c) => [c.sourceId, c.stretch?.sourceId, c.remix?.sourceId, c.soundAssistant?.duration?.orig?.sourceId].filter(Boolean)));
  const media = [...doc.pool].filter(([id]) => used.has(id)).map(([id, src]) => ({ id, channels: src.channels, sampleRate: state.sampleRate }));
  return captureSavedSession(doc, state, media, null);
}

export function savedAudioMatches(doc, snapshot) {
  return snapshot.media.every((saved) => {
    const src = doc.pool.get(saved.id);
    return src && src.name === saved.name && src.offline === saved.offline && src.frames === saved.frames && src.channelCount === saved.channelCount &&
      (src.channels?.length || 0) === (saved.channels?.length || 0) && (saved.channels || []).every((channel, i) => src.channels[i] === channel);
  });
}

export function savedVideoMatches(doc, snapshot) {
  const saved = snapshot.video;
  const src = snapshot.state.video && videoPool(doc).get(snapshot.state.video.sourceId);
  if (!saved || !src) return !saved && !src;
  return src.blob === saved.blob && src.name === saved.name && src.mime === saved.mime && src.width === saved.width && src.height === saved.height &&
    src.duration === saved.duration && src.fps === saved.fps && src.offline === saved.offline && (Boolean(src.blob) || src.path === saved.path);
}

/** Import only saved media, preserving every source used by the target's history. */
export function savedSessionSnapshot(target, captured) {
  let cache = imports.get(target);
  if (!cache) imports.set(target, (cache = { audio: new Map(), video: new Map(), states: new WeakMap() }));
  const ids = new Map();
  const media = captured.media.map((m) => {
    let versions = cache.audio.get(m.path);
    if (!versions) cache.audio.set(m.path, (versions = []));
    const signature = audioKey(m);
    let entry = versions.find((v) => {
      const src = target.pool.get(v.id);
      return v.signature === signature && src && !src.docId && src.channels === m.channels && audioKey(src) === signature;
    });
    if (!entry) {
      const id = target.addSource({ ...m, channelRate: m.sampleRate, id: freshId('src', target.pool), docId: null });
      Object.assign(target.pool.get(id), { frames: m.frames, channelCount: m.channelCount });
      versions.push((entry = { id, signature }));
    }
    ids.set(m.id, entry.id);
    return { ...m, id: entry.id };
  });
  let videoId = null;
  if (captured.video) {
    const src = captured.video;
    const signature = videoKey(src);
    let versions = cache.video.get(src.path);
    if (!versions) cache.video.set(src.path, (versions = []));
    let entry = versions.find((v) => {
      const current = videoPool(target).get(v.id);
      return current && current.blob === src.blob && videoKey(current) === signature;
    });
    if (!entry) {
      const id = addVideoSource(target, { ...src, id: freshId('vsrc', videoPool(target)) });
      versions.push((entry = { id }));
    }
    videoId = entry.id;
  }
  const original = captured.state;
  const prior = cache.states.get(original);
  if (prior && prior.videoId === videoId && prior.ids.size === ids.size && [...ids].every(([id, mapped]) => prior.ids.get(id) === mapped)) {
    return { state: prior.state, media };
  }
  const state = {
    ...original,
    clips: original.clips.map((c) => remapClipSources(c, ids)),
    ...(original.video ? { video: videoId ? { ...original.video, sourceId: videoId } : undefined } : {}),
  };
  cache.states.set(original, { ids, videoId, state });
  return { state, media };
}
