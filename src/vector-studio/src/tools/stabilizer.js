/**
 * Stroke smoothing for freehand tools (Pencil, Paintbrush, Merge Brush):
 * a pulled string. The drawn point trails the pen on a string whose length
 * grows with the smoothing amount; it only moves when the pen pulls the
 * string tight, so hand tremor and pen jitter shorter than the string never
 * reach the stroke, and quick wobbles flatten into clean curves. It acts
 * while drawing (the preview shows the smoothed line), unlike Fidelity,
 * which only simplifies the finished stroke.
 *
 * Every pen sample gives exactly one drawn point, so lists kept beside the
 * points (pen pressure, timestamps) stay aligned. The string length is in
 * screen pixels, so smoothing feels the same at every zoom.
 */

/** String length in screen pixels at smoothing 100. */
export const MAX_STRING_PX = 40;

/** String length in document units for a smoothing amount 0 (off) .. 100 at a zoom. */
export function stringLength(amount, zoom) {
  const a = Math.max(0, Math.min(100, Number(amount) || 0));
  return ((a / 100) * MAX_STRING_PX) / (zoom > 0 ? zoom : 1);
}

export class Stabilizer {
  /**
   * @param {number} amount smoothing 0 (off) .. 100
   * @param {number} zoom view zoom (screen pixels per document unit)
   * @param {{x:number,y:number}} start where the stroke starts
   */
  constructor(amount, zoom, start) {
    this.length = stringLength(amount, zoom);
    this.cur = { x: start.x, y: start.y };
    this.pen = { x: start.x, y: start.y };
    this.raw = [{ x: start.x, y: start.y }];
  }

  get active() {
    return this.length > 0;
  }

  /** The drawn point for the next pen sample. */
  push(p) {
    this.pen = { x: p.x, y: p.y };
    this.raw.push(this.pen);
    if (!this.active) return { x: p.x, y: p.y };
    const dx = p.x - this.cur.x;
    const dy = p.y - this.cur.y;
    const d = Math.hypot(dx, dy);
    if (d > this.length) {
      const k = (d - this.length) / d;
      this.cur = { x: this.cur.x + dx * k, y: this.cur.y + dy * k };
    }
    return { ...this.cur };
  }

  /**
   * The points to keep when the pen lifts. The stroke ends where the string
   * left it (so the flick of a lifting pen stays out); a stroke shorter than
   * the string, which smoothing would have kept from moving at all, keeps
   * the pen's own path instead.
   */
  finish(points) {
    if (!this.active || points.length !== this.raw.length) return points;
    const first = points[0];
    const moved = points.some((p) => Math.hypot(p.x - first.x, p.y - first.y) > this.length * 0.05);
    return moved ? points : this.raw.map((p) => ({ ...p }));
  }
}

/** Draw the string from the smoothed point to the pen (screen overlay). */
export function drawString(ctx, editor, stabilizer) {
  if (!stabilizer?.active) return;
  const a = editor.view.toScreen(stabilizer.cur.x, stabilizer.cur.y);
  const b = editor.view.toScreen(stabilizer.pen.x, stabilizer.pen.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(128,128,128,0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
