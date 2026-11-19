// Spectral selections: a time-frequency mask made of shapes, drawn on the
// spectral display and applied by STFT processing (see process.js).
//
//   selection = { channels: boolean[], shapes: Shape[], invert?: boolean }
//   (inverted, it covers everything in the shapes' time range except the shapes)
//   Shape =
//     { type: 'rect', t0, t1, f0, f1 }                         frames, Hz
//     { type: 'poly', log, points: [[t, f], ...] }             lasso outline
//     { type: 'brush', log, rt, rf, opacity, dots: [[t, f]] }  painted circles:
//        rt = radius in frames, rf = radius in octaves (log) or Hz (linear)
//
// Lasso and brush shapes remember the frequency axis they were drawn on, so
// their outline means the same thing after the display switches scales.

const LOG_MIN = 1; // Hz, guards log2(0)

const yOf = (log, f) => (log ? Math.log2(Math.max(LOG_MIN, f)) : f);
const fOf = (log, y) => (log ? Math.pow(2, y) : y);

/**
 * Frequency intervals [[fLo, fHi, weight]] a shape covers at frame t.
 */
export function shapeIntervals(shape, t) {
  if (shape.type === 'rect') {
    if (t < shape.t0 || t > shape.t1) return [];
    return [[Math.min(shape.f0, shape.f1), Math.max(shape.f0, shape.f1), shape.opacity ?? 1]];
  }
  if (shape.type === 'poly') {
    const pts = shape.points;
    if (pts.length < 3) return [];
    // Crossings of the vertical line at t with each edge (even-odd rule).
    const ys = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ta, fa] = pts[i];
      const [tb, fb] = pts[j];
      if (ta > t !== tb > t) {
        const u = (t - ta) / (tb - ta);
        const ya = yOf(shape.log, fa);
        const yb = yOf(shape.log, fb);
        ys.push(ya + (yb - ya) * u);
      }
    }
    ys.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < ys.length; i += 2) out.push([fOf(shape.log, ys[i]), fOf(shape.log, ys[i + 1]), shape.opacity ?? 1]);
    return out;
  }
  if (shape.type === 'brush') {
    const out = [];
    for (const [ct, cf] of shape.dots) {
      const dx = (t - ct) / shape.rt;
      if (dx < -1 || dx > 1) continue;
      const dy = shape.rf * Math.sqrt(1 - dx * dx);
      const yc = yOf(shape.log, cf);
      out.push([fOf(shape.log, yc - dy), fOf(shape.log, yc + dy), shape.opacity ?? 1]);
    }
    return out;
  }
  return [];
}

/** Weight (0..1) of the selection at frame t and frequency f. */
export function weightAt(selection, t, f) {
  let w = 0;
  for (const s of selection.shapes) {
    for (const [lo, hi, o] of shapeIntervals(s, t)) if (f >= lo && f <= hi && o > w) w = o;
  }
  if (selection.invert) {
    const b = selectionBounds(selection);
    return b && t >= b.t0 && t <= b.t1 ? 1 - w : 0;
  }
  return w;
}

/** Time and frequency bounds: { t0, t1, f0, f1 } or null when empty. */
export function selectionBounds(selection) {
  let t0 = Infinity;
  let t1 = -Infinity;
  let f0 = Infinity;
  let f1 = -Infinity;
  const add = (t, fa, fb = fa) => {
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
    f0 = Math.min(f0, fa, fb);
    f1 = Math.max(f1, fa, fb);
  };
  for (const s of selection?.shapes || []) {
    if (s.type === 'rect') {
      add(s.t0, s.f0, s.f1);
      add(s.t1, s.f0, s.f1);
    } else if (s.type === 'poly') {
      for (const [t, f] of s.points) add(t, f);
    } else if (s.type === 'brush') {
      for (const [t, f] of s.dots) {
        const y = yOf(s.log, f);
        add(t - s.rt, fOf(s.log, y - s.rf), fOf(s.log, y + s.rf));
        add(t + s.rt, f);
      }
    }
  }
  if (!(t1 >= t0)) return null;
  // Inverted, the selection reaches every frequency in its time range.
  if (selection.invert) return { t0: Math.max(0, t0), t1, f0: 0, f1: Infinity };
  return { t0: Math.max(0, t0), t1, f0: Math.max(0, f0), f1 };
}

export function isEmpty(selection) {
  return !selection || !selectionBounds(selection);
}

/**
 * Rasterises a selection onto an STFT grid: `cols` columns centred at
 * frames first + c * hop, n / 2 + 1 bins of rate / n Hz. Returns a
 * column-major Float32Array of weights, grown by `grow` bins/columns and
 * then feathered over the same distance so edges blend smoothly while the
 * selected core keeps full strength.
 */
export function rasterize(selection, { first, cols, hop, n, rate, growBins = 2, growCols = 1 }) {
  const bins = n / 2 + 1;
  const df = rate / n;
  const out = new Float32Array(cols * bins);
  for (let c = 0; c < cols; c++) {
    const t = first + c * hop;
    const row = c * bins;
    for (const s of selection.shapes) {
      for (const [lo, hi, w] of shapeIntervals(s, t)) {
        const k0 = Math.max(0, Math.round(lo / df));
        const k1 = Math.min(bins - 1, Math.round(hi / df));
        for (let k = k0; k <= k1; k++) if (out[row + k] < w) out[row + k] = w;
      }
    }
  }
  if (selection.invert) {
    const b = selectionBounds(selection);
    for (let c = 0; c < cols; c++) {
      const t = first + c * hop;
      const inside = b && t >= b.t0 && t <= b.t1;
      for (let k = c * bins, e = k + bins; k < e; k++) out[k] = inside ? 1 - out[k] : 0;
    }
  }
  if (growBins || growCols) {
    const grown = dilate(out, cols, bins, growCols, growBins);
    return blur(grown, cols, bins, growCols, growBins);
  }
  return out;
}

/** Maximum filter over (2rc+1) x (2rb+1) neighbourhoods, separable. */
export function dilate(src, cols, bins, rc, rb) {
  const tmp = new Float32Array(src.length);
  for (let c = 0; c < cols; c++) {
    const row = c * bins;
    for (let k = 0; k < bins; k++) {
      let m = 0;
      for (let d = Math.max(0, k - rb); d <= Math.min(bins - 1, k + rb); d++) if (src[row + d] > m) m = src[row + d];
      tmp[row + k] = m;
    }
  }
  const out = new Float32Array(src.length);
  for (let c = 0; c < cols; c++) {
    for (let k = 0; k < bins; k++) {
      let m = 0;
      for (let d = Math.max(0, c - rc); d <= Math.min(cols - 1, c + rc); d++) if (tmp[d * bins + k] > m) m = tmp[d * bins + k];
      out[c * bins + k] = m;
    }
  }
  return out;
}

/** Box blur over (2rc+1) x (2rb+1) neighbourhoods, separable. */
export function blur(src, cols, bins, rc, rb) {
  const tmp = new Float32Array(src.length);
  for (let c = 0; c < cols; c++) {
    const row = c * bins;
    for (let k = 0; k < bins; k++) {
      let s = 0;
      for (let d = k - rb; d <= k + rb; d++) s += d >= 0 && d < bins ? src[row + d] : 0;
      tmp[row + k] = s / (2 * rb + 1);
    }
  }
  const out = new Float32Array(src.length);
  for (let c = 0; c < cols; c++) {
    for (let k = 0; k < bins; k++) {
      let s = 0;
      for (let d = c - rc; d <= c + rc; d++) s += d >= 0 && d < cols ? tmp[d * bins + k] : 0;
      out[c * bins + k] = s / (2 * rc + 1);
    }
  }
  return out;
}

/** A selection covering every frequency over [t0, t1) (Auto Heal). */
export function timeSelection(t0, t1, nyquist, channels) {
  return { channels, shapes: [{ type: 'rect', t0, t1, f0: 0, f1: nyquist }] };
}

/** Adds a dot to a brush shape, filling gaps so fast strokes stay continuous. */
export function addBrushDot(shape, t, f) {
  const last = shape.dots[shape.dots.length - 1];
  if (last) {
    const dt = (t - last[0]) / shape.rt;
    const dy = (yOf(shape.log, f) - yOf(shape.log, last[1])) / shape.rf;
    const d = Math.hypot(dt, dy);
    const steps = Math.floor(d / 0.4);
    for (let i = 1; i <= steps; i++) {
      const u = i / (steps + 1);
      shape.dots.push([last[0] + (t - last[0]) * u, fOf(shape.log, yOf(shape.log, last[1]) + (yOf(shape.log, f) - yOf(shape.log, last[1])) * u)]);
    }
    if (d < 0.05) return shape;
  }
  shape.dots.push([t, f]);
  return shape;
}

/** Outline points of a brush dot in (t, f) for drawing: an ellipse of `steps` points. */
export function dotOutline(shape, [ct, cf], steps = 20) {
  const yc = yOf(shape.log, cf);
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [ct + Math.cos(a) * shape.rt, fOf(shape.log, yc + Math.sin(a) * shape.rf)];
  });
}
