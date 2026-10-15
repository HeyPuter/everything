// Pure color / weight helpers for the paint mode operators.

export interface ColorAdjust {
  offset?: number;
  gain?: number;
  /** 0.5 keeps the hue */
  hue?: number;
  saturation?: number;
  value?: number;
  brightness?: number;
  contrast?: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6),
    f = h * 6 - i;
  const p = v * (1 - s),
    q = v * (1 - f * s),
    t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Adjust RGBA colors in place (alpha untouched). */
export function adjustColor(cols: Float32Array, o: ColorAdjust) {
  const hsv = o.hue !== undefined || o.saturation !== undefined || o.value !== undefined;
  const bc = o.brightness !== undefined || o.contrast !== undefined;
  const c = o.contrast ?? 0;
  const a = c > 0 ? 1 / Math.max(1e-3, 1 - c) : 1 + c;
  for (let i = 0; i < cols.length; i += 4) {
    let r = cols[i],
      g = cols[i + 1],
      b = cols[i + 2];
    if (o.offset !== undefined || o.gain !== undefined) {
      const off = o.offset ?? 0,
        gain = o.gain ?? 1;
      r = (r + off) * gain;
      g = (g + off) * gain;
      b = (b + off) * gain;
    }
    if (hsv) {
      const [h, s, v] = rgbToHsv(clamp01(r), clamp01(g), clamp01(b));
      let nh = h + (o.hue ?? 0.5) - 0.5;
      nh -= Math.floor(nh);
      [r, g, b] = hsvToRgb(nh, clamp01(s * (o.saturation ?? 1)), v * (o.value ?? 1));
    }
    if (bc) {
      const br = o.brightness ?? 0;
      r = (r - 0.5) * a + 0.5 + br;
      g = (g - 0.5) * a + 0.5 + br;
      b = (b - 0.5) * a + 0.5 + br;
    }
    cols[i] = clamp01(r);
    cols[i + 1] = clamp01(g);
    cols[i + 2] = clamp01(b);
  }
}

/** Round a weight to `steps` levels. */
export function quantize(w: number, steps: number): number {
  return Math.round(w * steps) / steps;
}

/** For each vertex, the vertex at its mirrored position across X (or -1). */
export function mirrorVertexMap(P: ArrayLike<number>, eps = 1e-4): Int32Array {
  const n = P.length / 3;
  const q = (x: number) => Math.round(x / eps);
  const map = new Map<string, number>();
  for (let v = 0; v < n; v++) map.set(`${q(P[v * 3])},${q(P[v * 3 + 1])},${q(P[v * 3 + 2])}`, v);
  const out = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const k = `${q(-P[v * 3])},${q(P[v * 3 + 1])},${q(P[v * 3 + 2])}`;
    const m = map.get(k);
    if (m !== undefined) out[v] = m;
  }
  return out;
}
