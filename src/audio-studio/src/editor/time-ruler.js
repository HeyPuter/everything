// Time ruler with tick labels in the chosen time format, markers, and the
// playhead handle. Click or drag to move the playhead; drag a marker to move
// it; double-click a marker to rename it. Shared by the waveform and
// multitrack editors through a small host interface:
//   host.timeline() -> { rate, length, view: {start, end}, cursor, selection, markers }
//   host.seek(frame), host.moveMarker(id, start), host.renameMarker(id), host.snap(frame),
//   host.cancelMarkerMove() (drops a marker drag's preview)

import { h } from '../lib/dom.js';
import { rulerStep, rulerLabel, formatTime, musicalStep, frameRateOf } from '../lib/time.js';
import { cssVar, CANVAS_FONT } from '../ui/theme.js';
import { markerColor } from '../ui/appearance.js';

/** Short unit caption drawn at the ruler's left edge for a time format. */
export function rulerUnit(format) {
  if (format === 'samples') return 'smpl';
  if (format === 'bars') return 'bars';
  if (format === 'frames' || format?.startsWith('smpte')) return 'hmsf';
  return 'hms';
}

/** Minor tick spacing for a labelled step: halves, thirds (15 s, 30 s), fifths (5, 0.5), quarters past a minute. */
export function minorStep(step) {
  if (step >= 60) return step / 4;
  const digits = String(step).replace(/^0\.0*/, '');
  if (digits.startsWith('5')) return step / 5;
  if (step >= 1 && step % 3 === 0) return step / 3;
  return step / 2;
}

/** Frame rate the ruler counts in for a timecode or custom-frames time format, else 0. */
export function rulerFps(app) {
  const format = app.prefs.get('timeFormat') || '';
  if (format !== 'frames' && !format.startsWith('smpte')) return 0;
  return frameRateOf(format, app.timeOptions?.() || {}).real;
}

/**
 * Labelled tick positions (seconds) for the view: { step, minor, ticks: [seconds...] }.
 * With a frame rate (timecode), ticks closer than a second fall on frames a whole number of
 * frames apart, so their labels count up evenly instead of skipping frames unevenly.
 */
export function rulerTicks(t0, t1, width, minPx = 70, fps = 0) {
  if (!(t1 > t0) || width <= 0) return { step: 1, minor: 0.5, ticks: [] };
  let step = rulerStep((t1 - t0) / width, minPx);
  let minor = minorStep(step);
  // (Zoomed in past a frame, ticks stay where they were: every label is then one frame.)
  if (fps > 0 && step < 1 && step * fps > 1) {
    const frames = Math.ceil(step * fps - 1e-9);
    step = frames / fps;
    minor = frames > 1 ? 1 / fps : step;
  }
  const ticks = [];
  for (let s = Math.ceil(t0 / step - 1e-9) * step; s <= t1 + 1e-9; s += step) ticks.push(s || 0);
  return { step, minor, ticks };
}

export class TimeRuler {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.canvas = h('canvas.time-ruler-canvas', { 'aria-hidden': 'true' });
    // A slider for the playhead: drag or click it, or focus it and use the arrow keys,
    // Page Up/Down, Home and End.
    this.el = h(
      'div.time-ruler',
      {
        role: 'slider',
        tabindex: '0',
        'aria-label': 'Time ruler, playhead position',
        'aria-valuemin': '0',
      },
      this.canvas,
    );
    this.ctx = this.canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.drag = null;
    this.el.addEventListener('pointerdown', (e) => this.#down(e));
    this.el.addEventListener('pointermove', (e) => this.#move(e));
    this.el.addEventListener('pointerup', (e) => this.#up(e));
    this.el.addEventListener('pointercancel', (e) => this.#up(e, true));
    this.el.addEventListener('keydown', (e) => this.#keys(e));
    this.el.addEventListener('dblclick', (e) => {
      const m = this.#markerAt(e.offsetX);
      if (m) host.renameMarker?.(m.id);
    });
  }

  resize(w, hgt) {
    const dpr = window.devicePixelRatio || 1;
    this.width = w;
    this.height = hgt;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(hgt * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.dpr = dpr;
  }

  /** x of a frame; `view` saves asking the host again (its timeline lists every marker). */
  xOf(frame, view = this.host.timeline().view) {
    return ((frame - view.start) / (view.end - view.start)) * this.width;
  }

  frameAt(x) {
    const { view } = this.host.timeline();
    return view.start + (x / this.width) * (view.end - view.start);
  }

  /** The marker nearest x within `tol` px. */
  #markerAt(x, tol = 5) {
    const t = this.host.timeline();
    let best = null;
    let bestD = Infinity;
    for (const m of t.markers || []) {
      const d = Math.abs(x - this.xOf(m.start, t.view));
      if (d <= tol && d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  #keys(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = this.host.timeline();
    const span = t.view.end - t.view.start;
    const step = Math.max(1, Math.round((span / Math.max(1, this.width)) * (e.shiftKey ? 1 : 10)));
    const page = span / 2;
    const moves = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
      PageUp: -page,
      PageDown: page,
    };
    let f;
    if (e.key in moves) f = t.cursor + moves[e.key];
    else if (e.key === 'Home') f = 0;
    else if (e.key === 'End') f = t.length;
    else return;
    e.preventDefault();
    e.stopPropagation();
    f = Math.max(0, Math.min(t.length, Math.round(f)));
    this.host.seek(f);
    // Keep the playhead in view, as the transport keys do.
    const hidden = f < t.view.start || f > t.view.end;
    if (hidden && this.host.setView) this.host.setView(f - span / 2, f + span / 2);
    this.syncValue(f, t);
  }

  /** The slider's value: the playhead, as a time in the current format. */
  syncValue(frame, t = this.host.timeline()) {
    const f = Math.round(frame);
    const max = String(t.length);
    const el = this.el;
    const same = el.getAttribute('aria-valuenow') === String(f);
    if (same && el.getAttribute('aria-valuemax') === max) return;
    this.el.setAttribute('aria-valuemax', max);
    this.el.setAttribute('aria-valuenow', String(f));
    const text = this.app.formatTime ? this.app.formatTime(f, t.rate) : formatTime(f, t.rate);
    this.el.setAttribute('aria-valuetext', text);
  }

  #down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    // A finger covers more than a mouse pointer: markers grab from further away on touch.
    const tol = e.pointerType === 'touch' ? 12 : 5;
    const m = e.offsetY > this.height * 0.45 ? this.#markerAt(e.offsetX, tol) : null;
    if (m && this.host.moveMarker) {
      this.drag = { kind: 'marker', id: m.id, dx: e.offsetX - this.xOf(m.start), moved: false };
      this.host.selectMarker?.(m.id);
      return;
    }
    this.drag = { kind: 'seek' };
    const f0 = this.host.snap ? this.host.snap(this.frameAt(e.offsetX)) : this.frameAt(e.offsetX);
    this.host.seek(f0);
    this.app.scrub?.(f0);
  }

  #move(e) {
    if (!this.drag) {
      this.el.style.cursor = this.#markerAt(e.offsetX) && e.offsetY > this.height * 0.45 ? 'ew-resize' : '';
      return;
    }
    const f = this.frameAt(e.offsetX - (this.drag.dx || 0));
    if (this.drag.kind === 'seek') {
      const at = this.host.snap ? this.host.snap(f) : f;
      this.host.seek(at);
      this.app.scrub?.(at);
    }
    else if (this.drag.kind === 'marker') {
      this.drag.moved = true;
      this.host.moveMarker(this.drag.id, Math.max(0, this.host.snap ? this.host.snap(f, { exclude: this.drag.id }) : f), { preview: true });
    }
  }

  #up(e, cancelled = false) {
    if (!this.drag) return;
    // A cancelled marker drag (the system took the touch) leaves the marker where it was.
    if (cancelled && this.drag.kind === 'marker') this.host.cancelMarkerMove?.();
    else if (this.drag.kind === 'marker' && this.drag.moved) {
      const f = this.frameAt(e.offsetX - (this.drag.dx || 0));
      this.host.moveMarker(this.drag.id, Math.max(0, this.host.snap ? this.host.snap(f, { exclude: this.drag.id }) : f), { preview: false });
    }
    this.drag = null;
  }

  /** Bars-and-beats ruler: ticks on the beat grid (Time Display tempo, meter and subdivisions). */
  #drawMusical(t, W, H, textColor, tickColor, unitRight = 0) {
    const ctx = this.ctx;
    const rate = t.rate;
    const fpp = (t.view.end - t.view.start) / W;
    const music = this.app.timeOptions?.() || {};
    const xOf = (f) => (f - t.view.start) / fpp;
    const major = musicalStep(fpp, rate, music, 70);
    const minor = musicalStep(fpp, rate, music, 10);
    ctx.fillStyle = tickColor;
    for (let f = Math.ceil(t.view.start / minor - 1e-9) * minor; f <= t.view.end; f += minor) ctx.fillRect(Math.round(xOf(f)) + 0.5, H - 4, 1, 4);
    for (let f = Math.ceil(t.view.start / major - 1e-9) * major; f <= t.view.end + 1e-6; f += major) {
      const x = Math.round(xOf(f)) + 0.5;
      ctx.fillStyle = tickColor;
      ctx.fillRect(x, H - 9, 1, 9);
      const label = formatTime(Math.round(f), rate, 'bars', music);
      const lw = ctx.measureText(label).width;
      const lx = Math.min(W - lw - 1, x - lw / 2);
      if (lx < unitRight) continue;
      ctx.fillStyle = textColor;
      ctx.fillText(label, lx, 3);
    }
  }

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const W = this.width;
    const H = this.height;
    const t = this.host.timeline();
    this.syncValue(t.cursor, t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--bg-ruler');
    ctx.fillRect(0, 0, W, H);
    const rate = t.rate;
    const span = t.view.end - t.view.start;
    if (span <= 0 || W <= 0) return;
    const textColor = cssVar('--text-dim');
    const tickColor = cssVar('--text-faint');
    ctx.font = CANVAS_FONT;
    ctx.textBaseline = 'top';
    const t0 = t.view.start / rate;
    const t1 = t.view.end / rate;
    const format = this.app.prefs.get('timeFormat');
    // The unit caption sits at the left edge; labels that would run into it are left out.
    const unit = rulerUnit(format);
    const unitRight = 3 + ctx.measureText(unit).width + 6;
    if (format === 'bars') {
      this.#drawMusical(t, W, H, textColor, tickColor, unitRight);
    } else {
      const fps = rulerFps(this.app);
      const { step, minor, ticks } = rulerTicks(t0, t1, W, 70, fps);
      ctx.fillStyle = tickColor;
      for (let s = Math.ceil(t0 / minor - 1e-9) * minor; s <= t1; s += minor) {
        const x = Math.round(((s - t0) / (t1 - t0)) * W) + 0.5;
        ctx.fillRect(x, H - 4, 1, 4);
      }
      for (const s of ticks) {
        const x = Math.round(((s - t0) / (t1 - t0)) * W) + 0.5;
        ctx.fillStyle = tickColor;
        ctx.fillRect(x, H - 9, 1, 9);
        // A tick on a frame reads as its first sample (the nearest can show the frame before).
        const at = fps ? Math.ceil(s * rate - 1e-4) : Math.round(s * rate);
        const label =
          format === 'decimal' || format === 'compact'
            ? rulerLabel(Math.max(0, s), step)
            : formatTime(at, rate, format, this.app.timeOptions?.() || {});
        // Labels centre on their tick, kept inside the ruler.
        const lw = ctx.measureText(label).width;
        const lx = Math.min(W - lw - 1, x - lw / 2);
        if (lx < unitRight) continue;
        ctx.fillStyle = textColor;
        ctx.fillText(label, lx, 3);
      }
    }
    ctx.fillStyle = textColor;
    ctx.fillText(unit, 3, 3);
    // Selection band.
    const sel = t.selection;
    if (sel && sel.end > sel.start) {
      const x0 = Math.max(0, this.xOf(sel.start, t.view));
      const x1 = Math.min(W, this.xOf(sel.end, t.view));
      if (x1 > x0) {
        ctx.fillStyle = cssVar('--accent-soft');
        ctx.fillRect(x0, H - 6, x1 - x0, 6);
      }
    }
    // Markers.
    for (const m of t.markers || []) {
      const x = Math.round(this.xOf(m.start, t.view)) + 0.5;
      const x2 = m.duration ? this.xOf(m.start + m.duration, t.view) : x;
      if (x2 < -10 || x > W + 10) continue;
      ctx.fillStyle = m.selected ? cssVar('--text-strong') : markerColor(m.type);
      if (m.duration) {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, H - 12, x2 - x, 5);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(x2, H - 12);
        ctx.lineTo(x2 - 5, H - 7);
        ctx.lineTo(x2, H - 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(x, H - 12);
      ctx.lineTo(x + 5, H - 7);
      ctx.lineTo(x, H - 2);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Draws the playhead handle (a small pentagon) as a DOM element over a ruler. */
export function playheadHandle() {
  return h('div.playhead-handle', { 'aria-hidden': 'true' });
}
