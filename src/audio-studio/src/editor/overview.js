// Overview navigator: the whole timeline in miniature with the visible range
// as a frame. Drag the frame to scroll, drag its edges to zoom, click outside
// it to centre the view there, double-click to zoom out fully. Keyboard:
// Left/Right scroll, +/- zoom.
//   host.timeline() -> { rate, length, view, cursor, selection }
//   host.setView(start, end), host.overviewPeaks(columns) -> Float32Array(min,max pairs),
//   or an array of them (one strip per channel), or null; optional host.viewMax(), the
//   furthest frame the view can reach

import { h } from '../lib/dom.js';
import { cssVar } from '../ui/theme.js';

export class Overview {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.canvas = h('canvas', { 'aria-hidden': 'true' });
    this.frame = h('div.overview-frame', h('div.overview-grip.left'), h('div.overview-grip.right'));
    this.playhead = h('div.overview-playhead', { 'aria-hidden': 'true' });
    this.el = h(
      'div.overview',
      { role: 'scrollbar', tabindex: '0', 'aria-label': 'Zoom navigator', 'aria-orientation': 'horizontal' },
      this.canvas,
      this.playhead,
      this.frame,
    );
    this.ctx = this.canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.peaks = null;
    // What the cached peaks were computed for: the host's content key (an
    // object such as the document state, compared by identity), columns, total.
    this.peaksFor = null;
    this.el.addEventListener('pointerdown', (e) => this.#down(e));
    this.el.addEventListener('dblclick', () => {
      const t = this.host.timeline();
      this.host.setView(0, Math.max(t.length, 1));
    });
    this.el.addEventListener('keydown', (e) => this.#keys(e));
    // Hover feedback matching what a drag would do: resize at the frame edges,
    // move inside it, jump elsewhere.
    this.el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const t = this.host.timeline();
      const x = e.clientX - this.el.getBoundingClientRect().left;
      const x0 = this.#x(t.view.start);
      const x1 = this.#x(t.view.end);
      this.el.style.cursor = Math.abs(x - x0) < 6 || Math.abs(x - x1) < 6 ? 'ew-resize' : x > x0 && x < x1 ? 'grab' : 'pointer';
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
    this.peaksFor = null;
  }

  #total() {
    const t = this.host.timeline();
    return Math.max(t.length, t.view.end, 1);
  }

  #x(frame) {
    return (frame / this.#total()) * this.width;
  }

  #frame(x) {
    return (x / this.width) * this.#total();
  }

  #down(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    const t = this.host.timeline();
    this.placePlayhead(t.cursor);
    const x0 = this.#x(t.view.start);
    const x1 = this.#x(t.view.end);
    const x = e.offsetX;
    let mode;
    if (Math.abs(x - x0) < 6) mode = 'left';
    else if (Math.abs(x - x1) < 6) mode = 'right';
    else if (x > x0 && x < x1) mode = 'move';
    else {
      const span = t.view.end - t.view.start;
      const c = this.#frame(x);
      this.host.setView(c - span / 2, c + span / 2);
      mode = 'move';
    }
    const start = { x, view: { ...this.host.timeline().view } };
    const move = (ev) => {
      const dx = this.#frame(ev.clientX - this.el.getBoundingClientRect().left) - this.#frame(start.x);
      const v = start.view;
      // Edge drags stop at the timeline's ends; otherwise the view would keep
      // its span and the opposite edge would move instead.
      if (mode === 'move') this.host.setView(v.start + dx, v.end + dx);
      else if (mode === 'left') this.host.setView(Math.max(0, Math.min(v.start + dx, v.end - 16)), v.end);
      else this.host.setView(v.start, Math.min(this.host.viewMax?.() ?? Infinity, Math.max(v.end + dx, v.start + 16)));
    };
    const up = () => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  #keys(e) {
    const t = this.host.timeline();
    const span = t.view.end - t.view.start;
    let handled = true;
    if (e.key === 'ArrowLeft') this.host.setView(t.view.start - span / 4, t.view.end - span / 4);
    else if (e.key === 'ArrowRight') this.host.setView(t.view.start + span / 4, t.view.end + span / 4);
    else if (e.key === 'Home') this.host.setView(0, span);
    else if (e.key === 'End') this.host.setView(t.length - span, t.length);
    else if (e.key === '+' || e.key === '=') this.host.setView(t.view.start + span / 4, t.view.end - span / 4);
    else if (e.key === '-') this.host.setView(t.view.start - span / 2, t.view.end + span / 2);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Moves the playhead marker only (cheap; called every frame while playing). */
  placePlayhead(frame) {
    this.playhead.style.transform = `translateX(${Math.round(this.#x(frame))}px)`;
  }

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const W = this.width;
    const H = this.height;
    if (!W || !H) return;
    const t = this.host.timeline();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const cols = this.canvas.width;
    const content = this.host.peaksKey?.();
    const total = this.#total();
    const f = this.peaksFor;
    if (!f || f.content !== content || f.cols !== cols || f.total !== total) {
      this.peaks = this.host.overviewPeaks?.(cols, total) || null;
      this.peaksFor = { content, cols, total };
    }
    if (this.peaks) {
      // One strip per channel; inside the view frame in the full waveform color.
      const strips = Array.isArray(this.peaks) ? this.peaks : [this.peaks];
      const H = this.canvas.height;
      const pad = 2 * dpr;
      const lh = (H - pad * 2) / strips.length;
      const fx0 = Math.max(0, Math.floor(this.#x(t.view.start) * dpr));
      const fx1 = Math.min(cols, Math.ceil(this.#x(t.view.end) * dpr));
      const dim = cssVar('--wave-dim');
      const bright = cssVar('--wave');
      strips.forEach((peaks, i) => {
        const mid = pad + lh * (i + 0.5);
        const half = lh / 2 - dpr * 0.5;
        for (let c = 0; c < cols; c++) {
          const lo = peaks[2 * c];
          if (Number.isNaN(lo)) continue;
          const hi = peaks[2 * c + 1];
          const y0 = mid - Math.min(1, hi) * half;
          const y1 = mid - Math.max(-1, lo) * half;
          ctx.fillStyle = c >= fx0 && c < fx1 ? bright : dim;
          ctx.fillRect(c, y0, 1, Math.max(1, y1 - y0));
        }
      });
    }
    const sel = t.selection;
    if (sel && sel.end > sel.start) {
      ctx.fillStyle = cssVar('--sel-bg');
      const a = this.#x(sel.start) * dpr;
      const b = this.#x(sel.end) * dpr;
      ctx.fillRect(a, 0, Math.max(1, b - a), this.canvas.height);
    }
    this.placePlayhead(t.cursor);
    const x0 = this.#x(t.view.start);
    const x1 = this.#x(t.view.end);
    this.frame.style.left = `${Math.max(0, x0)}px`;
    this.frame.style.width = `${Math.max(6, Math.min(W, x1) - Math.max(0, x0))}px`;
    this.el.setAttribute('aria-valuenow', String(Math.round((t.view.start / total) * 100)));
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', '100');
  }
}
