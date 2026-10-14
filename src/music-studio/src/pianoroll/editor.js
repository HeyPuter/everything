// The piano roll editor: edits the notes of the selected channel
// (store.view.channel) in the selected pattern (store.view.pattern).
//
// Owns the view state (time viewport, key height, vertical scroll, tool,
// selection, hover), draws through render.js when something changed or the
// playhead moved, and implements the keyboard model and the panel actions.
// Pointer gestures live in pointer.js, the header toolbar in toolbar.js and
// the tool dialogs in dialogs.js.
//
// Keyboard (surface focused): arrows move the cursor, or the selected notes
// (Left/Right by the grid, Up/Down a semitone, Shift+Up/Down an octave,
// Shift+Left/Right change length, Alt+Up/Down velocity); Enter adds a note at
// the cursor (or edits the selected note); Tab / Shift+Tab select notes in
// time order; Page Up/Down scroll; Shift+F10 opens the options menu.

import { h, announce } from '../lib/dom.js';
import { clamp, keyName, uid } from '../lib/util.js';
import { createGfx } from '../render/gfx.js';
import { Viewport } from '../render/timeline.js';
import * as E from '../model/edits.js';
import { patternLength, patternById, channelById, DEFAULT_KEY } from '../model/project.js';
import { snapTicks, snapFloor, snapRound, gridTicks, ticksPerBar, STEP, formatBST } from '../model/time.js';
import { computeLayout, keyAtY, rowY, maxScrollY, centerScrollY, describeNote, describePos, describeLen, MIN_KEY_H, MAX_KEY_H, NUM_KEYS } from './geometry.js';
import * as N from './notes.js';
import { scaleMask, chordKeys } from './scales.js';
import { shared, sharedEvents } from './state.js';
import { drawPianoRoll } from './render.js';
import { installPointer } from './pointer.js';
import { patternTick, clipAt } from '../input/recorder.js';
import { isContextKey } from '../ui/menu.js';
import { cssVar } from '../ui/theme.js';
import { openNoteProps, closeNoteProps } from './dialogs.js';

export const PR_DEFAULTS = { ghosts: true, lane: true, laneH: 76, laneType: 'vel', scaleRoot: 0, scale: null, keyH: 0 };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class PianoRollEditor {
  constructor(app, host) {
    this.app = app;
    this.store = app.store;
    this.host = host;
    this.visible = false;
    this.dirty = true;
    this.selected = new Set();
    this.hover = null;
    this.gesture = null;
    this.overlay = { phantom: null, marquee: null, slice: null, zoom: null };
    this.pressed = new Set();
    this.cursor = shared.cursor;
    this.focused = false;
    this.showCursor = false;
    this.playhead = null;
    this.lastPlayheadPx = NaN;
    this.fitted = false;
    this.lastView = { pattern: null, channel: null };
    this.auditioning = [];
    this.coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const pr = this.prefs;
    this.keyH = pr.keyH || (this.coarse ? 18 : 14);
    this.scrollY = 0;
    this.vp = new Viewport({ pxPerTick: 0.5, minPx: 0.02, maxPx: 12 });

    this.helpId = 'pr-help';
    this.surface = h('div.pr-surface', {
      tabindex: '0',
      role: 'application',
      'aria-roledescription': 'piano roll',
      'aria-label': 'Piano roll',
      'aria-describedby': this.helpId,
    });
    this.help = h(
      'p.sr-only',
      { id: this.helpId },
      'Arrow keys move the cursor, or the selected notes: Left and Right by the grid, Up and Down by a semitone, Shift with Up or Down by an octave, Shift with Left or Right changes length, Alt with Up or Down changes velocity. Enter adds a note at the cursor or edits the selected note. Tab and Shift+Tab select the next or previous note. Delete removes the selection. Shift+F10 opens the piano roll menu.',
    );
    this.emptyEl = h('div.empty-state.pr-empty', { hidden: true });
    this.root = h('div.pr', this.surface, this.help, this.emptyEl);
    host.body.append(this.root);
    this.gfx = createGfx(this.surface);
    this.L = computeLayout({ w: 1, h: 1 });

    installPointer(this);
    this.surface.addEventListener('keydown', (e) => this.onKey(e));
    this.surface.addEventListener('focus', () => {
      this.focused = true;
      this.dirty = true;
    });
    this.surface.addEventListener('blur', () => {
      this.focused = false;
      this.showCursor = false;
      this.dirty = true;
    });

    const store = this.store;
    store.on('change', (p, prev, meta) => {
      if (meta?.source === 'load') {
        this.selected.clear();
        this.fitted = false;
      }
      this.dirty = true;
      this.syncEmpty();
      this.toolbar?.sync();
    });
    store.on('view', () => this.onViewChange());
    app.prefs.on('change', (k) => {
      if (k === 'snap' || k === 'pianoRoll' || k === 'theme') {
        this.dirty = true;
        this.toolbar?.sync();
      }
    });
    app.engine.on('state', () => {
      this.dirty = true;
    });
    app.on('frame', () => this.frame());
    app.on('layout', () => {
      this.dirty = true;
    });
    window.addEventListener('themechange', () => {
      this.dirty = true;
    });
    app.liveInput?.on('note', (key, on) => {
      if (on) this.pressed.add(key);
      else if (!this.auditioning.includes(key)) this.pressed.delete(key);
      this.dirty = true;
    });
    sharedEvents.on('cursor', () => {
      this.revealTick(this.cursor.tick);
      this.dirty = true;
      announce(`Cursor at ${describePos(this.cursor.tick, this.sig)}`);
    });
    this.syncEmpty();
  }

  // ---------------------------------------------------------------- data

  get prefs() {
    return { ...PR_DEFAULTS, ...(this.app.prefs.get('pianoRoll') || {}) };
  }

  setPref(changes) {
    this.app.prefs.merge('pianoRoll', { ...PR_DEFAULTS, ...(this.app.prefs.get('pianoRoll') || {}), ...changes });
  }

  get project() {
    return this.store.project;
  }

  get sig() {
    return this.store.project.sig;
  }

  get pattern() {
    return patternById(this.project, this.store.view.pattern) || this.project.patterns[0] || null;
  }

  get channel() {
    return channelById(this.project, this.store.view.channel) || null;
  }

  get notes() {
    const pat = this.pattern;
    const ch = this.channel;
    return (pat && ch && pat.notes[ch.id]) || [];
  }

  get channelColor() {
    return this.channel?.color || '#888888';
  }

  get patLen() {
    const pat = this.pattern;
    return pat ? patternLength(pat, this.sig) : ticksPerBar(this.sig);
  }

  /** Other channels' notes in this pattern, for ghost notes. */
  get ghosts() {
    if (!this.prefs.ghosts) return [];
    const pat = this.pattern;
    const ch = this.channel;
    if (!pat) return [];
    const out = [];
    for (const c of this.project.channels) {
      if (c.id === ch?.id) continue;
      const list = pat.notes[c.id];
      if (list?.length) out.push({ color: c.color, notes: list });
    }
    return out;
  }

  get snapId() {
    return this.app.prefs.get('snap')?.pianoRoll || 'line';
  }

  /** Snap in ticks for the current zoom (0 = free). */
  get gridTicks() {
    // "Line" follows the drawn grid, kept at least 18px apart so it never gets finicky.
    if (this.snapId === 'line') return gridTicks(this.vp.pxPerTick, this.sig, 18);
    return snapTicks(this.snapId, this.vp.pxPerTick, this.sig);
  }

  /** The snap, or 0 while Alt is held (free placement). */
  gridFor(e) {
    return e?.altKey ? 0 : this.gridTicks;
  }

  /** Spacing of the vertical grid lines: the snap when it is wide enough, else the zoom grid. */
  get lineTicks() {
    const g = this.gridTicks;
    const px = this.vp.pxPerTick;
    if (g > 0 && g * px >= 6) return g;
    return gridTicks(px, this.sig, 8);
  }

  get scaleMask() {
    const p = this.prefs;
    return p.scale ? scaleMask(p.scaleRoot, p.scale) : null;
  }

  get scaleRoot() {
    return this.prefs.scaleRoot;
  }

  get laneType() {
    return this.prefs.laneType;
  }

  /** Selected note ids that still exist. */
  selIds() {
    const notes = this.notes;
    if (!this.selected.size) return [];
    const out = [];
    for (const n of notes) if (this.selected.has(n.id)) out.push(n.id);
    if (out.length !== this.selected.size) this.selected = new Set(out);
    return out;
  }

  /** The selected ids, or null (every note) when nothing is selected. */
  targetIds() {
    const ids = this.selIds();
    return ids.length ? new Set(ids) : null;
  }

  noteById(id) {
    return this.notes.find((n) => n.id === id) || null;
  }

  // ---------------------------------------------------------------- edits

  /** One undo step replacing the edited channel's notes with fn(notes). */
  applyNotes(label, fn) {
    const pat = this.pattern;
    const ch = this.channel;
    if (!pat || !ch) return null;
    let extra = null;
    this.store.apply(label, (p) => {
      const out = fn(E.getNotes(p, pat.id, ch.id));
      const list = Array.isArray(out) ? out : out.notes;
      extra = Array.isArray(out) ? null : out;
      return this.fitLength(E.setNotes(p, pat.id, ch.id, list), pat.id);
    });
    return extra;
  }

  /** Grows an explicit pattern length to cover notes written past its end (else they would never play). */
  fitLength(p, patternId) {
    const len = N.lengthToFit(patternById(p, patternId), p.sig);
    return len ? E.updatePattern(p, patternId, { length: len }) : p;
  }

  /** Gesture preview from the gesture's start state. */
  previewNotes(fn) {
    const pat = this.pattern;
    const ch = this.channel;
    if (!pat || !ch) return;
    this.store.preview((base) => {
      const list = fn(E.getNotes(base, pat.id, ch.id));
      return this.fitLength(E.setNotes(base, pat.id, ch.id, list), pat.id);
    });
  }

  /** Notes at the start of the running gesture (for hit tests while previews change the list). */
  startNotes() {
    const pat = this.pattern;
    const ch = this.channel;
    const base = this.store.gesture?.start || this.project;
    return pat && ch ? E.getNotes(base, pat.id, ch.id) : [];
  }

  // ---------------------------------------------------------------- selection

  select(ids, { announceIt = false } = {}) {
    this.selected = new Set(ids);
    this.dirty = true;
    this.toolbar?.sync();
    if (announceIt) announce(this.selected.size ? `${plural(this.selected.size, 'note')} selected` : 'Selection cleared');
  }

  selectOnly(id) {
    this.select(id ? [id] : []);
  }

  // ---------------------------------------------------------------- audition

  async audition(keys, vel = 0.8, { hold = true } = {}) {
    this.stopAudition();
    const ch = this.channel;
    if (!ch) return;
    const list = Array.isArray(keys) ? keys : [keys];
    this.auditioning = list.slice();
    for (const k of list) this.pressed.add(k);
    this.dirty = true;
    const engine = this.app.engine;
    try {
      await engine.start();
    } catch (err) {
      this.app.reportError?.(err);
      return;
    }
    if (this.auditioning !== list && !this.auditioning.every((k, i) => k === list[i])) return;
    for (const k of list) engine.noteOn(ch.id, k, vel);
    this.auditionChannel = ch.id;
    if (!hold) {
      clearTimeout(this.auditionTimer);
      this.auditionTimer = setTimeout(() => this.stopAudition(), 220);
    }
  }

  stopAudition() {
    clearTimeout(this.auditionTimer);
    const engine = this.app.engine;
    const ch = this.auditionChannel || this.channel?.id;
    for (const k of this.auditioning) {
      if (ch) engine.noteOff(ch, k);
      if (!this.app.liveInput?.isHeld(k)) this.pressed.delete(k);
    }
    if (this.auditioning.length) this.dirty = true;
    this.auditioning = [];
  }

  // ---------------------------------------------------------------- view

  onViewChange() {
    const v = this.store.view;
    if (v.pattern !== this.lastView.pattern || v.channel !== this.lastView.channel) {
      const channelChanged = v.channel !== this.lastView.channel;
      this.lastView = { pattern: v.pattern, channel: v.channel };
      this.selected.clear();
      this.cancelGesture();
      if (this.fitted && channelChanged) this.revealNotes();
      this.updateLabel();
    }
    this.dirty = true;
    this.syncEmpty();
    this.toolbar?.sync();
  }

  updateLabel() {
    const ch = this.channel;
    const pat = this.pattern;
    this.surface.setAttribute('aria-label', ch ? `Piano roll: ${ch.name} in ${pat?.name || 'pattern'}` : 'Piano roll');
  }

  syncEmpty() {
    const hasChannels = this.project.channels.length > 0;
    const hasPattern = Boolean(this.pattern);
    const empty = !hasChannels || !hasPattern;
    if (empty === !this.emptyEl.hidden && this.emptyKind === (hasChannels ? 'pattern' : 'channels')) return;
    this.emptyKind = hasChannels ? 'pattern' : 'channels';
    this.emptyEl.hidden = !empty;
    this.surface.hidden = empty;
    if (!empty) {
      this.dirty = true;
      return;
    }
    const app = this.app;
    if (!hasChannels) {
      this.emptyEl.replaceChildren(
        h('h3', 'No instruments yet'),
        h('p', 'The piano roll edits the notes of a channel. Add an instrument to start writing.'),
        h('button.btn.primary', { type: 'button', onclick: () => app.addChannel({ type: 'synth', name: 'Poly Synth' }) }, 'Add a synth'),
      );
    } else {
      this.emptyEl.replaceChildren(
        h('h3', 'No pattern selected'),
        h('button.btn.primary', { type: 'button', onclick: () => app.commands.run('patterns.new') }, 'New pattern'),
      );
    }
  }

  resize() {
    const r = this.surface.getBoundingClientRect();
    const pr = this.prefs;
    this.L = computeLayout({ w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)), phone: this.app.root.classList.contains('is-phone'), coarse: this.coarse, lane: pr.lane, laneH: this.laneHLive ?? pr.laneH });
    this.vp.width = this.L.gridW;
    this.rect = r;
    this.clampScroll();
  }

  clampScroll() {
    this.keyH = clamp(this.keyH, MIN_KEY_H, MAX_KEY_H);
    this.scrollY = clamp(this.scrollY, 0, maxScrollY(this.L, this.keyH));
    if (this.vp.scroll < 0) this.vp.scroll = 0;
  }

  /** First sizing: zoom to the pattern (up to 8 bars) and center the notes (or C5) vertically. */
  fitView() {
    this.resize();
    if (this.L.gridW < 40 || this.L.gridH < 20) return;
    const bar = ticksPerBar(this.sig);
    const span = Math.min(Math.max(this.patLen, bar), bar * 8);
    this.vp.fit(0, span);
    this.revealNotes(true);
    this.fitted = true;
    this.lastView = { pattern: this.store.view.pattern, channel: this.store.view.channel };
    this.updateLabel();
  }

  /** Centers the notes vertically when they are out of view (always with force). */
  revealNotes(force = false) {
    const s = N.span(this.notes);
    const mid = s ? Math.round((s.lo + s.hi) / 2) : this.channel?.root ?? DEFAULT_KEY;
    const top = keyAtY(this.L, this.L.gridY, this.keyH, this.scrollY);
    const bottom = keyAtY(this.L, this.L.gridY + this.L.gridH - 1, this.keyH, this.scrollY);
    if (force || !s || s.hi > top || s.lo < bottom) this.scrollY = centerScrollY(this.L, mid, this.keyH);
    if (s && (force || s.start > this.vp.end || s.end < this.vp.scroll)) this.vp.scrollTo(snapFloor(s.start, ticksPerBar(this.sig)));
    if (!this.cursor || this.cursor.tick > this.patLen) this.cursor.tick = 0;
    this.cursor.key = s ? s.lo : mid;
    this.dirty = true;
  }

  revealTick(tick) {
    const span = this.L.gridW / this.vp.pxPerTick;
    if (tick < this.vp.scroll || tick > this.vp.scroll + span * 0.92) this.vp.scrollTo(Math.max(0, tick - span * 0.1));
  }

  revealKey(key) {
    const y = rowY(this.L, key, this.keyH, this.scrollY);
    if (y < this.L.gridY) this.scrollY -= this.L.gridY - y + this.keyH;
    else if (y + this.keyH > this.L.gridY + this.L.gridH) this.scrollY += y + this.keyH - (this.L.gridY + this.L.gridH) + this.keyH;
    this.clampScroll();
  }

  zoomTime(factor, px = this.L.gridW / 2) {
    this.vp.zoomAt(factor, px);
    this.dirty = true;
    this.toolbar?.sync();
  }

  /** Changes key height keeping the key under y in place. */
  zoomKeys(factor, y = this.L.gridY + this.L.gridH / 2) {
    const anchor = (y - this.L.gridY + this.scrollY) / this.keyH;
    this.keyH = clamp(Math.round(this.keyH * factor * 10) / 10, MIN_KEY_H, MAX_KEY_H);
    this.scrollY = anchor * this.keyH - (y - this.L.gridY);
    this.clampScroll();
    this.dirty = true;
    clearTimeout(this.keyHSave);
    this.keyHSave = setTimeout(() => this.setPref({ keyH: this.keyH }), 400);
  }

  zoomToFit() {
    const s = N.span(this.notes);
    const bar = ticksPerBar(this.sig);
    const end = Math.max(this.patLen, s ? s.end : 0);
    this.vp.fit(0, Math.max(bar, end));
    if (s) {
      const rows = s.hi - s.lo + 3;
      this.keyH = clamp(Math.floor(this.L.gridH / rows), MIN_KEY_H, 24);
      this.scrollY = centerScrollY(this.L, (s.lo + s.hi) / 2, this.keyH);
    }
    this.clampScroll();
    this.dirty = true;
  }

  /** Thumb positions for the scrollbars, in px within their tracks. */
  scrollMetrics() {
    const L = this.L;
    const visible = L.gridW / this.vp.pxPerTick;
    const s = N.span(this.notes);
    const total = Math.max(this.patLen + ticksPerBar(this.sig), s ? s.end + ticksPerBar(this.sig) : 0, this.vp.scroll + visible);
    const hw = Math.max(24, Math.min(L.gridW, (visible / total) * L.gridW));
    const hx = (this.vp.scroll / Math.max(1, total - visible)) * (L.gridW - hw) || 0;
    const vTotal = NUM_KEYS * this.keyH;
    const vh = Math.max(24, Math.min(L.gridH, (L.gridH / vTotal) * L.gridH));
    const maxY = maxScrollY(L, this.keyH);
    const vy = maxY ? (this.scrollY / maxY) * (L.gridH - vh) : 0;
    return { total, visible, hx: clamp(hx, 0, L.gridW - hw), hw, vy, vh, maxY };
  }

  // ---------------------------------------------------------------- frame

  computePlayhead() {
    const e = this.app.engine;
    const pat = this.pattern;
    if (!pat) return null;
    if (e.mode === 'pattern') return e.position;
    const clip = clipAt(e.position, pat.id, this.project.clips);
    if (!clip) return null;
    return patternTick(e.position, { mode: 'song', patternId: pat.id, patLen: this.patLen, clips: [clip] });
  }

  frame() {
    if (!this.visible || this.surface.hidden) return;
    const ph = this.computePlayhead();
    const e = this.app.engine;
    if (ph !== null && e.playing && this.app.prefs.get('autoScroll') && !this.gesture) {
      const before = this.vp.scroll;
      this.vp.reveal(ph, 0.02);
      if (this.vp.scroll !== before) this.dirty = true;
    }
    const px = ph === null ? NaN : Math.round(this.vp.x(ph));
    if (px !== this.lastPlayheadPx && !(Number.isNaN(px) && Number.isNaN(this.lastPlayheadPx))) this.dirty = true;
    this.playhead = ph;
    if (!this.dirty) return;
    this.draw();
  }

  /** Draws now (also callable directly when rAF does not run). */
  draw() {
    this.dirty = false;
    if (!this.fitted) this.fitView();
    else this.resize();
    if (this.playhead === null || this.playhead === undefined) this.playhead = this.computePlayhead();
    this.lastPlayheadPx = this.playhead === null ? NaN : Math.round(this.vp.x(this.playhead));
    shared.grid = this.gridTicks;
    this.gfx.frame((d) => {
      drawPianoRoll(this, d);
      if (!this.notes.length && this.channel && !this.gesture) {
        const L = this.L;
        const drawing = this.app.tools.pianoRoll === 'draw' || this.app.tools.pianoRoll === 'paint';
        // Narrow views (phones) get the short form instead of a clipped sentence (about 6.5 px per character).
        const roomy = L.gridW - 20 >= 66 * 6.5;
        const hint = drawing ? (roomy ? 'Click to add notes. Drag to set their length; right-click deletes.' : 'Tap or click to add notes') : roomy ? 'No notes in this pattern yet. Press P for the draw tool.' : 'No notes yet. Pick the draw tool.';
        d.text(hint, L.gridX + L.gridW / 2, L.gridY + 18, this.emptyHintColor(), { align: 'center', maxWidth: L.gridW - 20 });
      }
    });
  }

  emptyHintColor() {
    return cssVar('--muted') || '#888';
  }

  // ---------------------------------------------------------------- tools

  setTool(id) {
    this.app.tools.pianoRoll = id;
    this.overlay.phantom = null;
    this.overlay.slice = null;
    this.dirty = true;
    this.toolbar?.sync();
    this.updateCursorStyle();
  }

  get tool() {
    return this.app.tools.pianoRoll || 'draw';
  }

  updateCursorStyle(kind) {
    const cur = kind || { draw: 'crosshair', paint: 'crosshair', delete: 'not-allowed', slice: 'col-resize', select: 'default', zoom: 'zoom-in', audition: 'pointer' }[this.tool] || 'default';
    if (this.surface.style.cursor !== cur) this.surface.style.cursor = cur;
  }

  /** Length and velocity for new notes: the last ones used, else the preference defaults. */
  get lastNote() {
    if (!shared.last) {
      const d = this.app.prefs.get('noteDefaults') || { len: STEP, vel: 0.78 };
      shared.last = { len: d.len || STEP, vel: d.vel ?? 0.78 };
    }
    return shared.last;
  }

  remember(note) {
    if (note) shared.last = { len: note.len, vel: note.vel };
  }

  // ---------------------------------------------------------------- note operations

  /** Adds a note (or the chord stamp) at the keyboard cursor. */
  addAtCursor() {
    const ch = this.channel;
    if (!ch) return;
    const grid = this.gridTicks || STEP;
    const len = grid;
    const key = this.cursor.key;
    const keys = this.stampKeys(key);
    const notes = keys.map((k) => ({ key: k, pos: Math.round(this.cursor.tick), len, vel: this.lastNote.vel, pan: 0 }));
    const r = this.applyNotes(keys.length > 1 ? 'Add chord' : 'Add note', (list) => {
      const made = notes.map((n) => ({ ...n, id: uid(6) }));
      return { notes: [...list, ...made], ids: made.map((n) => n.id) };
    });
    this.audition(keys, this.lastNote.vel, { hold: false });
    announce(keys.length > 1 ? `Chord added at ${describePos(this.cursor.tick, this.sig)}` : `${describeNote(notes[0], this.sig).replace(' at ', ' added at ')}`);
    return r;
  }

  stampKeys(key) {
    return shared.stamp ? this.chordKeysFor(key, shared.stamp) : [key];
  }

  chordKeysFor(key, stamp) {
    const p = this.prefs;
    return chordKeys(key, stamp.chord, { inversion: stamp.inversion || 0, scaleRoot: p.scaleRoot, scaleId: p.scale });
  }

  moveSelection(dPos, dKey, label) {
    const ids = this.targetIds();
    if (!ids) return;
    const before = this.notes;
    const c = N.clampMove(before, ids, dPos, dKey);
    if (!c.dPos && !c.dKey) {
      announce(dKey ? 'Notes are at the edge of the keyboard' : 'Notes are at the start');
      return;
    }
    this.applyNotes(label || 'Move notes', (list) => N.moveNotes(list, ids, c.dPos, c.dKey));
    const first = this.notes.find((n) => ids.has(n.id));
    if (first && c.dKey) this.audition(first.key, first.vel, { hold: false });
    if (first) {
      this.revealTick(first.pos);
      this.revealKey(first.key);
    }
    const count = ids.size;
    const what = count === 1 && first ? keyName(first.key) : plural(count, 'note');
    if (c.dKey === 12 || c.dKey === -12) announce(`${what} moved ${c.dKey > 0 ? 'up' : 'down'} an octave`);
    else if (c.dKey) announce(`${what} moved ${c.dKey > 0 ? 'up' : 'down'}${count === 1 ? '' : ` ${plural(Math.abs(c.dKey), 'semitone')}`}`);
    else announce(`${what} moved to ${describePos(first?.pos ?? 0, this.sig)}`);
  }

  resizeSelection(dLen) {
    const ids = this.targetIds();
    if (!ids) return;
    const grid = this.gridTicks || STEP;
    this.applyNotes('Change note length', (list) => N.resizeNotes(list, ids, dLen, grid));
    const first = this.notes.find((n) => ids.has(n.id));
    if (first) {
      this.remember(first);
      announce(`${ids.size === 1 ? keyName(first.key) : plural(ids.size, 'note')} ${describeLen(first.len, this.sig)}`);
    }
  }

  changeVelocity(delta) {
    const ids = this.targetIds();
    if (!ids) return;
    this.applyNotes('Change velocity', (list) => list.map((n) => (ids.has(n.id) ? { ...n, vel: clamp(Math.round((n.vel + delta) * 100) / 100, 0.01, 1) } : n)));
    const first = this.notes.find((n) => ids.has(n.id));
    if (first) {
      this.remember(first);
      announce(`Velocity ${Math.round(first.vel * 100)}%`);
    }
  }

  deleteSelection() {
    const ids = this.selIds();
    if (!ids.length) return false;
    this.applyNotes(ids.length === 1 ? 'Delete note' : 'Delete notes', (list) => list.filter((n) => !this.selected.has(n.id)));
    this.select([]);
    announce(`${plural(ids.length, 'note')} deleted`);
    return true;
  }

  copy() {
    const ids = this.selIds();
    if (!ids.length) {
      this.app.notify('Select notes to copy');
      return false;
    }
    shared.clipboard = N.copyNotes(this.notes, ids, this.gridTicks);
    announce(`${plural(ids.length, 'note')} copied`);
    return true;
  }

  cut() {
    if (!this.copy()) return;
    const ids = this.selIds();
    this.applyNotes('Cut notes', (list) => list.filter((n) => !this.selected.has(n.id)));
    this.select([]);
    announce(`${plural(ids.length, 'note')} cut`);
  }

  /** Pastes at the playhead when it is in view, else at the start of the view (on the grid). */
  paste() {
    const clip = shared.clipboard;
    if (!clip || !this.channel) {
      this.app.notify('Nothing to paste. Copy notes in the piano roll first.');
      return;
    }
    const grid = this.gridTicks;
    const ph = this.computePlayhead();
    const view0 = this.vp.scroll;
    const view1 = this.vp.end;
    let at;
    if (ph !== null && ph >= view0 && ph < view1 && (this.app.engine.playing || ph > 0)) at = grid ? snapFloor(ph, grid) : Math.round(ph);
    else at = grid ? Math.ceil(view0 / grid) * grid : Math.round(view0);
    at = N.pasteTarget(this.notes, clip, at, grid);
    const made = N.pasteNotes(clip, at);
    this.applyNotes('Paste notes', (list) => [...list, ...made]);
    this.select(made.map((n) => n.id));
    announce(`${plural(made.length, 'note')} pasted at ${describePos(at, this.sig)}`);
  }

  duplicate() {
    const ids = this.selIds();
    if (!ids.length) {
      this.app.notify('Select notes to duplicate');
      return;
    }
    const r = this.applyNotes('Duplicate notes', (list) => N.duplicateAfter(list, ids, this.gridTicks));
    if (r?.ids) {
      this.select(r.ids);
      const first = this.notes.find((n) => r.ids.includes(n.id));
      if (first) this.revealTick(first.pos);
      announce(`${plural(r.ids.length, 'note')} duplicated`);
    }
  }

  selectAll() {
    this.select(this.notes.map((n) => n.id), { announceIt: true });
  }

  cancelGesture() {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = null;
    g.cancel?.();
    this.overlay.marquee = null;
    this.overlay.zoom = null;
    this.overlay.slice = null;
    this.dirty = true;
    return true;
  }

  deselect() {
    if (this.cancelGesture()) return;
    if (closeNoteProps()) return;
    if (this.selected.size) this.select([], { announceIt: true });
  }

  /** Runs a pure note tool on the selection (or every note) as one undo step. */
  runTool(label, fn, message) {
    const ids = this.targetIds();
    if (!this.notes.length) {
      this.app.notify('There are no notes to change');
      return;
    }
    this.applyNotes(label, (list) => fn(list, ids));
    const count = ids ? ids.size : this.notes.length;
    announce(message || `${label}: ${plural(count, 'note')}`);
  }

  // ---------------------------------------------------------------- keyboard

  onKey(e) {
    if (e.defaultPrevented) return;
    const key = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (isContextKey(e)) {
      e.preventDefault();
      this.toolbar?.openMore({ x: this.rect?.left + this.L.gridX + 20 || 40, y: this.rect?.top + this.L.gridY + 20 || 40 });
      return;
    }
    const hasSel = this.selIds().length > 0;
    const grid = this.gridTicks || STEP;
    let handled = true;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (mod) return;
      const dir = key === 'ArrowLeft' ? -1 : 1;
      if (hasSel) {
        if (e.shiftKey) this.resizeSelection(dir * grid);
        else this.moveSelection(dir * grid, 0);
      } else {
        this.showCursor = true;
        const t = this.cursor.tick + dir * grid;
        this.cursor.tick = Math.max(0, snapRound(t, grid));
        this.revealTick(this.cursor.tick);
        this.announceCursor();
      }
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      if (mod) return;
      const dir = key === 'ArrowUp' ? 1 : -1;
      if (hasSel) {
        if (e.altKey) this.changeVelocity(dir * 0.05);
        else this.moveSelection(0, dir * (e.shiftKey ? 12 : 1));
      } else {
        this.showCursor = true;
        this.cursor.key = clamp(this.cursor.key + dir * (e.shiftKey ? 12 : 1), 0, 127);
        this.revealKey(this.cursor.key);
        this.audition(this.stampKeys(this.cursor.key), this.lastNote.vel, { hold: false });
        this.announceCursor();
      }
    } else if (key === 'Enter' && !mod) {
      const ids = this.selIds();
      if (ids.length === 1) openNoteProps(this, this.noteById(ids[0]));
      else {
        this.showCursor = true;
        this.addAtCursor();
      }
    } else if (key === 'Tab' && !mod && !e.altKey) {
      const notes = this.notes;
      const ids = this.selIds();
      const current = ids.length ? ids[e.shiftKey ? 0 : ids.length - 1] : null;
      const next = N.stepNote(notes, current, e.shiftKey ? -1 : 1);
      if (!next) {
        handled = false; // let focus leave the editor at either end
        if (ids.length) this.select([]);
      } else {
        this.select([next.id]);
        this.cursor.tick = next.pos;
        this.cursor.key = next.key;
        this.revealTick(next.pos);
        this.revealKey(next.key);
        this.audition(next.key, next.vel, { hold: false });
        announce(`${describeNote(next, this.sig)}, velocity ${Math.round(next.vel * 100)}%`);
      }
    } else if (key === 'PageUp' || key === 'PageDown') {
      this.scrollY += (key === 'PageUp' ? -1 : 1) * this.L.gridH * 0.8;
      this.clampScroll();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.dirty = true;
    }
  }

  announceCursor() {
    const k = this.cursor.key;
    const t = this.cursor.tick;
    const hit = N.noteAt(this.notes, t, k);
    announce(`${keyName(k)}, ${describePos(t, this.sig)}${hit ? ', on a note' : ''}`);
  }

  /** Status bar text for the pointer position. */
  hintAt(key, tick) {
    this.app.hint(`${keyName(key)}  ${formatBST(Math.max(0, tick), this.sig)}`);
  }

  destroy() {
    this.gfx.destroy();
  }
}
