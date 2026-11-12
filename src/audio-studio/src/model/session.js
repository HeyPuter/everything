// A multitrack session document. It implements the same interface as
// AudioFile (history, view, selection, cursor, apply, markSaved, rename and
// 'change' events) so shared panels and commands work with it, and adds clip
// and track selection, drag previews and a media pool.
//
// The media pool maps source ids to { id, name, channels (at the session
// rate), sampleRate (of the original file), docId (linked AudioFile, if
// open), path (Puter path when saved), offline }. It is not part of the undo
// state: sources only ever get added, and edits in the Waveform editor flow
// into the clips that use them.

import { Emitter } from '../lib/emitter.js';
import { History } from '../lib/history.js';
import { createSessionState, sessionLength, findClip, findTrack, expandGroups, uid, frontOrder, bringToFront, clipEnd } from './session-edits.js';
import { markerOptions, markersOnlyChange } from './markers.js';
import { videoEnd } from './session-video.js';

let nextId = 1;

export class Session extends Emitter {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {number} [o.sampleRate]
   * @param {object} [o.state] initial session state (see session-edits.js)
   * @param {object} [o.source] { type: 'puter'|'local'|'new', path }
   */
  constructor({ name = 'Untitled Session.asesx', sampleRate = 48000, bitDepth = 32, state, tracks, template, autoCrossfade, masterChannels, source = { type: 'new' } } = {}) {
    super();
    this.id = `s${nextId++}`;
    this.kind = 'session';
    this.name = name;
    this.source = source;
    this.info = { bitDepth, format: 'asesx' };
    this.pool = new Map();
    this.history = new History(state || createSessionState({ sampleRate, bitDepth, tracks, template, autoCrossfade, masterChannels }), { label: 'New Session' });
    this.savedState = this.history.state;
    this.history.on('change', () => {
      this.previewState = null;
      this.#pruneSelection();
      this.clampView();
      this.emit('change', { kind: 'history' });
    });
    this.view = { start: 0, end: Math.max(this.length, this.sampleRate * 30), amp: 1 };
    this.selection = { start: 0, end: 0, channels: [true, true], tracks: [] };
    this.cursor = 0;
    this.selectedClips = new Set();
    this.selectedTrack = this.state.tracks[0]?.id || null;
    this.selectedKeys = null; // { owner: clipId | trackId, param, indices: Set }
    this.previewState = null;
    this.coalesceKey = null;
    this.poolVersion = 0;
    /** While true, clicking a grouped clip selects (and moves) only that clip. */
    this.groupsSuspended = false;
    /** The clip the user last picked: the one Remove Focus Clip from Group acts on. */
    this.focusClipId = null;
  }

  get state() {
    return this.history.state;
  }

  /** State to draw: the drag preview while a gesture is in progress. */
  get viewState() {
    return this.previewState || this.history.state;
  }

  get sampleRate() {
    return this.state.sampleRate;
  }

  get channelCount() {
    return 2;
  }

  get length() {
    return sessionLength(this.state);
  }

  get duration() {
    return this.length / this.sampleRate;
  }

  /** Frames the timeline can show and place things at: the content (and video) plus room to grow. */
  get extent() {
    return Math.max(Math.max(this.length, videoEnd(this.state)) + this.sampleRate * 30, this.sampleRate * 60);
  }

  get dirty() {
    return this.state !== this.savedState;
  }

  get hasSelection() {
    return this.selection.end > this.selection.start;
  }

  get channelMask() {
    return null;
  }

  /** Marks `state` (by default the current one) as what the file holds. */
  markSaved(state = this.state) {
    this.savedState = state;
    this.emit('change', { kind: 'saved' });
  }

  /**
   * Commits a new state as one undo step. With `coalesce`, consecutive
   * applies with the same key (a knob drag) amend one step until endGesture().
   */
  apply(label, state, { selection, cursor, coalesce, clips } = {}) {
    const hadPreview = Boolean(this.previewState);
    this.previewState = null;
    if (state === this.state) {
      if (hadPreview) this.emit('change', { kind: 'preview' });
      return false;
    }
    if (!markerOptions.undo && markersOnlyChange(this.state, state)) this.history.outside(state, (s) => ({ ...s, markers: state.markers }));
    else if (coalesce && this.coalesceKey === coalesce && this.history.index > 0) this.history.amend(state);
    else this.history.push(label, state);
    this.coalesceKey = coalesce || null;
    if (clips) this.selectedClips = new Set(clips);
    if (selection) this.setSelection(selection.start, selection.end, { silent: true, tracks: selection.tracks });
    if (cursor !== undefined) this.setCursor(cursor, { silent: true });
    this.#pruneSelection();
    this.clampView();
    this.emit('change', { kind: 'edit', label });
    return true;
  }

  /**
   * Changes view settings stored in the state (track heights, visibility,
   * automation lanes, the metronome) without an undo step. `fn(state)` is
   * applied to every history entry, so undo and redo keep the change.
   */
  amendView(fn) {
    for (const e of this.history.entries) e.state = fn(e.state);
    this.history.amend(this.history.state);
  }

  /** Ends a coalesced gesture so the next change starts a new undo step. */
  endGesture() {
    this.coalesceKey = null;
  }

  /** Shows a state while dragging without recording it (null clears). */
  preview(state) {
    this.previewState = state && state !== this.state ? state : null;
    this.emit('change', { kind: 'preview' });
  }

  rename(name) {
    this.name = name;
    this.emit('change', { kind: 'rename' });
  }

  setSelection(start, end, { silent, tracks } = {}) {
    const ext = this.extent;
    const a = Math.max(0, Math.min(ext, Math.round(Math.min(start, end))));
    const b = Math.max(0, Math.min(ext, Math.round(Math.max(start, end))));
    this.selection = { start: a, end: b, channels: [true, true], tracks: tracks ?? this.selection.tracks ?? [] };
    if (!silent) this.emit('change', { kind: 'selection' });
  }

  setChannelEnabled() {}

  setCursor(frame, { silent } = {}) {
    this.cursor = Math.max(0, Math.min(this.extent, Math.round(frame)));
    if (!silent) this.emit('change', { kind: 'cursor' });
  }

  setView(start, end, { silent } = {}) {
    const ext = this.extent;
    let span = Math.max(16, end - start);
    span = Math.min(span, ext);
    start = Math.max(0, Math.min(start, ext - span));
    this.view = { ...this.view, start, end: start + span };
    if (!silent) this.emit('change', { kind: 'view' });
  }

  /** Vertical zoom: scales every track height. */
  setAmp(amp) {
    this.view = { ...this.view, amp: Math.max(0.3, Math.min(4, amp)) };
    this.emit('change', { kind: 'view' });
  }

  clampView() {
    this.setView(this.view.start, this.view.end, { silent: true });
    this.cursor = Math.min(this.cursor, this.extent);
  }

  /** The time range edits apply to: the time selection or the whole session. */
  editRange() {
    if (this.hasSelection) return [this.selection.start, this.selection.end];
    return [0, this.length];
  }

  /**
   * Brings clips in front of the clips they overlap without an undo step
   * (Preferences > Multitrack Clips > bring clips to front when selected).
   * Returns true when the order changed.
   */
  raiseClips(ids) {
    const st = this.state;
    const set = new Set(ids);
    const order = frontOrder(st);
    const covered = st.clips.some((c) => set.has(c.id) && st.clips.some((o) => !set.has(o.id) && o.trackId === c.trackId && o.start < clipEnd(c) && clipEnd(o) > c.start && order.get(o.id) > order.get(c.id)));
    if (!covered) return false;
    // Like a view setting: every step gets the new order, so selecting is neither an
    // undo step nor folded into the previous one, and a saved session stays saved.
    const raise = (s) => (s.clips.some((c) => set.has(c.id)) ? bringToFront(s, [...set]) : s);
    for (const e of this.history.entries) {
      const next = raise(e.state);
      if (e.state === this.savedState) this.savedState = next;
      e.state = next;
    }
    this.history.amend(this.history.state);
    return true;
  }

  // -------------------------------------------------------- clip selection

  /** Selects clips (expanding to whole groups). `mode`: 'set' | 'add' | 'toggle'. */
  selectClips(ids, mode = 'set') {
    const expanded = this.groupsSuspended ? [...new Set(ids)] : expandGroups(this.state, ids);
    if (ids.length) this.focusClipId = ids[0];
    let next;
    if (mode === 'add') next = new Set([...this.selectedClips, ...expanded]);
    else if (mode === 'toggle') {
      next = new Set(this.selectedClips);
      const allIn = expanded.every((id) => next.has(id));
      for (const id of expanded) allIn ? next.delete(id) : next.add(id);
    } else next = new Set(expanded);
    this.selectedClips = next;
    const first = findClip(this.state, expanded[0]);
    if (first) this.selectedTrack = first.trackId;
    this.selectedKeys = null;
    this.emit('change', { kind: 'clip-selection' });
  }

  selectTrack(id) {
    if (!findTrack(this.state, id) || this.selectedTrack === id) return;
    this.selectedTrack = id;
    this.emit('change', { kind: 'clip-selection' });
  }

  /** Selected clips that still exist, in timeline order (a new array each time). */
  get clipSelection() {
    // Menus ask for it once per command: sort once per clip list and selection.
    const c = this.#selectionCache;
    const set = this.selectedClips;
    if (c && c.clips === this.state.clips && c.set === set && c.size === set.size) return c.list.slice();
    const list = this.state.clips.filter((x) => set.has(x.id)).sort((a, b) => a.start - b.start);
    this.#selectionCache = { clips: this.state.clips, set, size: set.size, list };
    return list.slice();
  }

  #selectionCache = null;

  #pruneSelection() {
    const ids = new Set(this.state.clips.map((c) => c.id));
    for (const id of [...this.selectedClips]) if (!ids.has(id)) this.selectedClips.delete(id);
    if (this.selectedTrack && !findTrack(this.state, this.selectedTrack)) this.selectedTrack = this.state.tracks[0]?.id || null;
  }

  // ---------------------------------------------------------------- pool

  /** Adds media to the pool; returns the source id. */
  addSource({ id = uid('src'), name, channels, sampleRate = this.sampleRate, docId = null, path = null, offline = false }) {
    this.pool.set(id, { id, name, channels, sampleRate, docId, path, offline });
    this.poolVersion++;
    return id;
  }

  /** Replaces a source's channels (e.g. after it was edited in the Waveform editor). */
  updateSource(id, patch) {
    const src = this.pool.get(id);
    if (!src) return;
    this.pool.set(id, { ...src, ...patch });
    this.poolVersion++;
    this.emit('change', { kind: 'graph' });
  }

  sourceLength(id) {
    const src = this.pool.get(id);
    return src?.channels?.[0]?.length ?? 0;
  }

  /** Source ids referenced by any clip in any history step (what a save must keep). */
  usedSources() {
    const used = new Set();
    for (const e of this.history.entries) {
      for (const c of e.state.clips) {
        used.add(c.sourceId);
        const orig = c.soundAssistant?.duration?.orig?.sourceId;
        if (orig) used.add(orig);
        if (c.stretch?.sourceId) used.add(c.stretch.sourceId);
        if (c.remix?.sourceId) used.add(c.remix.sourceId);
      }
    }
    return used;
  }
}
