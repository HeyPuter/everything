// Multitrack editor view for a Session: overview navigator, time ruler, track
// headers, clip lanes (backgrounds and overlays in Canvas 2D, waveforms in
// WebGL2), automation lanes, playhead, time selection, snapping, drag and
// drop, tools (Move, Razor, Slip, Time Selection) and keyboard operation.
//
// Clip drags preview through doc.preview() and commit one undo step on
// release; knob gestures coalesce in TrackControls.

import { h, announce } from '../lib/dom.js';
import { TimeRuler } from './time-ruler.js';
import { Overview } from './overview.js';
import { ClipWaveRenderer } from '../render/clips-gl.js';
import { channelColumns } from '../audio/peaks.js';
import { cssVar, CANVAS_FONT, parseColor, resolvedTheme } from '../ui/theme.js';
import { markerColor } from '../ui/appearance.js';
import { icon } from '../ui/icons.js';
import { contextMenu } from '../ui/menubar.js';
import { fadeShape } from '../engine/mixcore.js';
import * as S from '../model/session-edits.js';
import { createMarker, nextMarkerName, sortMarkers } from '../model/markers.js';
import { TrackHeader } from './track-header.js';
import { volumeToEnvPos, envPosToVolume, panToEnvPos, envPosToPan, formatGain, formatPan } from '../multitrack/levels.js';
import { CLIP_CONTEXT, TRACK_CONTEXT, LANE_CONTEXT } from '../multitrack/menus.js';
import { clipPlan } from '../model/session-graph.js';
import { TYPES as ASSISTANT_TYPES } from '../sound-assistant/model.js';
import { framesPerSecond, musicalStep } from '../lib/time.js';
import { wheelZoom, followPlayhead, defaultFadeCurve } from './view-prefs.js';
import { stretchOf, stretchActive, MIN_RATIO, MAX_RATIO } from '../model/clip-stretch.js';
import { stretcherFor } from '../multitrack/stretch.js';
import { isRemixed, remixSeams, MIN_REMIX_SECONDS } from '../model/clip-remix.js';
import { runRemix } from '../multitrack/remix-commands.js';
import { VideoLane } from '../video/video-lane.js';
import { TrackNav } from './track-nav.js';

const HEADER_BAR = 16;
const AUTO_H = 46;
const MIN_ROW = 28;
const EDGE = 5;
/** Size of the stretch handles in a clip's top corners (Move tool, global clip stretching on). */
const STRETCH_HANDLE = 10;
/** Longest remix the right edge of a remixed clip can ask for (seconds). */
const MAX_REMIX_SECONDS = 3600;

export class MultitrackView {
  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    this.headers = new Map();
    this.rows = [];
    this.scrollY = 0;
    this.headerWidth = Math.max(170, Math.min(320, Number(app.prefs.get('mtHeaderWidth')) || 236));
    this.headerMode = app.prefs.get('mtHeaderMode') || 'io';
    this.dirty = { bg: true, wave: true, overlay: true, ruler: true, overview: true };
    this.drag = null;
    this.hover = null;
    this.snapLine = null;
    this.dropHint = null;
    this.reorder = null;
    this.focusClip = null;
    this.#build();
    this.offDoc = doc.on('change', (e) => this.#onDocChange(e));
    this.offPrefs = app.on('prefs', (key) => {
      if (key === 'mtHeaderMode') this.#applyHeaderMode();
      this.invalidate();
    });
    this.offTool = app.on('tool', () => {
      this.#updateCursor();
      // Stretch handles show with the Move tool only.
      this.invalidate('overlay');
    });
    this.offMeters = app.engine.on('meters', (m) => this.#onMeters(m));
    this.onTheme = () => this.invalidate();
    window.addEventListener('themechange', this.onTheme);
    this.syncHeaders();
  }

  // ------------------------------------------------------------------ build

  #build() {
    const app = this.app;
    const doc = this.doc;
    const host = {
      timeline: () => ({
        rate: doc.sampleRate,
        length: doc.length,
        view: doc.view,
        cursor: app.active === doc ? app.playhead : doc.cursor,
        selection: doc.selection,
        markers: this.markers().map((m) => ({ ...m, selected: this.selectedMarkers?.has(m.id) })),
      }),
      seek: (f) => this.seek(f),
      snap: (f, o) => this.snap(f, o),
      setView: (a, b) => doc.setView(a, b),
      moveMarker: (id, start, { preview }) => this.moveMarker(id, start, preview),
      renameMarker: (id) => app.commands.run('marker.rename', { id }),
      selectMarker: (id) => this.selectMarker(id),
      overviewPeaks: (cols, total) => this.#overviewPeaks(cols, total),
      peaksKey: () => `${doc.history.index}:${doc.poolVersion}:${doc.state.clips.length}`,
    };
    this.ruler = new TimeRuler(app, host);
    this.overview = new Overview(app, host);
    this.rulerHandle = h('div.playhead-handle', { 'aria-hidden': 'true' });
    this.ruler.el.append(this.rulerHandle);

    const modeBtn = (mode, ic, label) =>
      h('button.icon-btn.sm.mt-mode-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': label, title: label, dataset: { mode }, onclick: () => app.prefs.set('mtHeaderMode', mode) }, icon(ic, 14));
    this.modeBtns = h('div.mt-modes', { role: 'radiogroup', 'aria-label': 'Track controls' }, modeBtn('io', 'track-io', 'Inputs and Outputs'), modeBtn('fx', 'fx', 'Effects'), modeBtn('sends', 'corner-down-right', 'Sends'), modeBtn('eq', 'sliders-horizontal', 'EQ'));
    const toolBtn = (cmd, ic, label) => h('button.icon-btn.sm', { type: 'button', 'aria-label': label, title: label, dataset: { cmd }, onclick: () => app.commands.run(cmd) }, icon(ic, 14));
    this.metroBtn = toolBtn('mt.metronome', 'metronome', 'Toggle Metronome (Shift+C)');
    this.snapBtn = toolBtn('edit.snapping', 'magnet', 'Toggle Snapping (S)');
    this.markerBtn = toolBtn('marker.add', 'marker-add', 'Add Cue Marker (M)');
    this.addTrackBtn = toolBtn('mt.addStereo', 'plus', 'Add Stereo Audio Track (Alt+A)');
    this.headTools = h('div.mt-head-tools', this.modeBtns, h('div.spacer'), this.addTrackBtn, this.metroBtn, this.snapBtn, this.markerBtn);

    this.headersInner = h('div.mt-headers-inner');
    this.reorderLine = h('div.mt-reorder-line', { hidden: true });
    this.headersEl = h('div.mt-headers', { role: 'group', 'aria-label': 'Tracks' }, this.headersInner, this.reorderLine);
    this.headersEl.addEventListener('wheel', (e) => {
      if (e.target.closest('.knob, .hot')) return;
      e.preventDefault();
      this.scrollBy(e.deltaY);
    }, { passive: false });
    this.splitter = h('div.mt-splitter', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize track headers', tabindex: '0' });
    this.#bindSplitter();

    this.bgCanvas = h('canvas.mt-bg', { 'aria-hidden': 'true' });
    this.glCanvas = h('canvas.mt-gl', { 'aria-hidden': 'true' });
    this.overlay = h('canvas.mt-overlay', { 'aria-hidden': 'true' });
    this.playheadEl = h('div.playhead', { 'aria-hidden': 'true' });
    this.status = h('div.sr-only', { id: `mt-help-${doc.id}` }, 'Multitrack editor. Arrow keys move the playhead, Up and Down select tracks, Tab selects the next clip, Alt+comma and Alt+period nudge clips, Delete removes them.');
    this.surface = h(
      'div.mt-lanes.editor-surface',
      { tabindex: '0', role: 'application', 'aria-roledescription': 'multitrack editor', 'aria-label': `Multitrack session ${doc.name}`, 'aria-describedby': this.status.id },
      this.bgCanvas,
      this.glCanvas,
      this.overlay,
      this.playheadEl,
    );
    this.renderer = new ClipWaveRenderer(this.glCanvas);
    this.renderer.onRestore = () => this.invalidate('wave');
    this.nav = new TrackNav(this);

    // The session's video track sits between the ruler and the audio tracks (hidden without a video).
    this.videoLane = new VideoLane(this);
    this.el = h(
      'div.mt.editor-view',
      { style: { '--mt-header-user': `${this.headerWidth}px` } },
      h('div.mt-top', this.overview.el, h('div.mt-top-corner')),
      h('div.mt-ruler-row', this.headTools, h('div.mt-splitter-gap'), this.ruler.el, h('div.mt-ruler-corner')),
      this.videoLane.el,
      h('div.mt-main', this.headersEl, this.splitter, this.surface, this.nav.el),
      this.status,
    );
    this.#applyHeaderMode();
    this.#bindPointer();
    this.#bindKeys();
    this.#bindDrop();
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.surface);
    this.resizeObserver.observe(this.ruler.el);
    this.resizeObserver.observe(this.overview.el);
  }

  #applyHeaderMode() {
    this.headerMode = this.app.prefs.get('mtHeaderMode') || 'io';
    for (const b of this.modeBtns.children) b.setAttribute('aria-checked', String(b.dataset.mode === this.headerMode));
    for (const hd of this.headers.values()) hd.setMode(this.headerMode);
  }

  #bindSplitter() {
    let drag = null;
    const set = (w) => {
      this.headerWidth = Math.max(150, Math.min(420, Math.round(w)));
      this.el.style.setProperty('--mt-header-user', `${this.headerWidth}px`);
      this.app.prefs.set('mtHeaderWidth', this.headerWidth);
    };
    this.splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.splitter.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, w: this.headerWidth };
    });
    this.splitter.addEventListener('pointermove', (e) => drag && set(drag.w + e.clientX - drag.x));
    this.splitter.addEventListener('pointerup', () => (drag = null));
    this.splitter.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') set(this.headerWidth - 10);
      else if (e.key === 'ArrowRight') set(this.headerWidth + 10);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ----------------------------------------------------------------- layout

  layout() {
    const r = this.surface.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.renderer.resize(this.width, this.height, dpr);
    for (const c of [this.glCanvas, this.bgCanvas, this.overlay]) {
      c.style.width = `${this.width}px`;
      c.style.height = `${this.height}px`;
    }
    for (const c of [this.bgCanvas, this.overlay]) {
      c.width = Math.round(this.width * dpr);
      c.height = Math.round(this.height * dpr);
    }
    const rr = this.ruler.el.getBoundingClientRect();
    this.ruler.resize(rr.width, rr.height);
    const orr = this.overview.el.getBoundingClientRect();
    this.overview.resize(orr.width, orr.height);
    this.computeRows();
    this.invalidate();
  }

  /** Row geometry in content coordinates for every visible track (master last). */
  computeRows(state = this.doc.viewState) {
    this.rowsAmp = this.doc.view.amp;
    const amp = this.doc.view.amp || 1;
    const rows = [];
    let y = 0;
    for (const t of S.allTracks(state)) {
      if (t.hidden) continue;
      const height = t.minimized ? MIN_ROW : Math.max(MIN_ROW, Math.round(t.height * amp));
      const auto = t.showAutomation ? AUTO_H : 0;
      rows.push({ id: t.id, track: t, top: y, height, autoTop: y + height, autoHeight: auto, total: height + auto });
      y += height + auto;
    }
    this.rows = rows;
    this.contentHeight = y;
    this.setScroll(this.scrollY, { silent: true });
    this.nav.update();
    return rows;
  }

  rowOf(id) {
    return this.rows.find((r) => r.id === id) || null;
  }

  /** Row under a lanes y coordinate (CSS px). */
  rowAt(y) {
    const cy = y + this.scrollY;
    for (const r of this.rows) if (cy >= r.top && cy < r.top + r.total) return r;
    return null;
  }

  setScroll(y, { silent = false } = {}) {
    const max = Math.max(0, (this.contentHeight || 0) - (this.height || 0));
    const next = Math.max(0, Math.min(max, y));
    const changed = next !== this.scrollY;
    this.scrollY = next;
    if (changed || !this.scrolled) this.headersInner.style.transform = `translateY(${-Math.round(next)}px)`;
    this.scrolled = true;
    if (changed || !silent) this.nav.update();
    if (changed && !silent) this.invalidate('lanes');
  }

  scrollBy(dy) {
    this.setScroll(this.scrollY + dy);
  }

  /** Makes a track row visible. */
  revealTrack(id) {
    const r = this.rowOf(id);
    if (!r) return;
    if (r.top < this.scrollY) this.setScroll(r.top);
    else if (r.top + r.total > this.scrollY + this.height) this.setScroll(r.top + r.total - this.height);
  }

  // ---------------------------------------------------------------- headers

  /** Creates, updates, orders and sizes the header DOM to match the state. */
  syncHeaders() {
    const state = this.doc.viewState;
    const rows = this.computeRows(state);
    const seen = new Set();
    const order = [];
    for (const r of rows) {
      seen.add(r.id);
      let hd = this.headers.get(r.id);
      if (!hd) {
        hd = new TrackHeader(this, r.track);
        hd.setMode(this.headerMode);
        this.headers.set(r.id, hd);
      } else if (hd.track !== r.track) hd.update(r.track);
      hd.setHeight(r.height, r.autoHeight);
      hd.setSelected(this.doc.selectedTrack === r.id);
      order.push(hd.el);
    }
    for (const [id, hd] of this.headers) {
      if (!seen.has(id)) {
        hd.el.remove();
        this.headers.delete(id);
      }
    }
    const current = [...this.headersInner.children];
    if (current.length !== order.length || current.some((el, i) => el !== order[i])) this.headersInner.replaceChildren(...order);
  }

  setTrackHeight(id, height, { minimize } = {}) {
    const doc = this.doc;
    const patch = { height };
    if (minimize !== undefined) patch.minimized = minimize;
    else patch.minimized = false;
    // Track heights are view state: they change the current step instead of adding one.
    doc.amendView((st) => S.updateTrack(st, id, patch));
  }

  showReorder(id, clientY) {
    const rect = this.headersEl.getBoundingClientRect();
    const y = clientY - rect.top + this.scrollY;
    const tracks = this.rows.filter((r) => r.track.type !== 'master');
    let index = tracks.length;
    for (let i = 0; i < tracks.length; i++) {
      if (y < tracks[i].top + tracks[i].total / 2) {
        index = i;
        break;
      }
    }
    const lineY = index < tracks.length ? tracks[index].top : tracks.length ? tracks[tracks.length - 1].top + tracks[tracks.length - 1].total : 0;
    // The track the line sits above (null: after the last one); hidden tracks have no row.
    this.reorder = { id, index, before: tracks[index]?.id ?? null };
    this.reorderLine.hidden = false;
    this.reorderLine.style.transform = `translateY(${lineY - this.scrollY}px)`;
  }

  finishReorder(id, clientY) {
    this.reorderLine.hidden = true;
    const r = this.reorder;
    this.reorder = null;
    if (!r || clientY === null) return;
    const tracks = this.doc.state.tracks;
    const from = tracks.findIndex((t) => t.id === id);
    const before = r.before === null ? -1 : tracks.findIndex((t) => t.id === r.before);
    let to = before < 0 ? tracks.length : before;
    if (to > from) to--;
    if (to !== from) this.doc.apply('Move Track', S.reorderTrack(this.doc.state, id, to));
  }

  // ------------------------------------------------------------ coordinates

  get fpp() {
    const v = this.doc.view;
    return (v.end - v.start) / (this.width || 1);
  }

  xOf(frame) {
    return (frame - this.doc.view.start) / this.fpp;
  }

  frameAt(x) {
    return this.doc.view.start + x * this.fpp;
  }

  /** Snap candidates (frames) honouring prefs; `exclude` is a Set of clip ids. */
  snapTargets(exclude) {
    const prefs = this.app.prefs;
    const snap = prefs.get('snap');
    const doc = this.doc;
    const out = [0, doc.cursor];
    if (doc.hasSelection) out.push(doc.selection.start, doc.selection.end);
    if (snap.markers) for (const m of doc.state.markers) out.push(m.start, m.start + m.duration);
    if (snap.clips) {
      for (const c of doc.state.clips) {
        if (exclude && exclude.has(c.id)) continue;
        out.push(c.start, S.clipEnd(c));
      }
    }
    if (snap.loops) {
      for (const c of doc.state.clips) {
        if (!c.loop || (exclude && exclude.has(c.id))) continue;
        const len = doc.sourceLength(c.sourceId);
        if (len > 0) for (let t = c.start - c.offset + len; t < S.clipEnd(c) && out.length < 5000; t += len) out.push(t);
      }
    }
    return out;
  }

  rulerStepFrames() {
    const rate = this.doc.sampleRate;
    if (this.app.prefs.get('timeFormat') === 'bars') {
      const music = this.app.timeOptions();
      return musicalStep(this.fpp, rate, { ...music, tempo: this.doc.state.tempo || music.tempo, beatsPerBar: this.doc.state.beatsPerBar || music.beatsPerBar }, 12);
    }
    const secPerPx = this.fpp / rate;
    const steps = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60];
    return (steps.find((s) => s / secPerPx >= 12) || 60) * rate;
  }

  /** Snaps a frame; returns the frame (and records the snap line for display). */
  snap(frame, { exclude, force, off } = {}) {
    if (off || (!this.app.prefs.get('snapping') && !force)) return Math.round(frame);
    const tol = this.fpp * 8;
    let best = Math.round(frame);
    let bestD = tol;
    const consider = (f) => {
      const d = Math.abs(f - frame);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    };
    const excludeSet = exclude instanceof Set ? exclude : null;
    for (const f of this.snapTargets(excludeSet)) consider(f);
    if (typeof exclude === 'string') {
      // Markers dragged on the ruler pass their own id.
      bestD = tol;
      best = Math.round(frame);
      for (const m of this.doc.state.markers) if (m.id !== exclude) consider(m.start);
      consider(0);
    }
    if (bestD === tol) for (const step of this.gridSteps()) consider(Math.round(Math.round(frame / step) * step));
    return Math.round(best);
  }

  /** Grid spacings (frames) that edges snap to: ruler ticks (coarse or fine) and video frames. */
  gridSteps() {
    const snap = this.app.prefs.get('snap');
    const out = [];
    if (snap.ruler) out.push(this.rulerStepFrames());
    if (snap.rulerFine) out.push(this.rulerStepFrames() / 10);
    const fps = snap.frames ? framesPerSecond(this.app.prefs) : 0;
    if (fps) out.push(this.doc.sampleRate / fps);
    return out;
  }

  /** Best snap adjustment for a set of moving edges. Returns the delta to add. */
  snapDelta(edges, exclude, off) {
    if (off || !this.app.prefs.get('snapping')) return { delta: 0, at: null };
    const tol = this.fpp * 8;
    let best = { delta: 0, at: null, d: tol };
    const targets = this.snapTargets(exclude);
    for (const step of this.gridSteps()) for (const e of edges) targets.push(Math.round(Math.round(e / step) * step));
    for (const e of edges) {
      for (const t of targets) {
        const d = Math.abs(t - e);
        if (d < best.d) best = { delta: t - e, at: t, d };
      }
    }
    return best;
  }

  // ----------------------------------------------------------------- render

  invalidate(part) {
    if (!part) for (const k of Object.keys(this.dirty)) this.dirty[k] = true;
    else if (part === 'lanes') {
      this.dirty.bg = true;
      this.dirty.wave = true;
      this.dirty.overlay = true;
    } else this.dirty[part] = true;
    this.app.requestRender?.();
  }

  frame() {
    if (!this.width) return;
    const doc = this.doc;
    const playing = this.app.engine.playing && this.app.active === doc;
    if (playing) this.#autoScroll();
    this.videoLane.frame();
    if (this.dirty.bg) this.#drawBg();
    if (this.dirty.wave) this.#drawWaves();
    if (this.dirty.overlay) this.#drawOverlay();
    if (this.dirty.ruler) this.ruler.draw();
    if (this.dirty.overview) this.overview.draw();
    for (const k of Object.keys(this.dirty)) this.dirty[k] = false;
    this.#placePlayhead();
    // Meters and automated knobs follow playback.
    const now = performance.now();
    let metersActive = false;
    for (const hd of this.headers.values()) {
      if (playing) hd.updateValues();
      if (hd.meter.draw(now)) metersActive = true;
    }
    if (metersActive) this.app.requestRender?.();
  }

  #onMeters(m) {
    if (this.app.active !== this.doc) return;
    for (const [id, hd] of this.headers) {
      if (hd.track.type === 'master') hd.meter.feed(m.master);
      else hd.meter.feed(m.tracks.get(id) || [0, 0]);
    }
  }

  #autoScroll() {
    if (this.drag) return;
    followPlayhead(this.app, this.doc, this.app.prefs.get('scrollMulti'));
  }

  #placePlayhead() {
    const p = this.app.active === this.doc ? this.app.playhead : this.doc.cursor;
    const x = this.xOf(p);
    const visible = x >= -1 && x <= this.width + 1;
    this.playheadEl.style.transform = `translateX(${Math.round(x)}px)`;
    this.playheadEl.style.display = visible ? '' : 'none';
    this.rulerHandle.style.transform = `translateX(${Math.round(x)}px)`;
    this.rulerHandle.style.display = visible ? '' : 'none';
    this.overview.placePlayhead(p);
  }

  clipColor(c, track) {
    return c.color || track?.color || S.TRACK_COLORS[0];
  }

  /** True when the Move tool shows stretch handles on clip corners. */
  get stretchHandles() {
    return Boolean(this.app.prefs.get('clipStretching')) && this.app.tool === 'move';
  }

  /** Smallest inset of the fade handles from the clip edges (clear of the stretch handles). */
  get fadeInset() {
    return this.stretchHandles ? STRETCH_HANDLE + 5 : 4;
  }

  /** Visible clip rectangles (CSS px, lanes coordinates) for the current state. */
  clipRects(state = this.doc.viewState) {
    const out = [];
    const v = this.doc.view;
    const rowById = new Map(this.rows.map((r) => [r.id, r]));
    const order = S.frontOrder(state);
    const clips = state.clips.slice().sort((a, b) => order.get(a.id) - order.get(b.id));
    for (const c of clips) {
      const row = rowById.get(c.trackId);
      if (!row) continue;
      if (S.clipEnd(c) < v.start || c.start > v.end) continue;
      const y = row.top - this.scrollY;
      if (y + row.height < 0 || y > this.height) continue;
      const x0 = this.xOf(c.start);
      const x1 = this.xOf(S.clipEnd(c));
      const hb = row.height >= 36 ? HEADER_BAR : 0;
      out.push({ clip: c, row, x0, x1, y: y + 1, h: row.height - 2, hb, wy: y + 1 + hb, wh: row.height - 2 - hb });
    }
    return out;
  }

  #drawBg() {
    const ctx = this.bgCanvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.dpr || 1;
    const W = this.width;
    const H = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--bg-editor');
    ctx.fillRect(0, 0, W, H);
    const doc = this.doc;
    const state = doc.viewState;
    const dark = resolvedTheme() === 'dark';
    for (const [i, r] of this.rows.entries()) {
      const y = r.top - this.scrollY;
      if (y > H || y + r.total < 0) continue;
      ctx.fillStyle = r.track.type === 'master' ? cssVar('--bg-panel-alt') : i % 2 ? cssVar('--bg-track-alt') : cssVar('--bg-track');
      ctx.fillRect(0, y, W, r.height);
      if (doc.selectedTrack === r.id) {
        ctx.fillStyle = cssVar('--grid');
        ctx.fillRect(0, y, W, r.height);
      }
      if (r.autoHeight) {
        ctx.fillStyle = cssVar('--bg-panel-alt');
        ctx.fillRect(0, y + r.height, W, r.autoHeight);
      }
      ctx.fillStyle = cssVar('--border');
      ctx.fillRect(0, y + r.total - 1, W, 1);
    }
    // Bar and beat grid when the time display uses bars.
    if (this.app.prefs.get('timeFormat') === 'bars') {
      const step = this.rulerStepFrames();
      ctx.fillStyle = cssVar('--grid');
      for (let f = Math.ceil(doc.view.start / step) * step; f < doc.view.end; f += step) ctx.fillRect(Math.round(this.xOf(f)), 0, 1, H);
    }
    // Time selection across tracks.
    const sel = doc.selection;
    if (sel.end > sel.start) {
      const x0 = Math.max(0, this.xOf(sel.start));
      const x1 = Math.min(W, this.xOf(sel.end));
      if (x1 > x0) {
        ctx.fillStyle = cssVar('--accent-soft');
        ctx.fillRect(x0, 0, x1 - x0, Math.min(H, this.contentHeight - this.scrollY));
      }
    }
    // Clip bodies.
    for (const r of this.clipRects(state)) {
      const c = r.clip;
      const selected = doc.selectedClips.has(c.id);
      const color = this.clipColor(c, r.row.track);
      const offline = !doc.pool.get(c.sourceId)?.channels?.length;
      const x0 = Math.max(-2, r.x0);
      const x1 = Math.min(W + 2, r.x1);
      ctx.globalAlpha = c.mute ? 0.12 : selected ? 0.5 : dark ? 0.3 : 0.24;
      ctx.fillStyle = c.mute || offline ? cssVar('--text-faint') : color;
      ctx.fillRect(x0, r.y, x1 - x0, r.h);
      if (r.hb) {
        ctx.globalAlpha = c.mute ? 0.3 : selected ? 0.95 : 0.7;
        ctx.fillRect(x0, r.y, x1 - x0, r.hb);
      }
      ctx.globalAlpha = 1;
      if (offline) {
        ctx.strokeStyle = cssVar('--danger');
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        for (let x = x0 - (x0 % 12); x < x1; x += 12) {
          ctx.moveTo(x, r.y + r.h);
          ctx.lineTo(x + Math.min(r.h, 40), r.y + r.h - Math.min(r.h, 40));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  #waveColor(color, muted) {
    if (muted) return cssVar('--text-faint');
    const [r, g, b] = parseColor(color);
    const dark = resolvedTheme() === 'dark';
    const mix = (v) => Math.round(255 * (dark ? v + (1 - v) * 0.45 : v * 0.55));
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  #drawWaves() {
    const rd = this.renderer;
    rd.clear();
    const dpr = this.dpr || 1;
    const fppDev = this.fpp / dpr;
    const doc = this.doc;
    const band = { y0: 0, y1: Math.round(this.height * dpr) };
    for (const r of this.clipRects()) {
      const c = r.clip;
      const src = doc.pool.get(c.sourceId);
      if (!src?.channels?.length || r.wh < 4) continue;
      const chs = src.channels;
      const srcLen = chs[0].length;
      const color = this.#waveColor(this.clipColor(c, r.row.track), c.mute);
      // Preferences > Multitrack Clips: the drawn waveform can follow clip gain or stay at unity.
      const amp = this.app.prefs.get('clipGainWaveform') === false ? 1 : Math.min(8, Math.pow(10, c.gain / 20));
      // Contiguous source segments: one for a plain clip, one per repeat for a loop.
      const segs = [];
      const vs = Math.max(c.start, doc.view.start - this.fpp * 2);
      const ve = Math.min(S.clipEnd(c), doc.view.end + this.fpp * 2);
      // While a stretch handle is dragged the clip previews its current audio squeezed or spread.
      const k = !c.loop && c.stretchPreview > 0 ? c.stretchPreview : 1;
      if (!c.loop) segs.push({ a: vs, b: Math.min(ve, c.start + (srcLen - c.offset) * k), off: c.offset + (vs - c.start) / k });
      else if (srcLen > 0) {
        let t = vs;
        let guard = 0;
        while (t < ve && guard++ < 4000) {
          const pos = (c.offset + (t - c.start)) % srcLen;
          const n = Math.min(ve - t, srcLen - pos);
          segs.push({ a: t, b: t + n, off: pos });
          t += n;
        }
      }
      const lanes = chs.length;
      const laneH = (r.wh * dpr) / lanes;
      for (const s of segs) {
        if (s.b <= s.a) continue;
        const px0 = Math.max(0, Math.floor(this.xOf(s.a) * dpr));
        const px1 = Math.min(Math.round(this.width * dpr), Math.ceil(this.xOf(s.b) * dpr));
        if (px1 <= px0) continue;
        const srcStart = s.off + (doc.view.start + (px0 / dpr) * this.fpp - s.a) / k;
        for (let i = 0; i < lanes; i++) {
          const rect = { x: px0, y: r.wy * dpr + i * laneH, w: px1 - px0, h: laneH };
          rd.drawChannel(chs[i], srcStart, fppDev / k, rect, amp, color, band);
        }
      }
    }
  }

  #envY(r, param, v) {
    const pos = param === 'pan' ? panToEnvPos(v) : volumeToEnvPos(v);
    return r.wy + 2 + (1 - pos) * Math.max(1, r.wh - 4);
  }

  #envValue(r, param, y) {
    const pos = 1 - (y - r.wy - 2) / Math.max(1, r.wh - 4);
    return param === 'pan' ? Math.round(envPosToPan(pos)) : Math.round(envPosToVolume(pos) * 10) / 10;
  }

  #autoY(row, param, v) {
    const top = row.autoTop - this.scrollY + 4;
    const hh = row.autoHeight - 8;
    const pos = param === 'pan' ? panToEnvPos(v) : volumeToEnvPos(v);
    return top + (1 - pos) * hh;
  }

  #autoValue(row, param, y) {
    const top = row.autoTop - this.scrollY + 4;
    const pos = 1 - (y - top) / (row.autoHeight - 8);
    return param === 'pan' ? Math.round(envPosToPan(pos)) : Math.round(envPosToVolume(pos) * 10) / 10;
  }

  /**
   * Seam marks of a remixed clip at its segment joins (`seams`, frames from
   * the clip start): a faint dashed line through the waveform with a small
   * zig-zag stitch at its top and bottom. Joins closer than a few pixels to
   * the previous mark are skipped.
   */
  #drawSeams(ctx, r, seams, accent, line) {
    const W = this.width;
    const top = r.wy;
    const bot = r.wy + r.wh;
    const z = Math.min(9, Math.max(5, r.wh / 6));
    let lastX = -Infinity;
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, r.x0), top, Math.min(W, r.x1) - Math.max(0, r.x0), r.wh);
    ctx.clip();
    for (const t of seams) {
      const x = Math.round(r.x0 + t / this.fpp) + 0.5;
      if (x < 0 || x > W || x - lastX < 6) continue;
      lastX = x;
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top + z + 1);
      ctx.lineTo(x, bot - z - 1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 1.5;
      for (const [y0, dir] of [[top + 1, 1], [bot - 1, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x - 2.5, y0 + dir * (z / 3));
        ctx.lineTo(x + 2.5, y0 + dir * ((2 * z) / 3));
        ctx.lineTo(x, y0 + dir * z);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }

  #drawOverlay() {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    const dpr = this.dpr || 1;
    const W = this.width;
    const H = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const doc = this.doc;
    const state = doc.viewState;
    const prefs = this.app.prefs;
    ctx.font = CANVAS_FONT;
    ctx.textBaseline = 'middle';
    const showVol = prefs.get('clipVolumeEnvelopes') !== false;
    const showPan = Boolean(prefs.get('clipPanEnvelopes'));
    const showFades = prefs.get('clipFadeHandles') !== false;
    const volColor = cssVar('--envelope-vol');
    const panColor = cssVar('--envelope-pan');
    const textColor = cssVar('--text-strong');
    const selEdge = cssVar('--sel-edge');
    const accent = cssVar('--accent');
    const stretchHandles = this.stretchHandles;
    // Fades as heard: overlapping clips crossfade over their overlap.
    const plan = clipPlan(state);
    for (const r of this.clipRects(state)) {
      const c = r.clip;
      const selected = doc.selectedClips.has(c.id);
      const eff = plan.get(c.id) || c;
      const x0 = r.x0;
      const x1 = r.x1;
      const w = x1 - x0;
      // Outline.
      ctx.strokeStyle = selected ? accent : cssVar('--border-soft');
      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(r.y) + 0.5, Math.max(1, Math.round(w) - 1), Math.max(1, Math.round(r.h) - 1));
      ctx.lineWidth = 1;
      // Fades: curve and shaded region above it.
      const fadeIn = c.fadeIn.length;
      const fadeOut = c.fadeOut.length;
      const effIn = eff.fadeIn;
      const effOut = eff.fadeOut;
      const drawFade = (dir, len, curve) => {
        if (len <= 0) return;
        const fx0 = dir === 'in' ? x0 : x1 - len / this.fpp;
        const fx1 = dir === 'in' ? x0 + len / this.fpp : x1;
        if (fx1 < 0 || fx0 > W) return;
        const top = r.wy;
        const bot = r.wy + r.wh;
        ctx.beginPath();
        const steps = 32;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const g = fadeShape(dir === 'in' ? t : 1 - t, curve);
          const x = fx0 + (fx1 - fx0) * t;
          const y = bot - g * (bot - top);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = volColor;
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.lineTo(dir === 'in' ? fx1 : fx1, top);
        ctx.lineTo(fx0, top);
        ctx.closePath();
        ctx.fillStyle = cssVar('--overlay');
        ctx.globalAlpha = 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;
      };
      if (r.wh > 6) {
        drawFade('in', effIn.length, effIn.curve);
        drawFade('out', effOut.length, effOut.curve);
      }
      if (r.wh > 12 && isRemixed(c) && !c.remixPreview) this.#drawSeams(ctx, r, remixSeams(c), accent, textColor);
      // Header: name, state glyphs, gain readout, fade handles.
      if (r.hb && w > 6) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.max(0, x0), r.y, Math.min(W, x1) - Math.max(0, x0), r.hb);
        ctx.clip();
        // Text moves inward to clear the fade handles (further in when stretch
        // handles show), and past a fade handle that sits further in.
        const pad = 10 + this.fadeInset;
        const handles = showFades && w > 18;
        const hIn = x0 + Math.max(this.fadeInset, fadeIn / this.fpp);
        const hOut = x1 - Math.max(this.fadeInset, fadeOut / this.fpp);
        let tx = Math.max(0, x0) + pad;
        if (handles && hIn + 7 > tx - 4) tx = Math.max(tx, Math.min(hIn + 8, x0 + w * 0.5));
        const textEnd = handles && hOut - 7 < Math.min(W, x1) - pad ? Math.max(hOut - 8, x0 + w * 0.5) : Math.min(W, x1) - pad;
        ctx.fillStyle = textColor;
        const st = stretchOf(c);
        const pending = doc.pool.get(c.sourceId)?.pending;
        const stretchText = c.stretchPreview ? `  (stretch ${Math.round((stretchActive(st) ? st.ratio : 1) * c.stretchPreview * 1000) / 10}%)` : stretchActive(st) ? `  (${pending ? 'stretching… ' : ''}${Math.round(st.ratio * 1000) / 10}%${st.semitones ? ` ${st.semitones > 0 ? '+' : ''}${st.semitones} st` : ''})` : '';
        // While the right edge of a remixed clip is dragged, the header shows the new target.
        const remixText = c.remixPreview ? `  (remix to ${this.app.formatTime(c.length, doc.sampleRate)})` : '';
        const label = c.name + (c.loop ? '  (loop)' : '') + (c.locked ? '  (locked)' : '') + stretchText + remixText;
        ctx.fillText(label, tx, r.y + r.hb / 2 + 0.5);
        const type = c.soundAssistant && ASSISTANT_TYPES[c.soundAssistant.type];
        // Keep the badges clear of the gain readout (shown on wider clips).
        const gainShown = w > 90 && prefs.get('clipGainControls') !== false;
        const room = gainShown ? textEnd - ctx.measureText(formatGain(c.gain)).width - 6 : Math.min(W, x1) - 8;
        let bx = tx + ctx.measureText(label).width + 6;
        if (isRemixed(c)) {
          // Remix badge: an outlined accent tag (it reads "remixing" until the crossfaded render is done).
          const text = pending ? 'remixing…' : 'remix';
          const bw = ctx.measureText(text).width + 10;
          if (bx + bw <= room) {
            ctx.fillStyle = accent;
            ctx.globalAlpha = 0.16;
            ctx.fillRect(bx, r.y + 2, bw, r.hb - 4);
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = accent;
            ctx.strokeRect(Math.round(bx) + 0.5, r.y + 2.5, Math.round(bw) - 1, r.hb - 5);
            ctx.globalAlpha = 1;
            ctx.fillStyle = textColor;
            ctx.fillText(text, bx + 5, r.y + r.hb / 2 + 0.5);
          }
          bx += bw + 4;
        }
        const bw = type ? ctx.measureText(type.label).width + 8 : 0;
        if (type && bx + bw <= room) {
          // Sound Assistant audio type badge after the name.
          ctx.globalAlpha = 0.22;
          ctx.fillRect(bx, r.y + 2, bw, r.hb - 4);
          ctx.globalAlpha = 1;
          ctx.fillText(type.label, bx + 4, r.y + r.hb / 2 + 0.5);
        }
        if (gainShown) {
          // Clip gain readout; drag it up or down to change the gain.
          const g = formatGain(c.gain);
          const gw = ctx.measureText(g).width;
          ctx.globalAlpha = Math.abs(c.gain) >= 0.05 ? 1 : 0.55;
          ctx.fillText(g, textEnd - gw, r.y + r.hb / 2 + 0.5);
          ctx.globalAlpha = 1;
        }
        ctx.restore();
        if (handles) {
          ctx.fillStyle = textColor;
          ctx.fillRect(Math.round(hIn - 3), r.y + 4, 7, 7);
          ctx.fillRect(Math.round(hOut - 4), r.y + 4, 7, 7);
        }
      }
      // Stretch handles: triangles in the top corners.
      if (stretchHandles && !c.locked && !c.remix && w > STRETCH_HANDLE * 2.5 && r.h > STRETCH_HANDLE + 4) {
        ctx.fillStyle = selected ? accent : textColor;
        ctx.globalAlpha = selected ? 0.95 : 0.55;
        ctx.beginPath();
        ctx.moveTo(x0 + 1, r.y + 1);
        ctx.lineTo(x0 + 1 + STRETCH_HANDLE, r.y + 1);
        ctx.lineTo(x0 + 1, r.y + 1 + STRETCH_HANDLE);
        ctx.closePath();
        ctx.moveTo(x1 - 1, r.y + 1);
        ctx.lineTo(x1 - 1 - STRETCH_HANDLE, r.y + 1);
        ctx.lineTo(x1 - 1, r.y + 1 + STRETCH_HANDLE);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Clip envelopes.
      if (r.wh > 14) {
        const env = (param, color, points, fallback) => {
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.beginPath();
          if (!points.length) {
            const y = this.#envY(r, param, fallback);
            ctx.moveTo(Math.max(0, x0), y);
            ctx.lineTo(Math.min(W, x1), y);
          } else {
            points.forEach((p, i) => {
              const x = x0 + p.t / this.fpp;
              const y = this.#envY(r, param, p.v);
              if (i === 0) {
                ctx.moveTo(x0, y);
                ctx.lineTo(x, y);
              } else ctx.lineTo(x, y);
            });
            ctx.lineTo(x1, this.#envY(r, param, points[points.length - 1].v));
          }
          ctx.stroke();
          const sk = doc.selectedKeys;
          for (const [i, p] of points.entries()) {
            const x = x0 + p.t / this.fpp;
            if (x < -4 || x > W + 4) continue;
            const y = this.#envY(r, param, p.v);
            const on = sk && sk.owner === c.id && sk.param === param && sk.indices.has(i);
            if (on) ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
            else ctx.strokeRect(x - 3, y - 3, 6, 6);
          }
        };
        if (showVol) env('volume', volColor, c.volumeEnv, 0);
        if (showPan) env('pan', panColor, c.panEnv, 0);
      }
    }
    // Automation lanes.
    for (const row of this.rows) {
      if (!row.autoHeight) continue;
      const top = row.autoTop - this.scrollY;
      if (top > H || top + row.autoHeight < 0) continue;
      const t = row.track;
      const param = t.type === 'master' ? 'volume' : t.autoParam;
      const pts = t.automation[param];
      const color = param === 'pan' ? panColor : volColor;
      ctx.fillStyle = cssVar('--text-dim');
      ctx.fillText(`${param === 'pan' ? 'Pan' : 'Volume'}${t.mode === 'off' ? ' (off)' : ''}`, 6, top + 9);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = t.mode === 'off' ? 0.45 : 1;
      ctx.beginPath();
      if (!pts.length) {
        const y = this.#autoY(row, param, t[param]);
        ctx.setLineDash([4, 3]);
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.moveTo(0, this.#autoY(row, param, pts[0].v));
        for (const p of pts) ctx.lineTo(this.xOf(p.t), this.#autoY(row, param, p.v));
        ctx.lineTo(W, this.#autoY(row, param, pts[pts.length - 1].v));
        ctx.stroke();
        const sk = doc.selectedKeys;
        pts.forEach((p, i) => {
          const x = this.xOf(p.t);
          if (x < -4 || x > W + 4) return;
          const y = this.#autoY(row, param, p.v);
          if (sk && sk.owner === t.id && sk.param === param && sk.indices.has(i)) ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
          else ctx.strokeRect(x - 3, y - 3, 6, 6);
        });
      }
      ctx.globalAlpha = 1;
    }
    // Markers (lines across the tracks can be hidden in Preferences > Markers & Metadata).
    for (const m of this.app.prefs.get('showMarkerLines') !== false ? this.markers() : []) {
      const x = Math.round(this.xOf(m.start)) + 0.5;
      if (m.duration) {
        const x2 = this.xOf(m.start + m.duration);
        if (x2 >= 0 && x <= W) {
          ctx.fillStyle = cssVar('--marker-range');
          ctx.fillRect(x, 0, x2 - x, H);
        }
      }
      if (x < 0 || x > W) continue;
      ctx.strokeStyle = markerColor(m.type);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Time selection edges.
    const sel = doc.selection;
    if (sel.end > sel.start) {
      ctx.fillStyle = selEdge;
      const xa = this.xOf(sel.start);
      const xb = this.xOf(sel.end);
      if (xa >= 0 && xa <= W) ctx.fillRect(Math.round(xa), 0, 1, H);
      if (xb >= 0 && xb <= W) ctx.fillRect(Math.round(xb) - 1, 0, 1, H);
    }
    // Rubber band, snap line, drop and razor hints.
    if (this.drag?.kind === 'marquee' && this.drag.rect) {
      const q = this.drag.rect;
      ctx.strokeStyle = selEdge;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(q.x + 0.5, q.y + 0.5, q.w, q.h);
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--accent-soft');
      ctx.fillRect(q.x, q.y, q.w, q.h);
    }
    if (this.snapLine !== null && this.snapLine !== undefined) {
      const x = Math.round(this.xOf(this.snapLine)) + 0.5;
      ctx.strokeStyle = cssVar('--text-strong');
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (this.dropHint) {
      const d = this.dropHint;
      const row = this.rowOf(d.trackId);
      const y = row ? row.top - this.scrollY : this.contentHeight - this.scrollY;
      const hh = row ? row.height : 60;
      const x = this.xOf(d.at);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y + 2, Math.max(8, d.length ? d.length / this.fpp : 120), hh - 4);
      ctx.lineWidth = 1;
    }
    if (this.hover?.razorX != null) {
      const x = Math.round(this.hover.razorX) + 0.5;
      const row = this.hover.row;
      ctx.strokeStyle = cssVar('--playhead');
      ctx.beginPath();
      if (this.hover.all) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      } else if (row) {
        ctx.moveTo(x, row.top - this.scrollY);
        ctx.lineTo(x, row.top - this.scrollY + row.height);
      }
      ctx.stroke();
    }
    // Past the content end of the last track.
    const below = this.contentHeight - this.scrollY;
    if (below < H) {
      ctx.fillStyle = cssVar('--bg-panel-alt');
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, below, W, H - below);
      ctx.globalAlpha = 1;
    }
  }

  #overviewPeaks(cols, total) {
    const state = this.doc.state;
    if (!state.clips.length) return null;
    const out = new Float32Array(cols * 2).fill(NaN);
    const fpp = total / cols;
    const tmp = new Float32Array(cols * 2);
    for (const c of state.clips) {
      if (c.mute) continue;
      const src = this.doc.pool.get(c.sourceId);
      if (!src?.channels?.length) continue;
      const c0 = Math.max(0, Math.floor(c.start / fpp));
      const c1 = Math.min(cols, Math.ceil(S.clipEnd(c) / fpp));
      if (c1 <= c0) continue;
      const n = c1 - c0;
      const len = src.channels[0].length;
      const start = c.offset + (c0 * fpp - c.start);
      const cols2 = channelColumns(src.channels[0], c.loop && len ? ((start % len) + len) % len : start, fpp, n, tmp);
      const g = Math.pow(10, c.gain / 20);
      for (let i = 0; i < n; i++) {
        let lo = cols2[2 * i];
        let hi = cols2[2 * i + 1];
        if (Number.isNaN(lo)) {
          if (!c.loop) continue;
          lo = -0.1;
          hi = 0.1;
        }
        const k = c0 + i;
        out[2 * k] = Number.isNaN(out[2 * k]) ? lo * g : Math.min(out[2 * k], lo * g);
        out[2 * k + 1] = Number.isNaN(out[2 * k + 1]) ? hi * g : Math.max(out[2 * k + 1], hi * g);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- hit tests

  /**
   * What is under lanes point (x, y): { row, clip, rect, part, param, index, auto }.
   * part: 'empty' | 'body' | 'header' | 'edgeIn' | 'edgeOut' | 'fadeIn' | 'fadeOut' | 'gain' | 'key' | 'line' | 'autoKey' | 'autoLine' | 'auto'
   */
  hitTest(x, y) {
    const row = this.rowAt(y);
    if (!row) return { part: 'none', row: null };
    const cy = y + this.scrollY;
    const doc = this.doc;
    if (cy >= row.autoTop && row.autoHeight) {
      const t = row.track;
      const param = t.type === 'master' ? 'volume' : t.autoParam;
      const pts = t.automation[param];
      for (let i = pts.length - 1; i >= 0; i--) {
        if (Math.abs(this.xOf(pts[i].t) - x) <= 5 && Math.abs(this.#autoY(row, param, pts[i].v) - y) <= 5) return { part: 'autoKey', row, param, index: i, auto: true };
      }
      const v = pts.length ? S.envelopeValue(pts, this.frameAt(x), t[param]) : t[param];
      if (Math.abs(this.#autoY(row, param, v) - y) <= 4) return { part: 'autoLine', row, param, auto: true };
      return { part: 'auto', row, param, auto: true };
    }
    const prefs = this.app.prefs;
    const rects = this.clipRects().filter((r) => r.row === row || r.row.id === row.id).reverse();
    for (const r of rects) {
      if (x < r.x0 - 2 || x > r.x1 + 2 || y < r.y || y > r.y + r.h) continue;
      const c = r.clip;
      const hit = { row, clip: c, rect: r };
      const showVol = prefs.get('clipVolumeEnvelopes') !== false;
      const showPan = Boolean(prefs.get('clipPanEnvelopes'));
      // A remixed clip has no stretch handles: its right edge retargets the remix instead.
      if (this.stretchHandles && !c.locked && !c.remix && r.x1 - r.x0 > STRETCH_HANDLE * 2.5 && y <= r.y + STRETCH_HANDLE + 2) {
        if (x <= r.x0 + STRETCH_HANDLE + 2) return { ...hit, part: 'stretchIn' };
        if (x >= r.x1 - STRETCH_HANDLE - 2) return { ...hit, part: 'stretchOut' };
      }
      if (r.hb && y <= r.y + r.hb) {
        const handles = prefs.get('clipFadeHandles') !== false;
        const hx1 = r.x1 - Math.max(this.fadeInset, c.fadeOut.length / this.fpp);
        if (handles) {
          const hx0 = r.x0 + Math.max(this.fadeInset, c.fadeIn.length / this.fpp);
          if (Math.abs(x - hx0) <= 6) return { ...hit, part: 'fadeIn' };
          if (Math.abs(x - hx1) <= 6) return { ...hit, part: 'fadeOut' };
        }
        // The gain readout ends before the fade-out handle (as drawn).
        const pad = 10 + this.fadeInset;
        const w = r.x1 - r.x0;
        const gainEnd = handles && w > 18 && hx1 - 7 < r.x1 - pad ? Math.max(hx1 - 8, r.x0 + w * 0.5) : r.x1 - pad;
        if (x > gainEnd - 52 && x < gainEnd + 4 && w > 90 && this.app.prefs.get('clipGainControls') !== false) return { ...hit, part: 'gain' };
        return { ...hit, part: 'header' };
      }
      // Keyframes first, then edges, then envelope lines.
      if (r.wh > 14) {
        const keys = (param, points) => {
          for (let i = points.length - 1; i >= 0; i--) {
            const px = r.x0 + points[i].t / this.fpp;
            if (Math.abs(px - x) <= 5 && Math.abs(this.#envY(r, param, points[i].v) - y) <= 5) return { ...hit, part: 'key', param, index: i };
          }
          return null;
        };
        const k = (showVol && keys('volume', c.volumeEnv)) || (showPan && keys('pan', c.panEnv));
        if (k) return k;
      }
      if (Math.abs(x - r.x0) <= EDGE) return { ...hit, part: 'edgeIn' };
      if (Math.abs(x - r.x1) <= EDGE) return { ...hit, part: 'edgeOut' };
      if (r.wh > 14) {
        const t = this.frameAt(x) - c.start;
        if (showVol && Math.abs(this.#envY(r, 'volume', S.envelopeValue(c.volumeEnv, t, 0)) - y) <= 3) return { ...hit, part: 'line', param: 'volume' };
        if (showPan && Math.abs(this.#envY(r, 'pan', S.envelopeValue(c.panEnv, t, 0)) - y) <= 3) return { ...hit, part: 'line', param: 'pan' };
      }
      return { ...hit, part: 'body' };
    }
    return { row, part: 'empty' };
  }

  #cursorFor(hit, e) {
    const tool = this.app.tool;
    if (!hit || hit.part === 'none') return 'default';
    if (tool === 'razor' && hit.clip) return 'crosshair';
    switch (hit.part) {
      case 'edgeIn':
      case 'edgeOut':
        return 'ew-resize';
      case 'stretchIn':
        return 'nw-resize';
      case 'stretchOut':
        return 'ne-resize';
      case 'fadeIn':
      case 'fadeOut':
      case 'key':
      case 'autoKey':
        return 'pointer';
      case 'gain':
        return 'ns-resize';
      case 'line':
      case 'autoLine':
        return 'copy';
      case 'header':
        return 'grab';
      case 'body':
        if (tool === 'slip') return 'ew-resize';
        if (tool === 'move') return e?.altKey ? 'copy' : 'grab';
        return 'text';
      default:
        return tool === 'time' ? 'text' : 'default';
    }
  }

  #updateCursor() {
    this.surface.style.cursor = this.app.tool === 'razor' ? 'crosshair' : '';
  }

  // ------------------------------------------------------------ interaction

  seek(frame) {
    frame = Math.max(0, Math.min(this.doc.extent, Math.round(frame)));
    if (this.app.engine.playing && this.app.active === this.doc) {
      this.app.engine.seek(frame);
      this.app.playStart = frame;
    }
    this.doc.setCursor(frame);
  }

  selectMarker(id, { add = false } = {}) {
    if (!this.selectedMarkers || !add) this.selectedMarkers = new Set();
    if (id) this.selectedMarkers.add(id);
    this.app.emit('marker-selection', this.doc, this.selectedMarkers);
    this.invalidate('ruler');
  }

  moveMarker(id, start, preview) {
    if (preview) {
      this.markerPreview = { id, start: Math.round(start) };
      this.invalidate('ruler');
      this.invalidate('overlay');
      return;
    }
    this.markerPreview = null;
    const markers = this.doc.state.markers.map((m) => (m.id === id ? { ...m, start: Math.round(start) } : m));
    this.doc.apply('Move Marker', { ...this.doc.state, markers: sortMarkers(markers) });
  }

  markers() {
    const p = this.markerPreview;
    const list = this.doc.viewState.markers;
    if (!p) return list;
    return list.map((m) => (m.id === p.id ? { ...m, start: p.start } : m));
  }

  addMarker({ range = false } = {}) {
    const doc = this.doc;
    const sel = doc.selection;
    const start = range && sel.end > sel.start ? sel.start : this.app.engine.playing && this.app.active === doc ? Math.round(this.app.playhead) : doc.cursor;
    const duration = range && sel.end > sel.start ? sel.end - sel.start : 0;
    const m = createMarker({ start, duration, name: nextMarkerName(doc.state.markers) });
    doc.apply(range ? 'Add Range Marker' : 'Add Marker', { ...doc.state, markers: sortMarkers([...doc.state.markers, m]) });
    this.selectMarker(m.id);
    return m;
  }

  #onDocChange(e) {
    const k = e.kind;
    if (k === 'view') {
      // Horizontal zoom and scroll leave the rows alone; only track height zoom relays them out.
      if (this.doc.view.amp !== this.rowsAmp) this.syncHeaders();
      this.invalidate();
    } else if (k === 'edit' || k === 'history' || k === 'preview' || k === 'graph') {
      this.syncHeaders();
      this.invalidate();
    } else if (k === 'selection') {
      this.invalidate('bg');
      this.invalidate('overlay');
      this.invalidate('ruler');
      this.invalidate('overview');
    } else if (k === 'clip-selection') {
      for (const [id, hd] of this.headers) hd.setSelected(this.doc.selectedTrack === id);
      this.invalidate('bg');
      this.invalidate('overlay');
    } else if (k === 'cursor') {
      this.invalidate('overview');
      this.#placePlayhead();
      for (const hd of this.headers.values()) hd.updateValues();
    } else if (k === 'automation') {
      for (const hd of this.headers.values()) hd.updateValues();
    } else if (k === 'rename') this.surface.setAttribute('aria-label', `Multitrack session ${this.doc.name}`);
  }

  #local(e) {
    const rect = this.surface.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  #bindPointer() {
    const s = this.surface;
    const pointers = new Map();
    let pinch = null;
    let longPress = 0;
    let lastClick = { t: 0, x: 0, id: null };

    s.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { x, y } = this.#local(e);
      // Preferences > General: right-click can extend the time selection (Shift+right-click opens the menu).
      if (e.button === 2 && !e.shiftKey && this.app.prefs.get('rightClick') === 'extend') {
        this.extendSelectionTo(this.frameAt(x));
        return;
      }
      this.#contextAt(x, y, e.clientX, e.clientY);
    });

    s.addEventListener('pointerdown', (e) => {
      s.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        clearTimeout(longPress);
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.abs(a.x - b.x) || 1, mid: (a.x + b.x) / 2, view: { ...this.doc.view } };
        this.#cancelDrag();
        return;
      }
      if (e.button !== 0) return;
      const { x, y } = this.#local(e);
      const hit = this.hitTest(x, y);
      if (hit.part === 'none') {
        this.doc.selectClips([]);
        return;
      }
      if (hit.row) this.doc.selectTrack(hit.row.id);
      const now = performance.now();
      const dbl = hit.clip && now - lastClick.t < 400 && Math.abs(x - lastClick.x) < 6 && lastClick.id === hit.clip.id;
      lastClick = { t: now, x, id: hit.clip?.id ?? null };
      if (dbl && (hit.part === 'body' || hit.part === 'header')) {
        this.app.commands.run('clip.editSource', { id: hit.clip.id });
        return;
      }
      s.setPointerCapture(e.pointerId);
      if (hit.clip && (hit.part === 'body' || hit.part === 'header') && this.app.prefs.get('clipsToFront')) this.doc.raiseClips(S.expandGroups(this.doc.state, [hit.clip.id]));
      this.#startDrag(e, x, y, hit);
      if (e.pointerType === 'touch') {
        longPress = setTimeout(() => {
          if (this.drag && !this.drag.moved) {
            this.#cancelDrag();
            this.#contextAt(x, y, e.clientX, e.clientY);
          }
        }, 550);
      }
    });

    s.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.abs(a.x - b.x) || 1;
        const mid = (a.x + b.x) / 2;
        const rect = s.getBoundingClientRect();
        const v = pinch.view;
        const span = (v.end - v.start) * (pinch.dist / dist);
        const anchor = v.start + ((pinch.mid - rect.left) / this.width) * (v.end - v.start);
        const start = anchor - ((mid - rect.left) / this.width) * span;
        this.doc.setView(start, start + span);
        return;
      }
      const { x, y } = this.#local(e);
      if (!this.drag) {
        const hit = this.hitTest(x, y);
        s.style.cursor = this.#cursorFor(hit, e);
        const razor = this.app.tool === 'razor' && hit.clip ? { razorX: this.xOf(this.snap(this.frameAt(x), { off: e.metaKey || e.ctrlKey })), row: hit.row, all: e.shiftKey } : null;
        if (razor || this.hover?.razorX != null) {
          this.hover = razor;
          this.invalidate('overlay');
        }
        return;
      }
      if (!this.drag.moved) {
        const tol = e.pointerType === 'touch' ? 8 : 3;
        if (Math.abs(x - this.drag.x0) < tol && Math.abs(y - this.drag.y0) < tol) return;
        this.drag.moved = true;
        clearTimeout(longPress);
      }
      this.#dragMove(e, x, y);
      this.#edgeScroll(x, y);
    });

    const finish = (e, cancelled) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      clearTimeout(longPress);
      if (!this.drag) return;
      if (cancelled) this.#cancelDrag();
      else this.#dragEnd(e);
    };
    s.addEventListener('pointerup', (e) => finish(e, false));
    s.addEventListener('pointercancel', (e) => finish(e, true));
    s.addEventListener('lostpointercapture', (e) => {
      if (this.drag) finish(e, false);
    });
    s.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.invalidate('overlay');
      }
    });

    s.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { x } = this.#local(e);
        const v = this.doc.view;
        const span = v.end - v.start;
        if (e.altKey) {
          this.scrollBy(e.deltaY);
          return;
        }
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        if (Math.abs(dx) > Math.abs(e.deltaY) || e.shiftKey) {
          const shift = (dx / this.width) * span;
          this.doc.setView(v.start + shift, v.end + shift);
          return;
        }
        wheelZoom(this.app, this.doc, e, x, this.width);
      },
      { passive: false },
    );
  }

  /** Extends the time selection to `frame` from its far edge (or from the playhead). */
  extendSelectionTo(frame) {
    const doc = this.doc;
    const f = this.snap(Math.max(0, frame));
    const sel = doc.selection;
    const anchor = sel.end > sel.start ? (Math.abs(f - sel.start) < Math.abs(f - sel.end) ? sel.end : sel.start) : doc.cursor;
    doc.setSelection(anchor, f);
  }

  #contextAt(x, y, cx, cy) {
    const hit = this.hitTest(x, y);
    const doc = this.doc;
    if (hit.part === 'key' || hit.part === 'autoKey') {
      const owner = hit.auto ? hit.row.id : hit.clip.id;
      doc.selectedKeys = { owner, param: hit.param, indices: new Set([hit.index]) };
      this.invalidate('overlay');
      this.app.openMenu([{ type: 'cmd', label: 'Delete Keyframe', enabled: true, run: () => this.deleteSelectedKeys() }], { x: cx, y: cy, label: 'Keyframe' });
      return;
    }
    if (hit.clip) {
      if (!doc.selectedClips.has(hit.clip.id)) doc.selectClips([hit.clip.id]);
      contextMenu(this.app, CLIP_CONTEXT, cx, cy, 'Clip context menu');
      return;
    }
    if (hit.row) {
      doc.selectTrack(hit.row.id);
      contextMenu(this.app, LANE_CONTEXT, cx, cy, 'Track context menu');
    }
  }

  trackMenu(id, cx, cy) {
    this.doc.selectTrack(id);
    contextMenu(this.app, TRACK_CONTEXT, cx, cy, 'Track context menu');
  }

  #startDrag(e, x, y, hit) {
    const doc = this.doc;
    const tool = this.app.tool;
    const f = this.frameAt(x);
    const base = { x0: x, y0: y, f0: f, hit, moved: false, state0: doc.state };
    const fine = e.metaKey || e.ctrlKey;
    if (hit.part === 'autoKey' || hit.part === 'autoLine') {
      const t = hit.row.track;
      let pts = t.automation[hit.param].slice();
      let index = hit.index;
      if (hit.part === 'autoLine') {
        const v = this.#autoValue(hit.row, hit.param, y);
        pts.push({ t: Math.round(this.snap(f, { off: fine })), v });
        pts.sort((a, b) => a.t - b.t);
        index = pts.findIndex((p) => p.v === v && p.t === Math.round(this.snap(f, { off: fine })));
        doc.preview(S.setAutomation(doc.state, t.id, hit.param, pts));
      }
      doc.selectedKeys = { owner: t.id, param: hit.param, indices: new Set([index]) };
      this.drag = { ...base, kind: 'autoKey', trackId: t.id, param: hit.param, index, pts, added: hit.part === 'autoLine' };
      this.invalidate('overlay');
      return;
    }
    if (hit.part === 'auto') {
      this.drag = { ...base, kind: 'none' };
      return;
    }
    const c = hit.clip;
    if (!c) {
      // Empty lane: time selection (Time tool) or rubber band clip selection (Move tool).
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) doc.selectClips([]);
      if (tool === 'move' || tool === 'slip') this.drag = { ...base, kind: 'marquee', additive: e.shiftKey || e.metaKey || e.ctrlKey, initial: new Set(doc.selectedClips) };
      else this.drag = { ...base, kind: 'select', anchor: e.shiftKey && doc.hasSelection ? (Math.abs(f - doc.selection.start) < Math.abs(f - doc.selection.end) ? doc.selection.end : doc.selection.start) : this.snap(f), startRow: hit.row };
      return;
    }
    // Clip selection on press (Shift/Cmd toggles).
    const toggle = e.shiftKey || e.metaKey || e.ctrlKey;
    if (toggle && (hit.part === 'body' || hit.part === 'header') && tool !== 'razor') doc.selectClips([c.id], 'toggle');
    else if (!doc.selectedClips.has(c.id)) doc.selectClips([c.id]);
    if (tool === 'razor') {
      this.drag = { ...base, kind: 'razor', all: e.shiftKey, fine };
      return;
    }
    switch (hit.part) {
      case 'edgeIn':
      case 'edgeOut':
        // The right edge of a remixed clip (showing the remix from its start) sets a new remix length.
        this.drag = { ...base, kind: 'trim', id: c.id, edge: hit.part === 'edgeIn' ? 'in' : 'out', fine, remix: hit.part === 'edgeOut' && isRemixed(c) && c.offset === 0 && !c.locked };
        return;
      case 'stretchIn':
      case 'stretchOut':
        this.drag = { ...base, kind: 'stretch', id: c.id, edge: hit.part === 'stretchIn' ? 'in' : 'out', fine };
        return;
      case 'fadeIn':
      case 'fadeOut':
        {
          const fc = hit.part === 'fadeIn' ? c.fadeIn : c.fadeOut;
          // A new fade (from zero length) starts with the default curve from Preferences > General.
          this.drag = { ...base, kind: 'fade', id: c.id, dir: hit.part === 'fadeIn' ? 'in' : 'out', curve0: fc.length > 0 ? fc.curve : defaultFadeCurve(this.app) };
        }
        return;
      case 'gain':
        this.drag = { ...base, kind: 'gain', id: c.id, gain0: c.gain };
        return;
      case 'key':
      case 'line': {
        const key = hit.param === 'pan' ? 'panEnv' : 'volumeEnv';
        let pts = c[key].slice();
        let index = hit.index;
        if (hit.part === 'line') {
          const t = Math.round(this.snap(f, { off: fine }) - c.start);
          const v = S.envelopeValue(pts, t, 0);
          const ins = S.insertEnvelopePoint(pts, Math.max(0, Math.min(c.length, t)), v, c.length, 0);
          pts = ins.points;
          index = ins.index;
          doc.preview(S.setClipEnvelope(doc.state, c.id, hit.param, pts));
        }
        doc.selectedKeys = { owner: c.id, param: hit.param, indices: new Set([index]) };
        this.drag = { ...base, kind: 'key', id: c.id, param: hit.param, index, pts, added: hit.part === 'line' };
        this.invalidate('overlay');
        return;
      }
      default:
        break;
    }
    if (tool === 'slip' && hit.part === 'body') {
      this.drag = { ...base, kind: 'slip', id: c.id, fine };
      return;
    }
    if (tool === 'time' && hit.part === 'body') {
      // Time Selection tool: drag in a clip selects time; the clip header moves it.
      this.drag = { ...base, kind: 'select', anchor: e.shiftKey && doc.hasSelection ? doc.selection.start : this.snap(f), startRow: hit.row, clickClip: c.id };
      return;
    }
    const ids = [...doc.selectedClips];
    this.drag = { ...base, kind: 'move', ids, lead: c, rowIndex: this.#audioIndex(hit.row.id), copy: false };
  }

  /** Position among the shown audio tracks (clip moves skip hidden tracks). */
  #audioIndex(trackId) {
    return S.audioTracks(this.doc.state).filter((t) => !t.hidden).findIndex((t) => t.id === trackId);
  }

  #dragMove(e, x, y) {
    const d = this.drag;
    const doc = this.doc;
    const fine = e.metaKey || e.ctrlKey;
    const scale = fine ? 0.25 : 1;
    const df = (x - d.x0) * this.fpp * scale;
    const f = d.f0 + df;
    this.snapLine = null;
    switch (d.kind) {
      case 'move': {
        const exclude = new Set(d.ids);
        const moving = d.state0.clips.filter((c) => exclude.has(c.id) && !c.locked);
        const edges = moving.flatMap((c) => [c.start + df, S.clipEnd(c) + df]);
        const sn = this.snapDelta(edges, exclude, fine);
        const row = this.rowAt(y);
        const target = row && row.track.type === 'audio' ? this.#audioIndex(row.id) : d.lastTrackIndex ?? d.rowIndex;
        d.lastTrackIndex = target;
        d.copy = e.altKey;
        const dt = Math.round(df + sn.delta);
        doc.preview(S.moveClips(d.state0, d.ids, dt, target - d.rowIndex, { copy: d.copy }));
        this.snapLine = sn.at;
        d.dt = dt;
        this.#status(`Move ${dt >= 0 ? '+' : '-'}${this.app.formatTime(Math.abs(dt), doc.sampleRate)}`);
        break;
      }
      case 'trim': {
        const c = S.findClip(d.state0, d.id);
        const edge = d.edge === 'in' ? c.start : S.clipEnd(c);
        const to = this.snap(edge + df, { exclude: new Set([c.id]), off: fine });
        if (to !== Math.round(edge + df)) this.snapLine = to;
        if (d.remix) {
          // Remixed: lengthening or shortening asks for a new remix of that length (on release).
          const rate = doc.sampleRate;
          const length = Math.max(Math.round(MIN_REMIX_SECONDS * rate), Math.min(MAX_REMIX_SECONDS * rate, to - c.start));
          doc.preview(S.updateClips(d.state0, [d.id], { length, remixPreview: true }));
          d.target = length;
          this.#status(`Remix length ${this.app.formatTime(length, rate)}`);
          break;
        }
        doc.preview(S.trimClip(d.state0, d.id, d.edge, to, doc.sourceLength(c.sourceId)));
        break;
      }
      case 'stretch': {
        // Corner drag: the clip's audio speeds up or slows down to fill the new length.
        const c = S.findClip(d.state0, d.id);
        const st = stretchOf(c);
        const k0 = stretchActive(st) ? st.ratio : 1;
        const end = S.clipEnd(c);
        const minLen = Math.max(16, Math.ceil((c.length * MIN_RATIO) / k0));
        const maxLen = Math.max(minLen, Math.floor((c.length * MAX_RATIO) / k0));
        const edge = d.edge === 'in' ? c.start : end;
        const to = this.snap(edge + df, { exclude: new Set([c.id]), off: fine });
        if (to !== Math.round(edge + df)) this.snapLine = to;
        let start = c.start;
        let length;
        if (d.edge === 'out') length = Math.max(minLen, Math.min(maxLen, to - c.start));
        else {
          start = Math.max(Math.max(0, end - maxLen), Math.min(end - minLen, to));
          length = end - start;
        }
        const ratio = (k0 * length) / c.length;
        doc.preview(S.updateClips(d.state0, [d.id], { start, length, stretchPreview: length / c.length }));
        d.result = { start, ratio };
        this.#status(`Stretch ${Math.round(ratio * 1000) / 10}%`);
        break;
      }
      case 'slip': {
        const c = S.findClip(d.state0, d.id);
        doc.preview(S.slipClip(d.state0, d.id, df, doc.sourceLength(c.sourceId)));
        break;
      }
      case 'fade': {
        const c = S.findClip(d.state0, d.id);
        const len = d.dir === 'in' ? this.snap(c.start + Math.max(0, f - c.start), { exclude: new Set([c.id]), off: fine }) - c.start : S.clipEnd(c) - this.snap(S.clipEnd(c) - Math.max(0, S.clipEnd(c) - f), { exclude: new Set([c.id]), off: fine });
        const dy = d.y0 - y;
        let curve = d.curve0;
        if (Math.abs(dy) > 4) curve = Math.max(-1, Math.min(1, (d.curve0 === 2 ? 0 : d.curve0) + dy / 80));
        doc.preview(S.setFade(d.state0, [d.id], d.dir, { length: Math.max(0, len), curve: Math.round(curve * 100) / 100 }));
        const fc = S.findClip(doc.viewState, d.id)[d.dir === 'in' ? 'fadeIn' : 'fadeOut'];
        this.#status(`Fade ${d.dir === 'in' ? 'In' : 'Out'} ${this.app.formatTime(fc.length, doc.sampleRate)}`);
        break;
      }
      case 'gain': {
        const g = Math.max(-48, Math.min(24, Math.round((d.gain0 + (d.y0 - y) * 0.1) * 10) / 10));
        doc.preview(S.updateClips(d.state0, [d.id], { gain: g }));
        this.#status(`Clip Gain ${formatGain(g)}`);
        break;
      }
      case 'key': {
        const c = S.findClip(doc.viewState, d.id) || S.findClip(d.state0, d.id);
        const r = this.clipRects().find((q) => q.clip.id === d.id);
        if (!r) break;
        const pts = d.pts.slice();
        const lo = d.index > 0 ? pts[d.index - 1].t : 0;
        const hi = d.index < pts.length - 1 ? pts[d.index + 1].t : c.length;
        const t = Math.max(lo, Math.min(hi, Math.round(this.snap(c.start + (x - r.x0) * this.fpp, { exclude: new Set([c.id]), off: fine }) - c.start)));
        const v = this.#envValue(r, d.param, y);
        pts[d.index] = { t, v };
        doc.preview(S.setClipEnvelope(d.state0, d.id, d.param, pts));
        this.#status(d.param === 'pan' ? `Pan ${formatPan(v)}` : `Volume ${formatGain(v)}`);
        break;
      }
      case 'autoKey': {
        const row = this.rowOf(d.trackId);
        const pts = d.pts.slice();
        const lo = d.index > 0 ? pts[d.index - 1].t : 0;
        const hi = d.index < pts.length - 1 ? pts[d.index + 1].t : Infinity;
        const t = Math.max(lo, Math.min(hi, this.snap(this.frameAt(x), { off: fine })));
        const v = this.#autoValue(row, d.param, y);
        pts[d.index] = { t, v };
        doc.preview(S.setAutomation(d.state0, d.trackId, d.param, pts));
        this.#status(d.param === 'pan' ? `Pan ${formatPan(v)}` : `Volume ${formatGain(v)}`);
        break;
      }
      case 'select': {
        const to = this.snap(this.frameAt(x), { off: fine });
        const rowA = d.startRow;
        const rowB = this.rowAt(Math.max(0, Math.min(this.height - 1, y))) || rowA;
        const i0 = this.rows.indexOf(rowA);
        const i1 = this.rows.indexOf(rowB);
        const tracks = this.rows.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map((r) => r.id);
        doc.setSelection(d.anchor, to, { tracks });
        if (!this.app.engine.playing) doc.setCursor(Math.min(d.anchor, to), { silent: true });
        const [a, b] = [Math.min(d.anchor, to), Math.max(d.anchor, to)];
        doc.selectedClips = new Set(S.clipsInRange(doc.state, a, b, tracks).map((c) => c.id));
        doc.emit('change', { kind: 'clip-selection' });
        break;
      }
      case 'marquee': {
        const rx = Math.min(d.x0, x);
        const ry = Math.min(d.y0, y);
        d.rect = { x: rx, y: ry, w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
        const hits = this.clipRects()
          .filter((r) => r.x1 >= rx && r.x0 <= rx + d.rect.w && r.y + r.h >= ry && r.y <= ry + d.rect.h)
          .map((r) => r.clip.id);
        doc.selectedClips = new Set([...(d.additive ? d.initial : []), ...hits]);
        doc.emit('change', { kind: 'clip-selection' });
        this.invalidate('overlay');
        break;
      }
      default:
        break;
    }
    this.invalidate('overlay');
  }

  #dragEnd(e) {
    const d = this.drag;
    this.drag = null;
    this.snapLine = null;
    const doc = this.doc;
    const { x } = this.#local(e);
    if (!d.moved) {
      doc.preview(null);
      this.#click(e, d, x);
      this.invalidate();
      return;
    }
    if (d.kind === 'trim' && d.remix) {
      this.#status('');
      const preview = doc.previewState;
      const c = S.findClip(doc.state, d.id);
      if (!preview || !c || !d.target || d.target === c.length) {
        doc.preview(null);
        this.invalidate();
        return;
      }
      // The preview stays up while the remix is planned (and the music analysed, the first time).
      runRemix(this.app, doc, 'Remix Clip Length', d.id, { target: d.target }).then((plan) => {
        if (!plan && doc.previewState === preview) doc.preview(null);
      });
      this.invalidate();
      return;
    }
    if (d.kind === 'stretch') {
      doc.preview(null);
      const c = S.findClip(doc.state, d.id);
      if (c && d.result) {
        const mode = stretchOf(c).mode;
        try {
          stretcherFor(this.app, doc).apply('Stretch Clip', [d.id], { mode: mode === 'off' ? (this.app.prefs.get('clipStretchMode') === 'rendered' ? 'rendered' : 'realtime') : mode, ratio: d.result.ratio, start: d.result.start });
          announce(`Clip stretched to ${Math.round(d.result.ratio * 1000) / 10}%`);
        } catch (err) {
          this.app.notify(err?.message || 'The clip could not be stretched.', { error: true });
        }
      }
      this.#status('');
      this.invalidate();
      return;
    }
    const labels = { move: d.copy ? 'Copy Clips' : d.ids?.length > 1 ? 'Move Clips' : 'Move Clip', trim: 'Trim Clip', slip: 'Slip Clip', fade: d.dir === 'in' ? 'Fade In' : 'Fade Out', gain: 'Clip Gain', key: d.param === 'pan' ? 'Pan Envelope' : 'Volume Envelope', autoKey: d.param === 'pan' ? 'Pan Automation' : 'Volume Automation' };
    const label = labels[d.kind];
    if (label && doc.previewState) {
      const state = doc.previewState;
      let clips;
      if (d.kind === 'move' && d.copy) clips = state.clips.slice(d.state0.clips.length).map((c) => c.id);
      doc.apply(label, state, clips ? { clips } : {});
      if (d.kind === 'move') announce(`${label} ${d.dt >= 0 ? 'right' : 'left'} by ${this.app.formatTime(Math.abs(d.dt || 0), doc.sampleRate)}`);
    } else doc.preview(null);
    this.#status('');
    this.invalidate();
  }

  /** A press and release without movement. */
  #click(e, d, x) {
    const doc = this.doc;
    const hit = d.hit;
    const f = this.frameAt(x);
    if (d.kind === 'razor') {
      const at = this.snap(f, { off: d.fine });
      const ids = d.all ? null : doc.selectedClips.has(hit.clip.id) ? [...doc.selectedClips] : [hit.clip.id];
      const next = S.splitClips(doc.state, ids, at);
      if (next !== doc.state) {
        doc.apply('Split', next);
        announce('Clip split');
      }
      return;
    }
    if (d.kind === 'key' || d.kind === 'autoKey') {
      if (d.added) {
        // A click on an envelope line adds a keyframe.
        const state = d.kind === 'key' ? S.setClipEnvelope(d.state0, d.id, d.param, d.pts) : S.setAutomation(d.state0, d.trackId, d.param, d.pts);
        doc.apply(d.kind === 'key' ? 'Add Keyframe' : 'Add Automation Keyframe', state);
      }
      return;
    }
    if (d.kind === 'marquee' || (d.kind === 'select' && !hit.clip)) {
      const at = this.snap(f);
      doc.setSelection(at, at, { tracks: hit.row ? [hit.row.id] : [] });
      this.seek(at);
      return;
    }
    if (d.kind === 'select' && hit.clip) {
      // Time tool click in a clip: place the playhead and select the clip.
      const at = this.snap(f);
      doc.setSelection(at, at);
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) doc.selectClips([hit.clip.id]);
      this.seek(at);
      return;
    }
    if (d.kind === 'move' && !(e.shiftKey || e.metaKey || e.ctrlKey)) doc.selectClips([hit.clip.id]);
  }

  #cancelDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.snapLine = null;
    this.doc.preview(null);
    this.#status('');
  }

  #edgeScroll(x, y) {
    const v = this.doc.view;
    const span = v.end - v.start;
    if (x < 0) this.doc.setView(v.start - span * 0.02, v.end - span * 0.02);
    else if (x > this.width) this.doc.setView(v.start + span * 0.02, v.end + span * 0.02);
    if (y < 0) this.scrollBy(-12);
    else if (y > this.height) this.scrollBy(12);
  }

  #status(text) {
    if (text) this.app.setStatus(text);
  }

  deleteSelectedKeys() {
    const doc = this.doc;
    const sk = doc.selectedKeys;
    if (!sk) return false;
    const clip = S.findClip(doc.state, sk.owner);
    let state;
    if (clip) {
      const key = sk.param === 'pan' ? 'panEnv' : 'volumeEnv';
      state = S.setClipEnvelope(doc.state, clip.id, sk.param, clip[key].filter((_, i) => !sk.indices.has(i)));
    } else {
      const t = S.findTrack(doc.state, sk.owner);
      if (!t) return false;
      state = S.setAutomation(doc.state, t.id, sk.param, t.automation[sk.param].filter((_, i) => !sk.indices.has(i)));
    }
    doc.selectedKeys = null;
    doc.apply('Delete Keyframe', state);
    return true;
  }

  #bindKeys() {
    this.surface.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const doc = this.doc;
      const step = e.altKey ? 1 : Math.max(1, Math.round(this.fpp * (e.shiftKey ? 1 : 10)));
      let handled = true;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey) {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) {
          const sel = doc.selection;
          const has = sel.end > sel.start;
          const anchor = has ? (doc.cursor === sel.end ? sel.start : sel.end) : doc.cursor;
          const moving = has ? (anchor === sel.start ? sel.end : sel.start) : doc.cursor;
          const next = Math.max(0, moving + dir * Math.max(1, Math.round(this.fpp * 10)));
          doc.setSelection(anchor, next);
          doc.setCursor(next, { silent: true });
        } else this.seek(doc.cursor + dir * step);
        this.#announcePosition();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
        const rows = this.rows;
        const i = rows.findIndex((r) => r.id === doc.selectedTrack);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))];
        if (next) {
          doc.selectTrack(next.id);
          this.revealTrack(next.id);
          announce(`Track ${next.track.name}`);
        }
      } else if (e.key === 'Tab') {
        if (!this.#focusNextClip(e.shiftKey ? -1 : 1)) handled = false;
      } else if (e.key === 'Escape') {
        doc.selectClips([]);
        doc.selectedKeys = null;
        doc.setSelection(doc.cursor, doc.cursor);
      } else if (e.key === 'Enter' && doc.selectedClips.size) {
        this.app.commands.run('clip.editSource');
      } else if (e.key === 'F2' && doc.selectedClips.size) {
        this.app.commands.run('clip.rename');
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  #focusNextClip(dir) {
    const doc = this.doc;
    // Clips on hidden tracks cannot be seen, so Tab skips them.
    const shown = new Set(this.rows.map((r) => r.id));
    const clips = doc.state.clips.filter((c) => shown.has(c.trackId)).sort((a, b) => a.start - b.start || this.#audioIndex(a.trackId) - this.#audioIndex(b.trackId));
    if (!clips.length) return false;
    const cur = clips.findIndex((c) => doc.selectedClips.has(c.id));
    // Past the last (or before the first) clip, Tab leaves the editor as usual.
    const i = cur < 0 ? (dir > 0 ? 0 : -1) : cur + dir;
    if (i < 0 || i >= clips.length) return false;
    const next = clips[i];
    doc.selectClips([next.id]);
    this.revealTrack(next.trackId);
    const v = doc.view;
    if (next.start < v.start || next.start > v.end) {
      const span = v.end - v.start;
      doc.setView(next.start - span * 0.1, next.start - span * 0.1 + span);
    }
    const track = S.findTrack(doc.state, next.trackId);
    announce(`Clip ${next.name}${next.soundAssistant && ASSISTANT_TYPES[next.soundAssistant.type] ? ` (${ASSISTANT_TYPES[next.soundAssistant.type].label})` : ''} on ${track?.name}, ${this.app.formatTime(next.start, doc.sampleRate)} to ${this.app.formatTime(S.clipEnd(next), doc.sampleRate)}`);
    return true;
  }

  #announcePosition() {
    const doc = this.doc;
    const sel = doc.selection;
    const text = sel.end > sel.start ? `Selection ${this.app.formatTime(sel.start)} to ${this.app.formatTime(sel.end)}` : `Playhead ${this.app.formatTime(doc.cursor)}`;
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => announce(text), 250);
  }

  // ------------------------------------------------------------------- drop

  #bindDrop() {
    const s = this.surface;
    const accepts = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes('application/x-audio-studio-file') || types.includes('Files');
    };
    const place = (e) => {
      const { x, y } = this.#local(e);
      const row = this.rowAt(y);
      const at = this.snap(Math.max(0, this.frameAt(x)));
      return { trackId: row && row.track.type === 'audio' ? row.id : null, at };
    };
    s.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const p = place(e);
      this.dropHint = { ...p, length: 0 };
      this.invalidate('overlay');
    });
    s.addEventListener('dragleave', () => {
      this.dropHint = null;
      this.invalidate('overlay');
    });
    s.addEventListener('drop', async (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      const p = place(e);
      this.dropHint = null;
      this.invalidate('overlay');
      const id = e.dataTransfer.getData('application/x-audio-studio-file');
      const mt = this.app.multitrack;
      if (id) {
        const doc = this.app.documents.find((d) => d.id === id);
        if (doc && doc.kind === 'audio') await mt.insertDocs(this.doc, [doc], p);
        return;
      }
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) await mt.insertFiles(this.doc, files, p);
    });
  }

  focus() {
    this.surface.focus({ preventScroll: true });
  }

  destroy() {
    this.offDoc();
    this.offPrefs();
    this.offTool();
    this.offMeters();
    window.removeEventListener('themechange', this.onTheme);
    this.resizeObserver.disconnect();
    this.videoLane.destroy();
    this.renderer.dispose();
  }
}
