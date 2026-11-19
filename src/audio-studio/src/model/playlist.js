// Playlists: an ordered list of a document's markers to play back to back.
// Each entry names a marker and how many times it plays. A range marker plays
// its range; a cue marker plays from the cue to the next marker (or the end).
// Entries whose marker was deleted stay in the list (undo can bring the marker
// back) but are skipped.
//
// PlaylistPlayer schedules the segments through app.play(): when the engine
// reports 'ended' at the end of a segment, the next one starts. Any other stop
// (Stop, Pause, playback started elsewhere, another file activated) ends the run.

import { Emitter } from '../lib/emitter.js';

let nextEntry = 1;

export function createEntry(markerId, loops = 1) {
  return { id: `pl${nextEntry++}`, markerId, loops: clampLoops(loops) };
}

export function clampLoops(n) {
  return Math.max(1, Math.min(99, Math.round(Number(n)) || 1));
}

/** [start, end) frames a marker plays, or null when it has no length. */
export function markerRange(marker, markers, length) {
  if (!marker) return null;
  if (marker.duration > 0) return [marker.start, marker.start + marker.duration];
  const next = markers.filter((m) => m.start > marker.start).reduce((min, m) => Math.min(min, m.start), Infinity);
  const end = Math.min(Number.isFinite(next) ? next : length, length);
  return end > marker.start ? [marker.start, end] : null;
}

/** Frames an entry plays (all its loops), or 0 when its marker is gone. */
export function entryFrames(entry, markers, length) {
  const r = markerRange(markers.find((m) => m.id === entry.markerId), markers, length);
  return r ? (r[1] - r[0]) * entry.loops : 0;
}

export function totalFrames(entries, markers, length) {
  return entries.reduce((sum, e) => sum + entryFrames(e, markers, length), 0);
}

/** Entries for markers not already listed (in marker order). */
export function addMarkers(entries, markerIds) {
  const listed = new Set(entries.map((e) => e.markerId));
  return [...entries, ...markerIds.filter((id) => !listed.has(id)).map((id) => createEntry(id))];
}

/** Entries for the markers in `markerIds` not listed yet, inserted before index `at` (dragged in). */
export function insertMarkersAt(entries, markerIds, at = entries.length) {
  const added = addMarkers(entries, markerIds).slice(entries.length);
  const i = Math.max(0, Math.min(entries.length, Math.round(at)));
  return [...entries.slice(0, i), ...added, ...entries.slice(i)];
}

/** The entries in `ids` moved, keeping their order, to before index `at` of the current list (dragged). */
export function moveEntriesTo(entries, ids, at) {
  const sel = new Set(ids);
  const moving = entries.filter((e) => sel.has(e.id));
  if (!moving.length) return entries;
  const before = entries.slice(0, Math.max(0, Math.min(entries.length, at))).filter((e) => !sel.has(e.id)).length;
  const rest = entries.filter((e) => !sel.has(e.id));
  return [...rest.slice(0, before), ...moving, ...rest.slice(before)];
}

/** Moves the entries in `ids` one step up (delta -1) or down (+1), keeping their order. */
export function moveEntries(entries, ids, delta) {
  const sel = new Set(ids);
  const list = entries.slice();
  const order = delta < 0 ? list.map((_, i) => i) : list.map((_, i) => list.length - 1 - i);
  for (const i of order) {
    const j = i + delta;
    if (!sel.has(list[i].id) || j < 0 || j >= list.length || sel.has(list[j].id)) continue;
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** The segments to play from entry `fromIndex` on: [{ entryId, start, end, pass }]. */
export function playQueue(entries, markers, length, fromIndex = 0) {
  const out = [];
  for (const e of entries.slice(Math.max(0, fromIndex))) {
    const r = markerRange(markers.find((m) => m.id === e.markerId), markers, length);
    if (!r) continue;
    for (let pass = 1; pass <= e.loops; pass++) out.push({ entryId: e.id, start: r[0], end: r[1], pass });
  }
  return out;
}

export class PlaylistPlayer extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.queue = [];
    this.index = -1;
    this.doc = null;
    this.running = false;
    this.advancing = false;
    app.engine.on('ended', (frame) => this.#onEnded(frame));
    app.on('transport', (s) => {
      if (!this.running || this.advancing) return;
      // Playback started by something else takes over.
      if (s === 'playing') this.stop();
      // Stop or Pause: wait for this tick's 'ended' handler before deciding.
      else setTimeout(() => this.running && !this.advancing && !app.engine.playing && this.stop(), 0);
    });
    app.on('active', (doc) => this.running && doc !== this.doc && this.stop());
  }

  /** The entry playing now (null when stopped). */
  get current() {
    return this.running ? this.queue[this.index] || null : null;
  }

  /** Plays `entries` of `doc` from entry index `from`. Returns false when there is nothing to play. */
  start(doc, entries, from = 0) {
    this.stop();
    const queue = playQueue(entries, doc.state.markers || [], doc.length, from);
    if (!queue.length) return false;
    if (this.app.engine.playing) this.app.stop();
    this.doc = doc;
    this.queue = queue;
    this.index = -1;
    this.running = true;
    this.#next();
    return true;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.advancing = false;
    this.endedEarly = false;
    this.queue = [];
    this.index = -1;
    if (this.app.engine.playing) this.app.stop();
    this.emit('change');
  }

  #onEnded(frame) {
    if (!this.running) return;
    if (this.advancing) {
      // A very short segment ended before play() resolved.
      this.endedEarly = true;
      return;
    }
    const seg = this.queue[this.index];
    const tolerance = (this.doc?.sampleRate || 48000) * 0.25;
    if (!seg || Math.abs(frame - seg.end) > tolerance) {
      this.stop();
      return;
    }
    this.#next();
  }

  async #next() {
    this.index++;
    const seg = this.queue[this.index];
    if (!seg || this.app.active !== this.doc) {
      this.running = false;
      this.queue = [];
      this.index = -1;
      this.emit('change');
      return;
    }
    this.advancing = true;
    this.endedEarly = false;
    this.emit('change');
    try {
      await this.app.play({ from: seg.start, to: seg.end, loop: false });
    } finally {
      this.advancing = false;
    }
    if (!this.running) return;
    if (this.endedEarly) this.#next();
    else if (!this.app.engine.playing) this.stop();
  }
}
