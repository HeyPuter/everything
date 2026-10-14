// Draws every strip's stereo peak meter on ONE canvas laid over the strips.
// The panel gives it the meter rectangles (CSS px, canvas space) and the
// horizontal clip range of the scrolling inserts; drawing reads MeterState
// only and allocates nothing per frame.

import { cssVar } from '../ui/theme.js';
import { dbToPos } from './db.js';

const INSET = 7; // px above and below the travel, matching the fader cap half height
const SEG_HIGH = dbToPos(0); // red above 0 dBFS
const SEG_MID = dbToPos(-6); // amber from -6 dBFS

export class MeterView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.colors = null;
  }

  resize(w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    return true;
  }

  themeChanged() {
    this.colors = null;
  }

  readColors() {
    this.colors = {
      bg: cssVar('--meter-bg'),
      low: cssVar('--meter-low'),
      mid: cssVar('--meter-mid'),
      high: cssVar('--meter-high'),
      tick: cssVar('--border'),
    };
  }

  /**
   * rects: Float32Array of [x, y, w, h] per track (w 0 = not shown).
   * pinned: tracks [0, pinned) are never clipped (the master); others clip to [clipL, clipR].
   */
  draw(state, rects, count, pinned, clipL, clipR) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.colors) this.readColors();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const n = Math.min(count, state.tracks);
    for (let t = 0; t < Math.min(pinned, n); t++) this.track(state, rects, t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipL, 0, Math.max(0, clipR - clipL), this.h);
    ctx.clip();
    for (let t = pinned; t < n; t++) {
      const x = rects[t * 4];
      if (x + rects[t * 4 + 2] < clipL || x > clipR) continue;
      this.track(state, rects, t);
    }
    ctx.restore();
  }

  track(state, rects, t) {
    const ctx = this.ctx;
    const c = this.colors;
    const x = rects[t * 4];
    const y = rects[t * 4 + 1];
    const w = rects[t * 4 + 2];
    const hh = rects[t * 4 + 3];
    if (w <= 0) return;
    const bw = Math.floor((w - 1) / 2);
    const top = y + INSET;
    const travel = hh - INSET * 2;
    for (let ch = 0; ch < 2; ch++) {
      const i = t * 2 + ch;
      const bx = x + ch * (bw + 1);
      ctx.fillStyle = c.bg;
      ctx.fillRect(bx, top, bw, travel);
      const lv = state.levelPos(i);
      if (lv > 0.001) {
        this.bar(bx, top, bw, travel, 0, Math.min(lv, SEG_MID), c.low);
        if (lv > SEG_MID) this.bar(bx, top, bw, travel, SEG_MID, Math.min(lv, SEG_HIGH), c.mid);
        if (lv > SEG_HIGH) this.bar(bx, top, bw, travel, SEG_HIGH, lv, c.high);
      }
      const pk = state.peakPos(i);
      if (pk > 0.001) {
        ctx.fillStyle = pk > SEG_HIGH ? c.high : pk > SEG_MID ? c.mid : c.low;
        ctx.fillRect(bx, top + (1 - pk) * travel - 1, bw, 2);
      }
      // Clip indicator above the scale.
      ctx.fillStyle = state.clip[i] ? c.high : c.bg;
      ctx.fillRect(bx, y + 1, bw, 4);
    }
  }

  bar(x, top, w, travel, from, to, color) {
    const y0 = top + (1 - to) * travel;
    const y1 = top + (1 - from) * travel;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y0, w, y1 - y0);
  }
}
