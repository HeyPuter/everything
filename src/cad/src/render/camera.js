/**
 * 2D view: world point at the viewport centre and zoom in CSS pixels per
 * world unit. Screen coordinates are CSS pixels from the canvas top-left,
 * y down; world y is up.
 */
export const MIN_SCALE = 1e-9;
export const MAX_SCALE = 1e9;

export class Camera {
  constructor() {
    this.cx = 0;
    this.cy = 0;
    this.scale = 4;
    this.width = 1;
    this.height = 1;
  }

  setSize(w, h) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
  }

  toWorld(sx, sy) {
    return { x: this.cx + (sx - this.width / 2) / this.scale, y: this.cy - (sy - this.height / 2) / this.scale };
  }

  toScreen(x, y) {
    return { x: (x - this.cx) * this.scale + this.width / 2, y: this.height / 2 - (y - this.cy) * this.scale };
  }

  /** World units covered by one CSS pixel. */
  get pixel() {
    return 1 / this.scale;
  }

  /** Visible world rectangle [minX, minY, maxX, maxY]. */
  bounds(margin = 0) {
    const hw = this.width / 2 / this.scale + margin,
      hh = this.height / 2 / this.scale + margin;
    return [this.cx - hw, this.cy - hh, this.cx + hw, this.cy + hh];
  }

  /** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.scale = clampScale(this.scale * factor);
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  panBy(dxPx, dyPx) {
    this.cx -= dxPx / this.scale;
    this.cy += dyPx / this.scale;
  }

  /** Fit a world rectangle with a margin in pixels. */
  fit(minX, minY, maxX, maxY, marginPx = 24) {
    const w = Math.max(maxX - minX, 1e-9),
      h = Math.max(maxY - minY, 1e-9);
    // A side too short for the margins gives them up, and a collapsed side
    // (a hidden or squeezed-out canvas) does not count: fitting to it would
    // zoom out until nothing can be seen once the canvas is back.
    const room = (size) => (size > 1 ? Math.max(size - marginPx * 2, size / 2) : Infinity);
    const s = Math.min(room(this.width) / w, room(this.height) / h);
    if (Number.isFinite(s)) this.scale = clampScale(s);
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
  }

  get state() {
    return { cx: this.cx, cy: this.cy, scale: this.scale };
  }

  set state(s) {
    this.cx = s.cx;
    this.cy = s.cy;
    this.scale = clampScale(s.scale);
  }
}

export function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}
