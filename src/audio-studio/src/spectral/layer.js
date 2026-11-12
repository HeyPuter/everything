// Spectral Frequency Display: a WaveformView layer below the waveform with a
// spectrogram per channel, a frequency ruler beside it, a draggable divider,
// spectral selection tools (marquee, lasso, paintbrush, spot healing brush)
// and an optional pitch (f0) overlay.
//
// Analysis runs in the analysis workers (Rust STFT); results come back as
// byte tiles cached as GPU textures (see tiles.js, renderer.js). Only tiles
// for the visible range at the current zoom density are requested, nearest
// the centre of the view first; tiles at neighbouring densities stand in
// while they arrive.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { cssVar, CANVAS_FONT, resolvedTheme } from '../ui/theme.js';
import { SpectrogramRenderer } from './renderer.js';
import { TileCache, planTiles, chooseHop, readTileSamples, FLOOR_DB } from './tiles.js';
import { makeScale, frequencyTicks, formatHzLong, noteName } from './freq-scale.js';
import { buildLut } from './colormaps.js';
import { settings, setSettings, displayOn, pitchOn, logScale, docState, visibleBand, setSpectralSelection, SPECTRAL_TOOLS, pitchSettings } from './state.js';
import { addBrushDot, dotOutline, shapeIntervals } from './mask.js';
import { analysisPool } from '../analysis/pool.js';
import { sourceKey } from '../engine/engine.js';
import { spectralMenuItems } from './menu.js';

const CACHE_BYTES = 96 * 1024 * 1024;
const MAX_INFLIGHT = 6;
const MAX_PER_FRAME = 3;
const LANE_GAP = 1;

export class SpectralLayer {
  constructor(app, view, services) {
    this.id = 'spectral';
    this.app = app;
    this.view = view;
    this.doc = view.doc;
    this.svc = services;
    this.rect = null;
    this.needs = true;
    this.inflight = 0;
    this.pending = new Set();
    this.drag = null;
    this.hover = null;
    this.pitch = null;
    this.renderer = null;
    this.generation = 0;
    this.cache = new TileCache(CACHE_BYTES, (v) => this.renderer?.deleteTile(v.tex));

    this.canvas = h('canvas.spec-gl', { 'aria-hidden': 'true' });
    this.over = h('canvas.spec-overlay', { 'aria-hidden': 'true' });
    this.divider = h('div.spec-divider', {
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'horizontal',
      'aria-label': 'Resize the spectral display',
      title: 'Drag to resize the spectral display. Double-click to reset.',
    });
    this.ruler = h('canvas.spec-ruler', { 'aria-hidden': 'true' });
    this.rulerHit = h('div.spec-ruler-hit', { title: 'Frequency ruler: scroll to zoom, drag to scroll, double-click to show all frequencies' });
    this.settingsBtn = h(
      'button.icon-btn.sm.spec-settings',
      { type: 'button', 'aria-label': 'Spectral display settings', title: 'Spectral display settings', 'aria-haspopup': 'menu' },
      icon('sliders-horizontal', 13),
    );
    this.readout = h('div.spec-readout', { 'aria-hidden': 'true' });
    this.live = h('div.sr-only', { 'aria-live': 'polite' });
    view.surface.insertBefore(this.canvas, view.overlay);
    view.surface.insertBefore(this.over, view.playheadEl);
    view.surface.append(this.divider, this.readout, this.live);
    view.amp.append(this.ruler, this.rulerHit, this.settingsBtn);
    this.settingsBtn.addEventListener('click', () => this.openSettings());
    this.#bindDivider();
    this.#bindRuler();
    this.offs = [
      app.on('spectral-selection', (doc) => doc === this.doc && this.invalidate()),
      app.on('tool', () => this.invalidate()),
      app.on('active', (doc) => {
        // Free GPU memory held for documents that are not on screen.
        if (doc !== this.doc) this.release();
      }),
    ];
    this.sync();
  }

  // ------------------------------------------------------------- layer API

  get share() {
    return this.shareDraft ?? settings(this.app).share;
  }

  visible() {
    return displayOn(this.app);
  }

  /** Shows or hides the layer's elements after the display is toggled. */
  sync() {
    const on = this.visible();
    for (const el of [this.canvas, this.over, this.divider, this.ruler, this.rulerHit, this.settingsBtn, this.readout]) el.hidden = !on;
    if (!on) {
      this.rect = null;
      clearTimeout(this.pitchTimer);
      this.release();
    }
    this.view.layout?.();
  }

  layout(rect) {
    this.rect = rect;
    const dpr = rect.dpr || window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.over]) {
      c.style.top = `${rect.y}px`;
      c.style.width = `${rect.width}px`;
      c.style.height = `${rect.height}px`;
    }
    this.over.width = Math.round(rect.width * dpr);
    this.over.height = Math.round(rect.height * dpr);
    this.renderer?.resize(rect.width, rect.height, dpr);
    this.divider.style.top = `${rect.y - 4}px`;
    this.divider.setAttribute('aria-valuenow', String(Math.round(this.share * 100)));
    this.divider.setAttribute('aria-valuemin', '15');
    this.divider.setAttribute('aria-valuemax', '85');
    const ampW = this.view.amp.clientWidth || 46;
    this.ruler.style.top = `${rect.y}px`;
    this.ruler.style.width = `${ampW}px`;
    this.ruler.style.height = `${rect.height}px`;
    this.ruler.width = Math.round(ampW * dpr);
    this.ruler.height = Math.round(rect.height * dpr);
    this.rulerHit.style.top = `${rect.y + 22}px`;
    this.rulerHit.style.height = `${Math.max(0, rect.height - 22)}px`;
    this.settingsBtn.style.top = `${rect.y + 2}px`;
    this.needs = true;
  }

  invalidate() {
    this.needs = true;
    this.app.requestRender?.();
  }

  /** Channel lanes of the spectral area in surface coordinates. */
  lanes() {
    const r = this.rect;
    if (!r) return [];
    const n = this.doc.channelCount;
    const lh = (r.height - LANE_GAP * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => ({ channel: i, top: r.y + i * (lh + LANE_GAP), bottom: r.y + i * (lh + LANE_GAP) + lh }));
  }

  scale() {
    const band = visibleBand(this.doc);
    return makeScale({ log: logScale(this.app), lo: band.lo, hi: band.hi });
  }

  // ---------------------------------------------------------------- drawing

  #ensureRenderer() {
    if (this.renderer || !this.rect) return this.renderer;
    try {
      this.renderer = new SpectrogramRenderer(this.canvas);
    } catch (err) {
      console.warn('[spectral]', err);
      this.renderer = null;
      return null;
    }
    this.renderer.onLost = () => this.invalidate();
    this.renderer.onRestore = () => {
      this.cache.clear();
      this.invalidate();
    };
    this.renderer.resize(this.rect.width, this.rect.height, this.rect.dpr || window.devicePixelRatio || 1);
    return this.renderer;
  }

  /** Frees textures and the GL context (re-created on the next draw). */
  release() {
    this.cache.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
      // Disposing loses the canvas' WebGL context, and a canvas keeps that lost
      // context for good: the next renderer needs a new canvas.
      const fresh = h('canvas.spec-gl', { 'aria-hidden': 'true' });
      fresh.hidden = this.canvas.hidden;
      fresh.style.cssText = this.canvas.style.cssText;
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
    }
    this.needs = true;
  }

  draw(dirty) {
    if (!this.rect || !this.visible()) return;
    const anyDirty = this.needs || Object.values(dirty).some(Boolean);
    if (!anyDirty) return;
    this.needs = false;
    const app = this.app;
    const doc = this.doc;
    const s = settings(app);
    const r = this.#ensureRenderer();
    const v = doc.view;
    const fpp = this.view.fpp;
    const fft = s.fft;
    const hop = chooseHop(fpp, fft);
    const prefix = `${s.window}:`;
    const lanes = this.lanes();
    const scale = this.scale();
    const nyquist = doc.sampleRate / 2;
    const wanted = [];
    const frameLanes = [];
    if (r?.available) {
      r.setLut(`${s.map}/${resolvedTheme()}`, buildLut(s.map, resolvedTheme() === 'light'));
      for (const lane of lanes) {
        const ch = doc.state.channels[lane.channel];
        const tiles = planTiles(ch, v.start, v.end, hop, fft, prefix);
        const drawn = [];
        let missing = false;
        for (const t of tiles) {
          const c = this.cache.get(t.key);
          if (c) drawn.push({ tex: c.tex, bins: c.bins, x0: t.x0, x1: t.x1 });
          else {
            missing = true;
            wanted.push({ tile: t, ch });
          }
        }
        const fallback = [];
        if (missing) {
          // Coarser and finer tiles already cached stand in, coarse first.
          for (const fh of [hop * 8, hop * 4, hop * 2, hop / 2]) {
            if (fh < Math.max(8, fft / 32)) continue;
            for (const t of planTiles(ch, v.start, v.end, fh, fft, prefix)) {
              const c = this.cache.peek(t.key);
              if (c) fallback.push({ tex: c.tex, bins: c.bins, x0: t.x0, x1: t.x1 });
            }
          }
        }
        frameLanes.push({ top: lane.top - this.rect.y, bottom: lane.bottom - this.rect.y, tiles: [...fallback, ...drawn] });
      }
      const lut = buildLut(s.map, resolvedTheme() === 'light');
      r.draw({
        lanes: frameLanes,
        start: v.start,
        fpp,
        width: this.rect.width,
        scale,
        nyquist,
        range: [s.minDb, s.maxDb],
        background: [lut[0] / 255, lut[1] / 255, lut[2] / 255, 1],
      });
      this.#request(wanted, fft, s.window, (v.start + v.end) / 2);
      if (!wanted.length) this.#prefetch(hop, fft, prefix, s.window);
    }
    this.#drawOverlay(lanes, scale, Boolean(r?.available));
    this.#drawRuler(lanes, scale);
    if (pitchOn(app)) this.#updatePitch();
  }

  #request(wanted, fft, window, centre) {
    if (!wanted.length) return;
    wanted.sort((a, b) => Math.abs((a.tile.x0 + a.tile.x1) / 2 - centre) - Math.abs((b.tile.x0 + b.tile.x1) / 2 - centre));
    // Reading samples costs main-thread time, so issue a few per frame; the
    // rest follow as results arrive.
    let issued = 0;
    for (const { tile, ch } of wanted) {
      if (this.inflight >= MAX_INFLIGHT || issued >= MAX_PER_FRAME) break;
      if (this.pending.has(tile.key)) continue;
      this.#compute(tile, ch, fft, window);
      issued++;
    }
  }

  #compute(tile, ch, fft, window) {
    const pool = analysisPool();
    const samples = readTileSamples(ch, tile, fft);
    this.pending.add(tile.key);
    this.inflight++;
    const generation = this.generation;
    pool
      .call({ op: 'columns', fft, window, hop: tile.read.contiguous ? tile.hop : fft, frames: tile.cols, samples, floor: FLOOR_DB }, [samples.buffer])
      .then((bytes) => {
        if (generation !== this.generation || !this.renderer) return;
        const bins = fft / 2 + 1;
        const tex = this.renderer.createTile(bytes, bins, tile.cols);
        if (tex) this.cache.set(tile.key, { tex, bins, cols: tile.cols }, bytes.length);
      })
      .catch((err) => console.warn('[spectral]', err))
      .finally(() => {
        this.pending.delete(tile.key);
        this.inflight--;
        this.invalidate();
      });
  }

  /** Once the view is complete, computes tiles just outside it for smooth scrolling. */
  #prefetch(hop, fft, prefix, window) {
    if (this.inflight) return;
    const v = this.doc.view;
    const span = v.end - v.start;
    const out = [];
    for (const ch of this.doc.state.channels) {
      for (const [a, b] of [[v.end, v.end + span * 0.5], [v.start - span * 0.5, v.start]]) {
        for (const t of planTiles(ch, a, b, hop, fft, prefix)) if (!this.cache.has(t.key)) out.push({ tile: t, ch });
      }
    }
    this.#request(out.slice(0, 4), fft, window, (v.start + v.end) / 2);
  }

  #drawOverlay(lanes, scale, gl) {
    const ctx = this.over.getContext('2d');
    if (!ctx) return;
    const dpr = this.rect.dpr || window.devicePixelRatio || 1;
    const W = this.rect.width;
    const H = this.rect.height;
    const y0 = this.rect.y;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = CANVAS_FONT;
    if (!gl) {
      ctx.fillStyle = cssVar('--bg-editor');
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = cssVar('--text-dim');
      ctx.textAlign = 'center';
      // A lost context (a graphics reset) comes back on its own; no WebGL2 at all does not.
      const text = this.renderer?.lost ? 'Restoring the spectral display after a graphics reset...' : 'The spectral display needs WebGL2, which is not available in this browser.';
      ctx.fillText(text, W / 2, H / 2);
      ctx.textAlign = 'left';
    }
    // Frequency gridlines (Preferences > Spectral Displays), on the ruler's ticks.
    if (gl && this.app.prefs.get('spectralGrid')) {
      ctx.save();
      ctx.globalAlpha = Math.max(0.02, Math.min(1, (Number(this.app.prefs.get('spectralGridOpacity')) || 15) / 100));
      ctx.fillStyle = cssVar('--text-strong');
      for (const lane of lanes) {
        const top = lane.top - y0;
        for (const t of frequencyTicks(scale, lane.bottom - lane.top, 16)) ctx.fillRect(0, Math.round(top + t.y), W, 1);
      }
      ctx.restore();
    }
    // Lane separators and the boundary with the waveform.
    ctx.fillStyle = cssVar('--divider');
    ctx.fillRect(0, 0, W, 1);
    for (let i = 1; i < lanes.length; i++) ctx.fillRect(0, Math.round(lanes[i].top - y0) - 1, W, 1);
    const doc = this.doc;
    const st = docState(doc);
    const sel = doc.selection;
    // Time selection across the spectral lanes (when no spectral selection).
    if (!st.selection && sel.end > sel.start) {
      const x0 = Math.max(0, this.view.xOf(sel.start));
      const x1 = Math.min(W, this.view.xOf(sel.end));
      if (x1 > x0) {
        ctx.fillStyle = cssVar('--sel-bg');
        for (const lane of lanes) if (sel.channels[lane.channel] !== false) ctx.fillRect(x0, lane.top - y0, x1 - x0, lane.bottom - lane.top);
      }
    }
    const shapes = [...(st.selection?.shapes || [])];
    const channels = st.selection?.channels || doc.selection.channels;
    if (this.drag?.shape) shapes.push(this.drag.shape);
    if (shapes.length) {
      for (const lane of lanes) {
        if (channels[lane.channel] === false && !this.drag) continue;
        this.#drawShapes(ctx, shapes, lane, scale, this.drag?.tool === 'heal');
      }
    }
    // Pitch overlay.
    if (pitchOn(this.app) && this.pitch?.f0s) this.#drawPitch(ctx, lanes, scale);
    // Brush cursor.
    const tool = this.app.tool;
    if (this.hover && (tool === 'brush' || tool === 'heal')) {
      const r = settings(this.app).brushSize / 2;
      ctx.strokeStyle = tool === 'heal' ? cssVar('--warning') : cssVar('--text-strong');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y - y0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  #toXY(lane, scale, t, f) {
    const x = this.view.xOf(t);
    const y = lane.bottom - this.rect.y - scale.toFrac(f) * (lane.bottom - lane.top);
    return [x, y];
  }

  #drawShapes(ctx, shapes, lane, scale, healing) {
    const y0 = this.rect.y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, lane.top - y0, this.rect.width, lane.bottom - lane.top);
    ctx.clip();
    // Union of fills, so overlapping brush dots do not stack up.
    const fill = healing ? cssVar('--warning') : resolvedTheme() === 'light' ? '#1473e6' : '#ffffff';
    ctx.globalAlpha = healing ? 0.35 : 0.22;
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (const s of shapes) {
      if (s.type === 'rect') {
        const [xa, ya] = this.#toXY(lane, scale, s.t0, Math.max(s.f0, s.f1));
        const [xb, yb] = this.#toXY(lane, scale, s.t1, Math.min(s.f0, s.f1));
        ctx.rect(xa, ya, xb - xa, yb - ya);
      } else if (s.type === 'poly') {
        s.points.forEach(([t, f], i) => {
          const [x, y] = this.#toXY(lane, scale, t, f);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
      } else if (s.type === 'brush') {
        for (const dot of s.dots) {
          dotOutline(s, dot, 16).forEach(([t, f], i) => {
            const [x, y] = this.#toXY(lane, scale, t, f);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.closePath();
        }
      }
    }
    ctx.fill('nonzero');
    ctx.globalAlpha = 1;
    ctx.strokeStyle = healing ? cssVar('--warning') : cssVar('--sel-edge');
    ctx.setLineDash([4, 3]);
    for (const s of shapes) {
      if (s.type === 'rect') {
        const [xa, ya] = this.#toXY(lane, scale, s.t0, Math.max(s.f0, s.f1));
        const [xb, yb] = this.#toXY(lane, scale, s.t1, Math.min(s.f0, s.f1));
        ctx.strokeRect(Math.round(xa) + 0.5, Math.round(ya) + 0.5, Math.round(xb - xa), Math.round(yb - ya));
      } else if (s.type === 'poly') {
        ctx.beginPath();
        s.points.forEach(([t, f], i) => {
          const [x, y] = this.#toXY(lane, scale, t, f);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        if (this.drag?.shape !== s) ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  #drawRuler(lanes, scale) {
    const ctx = this.ruler.getContext('2d');
    if (!ctx) return;
    const dpr = this.rect.dpr || window.devicePixelRatio || 1;
    const W = this.view.amp.clientWidth || 46;
    const H = this.rect.height;
    const y0 = this.rect.y;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = CANVAS_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--text-dim');
    for (const lane of lanes) {
      const top = lane.top - y0;
      const lh = lane.bottom - lane.top;
      for (const t of frequencyTicks(scale, lh, 16)) {
        const y = top + t.y;
        if (y < top + (lane.channel === 0 ? 26 : 8)) continue;
        ctx.fillRect(0, Math.round(y), 4, 1);
        ctx.fillText(t.label, 6, y);
      }
    }
    // The unit sits beside the settings button at the top of the ruler.
    ctx.fillText('Hz', 4, 12);
  }

  // ------------------------------------------------------------- pitch

  #updatePitch() {
    const doc = this.doc;
    const v = doc.view;
    const p = this.app.prefs;
    const key = `${sourceKey(doc.state.channels)}|${Math.round(v.start)}|${Math.round(v.end)}|${this.rect.width}|${p.get('pitchWindow')}|${p.get('pitchMinHz')}|${p.get('pitchMaxHz')}`;
    if (this.pitch?.key === key || this.pitch?.loading === key) return;
    clearTimeout(this.pitchTimer);
    this.pitchTimer = setTimeout(() => this.#computePitch(key), 120);
  }

  async #computePitch(key) {
    if (!this.rect) return;
    const doc = this.doc;
    const v = doc.view;
    const { n, fmin, fmax } = pitchSettings(this.app.prefs, doc.sampleRate);
    const points = Math.max(16, Math.min(1200, Math.floor(this.rect.width / 3)));
    const start = Math.max(0, v.start);
    const end = Math.min(doc.length, v.end);
    if (end - start < n) return;
    const hop = (end - start) / points;
    const frames = Math.max(1, Math.floor((end - start - n) / hop) + 1);
    // One window per point, per channel (stereo channels often differ).
    const chans = doc.state.channels;
    this.pitch = { ...(this.pitch || {}), loading: key };
    try {
      const f0s = await Promise.all(
        chans.map((ch) => {
          const samples = new Float32Array(frames * n);
          for (let i = 0; i < frames; i++) ch.read(Math.round(start + i * hop), samples, i * n, n);
          return analysisPool().call({ op: 'pitch', samples, rate: doc.sampleRate, n, hop: n, frames, fmin, fmax, threshold: 0.15 }, [samples.buffer]);
        }),
      );
      this.pitch = { key, f0s, start, hop, n };
      this.invalidate();
    } catch (err) {
      console.warn('[spectral] pitch', err);
      this.pitch = null;
    }
  }

  #drawPitch(ctx, lanes, scale) {
    const { f0s, start, hop, n } = this.pitch;
    ctx.strokeStyle = cssVar('--envelope-vol');
    ctx.lineWidth = 2;
    for (const lane of lanes) {
      const f0 = f0s[lane.channel] || f0s[0];
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < f0.length; i++) {
        const f = f0[i];
        if (!(f > 0) || f < scale.lo || f > scale.hi) {
          pen = false;
          continue;
        }
        const [x, y] = this.#toXY(lane, scale, start + i * hop + n / 2, f);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // ---------------------------------------------------------- interaction

  #locate(e) {
    const r = this.view.surface.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (!this.rect || y < this.rect.y) return null;
    const lanes = this.lanes();
    const lane = lanes.find((l) => y >= l.top - 1 && y <= l.bottom + 1) || lanes[lanes.length - 1];
    if (!lane) return null;
    const scale = this.scale();
    const frac = 1 - (y - lane.top) / (lane.bottom - lane.top);
    return { x, y, lane, scale, t: this.view.frameAt(x), f: scale.toHz(Math.max(0, Math.min(1, frac))) };
  }

  cursor(e) {
    const p = this.#locate(e);
    this.#setHover(p);
    if (!p) return null;
    const tool = this.app.tool;
    if (tool === 'brush' || tool === 'heal') return 'none';
    if (tool === 'marquee' || tool === 'lasso') return 'crosshair';
    return null;
  }

  #setHover(p) {
    const prev = this.hover;
    this.hover = p ? { x: p.x, y: p.y } : null;
    if (p) {
      const note = noteName(p.f);
      this.readout.textContent = `${formatHzLong(p.f)}${note ? `  ${note.name}` : ''}`;
      this.readout.style.top = `${this.rect.y + 4}px`;
      this.readout.hidden = false;
    } else this.readout.hidden = true;
    if (prev || p) {
      this.needs = true;
      this.app.requestRender?.();
    }
  }

  pointer(e, phase) {
    if (phase === 'down') {
      const tool = this.app.tool;
      if (!SPECTRAL_TOOLS.includes(tool) || !this.visible()) return false;
      const p = this.#locate(e);
      if (!p) return false;
      this.#startDrag(tool, p, e);
      return true;
    }
    if (!this.drag) return false;
    const p = this.#locate(e) || this.drag.last;
    if (phase === 'move') {
      this.#moveDrag(p, e);
      this.#setHover(p);
    } else if (phase === 'up') this.#endDrag(p);
    else {
      this.drag = null;
      this.invalidate();
    }
    return true;
  }

  #brushShape(p, tool) {
    const s = settings(this.app);
    const radius = s.brushSize / 2;
    const lh = p.lane.bottom - p.lane.top;
    const scale = p.scale;
    const rf = scale.log ? (Math.log2(scale.hi / scale.lo) * radius) / lh : ((scale.hi - scale.lo) * radius) / lh;
    return { type: 'brush', log: scale.log, rt: Math.max(1, radius * this.view.fpp), rf, opacity: tool === 'heal' ? 1 : s.brushOpacity, dots: [] };
  }

  #startDrag(tool, p, e) {
    const add = e.shiftKey;
    const doc = this.doc;
    const st = docState(doc);
    const base = add && st.selection ? st.selection : null;
    let shape;
    if (tool === 'marquee') shape = { type: 'rect', t0: p.t, t1: p.t, f0: p.f, f1: p.f };
    else if (tool === 'lasso') shape = { type: 'poly', log: p.scale.log, points: [[p.t, p.f]] };
    else {
      shape = this.#brushShape(p, tool);
      addBrushDot(shape, p.t, p.f);
    }
    this.drag = { tool, shape, base, start: p, last: p, moved: tool === 'brush' || tool === 'heal' };
    this.invalidate();
  }

  #moveDrag(p) {
    const d = this.drag;
    d.last = p;
    if (Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) > 3) d.moved = true;
    const s = d.shape;
    if (s.type === 'rect') {
      s.t0 = Math.min(d.start.t, p.t);
      s.t1 = Math.max(d.start.t, p.t);
      s.f0 = Math.min(d.start.f, p.f);
      s.f1 = Math.max(d.start.f, p.f);
    } else if (s.type === 'poly') {
      const lp = s.points[s.points.length - 1];
      if (Math.abs(this.view.xOf(lp[0]) - p.x) + Math.abs(p.scale.toFrac(lp[1]) - p.scale.toFrac(p.f)) * (p.lane.bottom - p.lane.top) > 2) s.points.push([p.t, p.f]);
    } else addBrushDot(s, p.t, p.f);
    this.invalidate();
  }

  #endDrag(p) {
    const d = this.drag;
    this.drag = null;
    const doc = this.doc;
    if (!d.moved || (d.shape.type === 'poly' && d.shape.points.length < 3)) {
      // A click clears the spectral selection and places the playhead.
      setSpectralSelection(this.app, doc, null);
      const f = Math.max(0, Math.min(doc.length, Math.round(p.t)));
      doc.setSelection(f, f);
      this.view.seek(f);
      this.invalidate();
      return;
    }
    if (d.tool === 'heal') {
      this.svc.heal(doc, { channels: doc.selection.channels.slice(), shapes: [d.shape] });
      this.invalidate();
      return;
    }
    const channels = doc.selection.channels.slice();
    const shapes = d.base ? [...d.base.shapes, d.shape] : [d.shape];
    setSpectralSelection(this.app, doc, { channels, shapes });
    const b = shapeIntervals(d.shape, (d.start.t + p.t) / 2);
    this.live.textContent = `Spectral selection ${this.app.formatTime(doc.selection.start)} to ${this.app.formatTime(doc.selection.end)}${b.length ? `, ${formatHzLong(b[0][0])} to ${formatHzLong(b[0][1])}` : ''}`;
    this.invalidate();
  }

  // --------------------------------------------------- divider and ruler

  #bindDivider() {
    const el = this.divider;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const r = this.view.surface.getBoundingClientRect();
      const move = (ev) => {
        const share = 1 - (ev.clientY - r.top) / r.height;
        this.#setShare(share, false);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        const share = this.share;
        this.shareDraft = null;
        setSettings(this.app, { share });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => setSettings(this.app, { share: 0.55 }));
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.03;
      if (e.key === 'ArrowUp') this.#setShare(this.share + step, true);
      else if (e.key === 'ArrowDown') this.#setShare(this.share - step, true);
      else if (e.key === 'Home') this.#setShare(0.85, true);
      else if (e.key === 'End') this.#setShare(0.15, true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  #setShare(share, commit) {
    share = Math.max(0.15, Math.min(0.85, share));
    if (commit) setSettings(this.app, { share });
    else {
      // Live drag: lay out without writing preferences on every move.
      this.shareDraft = share;
      this.view.layout();
    }
  }

  #bindRuler() {
    const el = this.rulerHit;
    const zoomAt = (factor, clientY) => {
      const lane = this.lanes()[0];
      if (!lane) return;
      const r = this.view.surface.getBoundingClientRect();
      const lanes = this.lanes();
      const y = clientY - r.top;
      const l = lanes.find((x) => y >= x.top && y <= x.bottom) || lane;
      const scale = this.scale();
      const centre = scale.toHz(1 - (y - l.top) / (l.bottom - l.top));
      this.svc.zoomFrequency(this.doc, factor, centre);
    };
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        zoomAt(Math.pow(1.0025, e.deltaY), e.clientY);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => this.svc.resetFrequency(this.doc));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const lane = this.lanes()[0];
      if (!lane) return;
      const startY = e.clientY;
      const s0 = this.scale();
      const band0 = { lo: s0.lo, hi: s0.hi };
      const lh = lane.bottom - lane.top;
      const move = (ev) => {
        const df = (ev.clientY - startY) / lh;
        const nyq = this.doc.sampleRate / 2;
        const sc = makeScale({ log: s0.log, ...band0 });
        let lo = sc.toHz(df);
        let hi = sc.toHz(1 + df);
        if (hi > nyq) {
          lo = sc.toHz(sc.toFrac(nyq) - 1);
          hi = nyq;
        }
        if (lo < (s0.log ? 20 : 0)) return;
        const st = docState(this.doc);
        st.lo = lo;
        st.hi = hi;
        this.invalidate();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  openSettings() {
    const r = this.settingsBtn.getBoundingClientRect();
    this.app.openMenu(spectralMenuItems(this.app), { x: r.left - 200, y: r.bottom + 2, anchor: this.settingsBtn, label: 'Spectral display settings' });
  }

  announce(text) {
    announce(text);
  }

  destroy() {
    for (const off of this.offs) off?.();
    clearTimeout(this.pitchTimer);
    this.generation = (this.generation || 0) + 1;
    this.release();
  }
}
