// Getting audio into sessions: linking open AudioFile documents as sources
// (resampled to the session rate when needed), inserting them as clips, and
// keeping clips in step with edits made to their sources in the Waveform
// editor.

import { Channel } from '../audio/channel.js';
import { dsp } from '../audio/dsp.js';
import { openFiles } from '../storage/files.js';
import { baseName } from '../audio/decode.js';
import * as S from '../model/session-edits.js';
import { announce } from '../lib/dom.js';

/** Channels of an audio document at `rate` (shared, not copied, when rates match). */
export async function channelsAtRate(channels, from, to) {
  if (from === to) return channels.slice();
  const d = await dsp();
  return channels.map((c) => Channel.fromSamples(d.resample(c.toArray(), from, to)));
}

/** Pool source id for an AudioFile, adding or refreshing the pool entry. */
export async function linkSource(session, doc) {
  for (const src of session.pool.values()) {
    if (src.docId === doc.id && src.stateRef === doc.state) return src.id;
  }
  const channels = await channelsAtRate(doc.state.channels, doc.sampleRate, session.sampleRate);
  const existing = [...session.pool.values()].find((s) => s.docId === doc.id);
  if (existing) {
    session.updateSource(existing.id, { channels, stateRef: doc.state, name: doc.name });
    return existing.id;
  }
  const id = session.addSource({ name: doc.name, channels, sampleRate: doc.sampleRate, docId: doc.id, path: doc.source?.path || null });
  session.pool.get(id).stateRef = doc.state;
  return id;
}

/** Next free "Track N" name. */
export function nextTrackName(state, prefix = 'Track') {
  const used = new Set(S.allTracks(state).map((t) => t.name));
  for (let i = 1; ; i++) if (!used.has(`${prefix} ${i}`)) return `${prefix} ${i}`;
}

export function nextBusName(state) {
  const used = new Set(state.tracks.map((t) => t.name));
  for (let i = 0; i < 26; i++) {
    const n = `Bus ${String.fromCharCode(65 + i)}`;
    if (!used.has(n)) return n;
  }
  return nextTrackName(state, 'Bus');
}

/**
 * Track and clip placement options from Preferences > Multitrack (set by the
 * app): `randomColor` gives new tracks a random palette color (different
 * from the track before), `avoidOverlap` moves inserted and pasted clips to
 * the next track where they fit, `sameTrack` places several inserted files
 * one after another on one track.
 */
export const placementOptions = { randomColor: false, avoidOverlap: false, sameTrack: false, random: Math.random };

function colorFor(state) {
  const n = S.TRACK_COLORS.length;
  if (!placementOptions.randomColor) return S.TRACK_COLORS[state.tracks.length % n];
  const prev = state.tracks[state.tracks.length - 1]?.color;
  const pool = S.TRACK_COLORS.filter((c) => c !== prev);
  return pool[Math.floor(placementOptions.random() * pool.length) % pool.length];
}

/** A new audio track state entry placed after `afterId` (or at the end). */
export function newTrack(state, { type = 'audio', channels = 2, name, afterId } = {}) {
  const track = S.createTrack({
    type,
    channels,
    name: name || (type === 'bus' ? nextBusName(state) : nextTrackName(state)),
    color: colorFor(state),
  });
  const i = afterId ? state.tracks.findIndex((t) => t.id === afterId) : -1;
  return { track, state: S.addTrack(state, track, i >= 0 ? i + 1 : state.tracks.length) };
}

/** True when [start, end) on the track is free of (unmuted or muted) clips. */
export function trackIsFree(state, trackId, start, end) {
  return !state.clips.some((c) => c.trackId === trackId && c.start < end && S.clipEnd(c) > start);
}

/** Audio tracks that are shown (not hidden): where inserted and pasted clips land. */
export const shownAudioTracks = (state) => S.audioTracks(state).filter((t) => !t.hidden);

/**
 * Smallest shift (in shown audio tracks, from 0) that lets clips placed at
 * `base + trackOffset` and times [start, end) land without overlapping
 * existing clips. Tracks past the end count as free (they get created).
 */
export function freeTrackShift(state, base, spans) {
  const audio = shownAudioTracks(state);
  for (let k = 0; k < 1000; k++) {
    const ok = spans.every(({ trackOffset, start, end }) => {
      const t = audio[base + trackOffset + k];
      return !t || trackIsFree(state, t.id, start, end);
    });
    if (ok) return k;
  }
  return audio.length;
}

/**
 * Called before an insert is committed: async (app, session, state, inserted)
 * => state, where inserted lists { doc, clip } (e.g. to add a video's picture
 * to the video track in the same undo step).
 */
export const INSERT_HOOKS = [];

/**
 * Inserts audio documents as clips: the first on `trackId` (undefined: the
 * selected audio track; null: a new track) at `at`, further documents on the following
 * tracks, creating tracks as needed. `range` = [a, b) inserts only part of
 * the first document (in its own frames). One undo step.
 */
export async function insertDocs(app, session, docs, { trackId, at, range } = {}) {
  docs = docs.filter((d) => d && d.kind === 'audio' && d.length > 0);
  if (!docs.length) return [];
  at = Math.max(0, Math.round(at ?? session.cursor));
  let state = session.state;
  // Clips never land on hidden tracks, where they could not be seen.
  const audio = () => shownAudioTracks(state);
  // trackId null means "a new track"; undefined means the selected track.
  let index = trackId === null ? -1 : audio().findIndex((t) => t.id === (trackId ?? session.selectedTrack));
  const ids = [];
  // Several files go one per track, or end to end on one track (Preferences > Multitrack Clips).
  const sameTrack = placementOptions.sameTrack && docs.length > 1;
  const parts = [];
  let t = at;
  for (const [i, doc] of docs.entries()) {
    const sourceId = await linkSource(session, doc);
    const srcLen = session.sourceLength(sourceId);
    let offset = 0;
    let length = srcLen;
    if (range && i === 0) {
      const ratio = session.sampleRate / doc.sampleRate;
      offset = Math.round(range[0] * ratio);
      length = Math.max(1, Math.min(srcLen - offset, Math.round((range[1] - range[0]) * ratio)));
    }
    parts.push({ doc, sourceId, offset, length, start: sameTrack ? t : at, trackOffset: sameTrack ? 0 : i });
    t += length;
  }
  if (placementOptions.avoidOverlap && index >= 0) index += freeTrackShift(state, index, parts.map((p) => ({ trackOffset: p.trackOffset, start: p.start, end: p.start + p.length })));
  for (const p of parts) {
    let track = index >= 0 ? audio()[index + p.trackOffset] : null;
    if (!track) {
      const last = state.tracks.filter((x) => x.type === 'audio').pop();
      const made = newTrack(state, { channels: Math.min(2, p.doc.channelCount), afterId: last?.id });
      state = made.state;
      track = made.track;
      if (index < 0 || !audio()[index + p.trackOffset] || audio()[index + p.trackOffset].id !== track.id) index = audio().findIndex((x) => x.id === track.id) - p.trackOffset;
    }
    const clip = S.createClip({ trackId: track.id, sourceId: p.sourceId, name: baseName(p.doc.name), start: p.start, offset: p.offset, length: p.length });
    state = S.addClipsOnTop(state, [clip]);
    ids.push(clip.id);
    p.clip = clip;
  }
  for (const hook of INSERT_HOOKS) state = (await hook(app, session, state, parts.map((p) => ({ doc: p.doc, clip: p.clip })))) || state;
  session.apply(docs.length > 1 ? 'Insert Files' : 'Insert File', state, { clips: ids });
  const first = S.findClip(session.state, ids[0]);
  if (first) session.selectTrack(first.trackId);
  announce(`${ids.length} clip${ids.length > 1 ? 's' : ''} inserted`);
  return ids;
}

/** Opens local files or Puter items (without activating them) and inserts them. */
export async function insertFiles(app, session, items, opts = {}) {
  const docs = await openFiles(app, items, { activate: false });
  if (app.active !== session) app.activate(session);
  return insertDocs(app, session, docs, opts);
}

/**
 * Re-resolves every session source linked to `doc` after it changed in the
 * Waveform editor. Rate conversion work is debounced per document.
 */
const pending = new Map();
export function syncLinkedSources(app, doc) {
  const sessions = app.documents.filter((d) => d.kind === 'session' && [...d.pool.values()].some((s) => s.docId === doc.id));
  if (!sessions.length) return;
  const run = async () => {
    pending.delete(doc.id);
    for (const s of sessions) {
      for (const src of s.pool.values()) {
        if (src.docId !== doc.id || src.stateRef === doc.state) continue;
        const channels = await channelsAtRate(doc.state.channels, doc.sampleRate, s.sampleRate);
        s.updateSource(src.id, { channels, stateRef: doc.state, name: doc.name });
        const fitted = S.fitClipsToSource(s.state, src.id, channels[0]?.length ?? 0);
        if (fitted !== s.state) s.apply('Fit Clips to Source', fitted);
      }
    }
    app.syncGraph();
  };
  clearTimeout(pending.get(doc.id));
  const sameRate = sessions.every((s) => s.sampleRate === doc.sampleRate);
  if (sameRate) run();
  else pending.set(doc.id, setTimeout(run, 300));
}
