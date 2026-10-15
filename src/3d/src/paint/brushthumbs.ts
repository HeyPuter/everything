// Brush thumbnails: small software-shaded spheres showing the effect of each brush (a bump for
// Draw, a groove for Crease, a plateau for Clay, color for paint brushes…), drawn once per brush.

type Shade = { h: (x: number, y: number) => number; color?: (x: number, y: number, base: number[]) => number[] };

const bump = (x: number, y: number, r = 0.45) => {
  const d = Math.hypot(x, y) / r;
  return d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
};
const smoothstep = (a: number, b: number, t: number) => {
  const u = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const noise = (x: number, y: number) => Math.sin(x * 9.1 + Math.sin(y * 6.3) * 2) * Math.cos(y * 7.7 + Math.sin(x * 5.1)) * 0.5;
const heat = (w: number): number[] => {
  const t = Math.max(0, Math.min(1, w));
  if (t < 0.25) return [0, t * 4, 1];
  if (t < 0.5) return [0, 1, 1 - (t - 0.25) * 4];
  if (t < 0.75) return [(t - 0.5) * 4, 1, 0];
  return [1, 1 - (t - 0.75) * 4, 0];
};

const SHADES: Record<string, Shade> = {
  DRAW: { h: (x, y) => bump(x, y) * 0.35 },
  DRAW_SHARP: { h: (x, y) => Math.max(0, 1 - Math.abs(x + y * 0.3) * 6) * smoothstep(0.7, 0.2, Math.abs(y)) * 0.25 },
  CLAY: { h: (x, y) => smoothstep(0.55, 0.35, Math.hypot(x, y)) * 0.15 },
  CLAY_STRIPS: { h: (x, y) => smoothstep(0.45, 0.35, Math.max(Math.abs(x), Math.abs(y * 2.2))) * 0.12 + smoothstep(0.3, 0.2, Math.max(Math.abs(x - 0.15), Math.abs(y * 2.2 + 0.2))) * 0.08 },
  LAYER: { h: (x, y) => smoothstep(0.42, 0.38, Math.hypot(x, y)) * 0.12 },
  INFLATE: { h: (x, y) => bump(x, y, 0.65) * 0.3 },
  BLOB: { h: (x, y) => Math.sqrt(Math.max(0, 1 - (x * x + y * y) / 0.16)) * 0.25 },
  CREASE: { h: (x, y) => -Math.max(0, 1 - Math.abs(x - y * 0.2) * 8) * smoothstep(0.75, 0.3, Math.abs(y)) * 0.25 },
  SMOOTH: { h: (x, y) => noise(x, y) * 0.06 * smoothstep(0.15, 0.6, Math.hypot(x, y)) },
  FLATTEN: { h: (x, y) => (noise(x, y) * 0.07 + bump(x, y, 0.8) * 0.15) * smoothstep(0.2, 0.55, Math.hypot(x, y)) },
  FILL: { h: (x, y) => -bump(x - 0.15, y, 0.5) * 0.25 * smoothstep(0.1, 0.4, Math.hypot(x + 0.15, y)) },
  SCRAPE: { h: (x, y) => Math.min(bump(x, y, 0.6) * 0.3, 0.08) },
  PINCH: { h: (x, y) => Math.max(0, 1 - Math.abs(x) * (3 + 6 * smoothstep(0.6, 0, Math.abs(y)))) * 0.2 },
  GRAB: { h: (x, y) => bump(x - 0.15, y + 0.15, 0.5) * 0.4 },
  SNAKE_HOOK: { h: (x, y) => Math.max(0, 1 - Math.hypot(x * 4, (y + 0.1) * 1.4)) * 0.35 },
  THUMB: { h: (x, y) => bump(x - 0.1, y, 0.5) * 0.15 - bump(x + 0.25, y, 0.3) * 0.08 },
  NUDGE: { h: (x, y) => bump(x - 0.2, y, 0.4) * 0.2 },
  CLAY_THUMB: { h: (x, y) => smoothstep(0.55, 0.2, Math.hypot(x * 0.8, y)) * (0.08 + 0.1 * smoothstep(-0.5, 0.5, x)) },
  MULTIPLANE_SCRAPE: { h: (x, y) => Math.max(0, 0.22 - Math.abs(x) * 0.6) * smoothstep(0.75, 0.4, Math.abs(y)) },
  ELASTIC_DEFORM: { h: (x, y) => Math.pow(1 + ((x - 0.1) ** 2 + (y + 0.1) ** 2) * 12, -1.5) * 0.35 },
  POSE: { h: (x, y) => (x > -0.1 ? smoothstep(0.75, 0.6, Math.abs(y + (x + 0.1) * 0.6)) * 0.12 * smoothstep(-0.1, 0.2, x) : 0) },
  CLOTH: { h: (x, y) => Math.sin(x * 9 + Math.sin(y * 3) * 1.5) * 0.04 * smoothstep(0.8, 0.2, Math.hypot(x, y)) },
  SLIDE_RELAX: { h: (x, y) => Math.sin((x + y * 0.2) * 10) * 0.03 * smoothstep(0.7, 0.2, Math.hypot(x, y)) },
  SIMPLIFY: { h: (x, y) => (Math.abs(Math.sin(x * 14)) + Math.abs(Math.sin(y * 14))) * 0.015 * smoothstep(0.2, 0.6, Math.hypot(x, y)) },
  ROTATE: { h: (x, y) => Math.sin(Math.atan2(y, x) * 3 + Math.hypot(x, y) * 8) * 0.06 * smoothstep(0.7, 0.1, Math.hypot(x, y)) },
  MASK: { h: () => 0, color: (x, y, c) => (Math.hypot(x, y) < 0.45 ? c.map((k) => k * 0.25) : c) },
  DRAW_FACE_SETS: { h: () => 0, color: (x, y, c) => (x + y * 0.4 < -0.1 ? [0.55, 0.85, 0.35] : x > 0.25 ? [0.95, 0.55, 0.75] : c) },
  // paint brushes
  P_DRAW: { h: () => 0, color: (x, y, c) => mix(c, [0.85, 0.2, 0.15], smoothstep(0.5, 0.3, Math.hypot(x, y))) },
  P_BLUR: { h: () => 0, color: (x, y, c) => mix(c, [0.85, 0.2, 0.15], smoothstep(0.9, -0.2, Math.hypot(x, y)) * 0.8) },
  P_AVERAGE: { h: () => 0, color: (x, y, c) => mix(mix(c, [0.2, 0.4, 0.9], x > 0 ? 0.8 : 0), [0.6, 0.45, 0.6], smoothstep(0.5, 0.35, Math.hypot(x, y))) },
  P_SMEAR: { h: () => 0, color: (x, y, c) => mix(c, [0.2, 0.5, 0.9], smoothstep(0.15, -0.1, x + Math.sin(y * 6) * 0.15 * smoothstep(0.6, 0, Math.abs(y)))) },
  P_FILL: { h: () => 0, color: () => [0.95, 0.75, 0.2] },
  P_CLONE: { h: () => 0, color: (x, y, c) => (Math.hypot(x + 0.3, y - 0.3) < 0.25 || Math.hypot(x - 0.25, y + 0.25) < 0.25 ? [0.3, 0.6, 0.9] : c) },
  W_DRAW: { h: () => 0, color: (x, y) => heat(smoothstep(0.7, 0.05, Math.hypot(x, y))) },
  W_BLUR: { h: () => 0, color: (x) => heat(0.5 + x * 0.35) },
  W_AVERAGE: { h: () => 0, color: (x, y) => heat(Math.hypot(x, y) < 0.45 ? 0.55 : x > 0 ? 0.9 : 0.15) },
  W_SMEAR: { h: () => 0, color: (x, y) => heat(smoothstep(0.2, -0.15, x + Math.sin(y * 6) * 0.12)) },
};

function mix(a: number[], b: number[], t: number) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

const cache = new Map<string, string>();

/** Data URL of the thumbnail of a brush (tool id + mode), `size` pixels square. */
export function brushThumb(tool: string, mode: string, size = 64): string {
  const key = `${mode}:${tool}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const shadeKey = mode === 'SCULPT' && tool !== 'PAINT' && tool !== 'SMEAR' ? tool : mode === 'WEIGHT_PAINT' ? `W_${tool}` : `P_${tool === 'TEXDRAW' || tool === 'PAINT' ? 'DRAW' : tool === 'SOFTEN' ? 'BLUR' : tool}`;
  const sh = SHADES[shadeKey] ?? SHADES.DRAW;
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(size, size);
  const L = [-0.45, 0.55, 0.7];
  const ll = Math.hypot(L[0], L[1], L[2]);
  const base = mode === 'SCULPT' ? [0.72, 0.72, 0.74] : [0.85, 0.85, 0.85];
  const e = 2 / size;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1,
        y = 1 - ((py + 0.5) / size) * 2;
      const r2 = x * x + y * y;
      const i = (py * size + px) * 4;
      // anti-aliased sphere edge
      const edge = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * size * 0.5));
      if (edge <= 0) continue;
      const z = Math.sqrt(Math.max(0, 1 - r2));
      // perturb the sphere normal by the brush height field
      const gx = (sh.h(x + e, y) - sh.h(x - e, y)) / (2 * e),
        gy = (sh.h(x, y + e) - sh.h(x, y - e)) / (2 * e);
      let nx = x - gx * z,
        ny = y - gy * z,
        nz = z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const d = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ll);
      const hx = L[0] / ll,
        hy = L[1] / ll,
        hz = L[2] / ll + 1;
      const hl = Math.hypot(hx, hy, hz);
      const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 30) * 0.25;
      const col = sh.color ? sh.color(x, y, base) : base;
      for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(Math.min(1, col[k] * (0.22 + 0.78 * d) + spec) * 255);
      img.data[i + 3] = Math.round(edge * 255);
    }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}
