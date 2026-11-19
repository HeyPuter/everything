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
  for (;;) {
    const state = doc.state;
    const sourceRate = doc.sampleRate;
    const rate = session.sampleRate;
    for (const src of session.pool.values()) {
      if (src.docId === doc.id && src.channelRate === rate && src.stateRef === state) return src.id;
    }
    const channels = await channelsAtRate(state.channels, sourceRate, rate);
    // Edits can arrive while DSP loads. Never cache old samples under a newer
    // document version, or overwrite a source refreshed by a later request.
    if (doc.state !== state || doc.sampleRate !== sourceRate || session.sampleRate !== rate) continue;
    // Revert can switch session rates. Keep older-rate sources intact for Undo.
    const existing = [...session.pool.values()].find((s) => s.docId === doc.id && s.channelRate === rate);
    if (existing) {
      session.updateSource(existing.id, { channels, stateRef: state, name: doc.name });
      return existing.id;
    }
    const id = session.addSource({ name: doc.name, channels, sampleRate: sourceRate, docId: doc.id, path: doc.source?.path || null });
    session.pool.get(id).stateRef = state;
    return id;
  }
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
export const placementOptions = { randomColor: false, avoidOverlap: false, sameTrack: false, embeddedTimecode: false, random: Math.random };

/**
 * Where a file's embedded timecode (the broadcast WAV time reference, in its own samples) puts it
 * on a timeline at `rate`, or null when it has none.
 */
export function embeddedStart(doc, rate) {
  const ref = Math.floor(Number(doc?.state?.meta?.bextTimeRef) || 0);
  return ref > 0 && doc.sampleRate > 0 ? Math.round((ref * rate) / doc.sampleRate) : null;
}

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

/** Channels of a new track for audio with `n` channels: 5.1 audio gets a 5.1 track in a 5.1 session. */
export function trackChannelsFor(state, n) {
  return n === 6 && state.master.channels === 6 ? 6 : Math.min(2, n);
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
 * => (state => state) | null, where inserted lists { doc, clip }. Prepare any
 * asynchronous decisions, then return a synchronous edit of the latest state
 * (e.g. to add a video's picture in the same undo step as its audio).
 */
export const INSERT_HOOKS = [];

/**
 * Inserts audio documents as clips: the first on `trackId` (undefined: the
 * selected audio track; null: a new track) at `at`, further documents on the following
 * tracks, creating tracks as needed. `range` = [a, b) inserts only part of
 * the first document (in its own frames); `ranges` gives one range per
 * document (the same document may be listed more than once, e.g. for range
 * markers), `names` the clip names, and `sameTrack` places them end to end on
 * one track whatever the preference says. One undo step.
 */
export async function insertDocs(app, session, docs, { trackId, at, range, ranges, names, sameTrack: sameTrackOpt } = {}) {
  const kept = docs.map((d, i) => [d, i]).filter(([d]) => d && d.kind === 'audio' && d.length > 0);
  docs = kept.map(([d]) => d);
  ranges = ranges && kept.map(([, i]) => ranges[i] || null);
  names = names && kept.map(([, i]) => names[i] || null);
  if (!docs.length) return [];
  // All prepared sources and frame positions must use the same session rate.
  // Revert/Undo can replace it while conversion or a hook's dialog is pending.
  const rate = session.sampleRate;
  const canInsert = () => {
    if (!app.documents.includes(session)) {
      app.notify('Insertion stopped because the destination session was closed. Imported files remain open.', { error: true });
    } else if (session.sampleRate !== rate) {
      app.notify('Insertion stopped because the session sample rate changed. Review the session and insert the files again.', { error: true });
    } else return true;
    return false;
  };
  if (!canInsert()) return [];
  at = Math.max(0, Math.round(at ?? session.cursor));
  // trackId null means "a new track"; undefined means the selected track.
  const target = trackId === undefined ? session.selectedTrack : trackId;
  const ids = [];
  // Several files go one per track, or end to end on one track (Preferences > Multitrack Clips).
  const sameTrack = (sameTrackOpt ?? placementOptions.sameTrack) && docs.length > 1;
  const parts = [];
  for (const [i, doc] of docs.entries()) {
    const ratio = rate / doc.sampleRate;
    const r = ranges?.[i] || (range && i === 0 ? range : null);
    const requested = r ? {
      offset: Math.max(0, Math.round(r[0] * ratio)),
      length: Math.max(1, Math.round((r[1] - r[0]) * ratio)),
    } : null;
    const sourceId = await linkSource(session, doc);
    if (!canInsert()) return [];
    parts.push({ doc, sourceId, requested, name: names?.[i] || null });
  }
  // Earlier sources can change while later ones convert. Refresh linked
  // audio before deriving any bounds, including after a hook's dialog.
  const ready = (p) => {
    const src = session.pool.get(p.sourceId);
    return src?.stateRef === p.doc.state && src.channelRate === rate;
  };
  const refreshSources = async () => {
    for (const p of parts) {
      if (ready(p)) continue;
      p.sourceId = await linkSource(session, p.doc);
      if (!canInsert()) return false;
    }
    return true;
  };
  while (!parts.every(ready)) if (!(await refreshSources())) return [];
  let activeParts;
  const place = (base) => {
    let state = base;
    let end = at;
    activeParts = [];
    for (const p of parts) {
      p.prepared = session.pool.get(p.sourceId);
      const length = session.sourceLength(p.sourceId);
      if (!length) continue;
      p.offset = p.requested ? Math.min(p.requested.offset, length - 1) : 0;
      p.length = p.requested ? Math.min(p.requested.length, length - p.offset) : length;
      // Preferences > Multitrack Clips: a whole file with a time reference goes where it was recorded.
      const stamped = placementOptions.embeddedTimecode && !sameTrack && !p.requested ? embeddedStart(p.doc, rate) : null;
      p.start = sameTrack ? end : stamped ?? at;
      p.trackOffset = sameTrack ? 0 : activeParts.length;
      end += p.length;
      activeParts.push(p);
    }
    // Re-resolve the original target after preparation; it may have been
    // hidden, moved or deleted. Never restore tracks from an older snapshot.
    const audio = () => shownAudioTracks(state);
    let index = target === null ? -1 : audio().findIndex((t) => t.id === target);
    ids.length = 0;
    if (placementOptions.avoidOverlap && index >= 0) index += freeTrackShift(state, index, activeParts.map((p) => ({ trackOffset: p.trackOffset, start: p.start, end: p.start + p.length })));
    for (const p of activeParts) {
      let track = index >= 0 ? audio()[index + p.trackOffset] : null;
      if (!track) {
        const last = state.tracks.filter((x) => x.type === 'audio').pop();
        const made = newTrack(state, { channels: trackChannelsFor(state, p.doc.channelCount), afterId: last?.id });
        state = made.state;
        track = made.track;
        if (index < 0 || !audio()[index + p.trackOffset] || audio()[index + p.trackOffset].id !== track.id) index = audio().findIndex((x) => x.id === track.id) - p.trackOffset;
      }
      const clip = S.createClip({ id: p.clip?.id, trackId: track.id, sourceId: p.sourceId, name: p.name || baseName(p.doc.name), start: p.start, offset: p.offset, length: p.length });
      state = S.addClipsOnTop(state, [clip]);
      ids.push(clip.id);
      p.clip = clip;
    }
    return state;
  };
  let base = session.state;
  let state = place(base);
  if (!ids.length) return [];
  const edits = [];
  for (const hook of INSERT_HOOKS) {
    const edit = await hook(app, session, state, activeParts.map((p) => ({ doc: p.doc, clip: p.clip })));
    if (!canInsert()) return [];
    while (!parts.every(ready)) if (!(await refreshSources())) return [];
    // Rebuild placement for source edits as well as timeline edits. Keep
    // clip ids stable so hook edits can locate their current audio bounds.
    if (session.state !== base || parts.some((p) => p.prepared !== session.pool.get(p.sourceId))) {
      base = session.state;
      state = place(base);
      for (const prior of edits) state = prior(state);
    }
    if (edit) {
      edits.push(edit);
      state = edit(state);
    }
  }
  if (!canInsert() || !ids.length) return [];
  session.apply(docs.length > 1 ? 'Insert Files' : 'Insert File', state, { clips: ids });
  const first = S.findClip(session.state, ids[0]);
  if (first) session.selectTrack(first.trackId);
  announce(`${ids.length} clip${ids.length > 1 ? 's' : ''} inserted`);
  return ids;
}

/** Opens local files or Puter items (without activating them) and inserts them. */
export async function insertFiles(app, session, items, opts = {}) {
  const rate = session.sampleRate;
  const docs = await openFiles(app, items, { activate: false });
  // The session was closed while the files opened: they stay in the Files panel.
  if (!app.documents.includes(session)) return [];
  // Drop/picker positions were captured before file I/O, in the old frame units.
  if (session.sampleRate !== rate && docs.some((d) => d.kind === 'audio' && d.length > 0)) {
    app.notify('Insertion stopped because the session sample rate changed. Review the session and insert the files again.', { error: true });
    return [];
  }
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
        for (;;) {
          const state = doc.state;
          const sourceRate = doc.sampleRate;
          const rate = src.channelRate;
          const channels = await channelsAtRate(state.channels, sourceRate, rate);
          if (doc.state !== state || doc.sampleRate !== sourceRate) continue;
          s.updateSource(src.id, { channels, stateRef: state, name: doc.name });
          const fitted = S.fitClipsToSource(s.state, src.id, channels[0]?.length ?? 0);
          if (fitted !== s.state) s.apply('Fit Clips to Source', fitted);
          break;
        }
      }
    }
    app.syncGraph();
  };
  clearTimeout(pending.get(doc.id));
  const sameRate = sessions.every((s) => {
    for (const src of s.pool.values()) if (src.docId === doc.id && src.channelRate !== doc.sampleRate) return false;
    return true;
  });
  if (sameRate) run();
  else pending.set(doc.id, setTimeout(run, 300));
}
