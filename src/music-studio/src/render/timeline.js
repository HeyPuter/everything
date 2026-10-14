// Horizontal time viewport and ruler shared by the playlist, the piano roll
// and the automation editor.
//
//   const vp = new Viewport({ pxPerTick: 0.25, minPx: 0.01, maxPx: 8 })
//   vp.x(ticks) -> px from the left of the content area
//   vp.tick(px) -> ticks
//   vp.zoomAt(factor, px)  keeps the tick under px in place
//   vp.scrollBy(px), vp.scrollTo(tick), vp.reveal(tick, width) (auto scroll)
//
//   drawRuler(g, vp, { x, y, w, h, sig, loop, markers, playhead, colors })
//   draws the bar ruler into a gfx frame (render/gfx.js).

import { ticksPerBar, ticksPerBeat, STEP, gridTicks } from '../model/time.js';
import { clamp } from '../lib/util.js';

export class Viewport {
  constructor({ pxPerTick = 0.25, minPx = 0.005, maxPx = 16, scroll = 0 } = {}) {
    this.pxPerTick = pxPerTick;
    this.minPx = minPx;
    this.maxPx = maxPx;
    this.scroll = scroll; // first visible tick
    this.width = 0; // content width in px
  }

  x(ticks) {
    return (ticks - this.scroll) * this.pxPerTick;
  }

  tick(px) {
    return this.scroll + px / this.pxPerTick;
  }

  get end() {
    return this.tick(this.width);
  }

  zoomAt(factor, px = this.width / 2) {
    const t = this.tick(px);
    this.pxPerTick = clamp(this.pxPerTick * factor, this.minPx, this.maxPx);
    this.scroll = Math.max(0, t - px / this.pxPerTick);
  }

  /** Shows ticks [a, b) across the width. */
  fit(a, b) {
    if (b <= a || this.width <= 0) return;
    this.pxPerTick = clamp(this.width / (b - a), this.minPx, this.maxPx);
    this.scroll = Math.max(0, a);
  }

  scrollBy(px) {
    this.scroll = Math.max(0, this.scroll + px / this.pxPerTick);
  }

  scrollTo(tick) {
    this.scroll = Math.max(0, tick);
  }

  /** Page-style auto scroll: when `tick` leaves the view, the view jumps to keep it visible. */
  reveal(tick, margin = 0.05) {
    const span = this.width / this.pxPerTick;
    if (tick < this.scroll || tick > this.scroll + span * (1 - margin)) this.scroll = Math.max(0, tick - span * margin);
  }

  /** Grid spacing for the current zoom. */
  grid(sig, minPx = 10) {
    return gridTicks(this.pxPerTick, sig, minPx);
  }
}

/**
 * Draws a ruler: bar numbers, beat ticks, the loop region and markers.
 * colors: { bg, text, bar, beat, loop, marker, playhead } (rgba arrays or CSS strings).
 * Returns nothing; the playhead triangle is drawn when `playhead` is a tick.
 */
export function drawRuler(g, vp, { x = 0, y = 0, w, h = 24, sig = [4, 4], loop = null, markers = [], playhead = null, colors, font = '11px system-ui, -apple-system, sans-serif' }) {
  g.rect(x, y, w, h, colors.bg);
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  if (loop) {
    const lx = x + vp.x(loop.start);
    const lw = (loop.end - loop.start) * vp.pxPerTick;
    g.rect(lx, y, lw, h, colors.loop);
  }
  const barPx = bar * vp.pxPerTick;
  // Label every bar, or every 2, 4, 8... when bars are narrow.
  let every = 1;
  while (barPx * every < 34) every *= 2;
  const first = Math.max(0, Math.floor(vp.scroll / bar) * bar);
  for (let t = first; t < vp.end + bar; t += bar) {
    const px = Math.round(x + vp.x(t));
    if (px > x + w) break;
    const n = Math.round(t / bar);
    const major = n % every === 0;
    g.rect(px, y + (major ? h * 0.35 : h * 0.6), 1, major ? h * 0.65 : h * 0.4, major ? colors.bar : colors.beat);
    if (major) g.text(String(n + 1), px + 4, y + h * 0.42, colors.text, { font, baseline: 'middle' });
    if (beat * vp.pxPerTick >= 8) {
      for (let b = t + beat; b < t + bar; b += beat) {
        const bx = Math.round(x + vp.x(b));
        g.rect(bx, y + h * 0.75, 1, h * 0.25, colors.beat);
      }
    }
    if (beat * vp.pxPerTick >= 64) {
      for (let s = t + STEP; s < t + bar; s += STEP) {
        if ((s - t) % beat === 0) continue;
        g.rect(Math.round(x + vp.x(s)), y + h * 0.86, 1, h * 0.14, colors.beat);
      }
    }
  }
  for (const m of markers) {
    const mx = Math.round(x + vp.x(m.pos));
    if (mx < x - 100 || mx > x + w) continue;
    g.rect(mx, y, 1, h, colors.marker);
    g.text(m.name, mx + 4, y + h * 0.82, colors.marker, { font: '10px system-ui, -apple-system, sans-serif', maxWidth: 120 });
  }
  g.rect(x, y + h - 1, w, 1, colors.bar);
  if (playhead !== null && playhead !== undefined) {
    const px = Math.round(x + vp.x(playhead));
    if (px >= x - 6 && px <= x + w + 6) {
      g.rect(px - 5, y + h - 9, 11, 3, colors.playhead, 1);
      g.rect(px - 3, y + h - 6, 7, 3, colors.playhead, 1);
      g.rect(px - 1, y + h - 3, 3, 3, colors.playhead);
    }
  }
}

/** Vertical grid lines for an editor body: step, beat and bar lines plus alternating bar shading. */
export function drawGrid(g, vp, { x = 0, y = 0, w, h, sig = [4, 4], colors, minPx = 10, shadeBars = true }) {
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  const grid = vp.grid(sig, minPx);
  const start = Math.max(0, Math.floor(vp.scroll / bar) * bar);
  if (shadeBars && colors.alt) {
    for (let t = start; t < vp.end + bar; t += bar) {
      if (Math.round(t / bar) % 2 === 1) {
        const bx = x + vp.x(t);
        if (bx > x + w) break;
        g.rect(bx, y, bar * vp.pxPerTick, h, colors.alt);
      }
    }
  }
  for (let t = Math.floor(vp.scroll / grid) * grid; t < vp.end + grid; t += grid) {
    const px = Math.round(x + vp.x(t));
    if (px < x) continue;
    if (px > x + w) break;
    const isBar = t % bar === 0;
    const isBeat = t % beat === 0;
    g.rect(px, y, 1, h, isBar ? colors.bar : isBeat ? colors.beat : colors.line);
  }
}
