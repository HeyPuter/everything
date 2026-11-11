/**
 * The view onto a document: zoom, pan and view rotation, mapping document
 * coordinates (points) to CSS pixels in the canvas element.
 *   screen = translate(panX, panY) * rotate(rotation) * scale(zoom) * doc
 */
import { apply, invert, multiply, rotate, scale, translate } from '../lib/matrix.js';

export const MIN_ZOOM = 0.0313; // 3.13%
export const MAX_ZOOM = 640; // 64000%

/** Preset zoom steps used by Zoom In / Zoom Out. */
export const ZOOM_STEPS = [
  0.0313, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128,
  192, 256, 384, 512, 640,
];

export class Viewport {
  constructor() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.#dirty = true;
  }

  #dirty;
  #m = null;
  #inv = null;

  #recompute() {
    if (!this.#dirty) return;
    this.#m = multiply(translate(this.panX, this.panY), multiply(rotate(this.rotation), scale(this.zoom)));
    this.#inv = invert(this.#m);
    this.#dirty = false;
  }

  set(props) {
    Object.assign(this, props);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom));
    this.#dirty = true;
  }

  /** Document to CSS-pixel matrix. */
  get matrix() {
    this.#recompute();
    return this.#m;
  }

  get inverse() {
    this.#recompute();
    return this.#inv;
  }

  toScreen(x, y) {
    return apply(this.matrix, x, y);
  }

  toDoc(x, y) {
    return apply(this.inverse, x, y);
  }

  /** Document units per CSS pixel (for hit tolerances and hairlines). */
  get unit() {
    return 1 / this.zoom;
  }

  /** Axis-aligned document rect that covers the visible canvas. */
  visibleRect(margin = 0) {
    const pts = [this.toDoc(-margin, -margin), this.toDoc(this.width + margin, -margin), this.toDoc(this.width + margin, this.height + margin), this.toDoc(-margin, this.height + margin)];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  /** Zoom by a factor keeping the document point under (sx, sy) fixed. */
  zoomAt(newZoom, sx, sy) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const p = this.toDoc(sx, sy);
    this.set({ zoom: z });
    const q = this.toScreen(p.x, p.y);
    this.set({ panX: this.panX + (sx - q.x), panY: this.panY + (sy - q.y) });
  }

  stepZoom(dir, sx = this.width / 2, sy = this.height / 2) {
    const z = this.zoom;
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
    else next = [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? MIN_ZOOM;
    this.zoomAt(next, sx, sy);
  }

  /**
   * Fit a document rect in the view with a margin in CSS pixels: one for
   * every side, or { top, right, bottom, left } (the rect is centered
   * between them). Resets rotation.
   */
  fit(rect, margin = 40) {
    if (!rect || rect.w <= 0 || rect.h <= 0) return;
    const m = typeof margin === 'number' ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
    const availW = Math.max(1, this.width - m.left - m.right);
    const availH = Math.max(1, this.height - m.top - m.bottom);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availW / rect.w, availH / rect.h)));
    this.set({ zoom: z, rotation: 0 });
    const cx = (m.left + this.width - m.right) / 2;
    const cy = (m.top + this.height - m.bottom) / 2;
    this.set({ panX: cx - (rect.x + rect.w / 2) * z, panY: cy - (rect.y + rect.h / 2) * z });
  }

  /** Center a document point in the view at the current zoom. */
  centerOn(x, y) {
    const q = this.toScreen(x, y);
    this.set({ panX: this.panX + this.width / 2 - q.x, panY: this.panY + this.height / 2 - q.y });
  }

  /** Rotate the view about the canvas center. */
  rotateView(deg) {
    const c = this.toDoc(this.width / 2, this.height / 2);
    this.set({ rotation: ((deg % 360) + 360) % 360 });
    this.centerOn(c.x, c.y);
  }

  snapshot() {
    return { zoom: this.zoom, panX: this.panX, panY: this.panY, rotation: this.rotation };
  }
}
