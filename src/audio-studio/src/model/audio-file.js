// An open audio file in the Waveform editor: undoable sample/marker state plus
// non-undoable view state (zoom, scroll, selection, playhead).

import { Emitter } from '../lib/emitter.js';
import { History } from '../lib/history.js';
import { Channel } from '../audio/channel.js';
import { lengthOf } from './edits.js';
import { markerOptions, markersOnlyChange } from './markers.js';

let nextId = 1;

export class AudioFile extends Emitter {
  /**
   * @param {object} o
   * @param {string} o.name file name shown in the Files panel and editor tab
   * @param {number} o.sampleRate
   * @param {Channel[]} o.channels
   * @param {object} [o.info] { bitDepth, format, size } from the source file
   * @param {object} [o.source] where it was opened from: { type: 'puter'|'local'|'new', path, handle }
   */
  constructor({ name, sampleRate, channels, markers = [], info = {}, source = { type: 'new' }, meta = {}, origin = null }) {
    super();
    this.id = `f${nextId++}`;
    this.kind = 'audio';
    this.name = name;
    this.info = { bitDepth: 32, format: 'wav', ...info };
    this.source = source;
    /** The session a mixdown or bounce was rendered from: { sessionId, name, path }. */
    this.origin = origin;
    this.history = new History({ sampleRate, channels, markers, meta });
    this.savedState = this.history.state;
    let shown = this.history.state;
    this.history.on('change', () => {
      // Undo or redo across a sample rate conversion keeps the view and playhead at the
      // same times; the conversion itself (an apply) sets them.
      const prev = shown;
      shown = this.state;
      if (!this.#applying && prev.sampleRate !== shown.sampleRate) this.#rescale(lengthOf(shown) / lengthOf(prev));
      this.#syncBitDepth();
      this.clampView();
      this.emit('change', { kind: 'history' });
    });
    const len = lengthOf(this.state);
    this.view = { start: 0, end: Math.max(len, sampleRate), amp: 1, freqZoom: 1 };
    this.selection = { start: 0, end: 0, channels: channels.map(() => true) };
    this.cursor = 0;
    /** Noise print captured from a noise-only selection, for Noise Reduction. */
    this.noisePrint = null;
    /** Model of a sound learned from an example of it, for Sound Remover. */
    this.soundModel = null;
  }

  static blank({ name = 'Untitled', sampleRate = 48000, channels = 2, seconds = 0 } = {}) {
    const frames = Math.round(seconds * sampleRate);
    return new AudioFile({
      name,
      sampleRate,
      channels: Array.from({ length: channels }, () => Channel.silence(frames)),
      info: { bitDepth: 32, format: 'wav' },
    });
  }

  get state() {
    return this.history.state;
  }

  get sampleRate() {
    return this.state.sampleRate;
  }

  get channelCount() {
    return this.state.channels.length;
  }

  get length() {
    return lengthOf(this.state);
  }

  get duration() {
    return this.length / this.sampleRate;
  }

  get dirty() {
    return this.state !== this.savedState;
  }

  get hasSelection() {
    return this.selection.end > this.selection.start;
  }

  /** The masked channel list for edits: null when every channel is selected. */
  get channelMask() {
    const m = this.selection.channels;
    return m.every(Boolean) ? null : m;
  }

  markSaved() {
    this.savedState = this.state;
    this.emit('change', { kind: 'saved' });
  }

  #applying = false;

  /** Scales the view, playhead and selection by `k` (frames at a new sample rate). */
  #rescale(k) {
    if (!(k > 0) || !Number.isFinite(k) || k === 1) return;
    this.view = { ...this.view, start: this.view.start * k, end: this.view.end * k };
    this.cursor = Math.round(this.cursor * k);
    this.selection = { ...this.selection, start: Math.round(this.selection.start * k), end: Math.round(this.selection.end * k) };
  }

  /** Commits a new state as one undo step. */
  apply(label, state, { selection, cursor } = {}) {
    if (state === this.state) return false;
    if (state.bitDepth !== undefined && this.state.bitDepth === undefined) this.baseBitDepth ??= this.info.bitDepth;
    this.#applying = true;
    try {
      if (!markerOptions.undo && markersOnlyChange(this.state, state)) this.history.outside(state, (s) => ({ ...s, markers: state.markers }));
      else this.history.push(label, state);
    } finally {
      this.#applying = false;
    }
    this.#syncBitDepth();
    if (selection) this.setSelection(selection.start, selection.end, { silent: true });
    if (cursor !== undefined) this.setCursor(cursor, { silent: true });
    this.clampView();
    this.emit('change', { kind: 'edit', label });
    return true;
  }

  /**
   * Convert Sample Type records the new bit depth in the state (state.bitDepth)
   * so undo and redo restore it; states without one use the depth the file had
   * before its first conversion.
   */
  #syncBitDepth() {
    if (this.state.bitDepth !== undefined) this.info.bitDepth = this.state.bitDepth;
    else if (this.baseBitDepth !== undefined) this.info.bitDepth = this.baseBitDepth;
  }

  rename(name) {
    this.name = name;
    this.emit('change', { kind: 'rename' });
  }

  setSelection(start, end, { channels, silent } = {}) {
    const len = this.length;
    let a = Math.max(0, Math.min(len, Math.round(Math.min(start, end))));
    let b = Math.max(0, Math.min(len, Math.round(Math.max(start, end))));
    this.selection = { start: a, end: b, channels: channels ?? this.selection.channels.slice(0, this.channelCount) };
    while (this.selection.channels.length < this.channelCount) this.selection.channels.push(true);
    if (!silent) this.emit('change', { kind: 'selection' });
  }

  setChannelEnabled(index, on) {
    const channels = this.selection.channels.slice();
    channels[index] = on;
    if (!channels.some(Boolean)) return;
    this.selection = { ...this.selection, channels };
    this.emit('change', { kind: 'selection' });
  }

  setCursor(frame, { silent } = {}) {
    this.cursor = Math.max(0, Math.min(this.length, Math.round(frame)));
    if (!silent) this.emit('change', { kind: 'cursor' });
  }

  /** View is [start, end) in frames; it may extend past the end of the file. */
  setView(start, end, { silent } = {}) {
    const min = 16;
    const len = Math.max(this.length, 1);
    let span = Math.max(min, end - start);
    span = Math.min(span, Math.max(len, this.sampleRate) * 1.0);
    start = Math.max(0, Math.min(start, Math.max(0, len - span)));
    this.view = { ...this.view, start, end: start + span };
    if (!silent) this.emit('change', { kind: 'view' });
  }

  setAmp(amp) {
    this.view = { ...this.view, amp: Math.max(0.05, Math.min(1000, amp)) };
    this.emit('change', { kind: 'view' });
  }

  clampView() {
    this.setView(this.view.start, this.view.end, { silent: true });
    this.setSelection(this.selection.start, this.selection.end, { silent: true });
    this.cursor = Math.min(this.cursor, this.length);
  }

  /** The time range edits apply to: the selection or, without one, the whole file. */
  editRange() {
    if (this.hasSelection) return [this.selection.start, this.selection.end];
    return [0, this.length];
  }
}
