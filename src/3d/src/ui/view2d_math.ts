// Pure math of the shared 2D view navigation (unit tested).

/** A rectangle in view units (y up). */
export interface ViewRect {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** Zoom factor of a step that moves each edge of the view in by `fac` of its size (fac < 0.5). */
export function stepFactor(fac: number): number {
  const f = Math.max(-2, Math.min(0.45, fac));
  return 1 / (1 - 2 * f);
}

/** Visible rect that a zoom border selection gives (zooming in: the box; out: the view grows by view/box). */
export function borderRect(cur: ViewRect, box: ViewRect, zoomOut: boolean): ViewRect {
  if (!zoomOut) return { ...box };
  const bw = Math.max(1e-9, box.xmax - box.xmin),
    bh = Math.max(1e-9, box.ymax - box.ymin);
  const cw = cur.xmax - cur.xmin,
    ch = cur.ymax - cur.ymin;
  const nw = (cw * cw) / bw,
    nh = (ch * ch) / bh;
  const cx = (box.xmin + box.xmax) / 2,
    cy = (box.ymin + box.ymax) / 2;
  return { xmin: cx - nw / 2, xmax: cx + nw / 2, ymin: cy - nh / 2, ymax: cy + nh / 2 };
}

/** Interpolate two rects (smooth view), easing in and out. */
export function lerpRect(a: ViewRect, b: ViewRect, t: number): ViewRect {
  const s = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const m = (p: number, q: number) => p + (q - p) * s;
  return { xmin: m(a.xmin, b.xmin), xmax: m(a.xmax, b.xmax), ymin: m(a.ymin, b.ymin), ymax: m(a.ymax, b.ymax) };
}

export interface EdgePanOptions {
  /** pixels inside the region where panning starts */
  inside_padding?: number;
  /** pixels outside the region where the speed is at its maximum */
  outside_padding?: number;
  /** pixels over which the speed ramps up */
  speed_ramp?: number;
  /** maximum speed in pixels per second */
  max_speed?: number;
  /** seconds before panning starts */
  delay?: number;
}

/** Pan speed (px/s, signed per axis) for a pointer at client (x, y) relative to a region rect. */
export function edgePanSpeed(r: { left: number; top: number; right: number; bottom: number }, x: number, y: number, o: EdgePanOptions = {}): [number, number] {
  const inside = o.inside_padding ?? 20,
    ramp = Math.max(1, o.speed_ramp ?? 40),
    max = o.max_speed ?? 1000;
  const axis = (p: number, lo: number, hi: number) => {
    if (p < lo + inside) return -Math.min(1, (lo + inside - p) / ramp);
    if (p > hi - inside) return Math.min(1, (p - (hi - inside)) / ramp);
    return 0;
  };
  // panning only while the pointer is not far outside the region (dragging into another area stops it)
  const far = 200 + (o.outside_padding ?? 0);
  if (x < r.left - far || x > r.right + far || y < r.top - far || y > r.bottom + far) return [0, 0];
  return [axis(x, r.left, r.right) * max, axis(y, r.top, r.bottom) * max];
}

/**
 * Scroll bar position for a visible range [v0, v1] inside a content range [t0, t1] (the content
 * is extended to include the visible range), on a track `track` pixels long.
 */
export function scrollerGeometry(ext: [number, number, number, number], track: number): { start: number; size: number } {
  const [v0, v1, t0, t1] = ext;
  const lo = Math.min(t0, v0),
    hi = Math.max(t1, v1);
  const span = Math.max(1e-9, hi - lo);
  const t = Math.max(0, track);
  return { start: ((v0 - lo) / span) * t, size: ((v1 - v0) / span) * t };
}
