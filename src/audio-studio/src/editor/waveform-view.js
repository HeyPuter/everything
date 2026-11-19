// Waveform editor view for an AudioFile: overview navigator, time ruler,
// channel lanes (WebGL2), dB ruler with channel enable buttons, selection,
// markers, fade handles, the gain HUD, sample point dragging at high zoom and
// touch/pointer/keyboard interaction.
//
// Extensions (e.g. the spectral display) register through
// WaveformView.extensions: each is { attach(view) } and may set
// view.layers entries { id, el, layout(rect), draw(), pointer(e, phase) }.

import { h, announce } from '../lib/dom.js';
import { TimeRuler, rulerTicks, rulerFps } from './time-ruler.js';
import { Overview } from './overview.js';
import { WaveformRenderer } from '../render/waveform-gl.js';
import { channelColumns } from '../audio/peaks.js';
import { cssVar, CANVAS_FONT, parseColor } from '../ui/theme.js';
import { markerColor } from '../ui/appearance.js';
import { icon } from '../ui/icons.js';
import './editor-icons.js';
import { gainRange, fadeRange, fadeCurve, smoothBoundaries } from '../model/edits.js';
import { WAVEFORM_CONTEXT } from '../ui/menus.js';
import { contextMenu, resolveItems } from '../ui/menubar.js';
import { bindRightDrag } from './right-drag.js';
import { dbToGain, formatDb, framesPerSecond, musicalStep } from '../lib/time.js';
import { createMarker, nextMarkerName, sortMarkers } from '../model/markers.js';
import {
  wheelZoom,
  followPlayhead,
  editSmoothFrames,
  defaultFadeCurve,
  MIN_VIEW_FRAMES,
} from './view-prefs.js';

const CHANNEL_NAMES = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
const CHANNEL_TOKENS = ['--wave', '--wave-2', '--wave-3', '--wave-4'];

/** Per-channel waveform color for View > Waveform Channels > Uniquely Colored. */
const channelColor = (i) => cssVar(CHANNEL_TOKENS[i % CHANNEL_TOKENS.length]);

const channelCursors = new Map();

/** A text cursor labelled with a channel name, shown where a drag selects that channel alone. */
export function channelCursor(name) {
  if (!channelCursors.has(name)) {
    const beam = 'M5 3h5M7.5 3v18M5 21h5';
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='24'>` +
      `<path d='${beam}' fill='none' stroke='black' stroke-width='3'/><path d='${beam}' fill='none' stroke='white' stroke-width='1'/>` +
      `<text x='12' y='11' font-family='sans-serif' font-size='10' font-weight='700' fill='white' stroke='black' stroke-width='2.5' paint-order='stroke'>${name}</text></svg>`;
    channelCursors.set(name, `url("data:image/svg+xml,${encodeURIComponent(svg)}") 7 12, text`);
  }
  return channelCursors.get(name);
}

function withAlpha(color, alpha) {
  const [r, g, b, a] = parseColor(color);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a * alpha})`;
}

/** Pixels between samples from which sample points can be dragged (the renderer draws them as dots). */
export const SAMPLE_EDIT_PX = 6;

/** Time each frame may spend building peak levels for blocks drawn for the first time. */
const PEAK_FRAME_BUDGET_MS = 12;

/** Levels the amplitude ruler can label, loudest first. */
const DB_LADDER = [0, -1, -3, -6, -9, -12, -18, -24, -30, -36, -42, -48, -54, -60, -72, -84, -96];

/**
 * dB values shown on a lane's amplitude ruler, spaced so labels do not
 * collide: [{ db, y, y2 }] with y above the centre line and y2 its mirror
 * below (null when too close to the lane edge). The grid uses the same ticks.
 */
export function dbTicks(lane, amp) {
  const mid = (lane.top + lane.bottom) / 2;
  const half = (lane.bottom - lane.top) / 2;
  const out = [];
  let lastY = -Infinity;
  for (const db of DB_LADDER) {
    const v = dbToGain(db) * amp;
    if (v > 1.0001) continue;
    const y = mid - v * half;
    // Leave room for the "dB" caption at the top and the -inf label at the centre.
    if (y - lastY < 13 || mid - y < 12 || y < lane.top + 15) continue;
    const y2 = mid + v * half;
    out.push({ db, y, y2: y2 < lane.bottom - 6 ? y2 : null });
    lastY = y;
  }
  return out;
}

/** y positions of the amplitude ruler's unlabelled 1 dB ticks (both halves of the lane). */
export function dbMinorTicks(lane, amp) {
  const mid = (lane.top + lane.bottom) / 2;
  const half = (lane.bottom - lane.top) / 2;
  const out = [];
  let last = -Infinity;
  for (let db = 0; db >= -96; db--) {
    const v = dbToGain(db) * amp;
    if (v > 1.0001) continue;
    const y = mid - v * half;
    if (mid - y < 10) break;
    if (y - last < 4) continue;
    out.push(y, mid + v * half);
    last = y;
  }
  return out;
}

/** Units the amplitude ruler can show (right-click the ruler to choose). */
export const AMP_UNITS = [
  { id: 'db', label: 'Decibels', caption: 'dB' },
  { id: 'percent', label: 'Percentage', caption: '%' },
  { id: 'normalized', label: 'Normalized Values', caption: 'norm' },
  { id: 'samples', label: 'Samples', caption: 'smpl' },
];

/** Full-scale value of a linear amplitude unit: integer sample values for fixed-point files. */
export function ampFullScale(unit, bits = 16) {
  if (unit === 'percent') return 100;
  if (unit === 'samples' && bits <= 24) return 2 ** (bits - 1);
  return 1;
}

function formatAmpValue(v, step, unit) {
  if (unit === 'samples' && step >= 1) return Math.abs(v) >= 10000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9) + (String(step).includes('25') ? 1 : 0));
  return v.toFixed(Math.min(4, decimals)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * Linear amplitude ruler ticks (percent, normalized or sample values) for a lane:
 * [{ value, y, y2, label }] at round steps at least 24 px apart, up to full scale,
 * with y above the centre line and y2 the negative value's mirror below (null near the edge).
 */
export function linearTicks(lane, amp, unit, bits = 16) {
  const mid = (lane.top + lane.bottom) / 2;
  const half = (lane.bottom - lane.top) / 2;
  const full = ampFullScale(unit, bits);
  const pxPer = (half * amp) / full;
  if (!(pxPer > 0)) return [];
  const raw = 24 / pxPer;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw * 0.9999);
  const out = [];
  for (let k = 1; k * step <= full * 1.0001 && out.length < 200; k++) {
    const value = k * step;
    const y = mid - value * pxPer;
    if (y < lane.top + 15) break;
    const y2 = mid + value * pxPer;
    out.push({ value, y, y2: y2 < lane.bottom - 6 ? y2 : null, label: formatAmpValue(value, step, unit) });
  }
  return out;
}

/**
 * Amplitude zoom that makes the range y0..y1 (px, dragged on the amplitude ruler) fill
 * the lane it starts in: the edge further from the centre line goes to the lane edge.
 * Null when the range is outside the lanes.
 */
export function ampForRange(lanes, y0, y1, amp) {
  const lane = lanes.find((l) => y0 >= l.top && y0 <= l.bottom);
  if (!lane) return null;
  const mid = (lane.top + lane.bottom) / 2;
  const half = (lane.bottom - lane.top) / 2;
  const d = Math.max(Math.abs(y0 - mid), Math.abs(Math.max(lane.top, Math.min(lane.bottom, y1)) - mid), 2);
  return (amp * half) / d;
}

/** Amplitude zoom for a vertical drag of dy px on the amplitude ruler (up zooms in). */
export const ampDragZoom = (amp0, dy) => amp0 * Math.pow(1.01, -dy);

/**
 * The first sample at or after a grid line between samples (a video frame or beat): the
 * time display rounds down, so the nearest sample could show as the previous frame.
 */
const firstSampleOf = (frame) => Math.ceil(frame - 1e-4);

/** Keeps a w x h box at (x, y) inside a W x H area. */
export function clampHud(x, y, w, h, W, H) {
  return { x: Math.round(Math.max(0, Math.min(W - w, x))), y: Math.round(Math.max(0, Math.min(H - h, y))) };
}

export class WaveformView {
  static extensions = [];

  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    this.layers = [];
    this.hudGain = 0;
    this.fadeDrag = null;
    this.snapLine = null;
    this.dirty = { wave: true, overlay: true, ruler: true, overview: true, amp: true };
    this.#build();
    this.offDoc = doc.on('change', (e) => this.#onDocChange(e));
    this.offPrefs = app.on('prefs', (key) => {
      if (key === 'waveLayered' || key === 'waveUniqueColors') this.#buildChannelButtons();
      if (key === 'waveLayered') this.overview.peaksFor = null;
      if (key === 'hudPinned') this.syncHudPin?.();
      if (key === 'ampUnits') this.amp.title = this.#ampTitle();
      this.invalidate();
    });
    this.onTheme = () => this.invalidate();
    window.addEventListener('themechange', this.onTheme);
    // A drag anywhere (lanes, ruler) ends with a release: the snap line goes with it.
    this.onRelease = () => this.#showSnap(null);
    window.addEventListener('pointerup', this.onRelease, true);
    window.addEventListener('pointercancel', this.onRelease, true);
    for (const ext of WaveformView.extensions) ext.attach?.(this);
  }

  // ------------------------------------------------------------------ build

  #build() {
    const app = this.app;
    const doc = this.doc;
    const timelineHost = {
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
      viewMax: () => Math.max(doc.length, doc.sampleRate),
      moveMarker: (id, start, { preview }) => this.moveMarker(id, start, preview),
      resizeMarker: (id, end, { preview }) => this.resizeMarker(id, end, preview),
      cancelMarkerMove: () => {
        this.markerPreview = null;
        this.invalidate('ruler');
        this.invalidate('overlay');
      },
      renameMarker: (id) => app.commands.run('marker.rename', { id }),
      selectMarker: (id) => this.selectMarker(id),
      overviewPeaks: (cols, total) => this.#overviewPeaks(cols, total),
      setSelection: (a, b) => {
        this.#showSnap(this.lastSnapTarget);
        doc.setSelection(a, b, { channels: doc.selection.channels });
        if (!app.engine.playing) doc.setCursor(Math.min(a, b), { silent: true });
      },
      wheel: (e, x) => this.#wheel(e, x),
      zoomRange: (a, b) => {
        if (b - a >= MIN_VIEW_FRAMES) doc.setView(a, b);
      },
      menuItems: () => this.rulerMenuItems(),
      peaksKey: () => doc.state,
    };
    this.ruler = new TimeRuler(app, timelineHost);
    this.overview = new Overview(app, timelineHost);
    this.rulerHandle = h('div.playhead-handle', { 'aria-hidden': 'true' });
    this.ruler.el.append(this.rulerHandle);

    this.glCanvas = h('canvas.wf-gl', { 'aria-hidden': 'true' });
    this.overlay = h('canvas.wf-overlay', { 'aria-hidden': 'true' });
    this.playheadEl = h('div.playhead', { 'aria-hidden': 'true' });
    this.hud = this.#buildHud();
    this.fadeInHandle = h('div.fade-handle.in', { title: 'Fade In: drag right to set the length, up or down to bend the curve', 'aria-hidden': 'true' });
    this.fadeOutHandle = h('div.fade-handle.out', { title: 'Fade Out: drag left to set the length, up or down to bend the curve', 'aria-hidden': 'true' });
    this.surface = h(
      'div.wf-lanes.editor-surface',
      {
        tabindex: '0',
        role: 'application',
        'aria-roledescription': 'waveform editor',
        'aria-label': `Waveform of ${doc.name}`,
        'aria-describedby': 'wf-help',
      },
      this.glCanvas,
      this.overlay,
      this.playheadEl,
      this.fadeInHandle,
      this.fadeOutHandle,
      this.hud,
    );
    this.renderer = new WaveformRenderer(this.glCanvas);
    this.renderer.onRestore = () => this.invalidate();
    this.ampCanvas = h('canvas', { 'aria-hidden': 'true' });
    this.channelButtons = h('div.wf-channel-buttons');
    this.amp = h('div.wf-amp', this.ampCanvas, this.channelButtons);
    this.amp.title = this.#ampTitle();
    this.snapBtn = h(
      'button.icon-btn.sm',
      {
        type: 'button',
        'aria-label': 'Snapping',
        title: 'Toggle snapping (S)',
        'aria-pressed': String(app.prefs.get('snapping')),
        onclick: () => app.commands.run('edit.snapping'),
      },
      icon('magnet', 14),
    );
    this.markerBtn = h(
      'button.icon-btn.sm',
      { type: 'button', 'aria-label': 'Add cue marker', title: 'Add cue marker (M)', onclick: () => app.commands.run('marker.add') },
      icon('marker-add', 14),
    );
    this.status = h('div#wf-help.sr-only', 'Arrow keys move the playhead. Shift with arrows extends the selection. Space plays.');
    this.el = h(
      'div.wf.editor-view',
      h(
        'div.wf-top',
        this.overview.el,
        h(
          'div.wf-top-corner',
          h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Zoom Out Full (All Axes)', title: 'Zoom Out Full (All Axes)', onclick: () => app.commands.run('view.zoomFull') }, icon('zoom-full', 14)),
        ),
      ),
      h('div.wf-ruler-row', this.ruler.el, h('div.wf-ruler-corner', this.snapBtn, this.markerBtn)),
      h('div.wf-main', this.surface, this.amp),
      this.status,
    );
    this.#bindPointer();
    this.#bindKeys();
    this.#bindFadeHandles();
    this.#bindAmpRuler();
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.surface);
    this.resizeObserver.observe(this.ruler.el);
    this.resizeObserver.observe(this.overview.el);
  }

  #buildHud() {
    const valueEl = h('span.hud-value', '+0');
    const knobEl = h('button.hud-knob', { type: 'button', role: 'slider', 'aria-label': 'Adjust amplitude', title: 'Adjust Amplitude: drag the knob, release to apply', 'aria-valuemin': '-60', 'aria-valuemax': '30', 'aria-valuenow': '0' }, icon('hud-knob', 18));
    const grip = h('span.hud-grip', { title: 'Drag to move the HUD. Double-click to put it back.', 'aria-hidden': 'true' });
    const pinBtn = h(
      'button.icon-btn.hud-pin',
      { type: 'button', 'aria-label': 'Pin HUD', title: 'Pin the HUD: keep it at full strength when the pointer leaves the editor', onclick: () => this.app.prefs.toggle('hudPinned') },
      icon('pin', 12),
    );
    const hud = h('div.hud', grip, h('span.hud-icon', icon('hud-level', 14)), knobEl, valueEl, h('span.hud-unit', 'dB'), h('span.hud-sep'), pinBtn);
    const syncPin = () => {
      const on = Boolean(this.app.prefs.get('hudPinned'));
      pinBtn.setAttribute('aria-pressed', String(on));
      hud.classList.toggle('pinned', on);
    };
    syncPin();
    this.syncHudPin = syncPin;
    this.#bindHudGrip(hud, grip);
    const showGain = (db) => {
      this.hudGain = Math.max(-60, Math.min(30, Math.round(db * 10) / 10));
      valueEl.textContent = formatDb(this.hudGain).replace(/ dB$/, '');
      knobEl.setAttribute('aria-valuenow', String(this.hudGain));
      knobEl.setAttribute('aria-valuetext', formatDb(this.hudGain));
    };
    // Switching files drops the HUD's preview (the app clears it), so an unapplied
    // adjustment is dropped too instead of showing a gain that is no longer heard.
    this.offActive = this.app.on('active', (d) => {
      if (d !== this.doc && this.hudGain) {
        drag = null;
        showGain(0);
      }
    });
    const setGain = (db) => {
      showGain(db);
      this.app.previewFx = this.hudGain ? [{ key: 'hud', kind: 1, params: [this.hudGain, this.hudGain, 1], enabled: true, mix: 1 }] : null;
      this.app.syncGraph();
      this.invalidate('wave');
    };
    const commit = () => {
      const db = this.hudGain;
      setGain(0);
      if (!db) return;
      const [a, b] = this.doc.editRange();
      const before = this.doc.state;
      const after = gainRange(before, a, b, dbToGain(db), this.doc.channelMask);
      this.doc.apply('Amplify', smoothBoundaries(before, after, a, b, editSmoothFrames(this.app, before.sampleRate), this.doc.channelMask));
    };
    let drag = null;
    knobEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      knobEl.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
    });
    knobEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      setGain(((e.clientX - drag.x) - (e.clientY - drag.y)) / 4);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      commit();
    };
    knobEl.addEventListener('pointerup', end);
    knobEl.addEventListener('pointercancel', () => {
      drag = null;
      setGain(0);
    });
    knobEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setGain(this.hudGain + (e.shiftKey ? 3 : 0.5));
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setGain(this.hudGain - (e.shiftKey ? 3 : 0.5));
      else if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') setGain(0);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    hud.addEventListener('pointerdown', (e) => e.stopPropagation());
    return hud;
  }

  /** Dragging the grip moves the HUD within the editor (kept per view); double-click resets it. */
  #bindHudGrip(hud, grip) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const box = this.surface.getBoundingClientRect();
      const r = hud.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        this.hudPos = clampHud(ev.clientX - box.left - dx, ev.clientY - box.top - dy, r.width, r.height, box.width, box.height);
        this.#placeHud();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => {
      this.hudPos = null;
      this.#placeHud();
    });
  }

  #placeHud() {
    const p = this.hudPos;
    if (p) {
      const c = clampHud(p.x, p.y, this.hud.offsetWidth, this.hud.offsetHeight, this.width, this.height);
      Object.assign(this.hud.style, { left: `${c.x}px`, top: `${c.y}px`, transform: 'none' });
    } else Object.assign(this.hud.style, { left: '', top: '', transform: '' });
  }

  // ----------------------------------------------------------------- layout

  layout() {
    const r = this.surface.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(this.width, this.height, dpr);
    this.glCanvas.style.width = `${this.width}px`;
    this.glCanvas.style.height = `${this.height}px`;
    this.overlay.width = Math.round(this.width * dpr);
    this.overlay.height = Math.round(this.height * dpr);
    this.overlay.style.width = `${this.width}px`;
    this.overlay.style.height = `${this.height}px`;
    this.ampCanvas.width = Math.round(this.amp.clientWidth * dpr);
    this.ampCanvas.height = Math.round(this.height * dpr);
    this.ampCanvas.style.width = `${this.amp.clientWidth}px`;
    this.ampCanvas.style.height = `${this.height}px`;
    const rr = this.ruler.el.getBoundingClientRect();
    this.ruler.resize(rr.width, rr.height);
    const orr = this.overview.el.getBoundingClientRect();
    this.overview.resize(orr.width, orr.height);
    // Layers (e.g. spectral display) claim part of the lane area.
    const layerShare = this.layers.reduce((s, l) => s + (l.visible?.() === false ? 0 : l.share || 0), 0);
    this.waveHeight = Math.round(this.height * (1 - Math.min(0.85, layerShare)));
    let y = this.waveHeight;
    for (const l of this.layers) {
      if (l.visible?.() === false) continue;
      const hh = Math.round(this.height * (l.share || 0));
      l.layout?.({ x: 0, y, width: this.width, height: hh, dpr });
      y += hh;
    }
    this.#buildChannelButtons();
    this.#placeHud();
    this.invalidate();
  }

  /** Lane rectangles (CSS px) for each channel within the waveform area. */
  lanes() {
    const n = this.doc.channelCount;
    const H = this.waveHeight ?? this.height;
    // Layered display draws every channel over the full height.
    if (n > 1 && this.app.prefs.get('waveLayered')) return Array.from({ length: n }, () => ({ top: 0, bottom: H }));
    const gap = n > 1 ? 1 : 0;
    const lh = (H - gap * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => ({ top: i * (lh + gap), bottom: i * (lh + gap) + lh }));
  }

  /** Channel enable buttons beside the dB ruler, updated in place so a focused button keeps focus. */
  #buildChannelButtons() {
    const lanes = this.lanes();
    const mono = this.doc.channelCount === 1;
    if (this.channelButtons.children.length !== lanes.length || this.channelButtons.dataset.mono !== String(mono)) {
      this.channelButtons.dataset.mono = String(mono);
      this.channelButtons.replaceChildren(
        ...lanes.map((_, i) => {
          const name = mono ? 'M' : CHANNEL_NAMES[i] || String(i + 1);
          return h('button.channel-btn', { type: 'button', 'aria-label': `Edit channel ${name}`, dataset: { name }, onclick: () => this.doc.setChannelEnabled(i, this.doc.selection.channels[i] === false) }, name);
        }),
      );
    }
    lanes.forEach((lane, i) => {
      const b = this.channelButtons.children[i];
      const on = this.doc.selection.channels[i] !== false;
      const name = b.dataset.name;
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? `Channel ${name} enabled for editing. Click to disable.` : `Channel ${name} disabled. Click to enable.`;
      const stack = this.app.prefs.get('waveLayered') && lanes.length > 1 ? (i - (lanes.length - 1) / 2) * 22 : 0;
      b.style.top = `${(lane.top + lane.bottom) / 2 - 8 + stack}px`;
      b.style.color = this.app.prefs.get('waveUniqueColors') && on ? channelColor(i) : '';
    });
  }

  /** Time and level under the pointer, for the status bar. */
  #reportCursorData(frame, y) {
    const doc = this.doc;
    if (frame < 0 || frame >= doc.length) return this.app.emit('cursor-data', null);
    const lane = this.app.prefs.get('waveLayered') ? -1 : this.#laneAt(y);
    const chans = lane >= 0 ? [lane] : doc.state.channels.map((_, i) => i);
    const one = new Float32Array(1);
    let peak = 0;
    for (const c of chans) {
      doc.state.channels[c]?.read(Math.floor(frame), one);
      peak = Math.max(peak, Math.abs(one[0]));
    }
    const names = doc.channelCount === 1 ? ['M'] : CHANNEL_NAMES;
    this.app.emit('cursor-data', { frame, rate: doc.sampleRate, channel: lane >= 0 ? names[lane] || String(lane + 1) : null, db: peak > 0 ? 20 * Math.log10(peak) : -Infinity });
  }

  // ------------------------------------------------------------- coordinates

  get fpp() {
    const v = this.doc.view;
    return (v.end - v.start) / this.width;
  }

  xOf(frame) {
    return (frame - this.doc.view.start) / this.fpp;
  }

  frameAt(x) {
    return this.doc.view.start + x * this.fpp;
  }

  /** Snaps a frame to markers, selection edges, playhead, ruler ticks or zero crossings. */
  snap(frame, { exclude, force } = {}) {
    const prefs = this.app.prefs;
    this.lastSnapTarget = null;
    if (!prefs.get('snapping') && !force) return Math.round(frame);
    const snap = prefs.get('snap');
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
    if (snap.markers) {
      for (const m of this.doc.state.markers) {
        if (m.id === exclude) continue;
        consider(m.start);
        if (m.duration) consider(m.start + m.duration);
      }
    }
    consider(0);
    consider(this.doc.length);
    if (snap.ruler || snap.rulerFine) {
      const rate = this.doc.sampleRate;
      if (prefs.get('timeFormat') === 'bars') {
        const step = musicalStep(this.fpp, rate, this.app.timeOptions(), snap.rulerFine ? 3 : 12);
        consider(firstSampleOf(Math.round(frame / step) * step));
      } else {
        const secPerPx = this.fpp / rate;
        const steps = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60];
        // Coarse snaps to labelled ticks; fine to ticks about 3 px apart.
        const step = steps.find((s) => s / secPerPx >= (snap.rulerFine ? 3 : 12)) || 60;
        consider(Math.round(frame / rate / step) * step * rate);
      }
    }
    const fps = snap.frames ? framesPerSecond(this.app.prefs) : 0;
    if (fps) {
      const step = this.doc.sampleRate / fps;
      consider(firstSampleOf(Math.round(frame / step) * step));
    }
    if (snap.zero && bestD === tol) {
      // The sum of the channels enabled for editing, as Adjust Selection to Zero Crossings uses.
      const chans = this.doc.state.channels.filter((_, i) => this.doc.selection.channels[i] !== false);
      const len = chans[0]?.length ?? 0;
      if (len) {
        const r = Math.max(8, Math.round(this.fpp * 6));
        const a = Math.max(0, Math.round(frame) - r);
        const b = Math.min(len, Math.round(frame) + r);
        const s = new Float32Array(Math.max(0, b - a));
        for (const c of chans) {
          const x = c.toArray(a, b);
          for (let i = 0; i < x.length; i++) s[i] += x[i];
        }
        let zbest = -1;
        let zd = Infinity;
        for (let i = 1; i < s.length; i++) {
          if ((s[i - 1] <= 0 && s[i] > 0) || (s[i - 1] >= 0 && s[i] < 0)) {
            const d = Math.abs(a + i - frame);
            if (d < zd) {
              zd = d;
              zbest = a + i;
            }
          }
        }
        if (zbest >= 0) {
          this.lastSnapTarget = zbest;
          return zbest;
        }
      }
    }
    if (bestD < tol) this.lastSnapTarget = best;
    return best;
  }

  /** Shows (or with null hides) the line marking where a drag snapped. */
  #showSnap(frame) {
    if (frame === (this.snapLine ?? null)) return;
    this.snapLine = frame;
    this.invalidate('overlay');
  }

  // ----------------------------------------------------------------- render

  invalidate(part) {
    if (part) this.dirty[part] = true;
    else for (const k of Object.keys(this.dirty)) this.dirty[k] = true;
    this.app.requestRender?.();
  }

  /** Called every animation frame by the editor panel while visible. */
  frame() {
    const doc = this.doc;
    if (!this.width) return;
    const playing = this.app.engine.playing && this.app.active === doc;
    if (playing) this.#autoScroll();
    // A newly opened long file builds its peak levels over several frames
    // instead of in one long task; what is not ready yet fills in as it is.
    this.peakDefer = { deadline: performance.now() + PEAK_FRAME_BUDGET_MS, pending: new Set() };
    if (this.dirty.wave) this.#drawWave();
    if (this.dirty.overlay) this.#drawOverlay();
    if (this.dirty.ruler) this.ruler.draw();
    if (this.dirty.overview) this.overview.draw();
    if (this.dirty.amp) this.#drawAmp();
    for (const l of this.layers) if (l.visible?.() !== false) l.draw?.(this.dirty);
    for (const k of Object.keys(this.dirty)) this.dirty[k] = false;
    if (this.peakDefer.pending.size) {
      this.overview.peaksFor = null;
      this.invalidate('wave');
      this.invalidate('overview');
    }
    this.peakDefer = null;
    this.#placePlayhead();
  }

  #autoScroll() {
    followPlayhead(this.app, this.doc, this.app.prefs.get('scrollWave'));
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

  #drawWave() {
    const doc = this.doc;
    const dpr = this.renderer.dpr || 1;
    const lanes = this.lanes().map((l) => ({ top: l.top * dpr, bottom: l.bottom * dpr }));
    const color = cssVar('--wave');
    const dim = cssVar('--wave-dim');
    const unique = this.app.prefs.get('waveUniqueColors');
    const layered = this.app.prefs.get('waveLayered') && doc.channelCount > 1;
    const colors = doc.state.channels.map((_, i) => {
      const c = doc.selection.channels[i] === false ? dim : unique ? channelColor(i) : color;
      // Overlapping layers stay readable when each is partly transparent.
      return layered ? withAlpha(c, 0.6) : c;
    });
    const amp = doc.view.amp;
    this.waveMask = doc.selection.channels.join();
    const channels = this.sampleDrag ? doc.state.channels.map((c, i) => (i === this.sampleDrag.ch ? this.sampleDrag.channel : c)) : doc.state.channels;
    this.renderer.draw({ channels, start: doc.view.start, fpp: this.fpp / dpr, amp, lanes, colors, defer: this.peakDefer });
  }

  #drawOverlay() {
    const ctx = this.overlay.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = this.width;
    const H = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const doc = this.doc;
    const lanes = this.lanes();
    const amp = doc.view.amp;
    // Grid: centre line and dB lines.
    // Grid lines sit on the dB values labelled in the ruler beside the lanes.
    const unit = this.ampUnit();
    for (const lane of lanes) {
      const mid = (lane.top + lane.bottom) / 2;
      ctx.fillStyle = cssVar('--grid-strong');
      ctx.fillRect(0, Math.round(mid), W, 1);
      ctx.fillStyle = cssVar('--grid');
      for (const t of unit === 'db' ? dbTicks(lane, amp) : linearTicks(lane, amp, unit, this.#bits())) {
        ctx.fillRect(0, Math.round(t.y), W, 1);
        if (t.y2 !== null) ctx.fillRect(0, Math.round(t.y2), W, 1);
      }
    }
    // Time grid: a line under each labelled ruler tick.
    ctx.fillStyle = cssVar('--wave-grid');
    for (const x of this.#gridXs()) ctx.fillRect(x, 0, 1, this.waveHeight ?? H);
    if (lanes.length > 1) {
      ctx.fillStyle = cssVar('--divider');
      for (let i = 1; i < lanes.length; i++) ctx.fillRect(0, Math.round(lanes[i].top) - 1, W, 1);
    }
    // Past the end of the file.
    const endX = this.xOf(doc.length);
    if (endX < W) {
      ctx.fillStyle = cssVar('--bg-panel-alt');
      ctx.fillRect(Math.max(0, endX), 0, W - Math.max(0, endX), H);
    }
    // Range markers and cue lines (Preferences > Markers & Metadata can hide them).
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
    // Selection.
    const sel = doc.selection;
    if (sel.end > sel.start) {
      const x0 = Math.max(0, this.xOf(sel.start));
      const x1 = Math.min(W, this.xOf(sel.end));
      if (x1 > x0) {
        ctx.fillStyle = cssVar('--sel-bg');
        lanes.forEach((lane, i) => {
          if (sel.channels[i] === false) return;
          ctx.fillRect(x0, lane.top, x1 - x0, lane.bottom - lane.top);
        });
        ctx.fillStyle = cssVar('--sel-edge');
        if (this.xOf(sel.start) >= 0) ctx.fillRect(Math.round(x0), 0, 1, this.waveHeight);
        if (this.xOf(sel.end) <= W) ctx.fillRect(Math.round(x1) - 1, 0, 1, this.waveHeight);
      }
    }
    // The sample point under the pointer (or being dragged), ringed so it reads as grabbable.
    const ring = this.sampleDrag ? { ch: this.sampleDrag.ch, frame: this.sampleDrag.a + (this.sampleDrag.last?.i ?? 0) } : this.hoverSample;
    if (ring && this.samplesEditable() && lanes[ring.ch]) {
      const one = new Float32Array(1);
      const ch = this.sampleDrag ? this.sampleDrag.channel : doc.state.channels[ring.ch];
      ch?.read(ring.frame, one);
      ctx.strokeStyle = cssVar('--text-strong');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(this.xOf(ring.frame), this.#sampleY(lanes[ring.ch], one[0]), 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    // Where a drag snapped (to a marker, selection edge, ruler tick or zero crossing).
    if (this.snapLine !== null && this.snapLine !== undefined) {
      const x = Math.round(this.xOf(this.snapLine)) + 0.5;
      if (x >= 0 && x <= W) {
        ctx.strokeStyle = cssVar('--text-strong');
        ctx.globalAlpha = 0.85;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    // Fade preview curve.
    if (this.fadeDrag) {
      const { dir, frames, curve } = this.fadeDrag;
      ctx.strokeStyle = cssVar('--envelope-vol');
      ctx.lineWidth = 1.5;
      lanes.forEach((lane, ch) => {
        // Only the channels enabled for editing get the fade.
        if (sel.channels[ch] === false) return;
        ctx.beginPath();
        const start = dir === 'in' ? 0 : doc.length - frames;
        for (let i = 0; i <= 64; i++) {
          const t = i / 64;
          const f = start + t * frames;
          const g = fadeCurve(dir === 'in' ? t : 1 - t, curve);
          const x = this.xOf(f);
          const y = lane.bottom - g * (lane.bottom - lane.top);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
      ctx.lineWidth = 1;
    }
    // Fade handles sit at the visible file edges.
    const sx = this.xOf(0);
    const ex = this.xOf(doc.length);
    const showHandles = this.app.prefs.get('clipFadeHandles') !== false && doc.length > 0;
    this.fadeInHandle.style.display = showHandles && sx >= -2 && sx < W - 20 ? '' : 'none';
    this.fadeOutHandle.style.display = showHandles && ex <= W + 2 && ex > 20 ? '' : 'none';
    this.fadeInHandle.style.left = `${Math.max(0, sx) + 4 + (this.fadeDrag?.dir === 'in' ? this.fadeDrag.frames / this.fpp : 0)}px`;
    this.fadeOutHandle.style.left = `${Math.min(W, ex) - 16 - (this.fadeDrag?.dir === 'out' ? this.fadeDrag.frames / this.fpp : 0)}px`;
    const hudOn = this.app.prefs.get('hud') && doc.length && (!this.app.prefs.get('hudSelectionOnly') || doc.hasSelection);
    this.hud.style.display = hudOn ? '' : 'none';
  }

  /** x positions (CSS px) of the labelled time ruler ticks. */
  #gridXs() {
    const v = this.doc.view;
    const rate = this.doc.sampleRate;
    const W = this.width;
    if (this.app.prefs.get('timeFormat') === 'bars') {
      const step = musicalStep(this.fpp, rate, this.app.timeOptions(), 70);
      const out = [];
      for (let f = Math.ceil(v.start / step - 1e-9) * step; f <= v.end && out.length < 1000; f += step) out.push(Math.round(this.xOf(f)));
      return out;
    }
    const t0 = v.start / rate;
    const t1 = v.end / rate;
    const { ticks } = rulerTicks(t0, t1, W, 70, rulerFps(this.app));
    return ticks.map((sec) => Math.round(((sec - t0) / (t1 - t0)) * W));
  }

  #drawAmp() {
    const ctx = this.ampCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = this.amp.clientWidth;
    const H = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = CANVAS_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--text-dim');
    const amp = this.doc.view.amp;
    const faint = cssVar('--text-faint');
    const unit = this.ampUnit();
    const caption = AMP_UNITS.find((u) => u.id === unit)?.caption || 'dB';
    for (const lane of this.lanes()) {
      const mid = (lane.top + lane.bottom) / 2;
      if (unit !== 'db') {
        for (const { y, y2, label } of linearTicks(lane, amp, unit, this.#bits())) {
          ctx.fillRect(0, Math.round(y), 4, 1);
          ctx.fillText(label, 6, y);
          if (y2 !== null) {
            ctx.fillRect(0, Math.round(y2), 4, 1);
            ctx.fillText(`-${label}`, 6, y2);
          }
        }
        ctx.fillText('0', 6, mid);
        ctx.fillText(caption, 6, lane.top + 6);
        continue;
      }
      // Minor ticks every dB while they stay a few pixels apart.
      ctx.fillStyle = faint;
      for (const y of dbMinorTicks(lane, amp)) ctx.fillRect(0, Math.round(y), 2, 1);
      ctx.fillStyle = cssVar('--text-dim');
      for (const { db, y, y2 } of dbTicks(lane, amp)) {
        const text = db === 0 ? '0' : String(db);
        ctx.fillRect(0, Math.round(y), 4, 1);
        ctx.fillText(text, 6, y);
        if (y2 !== null) {
          ctx.fillRect(0, Math.round(y2), 4, 1);
          ctx.fillText(text, 6, y2);
        }
      }
      ctx.fillText('-\u221e', 6, mid);
      ctx.fillText('dB', 6, lane.top + 6);
    }
  }

  #ampTitle() {
    const u = AMP_UNITS.find((x) => x.id === this.ampUnit());
    return `Amplitude (${u.label}). Drag or scroll to zoom, right-drag over a range to zoom to it, double-click to reset, right-click for units.`;
  }

  /** Unit of the amplitude ruler and grid: 'db', 'percent', 'normalized' or 'samples'. */
  ampUnit() {
    const u = this.app.prefs.get('ampUnits');
    return AMP_UNITS.some((x) => x.id === u) ? u : 'db';
  }

  #bits() {
    return this.doc.info?.bitDepth || 32;
  }

  /** Right-click menu of the amplitude ruler: units and amplitude zoom. */
  ampMenuItems() {
    const app = this.app;
    const unit = this.ampUnit();
    const cmd = (id) => ({ type: 'cmd', label: app.commands.label(id), shortcut: app.commands.shortcutLabel(id), enabled: app.commands.isEnabled(id), run: () => app.commands.run(id) });
    return [
      ...AMP_UNITS.map((u) => ({ type: 'cmd', label: u.label, enabled: true, checked: unit === u.id, run: () => app.prefs.set('ampUnits', u.id) })),
      { type: 'sep' },
      cmd('view.zoomInAmp'),
      cmd('view.zoomOutAmp'),
      { type: 'cmd', label: 'Reset Amplitude Zoom', enabled: this.doc.view.amp !== 1, run: () => this.doc.setAmp(1) },
    ];
  }

  /** Amplitude ruler: right-click for units, wheel or vertical drag to zoom, double-click to reset. */
  #bindAmpRuler() {
    const el = this.amp;
    // Only the amplitude ruler itself: layers (the spectral display's frequency ruler)
    // and the channel buttons share this column and handle their own events.
    const mine = (e) => e.target === el || e.target === this.ampCanvas;
    // Right-click: units and zoom. Right-drag: zoom so the range dragged over fills the lane.
    const band = h('div.amp-zoom-band', { hidden: true });
    el.append(band);
    const yOf = (e) => e.clientY - el.getBoundingClientRect().top;
    bindRightDrag(el, {
      filter: mine,
      move: (a, b) => {
        const [y0, y1] = [yOf(a), yOf(b)].sort((p, q) => p - q);
        Object.assign(band.style, { top: `${y0}px`, height: `${y1 - y0}px` });
        band.hidden = false;
      },
      done: (a, b) => {
        band.hidden = true;
        const amp = ampForRange(this.lanes(), yOf(a), yOf(b), this.doc.view.amp);
        if (amp) this.doc.setAmp(amp);
      },
      cancel: () => (band.hidden = true),
      menu: (x, y) => this.app.openMenu(this.ampMenuItems(), { x, y, label: 'Amplitude ruler' }),
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (!mine(e)) return;
        e.preventDefault();
        this.doc.setAmp(this.doc.view.amp * Math.pow(1.0015, -(e.deltaY || e.deltaX)));
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !mine(e)) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const amp0 = this.doc.view.amp;
      const move = (ev) => this.doc.setAmp(ampDragZoom(amp0, ev.clientY - y0));
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', (e) => {
      if (mine(e)) this.doc.setAmp(1);
    });
  }

  /** Overview peaks: one strip per channel, like the lanes (merged when layered). */
  #overviewPeaks(cols, total) {
    const ch = this.doc.state.channels;
    if (!ch.length || !this.doc.length) return null;
    const fpp = total / cols;
    const strips = ch.map((c) => channelColumns(c, 0, fpp, cols, undefined, this.peakDefer));
    if (strips.length === 1 || !this.app.prefs.get('waveLayered')) return strips.length === 1 ? strips[0] : strips;
    const out = strips[0];
    for (const o of strips.slice(1)) {
      for (let c = 0; c < cols; c++) {
        if (o[2 * c] < out[2 * c]) out[2 * c] = o[2 * c];
        if (o[2 * c + 1] > out[2 * c + 1]) out[2 * c + 1] = o[2 * c + 1];
      }
    }
    return out;
  }

  // ------------------------------------------------------------ interaction

  seek(frame) {
    frame = Math.max(0, Math.min(this.doc.length, Math.round(frame)));
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
    // Markers stay inside the file: a drag past the end stops with the marker (or range) at the end.
    const dur = this.doc.state.markers.find((m) => m.id === id)?.duration || 0;
    start = Math.max(0, Math.min(Math.round(start), this.doc.length - dur));
    this.#showSnap(preview ? this.lastSnapTarget : null);
    if (preview) {
      this.markerPreview = { id, start };
      this.invalidate('ruler');
      this.invalidate('overlay');
      return;
    }
    this.markerPreview = null;
    const markers = this.doc.state.markers.map((m) => (m.id === id ? { ...m, start } : m));
    this.doc.apply('Move Marker', { ...this.doc.state, markers: sortMarkers(markers) });
  }

  /** Drags the end of a range marker: it keeps its start and stays at least one sample long. */
  resizeMarker(id, end, preview) {
    const m = this.doc.state.markers.find((x) => x.id === id);
    if (!m) return;
    const duration = Math.max(1, Math.min(Math.round(end), this.doc.length) - m.start);
    this.#showSnap(preview ? this.lastSnapTarget : null);
    if (preview) {
      this.markerPreview = { id, start: m.start, duration };
      this.invalidate('ruler');
      this.invalidate('overlay');
      return;
    }
    this.markerPreview = null;
    if (duration === m.duration) {
      this.invalidate('ruler');
      this.invalidate('overlay');
      return;
    }
    const markers = this.doc.state.markers.map((x) => (x.id === id ? { ...x, duration } : x));
    this.doc.apply('Resize Marker', { ...this.doc.state, markers: sortMarkers(markers) });
  }

  /** Markers as displayed, including a marker being dragged. */
  markers() {
    const p = this.markerPreview;
    if (!p) return this.doc.state.markers;
    return this.doc.state.markers.map((m) => (m.id === p.id ? { ...m, start: p.start, duration: p.duration ?? m.duration } : m));
  }

  #onDocChange(e) {
    if (e.kind === 'view' || e.kind === 'edit' || e.kind === 'history') this.invalidate();
    else if (e.kind === 'selection') {
      this.invalidate('overlay');
      this.invalidate('ruler');
      this.invalidate('overview');
      // The waveform itself only changes colour when channels are enabled or
      // disabled; a time selection drag redraws the overlay alone.
      const mask = this.doc.selection.channels.join();
      if (mask !== this.waveMask) {
        this.waveMask = mask;
        this.invalidate('wave');
        this.#buildChannelButtons();
      }
    } else if (e.kind === 'cursor') {
      this.#placePlayhead();
      this.ruler.syncValue(this.doc.cursor);
    } else if (e.kind === 'rename') {
      this.surface.setAttribute('aria-label', `Waveform of ${this.doc.name}`);
    }
    if (e.kind === 'edit' || e.kind === 'history') this.#buildChannelButtons();
  }

  #laneAt(y) {
    const lanes = this.lanes();
    for (let i = 0; i < lanes.length; i++) if (y >= lanes[i].top - 1 && y <= lanes[i].bottom + 1) return i;
    return -1;
  }

  /** Channel mask for a selection drag that starts at y: the top quarter of the
   *  first lane selects only it, the bottom quarter of the last lane only it. */
  #channelMaskAt(y) {
    const n = this.doc.channelCount;
    if (n < 2) return null;
    // Below the waveform (spectral display): every channel.
    if (y >= (this.waveHeight ?? this.height)) return this.lanes().map(() => true);
    const lanes = this.lanes();
    const first = lanes[0];
    const last = lanes[n - 1];
    if (y < first.top + (first.bottom - first.top) * 0.25) return lanes.map((_, i) => i === 0);
    if (y > last.bottom - (last.bottom - last.top) * 0.25) return lanes.map((_, i) => i === n - 1);
    return lanes.map(() => true);
  }

  #bindPointer() {
    const s = this.surface;
    let drag = null;
    let clicks = { n: 0, t: 0, x: 0 };
    const pointers = new Map();
    let pinch = null;
    let longPress = 0;
    // Set when a long press opened the context menu: that touch's release must not click it.
    let menuTouch = false;

    s.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Preferences > General: right-click can extend the selection instead
      // (Shift+right-click still opens the menu).
      if (e.button === 2 && !e.shiftKey && this.app.prefs.get('rightClick') === 'extend') {
        this.extendSelectionTo(this.frameAt(e.clientX - s.getBoundingClientRect().left));
        return;
      }
      contextMenu(this.app, WAVEFORM_CONTEXT, e.clientX, e.clientY, 'Waveform context menu');
    });

    s.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.hud, .fade-handle')) return;
      menuTouch = false;
      s.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        clearTimeout(longPress);
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.abs(a.x - b.x) || 1, mid: (a.x + b.x) / 2, view: { ...this.doc.view } };
        if (drag?.started) this.doc.setSelection(drag.prev.start, drag.prev.end, { channels: drag.prev.channels });
        clearTimeout(drag?.edgeTimer);
        drag = null;
        return;
      }
      if (e.button === 2) return;
      if (e.button !== 0) return;
      // Layers (spectral display) get first refusal for pointer gestures.
      for (const l of this.layers) {
        if (l.visible?.() !== false && l.pointer?.(e, 'down')) {
          drag = { layer: l };
          s.setPointerCapture(e.pointerId);
          return;
        }
      }
      const rect = s.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Zoomed in to single samples: dragging a sample point redraws the waveform.
      const hit = !e.shiftKey && e.pointerType !== 'touch' ? this.sampleAt(x, y) : null;
      if (hit) {
        s.setPointerCapture(e.pointerId);
        this.#startSampleDrag(hit);
        drag = { samples: true };
        return;
      }
      const now = performance.now();
      if (now - clicks.t < 400 && Math.abs(x - clicks.x) < 6) clicks.n++;
      else clicks.n = 1;
      clicks.t = now;
      clicks.x = x;
      if (clicks.n === 2) {
        // Double-click selects the visible range; triple selects all.
        this.doc.setSelection(Math.max(0, this.doc.view.start), Math.min(this.doc.length, this.doc.view.end));
        return;
      }
      if (clicks.n >= 3) {
        this.doc.setSelection(0, this.doc.length);
        return;
      }
      s.setPointerCapture(e.pointerId);
      const sel = this.doc.selection;
      const f = this.frameAt(x);
      const prev = { ...sel, channels: sel.channels.slice() };
      // A finger covers more than a mouse pointer: selection edges grab from further away,
      // up to a quarter of the selection inside it (a tap in a short one still places the
      // playhead), as clip edges do in the Multitrack editor.
      const selPx = (sel.end - sel.start) / this.fpp;
      const tolPx = e.pointerType === 'touch' ? Math.max(6, Math.min(14, selPx / 4)) : 6;
      const edgeTol = tolPx * this.fpp;
      let anchor;
      if (sel.end > sel.start && Math.abs(f - sel.start) < edgeTol) anchor = sel.end;
      else if (sel.end > sel.start && Math.abs(f - sel.end) < edgeTol) anchor = sel.start;
      else if (e.shiftKey && sel.end > sel.start) anchor = Math.abs(f - sel.start) < Math.abs(f - sel.end) ? sel.end : sel.start;
      else if (e.shiftKey) anchor = this.doc.cursor;
      else anchor = null;
      const channels = anchor === null ? this.#channelMaskAt(y) : sel.channels.slice();
      drag = { anchor: anchor ?? this.snap(f), x0: x, started: anchor !== null, prev, channels, pointerType: e.pointerType };
      if (anchor !== null) this.#dragTo(drag, x);
      if (e.pointerType === 'touch') {
        longPress = setTimeout(() => {
          if (drag && !drag.started) {
            drag = null;
            menuTouch = true;
            contextMenu(this.app, WAVEFORM_CONTEXT, e.clientX, e.clientY, 'Waveform context menu');
          }
        }, 550);
      }
    });

    // The menu can open under the finger (kept on screen near an edge); cancelling the
    // touch's end keeps the browser from clicking the item there, which ran that command.
    s.addEventListener('touchend', (e) => {
      if (!menuTouch) return;
      menuTouch = false;
      if (e.cancelable) e.preventDefault();
    });
    s.addEventListener('pointerleave', () => {
      this.app.emit('cursor-data', null);
      if (this.hoverSample) {
        this.hoverSample = null;
        this.invalidate('overlay');
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
        const span = Math.max(MIN_VIEW_FRAMES, (v.end - v.start) * (pinch.dist / dist));
        const anchorFrame = v.start + ((pinch.mid - rect.left) / this.width) * (v.end - v.start);
        const start = anchorFrame - ((mid - rect.left) / this.width) * span;
        this.doc.setView(start, start + span);
        return;
      }
      if (!drag) {
        this.#hoverCursor(e);
        return;
      }
      if (drag.layer) {
        drag.layer.pointer(e, 'move');
        return;
      }
      if (drag.samples) {
        const r = s.getBoundingClientRect();
        this.#moveSampleDrag(e.clientX - r.left, e.clientY - r.top);
        return;
      }
      const rect = s.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (!drag.started && Math.abs(x - drag.x0) < (drag.pointerType === 'touch' ? 8 : 3)) return;
      clearTimeout(longPress);
      drag.started = true;
      this.#dragTo(drag, x);
      this.#edgeScroll(drag, x);
    });

    const finish = (e, cancelled) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      clearTimeout(longPress);
      if (!drag) return;
      clearTimeout(drag.edgeTimer);
      if (drag.layer) {
        drag.layer.pointer(e, cancelled ? 'cancel' : 'up');
        drag = null;
        return;
      }
      if (drag.samples) {
        const start = this.sampleDrag?.start;
        // A click on a sample point without dragging places the playhead, as anywhere else.
        if (!this.#endSampleDrag(cancelled) && !cancelled && start !== undefined) {
          this.doc.setSelection(start, start, { channels: this.doc.state.channels.map(() => true) });
          this.seek(start);
        }
        drag = null;
        return;
      }
      if (cancelled) {
        this.doc.setSelection(drag.prev.start, drag.prev.end, { channels: drag.prev.channels });
      } else if (!drag.started) {
        // A plain click places the playhead and clears the selection.
        const f = this.snap(this.frameAt(drag.x0));
        this.doc.setSelection(f, f, { channels: this.doc.channelCount ? this.doc.state.channels.map(() => true) : [] });
        this.seek(f);
      }
      drag = null;
    };
    s.addEventListener('pointerup', (e) => finish(e, false));
    s.addEventListener('pointercancel', (e) => finish(e, true));
    s.addEventListener('lostpointercapture', (e) => {
      if (drag && !drag.layer) finish(e, false);
    });
    s.addEventListener('keydown', (e) => {
      // Escape during a sample drag puts the samples back.
      if (e.key === 'Escape' && drag?.samples) {
        this.#endSampleDrag(true);
        drag = null;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });

    s.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.#wheel(e, e.clientX - s.getBoundingClientRect().left);
      },
      { passive: false },
    );
  }

  /** Mouse wheel over the lanes or the time ruler, at x px from the left edge. */
  #wheel(e, x) {
    const v = this.doc.view;
    const span = v.end - v.start;
    if (e.altKey) {
      this.doc.setAmp(this.doc.view.amp * Math.pow(1.0015, -e.deltaY));
      return;
    }
    // Horizontal trackpad motion (or Shift+wheel) scrolls; vertical zooms
    // around the pointer, as in desktop audio editors.
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    if (Math.abs(dx) > Math.abs(e.deltaY) || e.shiftKey) {
      const shift = (dx / this.width) * span;
      this.doc.setView(v.start + shift, v.end + shift);
      return;
    }
    wheelZoom(this.app, this.doc, e, x, this.width);
  }

  /** Right-click menu of the time ruler: the time display format and time zoom. */
  rulerMenuItems() {
    const app = this.app;
    const formats = app.timeFormatMenuItems?.() || [];
    return [
      ...formats,
      ...(formats.length ? [{ type: 'sep' }] : []),
      ...resolveItems(app, ['view.zoomInTime', 'view.zoomOutTime', 'view.zoomSelection', 'view.zoomFull', '-', 'edit.selectView', 'edit.selectAll']),
    ];
  }

  /** True when the view is zoomed in far enough for single samples to be dragged. */
  samplesEditable() {
    return this.doc.length > 0 && this.width > 0 && 1 / this.fpp >= SAMPLE_EDIT_PX;
  }

  /** y (CSS px) of a sample value in a lane at the current amplitude zoom. */
  #sampleY(lane, v) {
    const mid = (lane.top + lane.bottom) / 2;
    return mid - Math.max(-1.05, Math.min(1.05, v * this.doc.view.amp)) * ((lane.bottom - lane.top) / 2);
  }

  /**
   * The sample point under (x, y) when zoomed in to single samples: { ch, frame }, or
   * null. Only channels enabled for editing respond; in a layered display the channel
   * whose point is nearest wins.
   */
  sampleAt(x, y) {
    if (!this.samplesEditable() || y >= (this.waveHeight ?? this.height)) return null;
    const doc = this.doc;
    const frame = Math.round(this.frameAt(x));
    if (frame < 0 || frame >= doc.length || Math.abs(this.xOf(frame) - x) > 5) return null;
    const one = new Float32Array(1);
    let best = null;
    let bestD = 6;
    this.lanes().forEach((lane, ch) => {
      if (doc.selection.channels[ch] === false || y < lane.top - 2 || y > lane.bottom + 2) return;
      doc.state.channels[ch].read(frame, one);
      const d = Math.abs(this.#sampleY(lane, one[0]) - y);
      if (d <= bestD) {
        bestD = d;
        best = { ch, frame };
      }
    });
    return best;
  }

  #startSampleDrag({ ch, frame }) {
    const doc = this.doc;
    const before = doc.state;
    const a = Math.max(0, Math.floor(doc.view.start) - 1);
    const b = Math.min(doc.length, Math.ceil(doc.view.end) + 2);
    this.sampleDrag = { ch, start: frame, before, a, buf: before.channels[ch].toArray(a, b), last: null, channel: before.channels[ch], changed: false };
    this.#setSampleAt(frame, this.xOf(frame));
  }

  /** Sets the sample under x to the value at y, filling in samples skipped since the last move. */
  #moveSampleDrag(x, y) {
    const d = this.sampleDrag;
    if (!d) return;
    d.y = y;
    const frame = Math.round(this.frameAt(Math.max(0, Math.min(this.width, x))));
    this.#setSampleAt(frame, x);
  }

  #setSampleAt(frame, x, y = this.sampleDrag.y) {
    const d = this.sampleDrag;
    const lane = this.lanes()[d.ch];
    const half = (lane.bottom - lane.top) / 2;
    const value = y === undefined ? null : Math.max(-1, Math.min(1, ((lane.top + lane.bottom) / 2 - y) / half / this.doc.view.amp));
    const i = frame - d.a;
    if (value === null || i < 0 || i >= d.buf.length) {
      d.last = i >= 0 && i < d.buf.length ? { i, v: d.buf[i] } : d.last;
      return;
    }
    const from = d.last ?? { i, v: value };
    const lo = Math.min(from.i, i);
    const hi = Math.max(from.i, i);
    for (let k = lo; k <= hi; k++) {
      const t = hi === lo ? 1 : (k - from.i) / (i - from.i);
      d.buf[k] = from.v + (value - from.v) * t;
    }
    d.last = { i, v: value };
    d.changed = true;
    d.channel = d.before.channels[d.ch].write(d.a, d.buf.slice());
    this.invalidate('wave');
    this.invalidate('overlay');
    // The status bar reads the value being drawn, not the one in the file.
    const names = this.doc.channelCount === 1 ? ['M'] : CHANNEL_NAMES;
    this.app.emit('cursor-data', { frame, rate: this.doc.sampleRate, channel: names[d.ch] || String(d.ch + 1), db: value ? 20 * Math.log10(Math.abs(value)) : -Infinity });
  }

  #endSampleDrag(cancelled) {
    const d = this.sampleDrag;
    this.sampleDrag = null;
    this.invalidate('wave');
    if (!d || cancelled || !d.changed || this.doc.state !== d.before) return false;
    return this.doc.apply('Edit Samples', { ...d.before, channels: d.before.channels.map((c, i) => (i === d.ch ? d.channel : c)) });
  }

  /** Extends the time selection to `frame` from its far edge (or from the playhead). */
  extendSelectionTo(frame) {
    const doc = this.doc;
    const f = this.snap(Math.max(0, Math.min(doc.length, frame)));
    const sel = doc.selection;
    const anchor = sel.end > sel.start ? (Math.abs(f - sel.start) < Math.abs(f - sel.end) ? sel.end : sel.start) : doc.cursor;
    doc.setSelection(anchor, f, { channels: sel.channels });
    this.#announcePosition();
  }

  #hoverCursor(e) {
    const rect = this.surface.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const f = this.frameAt(x);
    this.#reportCursorData(f, e.clientY - rect.top);
    const sel = this.doc.selection;
    const tol = 6 * this.fpp;
    const onEdge = sel.end > sel.start && (Math.abs(f - sel.start) < tol || Math.abs(f - sel.end) < tol);
    const y = e.clientY - rect.top;
    const sample = onEdge ? null : this.sampleAt(x, y);
    if (sample?.frame !== this.hoverSample?.frame || sample?.ch !== this.hoverSample?.ch) {
      this.hoverSample = sample;
      this.invalidate('overlay');
    }
    let cursor = onEdge ? 'ew-resize' : sample ? 'ns-resize' : 'text';
    if (cursor === 'text') {
      // Near the top or bottom edge a drag selects one channel: the I-beam names it.
      const mask = this.#channelMaskAt(y);
      const one = mask && mask.filter(Boolean).length === 1 ? mask.indexOf(true) : -1;
      if (one >= 0) cursor = channelCursor(CHANNEL_NAMES[one] || String(one + 1));
    }
    for (const l of this.layers) {
      const c = l.visible?.() !== false && l.cursor?.(e);
      if (c) cursor = c;
    }
    this.surface.style.cursor = cursor;
  }

  #dragTo(drag, x) {
    const f = this.snap(Math.max(0, Math.min(this.doc.length, this.frameAt(x))));
    this.#showSnap(this.lastSnapTarget);
    this.doc.setSelection(drag.anchor, f, { channels: drag.channels || this.doc.selection.channels });
    if (!this.app.engine.playing) this.doc.setCursor(Math.min(drag.anchor, f), { silent: true });
  }

  /**
   * While a selection drag is held past the left or right edge, the view keeps
   * scrolling (faster the further out the pointer is) and the selection follows,
   * even when the pointer stops moving.
   */
  #edgeScroll(drag, x) {
    drag.edgeX = x;
    if (drag.edgeTimer) return;
    const tick = () => {
      drag.edgeTimer = 0;
      const over = drag.edgeX < 0 ? drag.edgeX : drag.edgeX > this.width ? drag.edgeX - this.width : 0;
      if (!over) return;
      const v = this.doc.view;
      const shift = (v.end - v.start) * 0.02 * Math.sign(over) * Math.min(2, Math.max(0.25, Math.abs(over) / 40));
      this.doc.setView(v.start + shift, v.end + shift);
      this.#dragTo(drag, drag.edgeX);
      drag.edgeTimer = setTimeout(tick, 16);
    };
    tick();
  }

  #bindKeys() {
    this.surface.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const doc = this.doc;
      const step = Math.max(1, Math.round(this.fpp * (e.shiftKey ? 1 : 10)));
      let handled = true;
      // Alt+Left/Right are Move Playhead to Previous/Next, as in the Multitrack editor.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey) {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) {
          const sel = doc.selection;
          const hasSel = sel.end > sel.start;
          const anchor = hasSel ? (doc.cursor === sel.end ? sel.start : sel.end) : doc.cursor;
          const moving = hasSel ? (anchor === sel.start ? sel.end : sel.start) : doc.cursor;
          const next = Math.max(0, Math.min(doc.length, moving + dir * Math.max(1, Math.round(this.fpp * 10))));
          doc.setSelection(anchor, next);
          doc.setCursor(next, { silent: true });
        } else {
          // While this file plays, step from the moving playhead, not from where playback started.
          const from = this.app.engine.playing && this.app.active === doc ? this.app.playhead : doc.cursor;
          this.seek(from + dir * step);
        }
      } else if (e.key === 'Escape') doc.setSelection(doc.cursor, doc.cursor);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        this.#announcePosition();
      }
    });
  }

  #announcePosition() {
    const doc = this.doc;
    const sel = doc.selection;
    const text = sel.end > sel.start ? `Selection ${this.app.formatTime(sel.start)} to ${this.app.formatTime(sel.end)}` : `Playhead ${this.app.formatTime(doc.cursor)}`;
    // Spoken through the shared live region; #wf-help keeps the static key help.
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => announce(text), 250);
  }

  #bindFadeHandles() {
    const bind = (el, dir) => {
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const y0 = e.clientY;
        // New fades start with the curve chosen in Preferences > General.
        const base = defaultFadeCurve(this.app);
        this.fadeDrag = { dir, frames: 0, curve: base };
        const move = (ev) => {
          const dx = (ev.clientX - x0) * (dir === 'in' ? 1 : -1);
          const frames = Math.max(0, Math.min(this.doc.length, Math.round(dx * this.fpp)));
          const dy = y0 - ev.clientY;
          const curve = Math.abs(dy) < 4 ? base : Math.max(-1, Math.min(1, (base === 2 ? 0 : base) + dy / 100));
          this.fadeDrag = { dir, frames, curve };
          this.invalidate('overlay');
        };
        const up = (ev) => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          const d = this.fadeDrag;
          this.fadeDrag = null;
          this.invalidate('overlay');
          if (ev.type === 'pointercancel' || !d || d.frames < 2) return;
          const len = this.doc.length;
          const [a, b] = dir === 'in' ? [0, d.frames] : [len - d.frames, len];
          this.doc.apply(dir === 'in' ? 'Fade In' : 'Fade Out', fadeRange(this.doc.state, a, b, dir, d.curve, this.doc.channelMask));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    };
    bind(this.fadeInHandle, 'in');
    bind(this.fadeOutHandle, 'out');
  }

  /** Adds a cue (or range, with a selection) marker at the playhead. */
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

  focus() {
    this.surface.focus({ preventScroll: true });
  }

  destroy() {
    this.offDoc();
    this.offPrefs();
    this.offActive();
    window.removeEventListener('themechange', this.onTheme);
    window.removeEventListener('pointerup', this.onRelease, true);
    window.removeEventListener('pointercancel', this.onRelease, true);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    for (const l of this.layers) l.destroy?.();
  }
}
