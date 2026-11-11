// Waveform editor view for an AudioFile: overview navigator, time ruler,
// channel lanes (WebGL2), dB ruler with channel enable buttons, selection,
// markers, fade handles, the gain HUD and touch/pointer/keyboard interaction.
//
// Extensions (e.g. the spectral display) register through
// WaveformView.extensions: each is { attach(view) } and may set
// view.layers entries { id, el, layout(rect), draw(), pointer(e, phase) }.

import { h, announce } from '../lib/dom.js';
import { TimeRuler, rulerTicks } from './time-ruler.js';
import { Overview } from './overview.js';
import { WaveformRenderer } from '../render/waveform-gl.js';
import { channelColumns } from '../audio/peaks.js';
import { cssVar, CANVAS_FONT, parseColor } from '../ui/theme.js';
import { markerColor } from '../ui/appearance.js';
import { icon } from '../ui/icons.js';
import './editor-icons.js';
import { gainRange, fadeRange, fadeCurve, smoothBoundaries } from '../model/edits.js';
import { WAVEFORM_CONTEXT } from '../ui/menus.js';
import { contextMenu } from '../ui/menubar.js';
import { dbToGain, formatDb, framesPerSecond, musicalStep } from '../lib/time.js';
import { createMarker, nextMarkerName, sortMarkers } from '../model/markers.js';
import { wheelZoom, followPlayhead, editSmoothFrames, defaultFadeCurve } from './view-prefs.js';

const CHANNEL_NAMES = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
const CHANNEL_TOKENS = ['--wave', '--wave-2', '--wave-3', '--wave-4'];

/** Per-channel waveform color for View > Waveform Channels > Uniquely Colored. */
const channelColor = (i) => cssVar(CHANNEL_TOKENS[i % CHANNEL_TOKENS.length]);

function withAlpha(color, alpha) {
  const [r, g, b, a] = parseColor(color);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a * alpha})`;
}

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
    this.dirty = { wave: true, overlay: true, ruler: true, overview: true, amp: true };
    this.#build();
    this.offDoc = doc.on('change', (e) => this.#onDocChange(e));
    this.offPrefs = app.on('prefs', (key) => {
      if (key === 'waveLayered' || key === 'waveUniqueColors') this.#buildChannelButtons();
      if (key === 'waveLayered') this.overview.peaksFor = null;
      if (key === 'hudPinned') this.syncHudPin?.();
      this.invalidate();
    });
    this.onTheme = () => this.invalidate();
    window.addEventListener('themechange', this.onTheme);
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
      moveMarker: (id, start, { preview }) => this.moveMarker(id, start, preview),
      renameMarker: (id) => app.commands.run('marker.rename', { id }),
      selectMarker: (id) => this.selectMarker(id),
      overviewPeaks: (cols, total) => this.#overviewPeaks(cols, total),
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
      { type: 'button', 'aria-label': 'Pin HUD', title: 'Keep the HUD visible when the pointer leaves the editor', onclick: () => this.app.prefs.toggle('hudPinned') },
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
    const setGain = (db) => {
      this.hudGain = Math.max(-60, Math.min(30, Math.round(db * 10) / 10));
      valueEl.textContent = formatDb(this.hudGain).replace(/ dB$/, '');
      knobEl.setAttribute('aria-valuenow', String(this.hudGain));
      knobEl.setAttribute('aria-valuetext', formatDb(this.hudGain));
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
        consider(Math.round(Math.round(frame / step) * step));
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
      consider(Math.round(Math.round(frame / step) * step));
    }
    if (snap.zero && bestD === tol) {
      const ch = this.doc.state.channels[0];
      if (ch && ch.length) {
        const r = Math.max(8, Math.round(this.fpp * 6));
        const a = Math.max(0, Math.round(frame) - r);
        const b = Math.min(ch.length, Math.round(frame) + r);
        const s = ch.toArray(a, b);
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
        if (zbest >= 0) return zbest;
      }
    }
    return best;
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
    if (this.dirty.wave) this.#drawWave();
    if (this.dirty.overlay) this.#drawOverlay();
    if (this.dirty.ruler) this.ruler.draw();
    if (this.dirty.overview) this.overview.draw();
    if (this.dirty.amp) this.#drawAmp();
    for (const l of this.layers) if (l.visible?.() !== false) l.draw?.(this.dirty);
    for (const k of Object.keys(this.dirty)) this.dirty[k] = false;
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
    this.renderer.draw({ channels: doc.state.channels, start: doc.view.start, fpp: this.fpp / dpr, amp, lanes, colors });
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
    for (const lane of lanes) {
      const mid = (lane.top + lane.bottom) / 2;
      ctx.fillStyle = cssVar('--grid-strong');
      ctx.fillRect(0, Math.round(mid), W, 1);
      ctx.fillStyle = cssVar('--grid');
      for (const t of dbTicks(lane, amp)) {
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
    // Fade preview curve.
    if (this.fadeDrag) {
      const { dir, frames, curve } = this.fadeDrag;
      ctx.strokeStyle = cssVar('--envelope-vol');
      ctx.lineWidth = 1.5;
      for (const lane of lanes) {
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
      }
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
    return rulerTicks(t0, t1, W).ticks.map((sec) => Math.round(((sec - t0) / (t1 - t0)) * W));
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
    for (const lane of this.lanes()) {
      const mid = (lane.top + lane.bottom) / 2;
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

  /** Overview peaks: one strip per channel, like the lanes (merged when layered). */
  #overviewPeaks(cols, total) {
    const ch = this.doc.state.channels;
    if (!ch.length || !this.doc.length) return null;
    const fpp = total / cols;
    const strips = ch.map((c) => channelColumns(c, 0, fpp, cols));
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

  /** Markers as displayed, including a marker being dragged. */
  markers() {
    const p = this.markerPreview;
    if (!p) return this.doc.state.markers;
    return this.doc.state.markers.map((m) => (m.id === p.id ? { ...m, start: p.start } : m));
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
    } else if (e.kind === 'cursor') this.#placePlayhead(); else if (e.kind === 'rename') this.surface.setAttribute('aria-label', `Waveform of ${this.doc.name}`);
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
      s.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        clearTimeout(longPress);
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.abs(a.x - b.x) || 1, mid: (a.x + b.x) / 2, view: { ...this.doc.view } };
        if (drag?.started) this.doc.setSelection(drag.prev.start, drag.prev.end, { channels: drag.prev.channels });
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
      const edgeTol = 6 * this.fpp;
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
            contextMenu(this.app, WAVEFORM_CONTEXT, e.clientX, e.clientY, 'Waveform context menu');
          }
        }, 550);
      }
    });

    s.addEventListener('pointerleave', () => this.app.emit('cursor-data', null));
    s.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.abs(a.x - b.x) || 1;
        const mid = (a.x + b.x) / 2;
        const rect = s.getBoundingClientRect();
        const v = pinch.view;
        const span = (v.end - v.start) * (pinch.dist / dist);
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
      const rect = s.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (!drag.started && Math.abs(x - drag.x0) < (drag.pointerType === 'touch' ? 8 : 3)) return;
      clearTimeout(longPress);
      drag.started = true;
      this.#dragTo(drag, x);
      this.#edgeScroll(x);
    });

    const finish = (e, cancelled) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      clearTimeout(longPress);
      if (!drag) return;
      if (drag.layer) {
        drag.layer.pointer(e, cancelled ? 'cancel' : 'up');
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

    s.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = s.getBoundingClientRect();
        const x = e.clientX - rect.left;
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
      },
      { passive: false },
    );
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
    let cursor = onEdge ? 'ew-resize' : 'text';
    for (const l of this.layers) {
      const c = l.visible?.() !== false && l.cursor?.(e);
      if (c) cursor = c;
    }
    this.surface.style.cursor = cursor;
  }

  #dragTo(drag, x) {
    const f = this.snap(Math.max(0, Math.min(this.doc.length, this.frameAt(x))));
    this.doc.setSelection(drag.anchor, f, { channels: drag.channels || this.doc.selection.channels });
    if (!this.app.engine.playing) this.doc.setCursor(Math.min(drag.anchor, f), { silent: true });
  }

  #edgeScroll(x) {
    const v = this.doc.view;
    const span = v.end - v.start;
    if (x < 0) this.doc.setView(v.start - span * 0.02, v.end - span * 0.02);
    else if (x > this.width) this.doc.setView(v.start + span * 0.02, v.end + span * 0.02);
  }

  #bindKeys() {
    this.surface.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const doc = this.doc;
      const step = e.altKey ? 1 : Math.max(1, Math.round(this.fpp * (e.shiftKey ? 1 : 10)));
      let handled = true;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
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
    window.removeEventListener('themechange', this.onTheme);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    for (const l of this.layers) l.destroy?.();
  }
}
