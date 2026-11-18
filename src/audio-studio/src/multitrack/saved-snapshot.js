// A session's media pool is outside Undo. A file replaced by another session
// needs independent source ids so Revert never changes media used by history.
import { uid } from '../model/session-edits.js';
import { addVideoSource, videoPool } from '../model/session-video.js';

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
      return { ...m, name: source.name, offline: source.offline, frames: source.frames, channelCount: source.channelCount, path: `${dir}/${m.file}` };
    }),
    video: src ? { ...src, path: video ? `${dir}/${video.file}` : src.path } : null,
  };
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
      const id = target.addSource({ ...m, id: freshId('src', target.pool), docId: null });
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
  const sourceId = (id) => id ? ids.get(id) : id;
  const state = {
    ...original,
    clips: original.clips.map((c) => ({
      ...c,
      sourceId: sourceId(c.sourceId),
      stretch: c.stretch ? { ...c.stretch, sourceId: sourceId(c.stretch.sourceId) } : c.stretch,
      remix: c.remix ? { ...c.remix, sourceId: sourceId(c.remix.sourceId) } : c.remix,
      soundAssistant: c.soundAssistant?.duration?.orig ? {
        ...c.soundAssistant,
        duration: { ...c.soundAssistant.duration, orig: { ...c.soundAssistant.duration.orig, sourceId: sourceId(c.soundAssistant.duration.orig.sourceId) } },
      } : c.soundAssistant,
    })),
    ...(original.video ? { video: videoId ? { ...original.video, sourceId: videoId } : undefined } : {}),
  };
  cache.states.set(original, { ids, videoId, state });
  return { state, media };
}
