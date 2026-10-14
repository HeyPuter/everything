// The channel rack panel: a step sequencer with one row per channel for the
// selected pattern, a step header, an optional velocity lane, the panel
// toolbar (steps, swing, velocity lane, add channel) and every interaction
// (paint steps, reorder rows, drop instruments and audio files, keyboard
// grid navigation).
//
// Store changes are diffed by reference: rows are keyed by channel id and
// only rows whose channel or notes changed are patched; the playhead touches
// two cells per row when it moves to a new step.

import { h, announce } from '../lib/dom.js';
import { clamp, IS_MAC } from '../lib/util.js';
import * as E from '../model/edits.js';
import { channelAudible } from '../model/project.js';
import { STEP, barLabel, ticksPerBar } from '../model/time.js';
import { INSTRUMENTS } from '../instruments/catalog.js';
import { SYNTH_PRESETS, DRUM_PRESETS } from '../instruments/presets.js';
import { createKnob } from '../ui/knob.js';
import { icon } from '../ui/icons.js';
import { openMenu, contextMenu, isContextKey } from '../ui/menu.js';
import { setDragData, getDragData, dragHasPayload } from '../lib/dnd.js';
import { RackRow, COL, PHONE_HIDDEN } from './row.js';
import { channelActions, channelMenuItems } from './actions.js';
import { stepCount, stepsPerBeat, stepStates, paintSteps, setStepVelocity, editChannelNotes, resizedBars, copyNotes, fitsSteps, MAX_BARS } from './steps.js';

const SWING = { id: 'swing', label: 'Swing', min: 0, max: 1, def: 0, unit: '%' };
const GAP = 2; // px between steps
const BEAT_GAP = 4; // extra px before each beat

/** Clipboard for copied steps, shared by every rack instance. */
let clipboard = null;

const isAudioFile = (f) => /^audio\//.test(f.type) || /\.(wav|mp3|ogg|oga|flac|aac|m4a|aif|aiff|webm|opus)$/i.test(f.name);
const baseName = (n) => String(n || 'Sample').replace(/\.[a-z0-9]+$/i, '');

export class RackView {
  constructor(app, host) {
    this.app = app;
    this.store = app.store;
    this.host = host;
    this.actions = channelActions(app);
    this.rows = new Map();
    this.channels = null;
    this.mixer = null;
    this.count = 0;
    this.sigKey = '';
    this.stepW = 22;
    this.stepsW = 0;
    this.previewH = 22;
    this.playStep = -1;
    this.visible = false;
    this.focusEl = null;
    this.anchor = null;
    this.viaPointer = false;
    this.velLane = false;
    this.knobGesture = null;
    this.build();
    this.bind();
    this.sync(true);
  }

  // ---------------------------------------------------------------- build

  build() {
    const app = this.app;
    this.headSteps = h('div.rack-head-steps');
    this.head = h('div.rack-head', { 'aria-hidden': 'true' }, h('div.rack-head-ctl', h('span.rack-head-pattern')), this.headSteps);
    this.grid = h('div.rack-grid', { role: 'grid', 'aria-label': 'Channel rack steps', 'aria-multiselectable': 'true' });
    this.dropLine = h('div.rack-drop', { hidden: true });
    this.empty = h(
      'div.rack-empty',
      { hidden: true },
      h('h3', 'The rack is empty'),
      h('p', 'Add an instrument, or drag one here from the browser. Audio files dropped here become samplers.'),
      h('button.btn.sm', { type: 'button', onclick: (e) => this.openAddMenu(e.currentTarget) }, icon('plus', 14), 'Add channel'),
    );
    this.addRowBtn = h('button.rack-add-row', { type: 'button', 'aria-haspopup': 'menu', title: 'Add a channel', onclick: (e) => this.openAddMenu(e.currentTarget) }, icon('plus', 14), h('span', 'Add channel'));
    this.foot = h('div.rack-foot', h('div.rack-foot-ctl', this.addRowBtn));
    // Velocity lane.
    this.velName = h('span.rack-vel-name');
    this.velBars = h('div.rack-vel-bars', { 'aria-hidden': 'true' });
    this.vel = h('div.rack-vel', { hidden: true }, h('div.rack-vel-ctl', h('span.rack-vel-title', 'Velocity'), this.velName), this.velBars);
    this.scroller = h('div.rack', { dataset: { hint: 'Click steps to toggle, drag to paint, right-drag to erase. Right-click a channel for options.' } }, this.head, this.grid, this.empty, this.foot, this.vel, this.dropLine);
    this.host.body.append(this.scroller);
    this.toolbar = this.buildToolbar();
  }

  buildToolbar() {
    const app = this.app;
    this.stepsLabel = h('span.rack-steps-count', { 'aria-live': 'polite' });
    const minus = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Remove a bar', title: 'Remove a bar of steps', onclick: () => this.resize(-1) }, icon('minus', 14));
    const plus = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Add a bar', title: 'Add a bar of steps', onclick: () => this.resize(1) }, icon('plus', 14));
    this.minusBtn = minus;
    this.plusBtn = plus;
    this.swing = createKnob({
      param: SWING,
      value: this.store.project.swing,
      label: 'Swing',
      ariaLabel: 'Swing',
      size: 20,
      showLabel: false,
      onStart: () => this.store.begin('Swing'),
      onInput: (v) => this.store.preview((p) => E.setProjectProps(p, { swing: v })),
      onEnd: () => this.store.commit(),
    });
    this.swing.el.dataset.hint = 'Swing: delays every second sixteenth for a shuffled feel';
    this.velBtn = h('button.icon-btn.sm', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Velocity lane', title: 'Velocity lane: edit step velocities of the selected channel', onclick: () => this.toggleVelLane() }, icon('sliders-vertical', 14));
    const add = h('button.btn.sm.ghost.rack-add', { type: 'button', 'aria-haspopup': 'menu', title: 'Add a channel', onclick: (e) => this.openAddMenu(e.currentTarget) }, icon('plus', 14), h('span', 'Add'));
    return h(
      'div.rack-toolbar',
      h('div.rack-tb-group', { role: 'group', 'aria-label': 'Pattern steps' }, minus, this.stepsLabel, plus),
      h('span.tool-sep'),
      h('label.rack-tb-group.rack-swing', this.swing.el, h('span.rack-tb-label', 'Swing')),
      h('span.tool-sep'),
      this.velBtn,
      h('span.rack-tb-spacer'),
      add,
    );
  }

  bind() {
    const { store, app } = this;
    this.offs = [
      store.on('change', () => this.sync()),
      store.on('view', () => this.sync()),
      app.on('frame', () => this.frame()),
      app.on('layout', () => this.onLayout()),
    ];
    window.addEventListener('themechange', () => this.redrawPreviews());
    const g = this.grid;
    g.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    g.addEventListener('click', (e) => this.onClick(e));
    g.addEventListener('dblclick', (e) => this.onDblClick(e));
    g.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    g.addEventListener('keydown', (e) => this.onKeyCapture(e), true);
    g.addEventListener('keydown', (e) => this.onKeyDown(e));
    g.addEventListener('keyup', (e) => {
      // Space activates buttons on keyup; the grid already handled it on keydown.
      if (e.key === ' ' && this.handledSpace) {
        e.preventDefault();
        this.handledSpace = false;
      }
    });
    g.addEventListener('focusin', (e) => this.onFocusIn(e));
    g.addEventListener('dragstart', (e) => this.onDragStart(e));
    const s = this.scroller;
    s.addEventListener('dragover', (e) => this.onDragOver(e));
    s.addEventListener('dragleave', (e) => {
      if (!s.contains(e.relatedTarget)) this.dropLine.hidden = true;
    });
    s.addEventListener('drop', (e) => this.onDrop(e));
    this.velBars.addEventListener('pointerdown', (e) => this.onVelPointer(e));
    // Two-finger pan on touch screens (one finger paints).
    this.touches = new Map();
    s.addEventListener('pointerdown', (e) => this.trackTouch(e), true);
  }

  // ---------------------------------------------------------------- sync

  /** Brings the DOM in line with the store, touching only what changed. */
  sync(force = false) {
    const p = this.store.project;
    const pat = this.store.pattern;
    if (!pat) return;
    const count = stepCount(pat, p.sig);
    const sigKey = p.sig.join('/');
    let relayout = false;
    if (count !== this.count || sigKey !== this.sigKey) {
      this.count = count;
      this.sigKey = sigKey;
      this.buildHeader();
      relayout = true;
      force = true;
    }
    if (force || p.channels !== this.channels) this.syncRows(p);
    if (force || p.mixer !== this.mixer) {
      const prevMixer = this.mixer;
      this.mixer = p.mixer;
      if (!prevMixer || prevMixer.length !== p.mixer.length || prevMixer.some((t, i) => t.name !== p.mixer[i]?.name)) {
        for (const row of this.rows.values()) {
          row.insert.setMax(p.mixer.length - 1);
          row.insert.refresh();
        }
      }
    }
    const sel = this.store.view.selectedChannels;
    const primary = this.store.view.channel;
    for (const ch of p.channels) {
      const row = this.rows.get(ch.id);
      row.setChannel(ch, { audible: channelAudible(p, ch), selected: sel.has(ch.id), primary: ch.id === primary });
      row.setNotes(pat.notes[ch.id], count, p.sig);
    }
    if (relayout) this.layoutSteps(true);
    this.syncToolbar(p, pat);
    this.syncVelLane();
    this.grid.setAttribute('aria-label', `Channel rack, ${pat.name}`);
    this.head.querySelector('.rack-head-pattern').textContent = pat.name;
    this.empty.hidden = p.channels.length > 0;
    this.grid.hidden = p.channels.length === 0;
    if (!this.focusEl?.isConnected || !this.grid.contains(this.focusEl)) this.setRoving(this.rows.values().next().value?.nameBtn || null);
  }

  syncRows(p) {
    this.channels = p.channels;
    const ids = new Set();
    let i = 0;
    for (const ch of p.channels) {
      ids.add(ch.id);
      let row = this.rows.get(ch.id);
      if (!row) {
        row = new RackRow(this, ch);
        this.rows.set(ch.id, row);
      }
      const at = this.grid.children[i];
      if (at !== row.el) this.grid.insertBefore(row.el, at || null);
      row.el.setAttribute('aria-rowindex', String(i + 1));
      i++;
    }
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.el.remove();
      this.rows.delete(id);
    }
  }

  buildHeader() {
    const p = this.store.project;
    const spb = stepsPerBeat(p.sig);
    const frag = document.createDocumentFragment();
    this.headCells = [];
    for (let i = 0; i < this.count; i++) {
      const beat = Math.floor(i / spb);
      const start = i % spb === 0;
      let cls = 'div.rack-hstep';
      if (beat % 2) cls += '.alt';
      if (i > 0 && start) cls += '.beat';
      const c = h(cls, start ? barLabel(i * STEP, p.sig) : '');
      this.headCells.push(c);
      frag.append(c);
    }
    this.headSteps.replaceChildren(frag);
    this.playStep = -1;
  }

  syncToolbar(p, pat) {
    const bars = Math.round(stepCount(pat, p.sig) * STEP / ticksPerBar(p.sig));
    const text = `${this.count} steps`;
    if (this.stepsLabel.textContent !== text) this.stepsLabel.textContent = text;
    this.stepsLabel.title = `${bars} bar${bars === 1 ? '' : 's'}`;
    this.minusBtn.disabled = bars <= 1;
    this.plusBtn.disabled = bars >= MAX_BARS;
    this.swing.set(p.swing);
  }

  // ---------------------------------------------------------------- layout

  /** Step widths that fit the panel when possible (within comfortable limits). */
  layoutSteps(force = false) {
    const phone = this.isPhone();
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const ctlW = this.head.firstChild.offsetWidth || (phone ? 132 : 268);
    const avail = this.scroller.clientWidth - ctlW - 16;
    const spb = stepsPerBeat(this.store.project.sig);
    const beats = Math.ceil(this.count / spb);
    const gaps = (this.count - 1) * GAP + (beats - 1) * BEAT_GAP;
    const min = coarse || phone ? 26 : 16;
    const max = coarse || phone ? 34 : 26;
    const w = avail > 0 ? clamp(Math.floor((avail - gaps) / this.count), min, max) : 22;
    if (!force && w === this.stepW) return;
    this.stepW = w;
    this.stepsW = this.stepX(this.count - 1) + w;
    this.previewH = coarse || phone ? 28 : 20;
    this.scroller.style.setProperty('--step-w', `${w}px`);
    this.scroller.style.setProperty('--steps-w', `${this.stepsW}px`);
    this.redrawPreviews();
  }

  stepX(i) {
    const spb = stepsPerBeat(this.store.project.sig);
    return i * (this.stepW + GAP) + Math.floor(i / spb) * BEAT_GAP;
  }

  redrawPreviews() {
    for (const row of this.rows.values()) if (!row.fits) row.drawPreview();
  }

  isPhone() {
    return this.app.root?.classList?.contains('is-phone') || false;
  }

  onLayout() {
    const phone = this.isPhone();
    if (phone !== this.phone) {
      this.phone = phone;
      this.layoutSteps(true);
    }
  }

  // ---------------------------------------------------------------- playhead

  frame() {
    if (!this.visible) return;
    const e = this.app.engine;
    const s = e.playing && e.mode === 'pattern' ? Math.floor(e.position / STEP) : -1;
    if (s === this.playStep) return;
    const old = this.playStep;
    this.playStep = s;
    if (old >= 0) this.headCells[old]?.classList.remove('play');
    if (s >= 0) this.headCells[s]?.classList.add('play');
    for (const row of this.rows.values()) {
      if (old >= 0) row.setPlay(old, false);
      if (s >= 0) row.setPlay(s, true);
    }
    if (old >= 0) this.velBars.children[old]?.classList.remove('play');
    if (s >= 0) this.velBars.children[s]?.classList.add('play');
  }

  // ---------------------------------------------------------------- row callbacks

  mixerMax() {
    return this.store.project.mixer.length - 1;
  }

  insertName(i) {
    return i > 0 ? this.store.project.mixer[i]?.name || '' : 'Master';
  }

  knob(id, param, phase, v) {
    const { store, app } = this;
    const ch = store.project.channels.find((c) => c.id === id);
    if (!ch) return;
    const label = `${ch.name} ${param === 'volume' ? 'volume' : 'pan'}`;
    if (phase === 'start') {
      store.begin(param === 'volume' ? 'Channel volume' : 'Channel pan');
    } else if (phase === 'input') {
      store.preview((p) => E.updateChannel(p, id, { [param]: v }));
      app.lastTweaked = { label, target: { kind: 'channel', id, param } };
    } else store.commit();
  }

  insertGesture(id, phase, v) {
    const store = this.store;
    if (phase === 'start') store.begin('Route to insert');
    else if (phase === 'input') store.preview((p) => E.updateChannel(p, id, { mixer: v }));
    else store.commit();
  }

  // ---------------------------------------------------------------- pointer

  rowOf(el) {
    const r = el?.closest?.('.rack-row');
    return r ? this.rows.get(r.dataset.id) || null : null;
  }

  onPointerDown(e) {
    this.viaPointer = true;
    const t = e.target;
    const cell = t.closest('.step');
    if (cell) return this.startPaint(e, cell);
    const grip = t.closest('.rack-grip');
    if (grip && e.button === 0) return this.startReorder(e, this.rowOf(grip));
    return undefined;
  }

  startPaint(e, cell) {
    const row = this.rowOf(cell);
    if (!row || !row.fits) return;
    const erase = e.button === 2;
    if (e.button !== 0 && !erase) return;
    if (e.pointerType === 'touch' && this.touches.size > 1) return;
    e.preventDefault();
    this.setRoving(cell);
    const store = this.store;
    const step = Number(cell.dataset.step);
    const on = erase ? false : !(row.states[step] >= 0);
    const painted = new Set([step]);
    const patId = store.view.pattern;
    const id = row.id;
    store.begin(on ? 'Paint steps' : 'Erase steps');
    const apply = () => store.preview((p) => editChannelNotes(p, patId, id, (notes, c) => paintSteps(notes, painted, on, c.root)));
    apply();
    let last = step;
    const g = this.grid;
    try {
      g.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer.
    }
    this.painting = { pointerId: e.pointerId };
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId || !this.painting) return;
      const el = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest?.('.step');
      let s;
      if (el && this.rowOf(el) === row) s = Number(el.dataset.step);
      else {
        // Outside the row: follow the x position along this row's cells.
        const r0 = row.stepsEl.getBoundingClientRect();
        if (!r0.width) return;
        s = clamp(Math.floor((ev.clientX - r0.left) / (this.stepW + GAP + BEAT_GAP / stepsPerBeat(store.project.sig))), 0, row.count - 1);
      }
      if (s === last) return;
      const [a, b] = s > last ? [last + 1, s] : [s, last - 1];
      let added = false;
      for (let i = a; i <= b; i++) {
        if (!painted.has(i)) {
          painted.add(i);
          added = true;
        }
      }
      last = s;
      if (added) apply();
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      const cancelled = !this.painting;
      this.painting = null;
      if (cancelled) return;
      if (painted.size === 1 && store.gesture) store.gesture.label = on ? 'Step on' : 'Step off';
      store.commit();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  }

  trackTouch(e) {
    if (e.pointerType !== 'touch') return;
    const s = this.scroller;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 2) {
      // A second finger turns the gesture into a pan: undo the paint stroke.
      if (this.painting) {
        this.painting = null;
        this.store.cancel();
      }
      let mid = this.midpoint();
      const move = (ev) => {
        if (!this.touches.has(ev.pointerId)) return;
        this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        const m = this.midpoint();
        s.scrollLeft -= m.x - mid.x;
        s.scrollTop -= m.y - mid.y;
        mid = m;
      };
      const end = (ev) => {
        this.touches.delete(ev.pointerId);
        if (this.touches.size < 2) {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', end, true);
          window.removeEventListener('pointercancel', end, true);
        }
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    } else {
      const end = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        this.touches.delete(ev.pointerId);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
      };
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    }
  }

  midpoint() {
    let x = 0;
    let y = 0;
    for (const p of this.touches.values()) {
      x += p.x;
      y += p.y;
    }
    const n = this.touches.size || 1;
    return { x: x / n, y: y / n };
  }

  /** Index (0..n) of the gap between rows nearest to clientY. */
  dropIndex(clientY) {
    const rows = [...this.grid.children].filter((el) => el.classList.contains('rack-row'));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  showDropLine(index) {
    const rows = [...this.grid.children].filter((el) => el.classList.contains('rack-row'));
    const sr = this.scroller.getBoundingClientRect();
    let y;
    if (!rows.length) y = this.grid.getBoundingClientRect().top;
    else if (index < rows.length) y = rows[index].getBoundingClientRect().top;
    else y = rows.at(-1).getBoundingClientRect().bottom;
    this.dropLine.hidden = false;
    this.dropLine.style.top = `${Math.round(y - sr.top + this.scroller.scrollTop - 1)}px`;
  }

  startReorder(e, row) {
    if (!row) return;
    e.preventDefault();
    const from = this.store.project.channels.findIndex((c) => c.id === row.id);
    const g = this.grid;
    try {
      g.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events in tests.
    }
    row.el.classList.add('dragging');
    let target = from;
    const move = (ev) => {
      target = this.dropIndex(ev.clientY);
      this.showDropLine(target);
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      row.el.classList.remove('dragging');
      this.dropLine.hidden = true;
      const to = target > from ? target - 1 : target;
      if (to !== from) {
        this.actions.moveTo(row.id, to);
        announce(`Moved ${row.ch.name} to position ${to + 1}`);
      }
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  }

  onClick(e) {
    const t = e.target;
    const row = this.rowOf(t);
    if (!row) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (t.closest('.rack-mute')) {
      if (mod) this.actions.solo(row.id);
      else this.actions.toggleMute([row.id]);
    } else if (t.closest('.rack-sel')) {
      this.actions.select(row.id, { toggle: true });
      this.anchor = row.id;
    } else if (t.closest('.rack-name')) {
      this.actions.select(row.id, { extend: e.shiftKey, toggle: mod, anchor: this.anchor });
      if (!e.shiftKey) this.anchor = row.id;
    } else if (t.closest('.rack-preview')) {
      this.actions.openPianoRoll(row.id);
    }
  }

  onDblClick(e) {
    const row = this.rowOf(e.target);
    if (row && e.target.closest('.rack-name')) this.actions.openEditor(row.id);
  }

  onContextMenu(e) {
    const t = e.target;
    const row = this.rowOf(t);
    if (!row) return;
    if (t.closest('.step')) {
      e.preventDefault(); // right-drag erases
      return;
    }
    if (t.closest('.rack-knob, .insert-spin')) return; // knob menus
    if (t.closest('.rack-mute')) {
      e.preventDefault();
      this.actions.solo(row.id);
      return;
    }
    this.openChannelMenu(row, e);
  }

  openChannelMenu(row, e) {
    if (!this.store.view.selectedChannels.has(row.id)) this.actions.select(row.id);
    contextMenu(e, channelMenuItems(this.app, this.actions, row.id), `${row.ch.name} options`);
  }

  // ---------------------------------------------------------------- keyboard

  setRoving(el) {
    if (this.focusEl === el) return;
    if (this.focusEl) this.focusEl.tabIndex = -1;
    this.focusEl = el;
    if (el) el.tabIndex = 0;
  }

  onFocusIn(e) {
    const t = e.target.closest('[data-col]');
    if (t && this.grid.contains(t)) this.setRoving(t);
  }

  posOf(el) {
    const t = el?.closest?.('[data-col]');
    const row = this.rowOf(t);
    if (!t || !row) return null;
    const ids = this.store.project.channels.map((c) => c.id);
    return { row, r: ids.indexOf(row.id), c: Number(t.dataset.col), el: t };
  }

  /** Moves focus within the grid by rows/columns, skipping columns hidden on phones. */
  move(pos, dr, dc, { absCol = null, absRow = null } = {}) {
    const ids = this.store.project.channels.map((c) => c.id);
    if (!ids.length) return;
    const r = clamp(absRow ?? pos.r + dr, 0, ids.length - 1);
    const row = this.rows.get(ids[r]);
    let c = absCol ?? pos.c + dc;
    const hidden = this.isPhone() ? PHONE_HIDDEN : null;
    if (hidden) {
      const dir = dc < 0 ? -1 : 1;
      while (hidden.has(c) && c >= 0 && c < COL.steps) c += dir;
    }
    c = clamp(c, 0, row.lastCol());
    if (hidden?.has(c)) c = COL.name;
    const el = row.focusable(c);
    if (!el) return;
    this.setRoving(el);
    this.viaPointer = false;
    el.focus({ preventScroll: false });
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  onKeyCapture(e) {
    // Mod+arrows move between cells from anywhere, including knobs.
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || !/^Arrow/.test(e.key)) return;
    const pos = this.posOf(e.target);
    if (!pos) return;
    e.preventDefault();
    e.stopPropagation();
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    this.move(pos, d[0], d[1]);
  }

  onKeyDown(e) {
    if (e.defaultPrevented || e.altKey) return;
    const pos = this.posOf(e.target);
    if (!pos) return;
    const { row, c } = pos;
    const isStep = c >= COL.steps && row.fits;
    const isPreview = c >= COL.steps && !row.fits;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const key = e.key;
    if (isContextKey(e)) {
      e.preventDefault();
      const r = e.target.getBoundingClientRect();
      this.openChannelMenu(row, { clientX: r.left, clientY: r.bottom, preventDefault() {} });
      return;
    }
    // Knobs and the insert spinner take plain arrows themselves.
    if (c === COL.pan || c === COL.vol || c === COL.insert) return;
    const nav = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
    if (nav && !mod) {
      e.preventDefault();
      if (e.shiftKey && isStep && (key === 'ArrowUp' || key === 'ArrowDown')) {
        this.nudgeVelocity(row, c - COL.steps, key === 'ArrowUp' ? 0.05 : -0.05);
        return;
      }
      this.move(pos, nav[0], nav[1]);
      return;
    }
    if (key === 'Home' || key === 'End') {
      e.preventDefault();
      if (mod) this.move(pos, 0, 0, { absRow: key === 'Home' ? 0 : Infinity });
      else if (c >= COL.steps) this.move(pos, 0, 0, { absCol: key === 'Home' ? COL.steps : row.lastCol() });
      else this.move(pos, 0, 0, { absCol: key === 'Home' ? 0 : COL.name });
      return;
    }
    const space = key === ' ';
    if (!space && key !== 'Enter') return;
    // Space after a mouse click keeps its global meaning (play / pause).
    if (space && this.viaPointer) return;
    e.preventDefault();
    e.stopPropagation();
    if (space) this.handledSpace = true;
    if (isStep) {
      const step = c - COL.steps;
      const on = !(row.states[step] >= 0);
      this.actions.setStep(row.id, step, on);
      announce(`${row.ch.name} step ${step + 1} ${on ? 'on' : 'off'}`);
    } else if (isPreview) this.actions.openPianoRoll(row.id);
    else if (c === COL.mute) {
      if (mod) this.actions.solo(row.id);
      else this.actions.toggleMute([row.id]);
    } else if (c === COL.sel) this.actions.select(row.id, { toggle: true });
    else if (c === COL.name) {
      if (key === 'Enter') this.actions.openEditor(row.id);
      else {
        this.actions.select(row.id, { extend: e.shiftKey, toggle: mod, anchor: this.anchor });
        if (!e.shiftKey) this.anchor = row.id;
        announce(`${row.ch.name} selected`);
      }
    }
  }

  nudgeVelocity(row, step, d) {
    const v = row.states[step];
    if (!(v >= 0)) return;
    const next = clamp(Math.round((v + d) * 100) / 100, 0, 1);
    this.store.apply('Step velocity', (p) => editChannelNotes(p, this.store.view.pattern, row.id, (notes) => setStepVelocity(notes, step, next)));
    announce(`Velocity ${Math.round(next * 100)}%`);
  }

  // ---------------------------------------------------------------- drag and drop

  onDragStart(e) {
    const name = e.target.closest?.('.rack-name');
    const row = this.rowOf(name);
    if (!name || !row) return;
    setDragData(e, { kind: 'channel', id: row.id }, row.ch.name);
    e.dataTransfer.effectAllowed = 'copyMove';
    this.draggingId = row.id;
  }

  onDragOver(e) {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = this.draggingId ? 'move' : 'copy';
    this.showDropLine(this.dropIndex(e.clientY));
  }

  async onDrop(e) {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    this.dropLine.hidden = true;
    const index = this.dropIndex(e.clientY);
    const data = getDragData(e);
    const dragged = this.draggingId;
    this.draggingId = null;
    const app = this.app;
    if (data?.kind === 'channel' && (dragged || data.id)) {
      const id = data.id;
      const from = this.store.project.channels.findIndex((c) => c.id === id);
      if (from < 0) return;
      const to = index > from ? index - 1 : index;
      if (to !== from) this.actions.moveTo(id, to);
      return;
    }
    if (data?.kind === 'preset' && INSTRUMENTS[data.type]) {
      app.addChannel({ type: data.type, name: data.name, params: data.params, index });
      return;
    }
    if (data?.kind === 'instrument' && INSTRUMENTS[data.type]) {
      const id = app.addChannel({ type: data.type, name: INSTRUMENTS[data.type].label, index });
      if (data.type === 'sampler') app.openChannelEditor?.(id);
      return;
    }
    if (data?.kind === 'file') {
      await this.importFile(null, data, index);
      return;
    }
    const files = [...(e.dataTransfer?.files || [])].filter(isAudioFile);
    if (!files.length) {
      if (e.dataTransfer?.files?.length) app.notify('Only audio files can be dropped on the rack.', { error: true });
      return;
    }
    let at = index;
    for (const f of files) if (await this.importFile(f, { name: f.name }, at)) at++;
  }

  /** Imports an OS file (or a Puter file payload) as a sampler channel at `index`. */
  async importFile(file, { name, path } = {}, index) {
    const app = this.app;
    if (!app.importAudio) {
      app.notify('Audio import is not available yet.', { error: true });
      return false;
    }
    try {
      let blob = file;
      if (!blob && path) {
        const puter = window.puter;
        if (!puter?.auth?.isSignedIn?.() || !puter.fs?.read) {
          app.notify('Sign in to use files from your Puter cloud.', { error: true });
          return false;
        }
        blob = await puter.fs.read(path);
      }
      const r = await app.importAudio(blob, { name: baseName(name), path, as: 'sampler' });
      if (r?.channelId) {
        const from = this.store.project.channels.findIndex((c) => c.id === r.channelId);
        if (from >= 0 && index < this.store.project.channels.length - 1 && from !== index) this.actions.moveTo(r.channelId, index);
      }
      return true;
    } catch (err) {
      app.reportError(err);
      return false;
    }
  }

  // ---------------------------------------------------------------- add menu

  addMenuItems() {
    const app = this.app;
    const add = (type, name, params) => () => {
      const id = app.addChannel({ type, name, params });
      if (type === 'sampler') app.openChannelEditor?.(id);
    };
    return [
      { label: INSTRUMENTS.synth.label, icon: 'synth', run: add('synth', INSTRUMENTS.synth.label) },
      { label: INSTRUMENTS.drum.label, icon: 'drum', run: add('drum', INSTRUMENTS.drum.label) },
      { label: INSTRUMENTS.sampler.label, icon: 'sampler', run: add('sampler', INSTRUMENTS.sampler.label) },
      { type: 'sep' },
      { type: 'submenu', label: 'Synth presets', items: () => SYNTH_PRESETS.filter((p) => p.name !== 'Init').map((p) => ({ label: p.name, icon: 'synth', run: add('synth', p.name, p.params) })) },
      { type: 'submenu', label: 'Drum presets', items: () => DRUM_PRESETS.map((p) => ({ label: p.name, icon: 'drum', run: add('drum', p.name, p.params) })) },
      ...(app.importAudio ? [{ type: 'sep' }, { label: 'Sampler from audio file...', icon: 'file-audio', run: () => this.pickAudioFile() }] : []),
    ];
  }

  openAddMenu(anchor) {
    openMenu(this.addMenuItems(), { anchor, label: 'Add channel' });
  }

  pickAudioFile() {
    const input = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
    input.addEventListener('change', async () => {
      let at = this.store.project.channels.length;
      for (const f of input.files) if (await this.importFile(f, { name: f.name }, at)) at++;
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  // ---------------------------------------------------------------- velocity lane

  toggleVelLane(on = !this.velLane) {
    this.velLane = on;
    this.vel.hidden = !on;
    this.velBtn.setAttribute('aria-pressed', String(on));
    this.laneKey = null;
    this.syncVelLane();
  }

  syncVelLane() {
    if (!this.velLane) return;
    const ch = this.store.channel;
    const pat = this.store.pattern;
    const notes = ch ? pat.notes[ch.id] : undefined;
    const key = `${ch?.id}|${this.count}|${this.sigKey}`;
    if (key !== this.laneKey) {
      this.laneKey = key;
      this.laneNotes = undefined;
      const spb = stepsPerBeat(this.store.project.sig);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < this.count; i++) {
        let cls = 'div.vbar';
        if (Math.floor(i / spb) % 2) cls += '.alt';
        if (i > 0 && i % spb === 0) cls += '.beat';
        frag.append(h(cls, { dataset: { step: String(i) } }, h('div.vfill')));
      }
      this.velBars.replaceChildren(frag);
      this.laneStates = new Float32Array(this.count);
    }
    this.vel.style.setProperty('--ch', ch?.color || 'var(--accent)');
    this.velName.textContent = ch ? ch.name : 'No channel';
    if (notes === this.laneNotes) return;
    this.laneNotes = notes;
    stepStates(notes, this.count, this.laneStates);
    const bars = this.velBars.children;
    for (let i = 0; i < this.count; i++) {
      const v = this.laneStates[i];
      bars[i].classList.toggle('on', v >= 0);
      bars[i].firstChild.style.height = v >= 0 ? `${Math.round(v * 100)}%` : '0';
    }
  }

  onVelPointer(e) {
    const ch = this.store.channel;
    if (!ch || e.button !== 0) return;
    e.preventDefault();
    const store = this.store;
    const patId = store.view.pattern;
    const values = new Map();
    store.begin('Step velocity');
    const at = (ev) => {
      const bar = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest?.('.vbar');
      if (!bar || !this.velBars.contains(bar)) return;
      const r = bar.getBoundingClientRect();
      const v = clamp(1 - (ev.clientY - r.top) / (r.height || 1), 0, 1);
      values.set(Number(bar.dataset.step), Math.round(v * 100) / 100);
      store.preview((p) => editChannelNotes(p, patId, ch.id, (notes) => {
        let next = notes;
        for (const [s, val] of values) next = setStepVelocity(next, s, val);
        return next;
      }));
    };
    at(e);
    const el = this.velBars;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events in tests.
    }
    const up = () => {
      el.removeEventListener('pointermove', at);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      store.commit();
    };
    el.addEventListener('pointermove', at);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- pattern length

  resize(delta) {
    const p = this.store.project;
    const pat = this.store.pattern;
    const bars = resizedBars(pat, p.sig, delta);
    const len = bars * ticksPerBar(p.sig);
    if (len === pat.length) return;
    this.store.apply(delta > 0 ? 'Add bar' : 'Remove bar', (proj) => E.updatePattern(proj, pat.id, { length: len }));
    announce(`${Math.round(len / STEP)} steps`);
  }

  // ---------------------------------------------------------------- panel actions

  targets() {
    const sel = this.store.view.selectedChannels;
    const ids = this.store.project.channels.filter((c) => sel.has(c.id)).map((c) => c.id);
    if (ids.length) return ids;
    return this.store.view.channel ? [this.store.view.channel] : [];
  }

  copySteps() {
    const ch = this.store.channel;
    if (!ch) return false;
    const notes = this.store.pattern.notes[ch.id] || [];
    clipboard = { notes: copyNotes(notes), root: ch.root, steps: fitsSteps(notes, ch.root) };
    this.app.notify(`Copied ${ch.name} ${clipboard.steps ? 'steps' : 'notes'}`);
    return true;
  }

  pasteSteps() {
    if (!clipboard) return;
    const ids = this.targets();
    const patId = this.store.view.pattern;
    this.store.apply('Paste steps', (p) => ids.reduce((next, id) => editChannelNotes(next, patId, id, (_, c) => copyNotes(clipboard.notes, clipboard.steps ? { key: c.root } : {})), p));
  }

  api() {
    const a = this.actions;
    return {
      toolbar: this.toolbar,
      onShow: () => {
        this.visible = true;
        this.layoutSteps(true);
      },
      onHide: () => {
        this.visible = false;
      },
      onResize: () => this.layoutSteps(),
      focus: () => (this.focusEl || this.grid).focus({ preventScroll: true }),
      actions: {
        selectAll: () => this.store.selectChannels(this.store.project.channels.map((c) => c.id), { primary: this.store.view.channel }),
        deselect: () => this.store.selectChannels([], { primary: this.store.view.channel }),
        delete: () => a.remove(this.targets()),
        duplicate: () => a.clone(this.targets()),
        copy: () => this.copySteps(),
        cut: () => {
          if (this.copySteps()) a.clear([this.store.channel.id]);
        },
        paste: () => this.pasteSteps(),
      },
      view: this,
    };
  }
}
