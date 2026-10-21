// GLSL library: Voronoi texture (1–4D; F1, F2, Smooth F1, Distance to Edge, N-Sphere Radius;
// Euclidean / Manhattan / Chebychev / Minkowski; fractal detail). Mirrors nodes/cpu/voronoi.ts.
import type { GlslLib } from './lib';

interface Dim {
  n: number;
  T: string;
  IT: string;
  /** jitter of cell `c` (an IT expression) as a T */
  jitter: (c: string) => string;
  /** color of cell `c` */
  color: (c: string) => string;
  /** all-ones T */
  ones: string;
  /** T → vec4 position (1D: W in .w) */
  toPos: (v: string) => string;
}

const dims: Dim[] = [
  { n: 1, T: 'float', IT: 'int', jitter: (c) => `nd_hash_f(float(${c}))`, color: (c) => `nd_hash3_f(float(${c}))`, ones: '1.0', toPos: (v) => `vec4(0.0, 0.0, 0.0, ${v})` },
  { n: 2, T: 'vec2', IT: 'ivec2', jitter: (c) => `nd_pcg2(${c})`, color: (c) => `nd_pcg3(ivec3(${c}, 0))`, ones: 'vec2(1.0)', toPos: (v) => `vec4(${v}, 0.0, 0.0)` },
  { n: 3, T: 'vec3', IT: 'ivec3', jitter: (c) => `nd_pcg3(${c})`, color: (c) => `nd_pcg3(${c})`, ones: 'vec3(1.0)', toPos: (v) => `vec4(${v}, 0.0)` },
  { n: 4, T: 'vec4', IT: 'ivec4', jitter: (c) => `nd_pcg4(${c})`, color: (c) => `nd_pcg4(${c}).xyz`, ones: 'vec4(1.0)', toPos: (v) => v },
];

/** Loops over neighbour cells in [-r, r]^n (last axis outermost), declaring `IT o`. */
function loops(d: Dim, r: number, body: string) {
  const v = ['vi', 'vj', 'vk', 'vl'].slice(0, d.n);
  let open = '';
  for (const x of [...v].reverse()) open += `for (int ${x} = -${r}; ${x} <= ${r}; ${x}++) `;
  const o = d.n === 1 ? 'vi' : `${d.IT}(${v.join(', ')})`;
  return `${open}{ ${d.IT} o = ${o}; ${body} }`;
}

function gen(d: Dim): string {
  const { T, IT, n } = d;
  const s = n;
  const sum = n === 1 ? (v: string) => v : (v: string) => `dot(${v}, ${T}(1.0))`;
  const maxc = n === 1 ? (v: string) => v : n === 2 ? (v: string) => `max(${v}.x, ${v}.y)` : n === 3 ? (v: string) => `max(${v}.x, max(${v}.y, ${v}.z))` : (v: string) => `max(max(${v}.x, ${v}.y), max(${v}.z, ${v}.w))`;
  return `
float nd_vdist${s}(${T} a, ${T} b, int metric, float e) {
  ${T} q = abs(a - b);
  if (metric == 1) return ${sum('q')};
  if (metric == 2) return ${maxc('q')};
  if (metric == 3) return pow(${sum(`pow(q, ${T}(e))`)}, 1.0 / e);
  return length(a - b);
}
// one octave: F1 / F2 / smooth F1 (distance, color, position in octave space)
NdVor nd_voronoi${s}_octave(${T} p, int feature, int metric, float e, float smoothness, float rnd) {
  ${T} cellf = floor(p);
  ${IT} cell = ${IT}(cellf);
  ${T} local = p - cellf;
  NdVor r; r.dist = 0.0; r.col = vec3(0.0); r.pos = vec4(0.0); r.radius = 0.0;
  if (feature == 2 && smoothness != 0.0) {
    float sm = clamp(smoothness * 0.5, 0.0, 0.5);
    float sd = 8.0; vec3 col = vec3(0.0); ${T} pos = ${T}(0.0);
    ${loops(
      d,
      2,
      `${T} pt = ${T}(o) + ${d.jitter('cell + o')} * rnd; float dd = nd_vdist${s}(pt, local, metric, e);
      float h = smoothstep(0.0, 1.0, 0.5 + 0.5 * (sd - dd) / sm); float corr = sm * h * (1.0 - h);
      sd = mix(sd, dd, h) - corr; corr /= 1.0 + 3.0 * sm;
      col = mix(col, ${d.color('cell + o')}, h) - corr; pos = mix(pos, pt, h) - corr;`,
    )}
    r.dist = sd; r.col = col; r.pos = ${d.toPos('pos + cellf')};
    return r;
  }
  float d1 = 1e30, d2 = 1e30; ${T} p1 = ${T}(0.0), p2 = ${T}(0.0); ${IT} o1 = ${IT}(0), o2 = ${IT}(0);
  ${loops(
    d,
    1,
    `${T} pt = ${T}(o) + ${d.jitter('cell + o')} * rnd; float dd = nd_vdist${s}(pt, local, metric, e);
    if (dd < d1) { d2 = d1; p2 = p1; o2 = o1; d1 = dd; p1 = pt; o1 = o; } else if (dd < d2) { d2 = dd; p2 = pt; o2 = o; }`,
  )}
  if (feature == 1) { r.dist = d2; r.col = ${d.color('cell + o2')}; r.pos = ${d.toPos('p2 + cellf')}; }
  else { r.dist = d1; r.col = ${d.color('cell + o1')}; r.pos = ${d.toPos('p1 + cellf')}; }
  return r;
}
float nd_voronoi${s}_edge(${T} p, float rnd) {
  ${T} cellf = floor(p);
  ${IT} cell = ${IT}(cellf);
  ${T} local = p - cellf;
  ${
    n === 1
      ? `float mid = ${d.jitter('cell')} * rnd, left = -1.0 + ${d.jitter('cell - 1')} * rnd, right = 1.0 + ${d.jitter('cell + 1')} * rnd;
  return min(abs((mid + left) * 0.5 - local), abs((mid + right) * 0.5 - local));`
      : `${T} closest = ${T}(0.0); float best = 1e30;
  ${loops(d, 1, `${T} v = ${T}(o) + ${d.jitter('cell + o')} * rnd - local; float dd = dot(v, v); if (dd < best) { best = dd; closest = v; }`)}
  best = 1e30;
  ${loops(d, 1, `${T} v = ${T}(o) + ${d.jitter('cell + o')} * rnd - local; ${T} pe = v - closest; if (dot(pe, pe) > 0.0001) best = min(best, dot((closest + v) * 0.5, normalize(pe)));`)}
  return best;`
  }
}
float nd_voronoi${s}_radius(${T} p, float rnd) {
  ${T} cellf = floor(p);
  ${IT} cell = ${IT}(cellf);
  ${T} local = p - cellf;
  ${T} closest = ${T}(0.0); ${IT} coff = ${IT}(0); float best = 1e30;
  ${loops(d, 1, `${T} pt = ${T}(o) + ${d.jitter('cell + o')} * rnd; float dd = distance(pt, local); if (dd < best) { best = dd; closest = pt; coff = o; }`)}
  best = 1e30; ${T} other = ${T}(0.0);
  ${loops(d, 1, `if (o != ${IT}(0)) { ${IT} oo = o + coff; ${T} pt = ${T}(oo) + ${d.jitter('cell + oo')} * rnd; float dd = distance(closest, pt); if (dd < best) { best = dd; other = pt; } }`)}
  return distance(other, closest) * 0.5;
}
NdVor nd_voronoi${s}(${T} coord, float scale, float detail, float rough, float lac, float smoothness, float e, float rnd, int feature, int metric, bool norm) {
  ${T} p = coord * scale;
  rnd = clamp(rnd, 0.0, 1.0);
  detail = clamp(detail, 0.0, 15.0);
  rough = clamp(rough, 0.0, 1.0);
  bool zero = detail == 0.0 || rough == 0.0 || lac == 0.0;
  NdVor res; res.dist = 0.0; res.col = vec3(0.0); res.pos = vec4(0.0); res.radius = 0.0;
  if (feature == 4) { res.radius = nd_voronoi${s}_radius(p, rnd); return res; }
  int steps = int(ceil(detail));
  if (feature == 3) {
    float md = 0.5 + 0.5 * rnd;
    float amp = 1.0, mxa = md, sc = 1.0, dd = 8.0;
    for (int i = 0; i <= 15; i++) {
      if (i > steps) break;
      float od = nd_voronoi${s}_edge(p * sc, rnd);
      if (zero) { dd = od; break; }
      if (float(i) <= detail) {
        mxa = mix(mxa, md / sc, amp); dd = mix(dd, min(dd, od / sc), amp);
        sc *= lac; amp *= rough;
      } else {
        float rem = detail - floor(detail);
        if (rem != 0.0) {
          float la = mix(mxa, md / sc, amp); mxa = mix(mxa, la, rem);
          float ld = mix(dd, min(dd, od / sc), amp); dd = mix(dd, min(dd, ld), rem);
        }
      }
    }
    res.dist = norm ? dd / mxa : dd;
    return res;
  }
  float amp = 1.0, mxa = 0.0, sc = 1.0, dist = 0.0;
  vec3 col = vec3(0.0); vec4 pos = vec4(0.0);
  for (int i = 0; i <= 15; i++) {
    if (i > steps) break;
    NdVor o = nd_voronoi${s}_octave(p * sc, feature, metric, e, smoothness, rnd);
    if (zero) { mxa = 1.0; dist = o.dist; col = o.col; pos = o.pos; break; }
    if (float(i) <= detail) {
      mxa += amp; dist += o.dist * amp; col += o.col * amp; pos = mix(pos, o.pos / sc, amp);
      sc *= lac; amp *= rough;
    } else {
      float rem = detail - floor(detail);
      if (rem != 0.0) {
        mxa += amp * rem; dist += o.dist * amp * rem; col += o.col * amp * rem;
        pos = mix(pos, mix(pos, o.pos / sc, amp), rem);
      }
    }
  }
  if (norm) {
    float unit = nd_vdist${s}(${d.ones}, ${T}(0.0), metric, e);
    dist /= mxa * (feature == 1 ? 1.0 + 0.5 * rnd : 0.5 + 0.5 * rnd) * unit;
    col /= mxa;
  }
  res.dist = dist; res.col = col; res.pos = scale != 0.0 ? pos / scale : vec4(0.0);
  return res;
}`;
}

export const VORONOI: GlslLib = {
  nd_voronoi_struct: {
    code: 'struct NdVor { float dist; vec3 col; vec4 pos; float radius; };',
  },
  nd_voronoi1: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[0]) },
  nd_voronoi2: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[1]) },
  nd_voronoi3: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[2]) },
  nd_voronoi4: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[3]) },
};
