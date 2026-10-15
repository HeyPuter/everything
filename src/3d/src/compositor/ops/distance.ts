// Distance-based nodes built on a jump flooding pass (nearest seed pixel for every pixel):
// Mask To SDF, Double Edge Mask and Inpaint; plus ID Mask and Convolve.
import { registerExec, type NodeCtx } from '../eval/evaluator';
import { Result, type Domain } from '../eval/result';
import type { Texture } from '../gpu/gpu';
import { menuValue } from '../nodes/defs';

/** Seeds: rgba = (x, y, 0, 1) of the pixel itself when `cond` holds, else (-1, -1, 0, 0). */
const SEED = (cond: string) => `
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform int u_edges;
layout(location = 0) out vec4 o0;
float A(ivec2 p) { return cmpFetch(u_a, p, 1, 1).r; }
float B(ivec2 p) { return cmpFetch(u_b, p, 1, 1).r; }
bool inA(ivec2 p) { ivec2 s = textureSize(u_a, 0); if (p.x < 0 || p.y < 0 || p.x >= s.x || p.y >= s.y) return false; return A(p) > 0.5; }
bool inB(ivec2 p) { ivec2 s = textureSize(u_b, 0); if (p.x < 0 || p.y < 0 || p.x >= s.x || p.y >= s.y) return u_edges == 0 && B(clamp(p, ivec2(0), s - 1)) > 0.5; return B(p) > 0.5; }
bool edgeA(ivec2 p) {
  if (!inA(p)) return false;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) if (!inA(p + ivec2(i, j))) return true;
  return false;
}
bool edgeB(ivec2 p) {
  if (!inB(p)) return false;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) if (!inB(p + ivec2(i, j))) return true;
  return false;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o0 = (${cond}) ? vec4(vec2(p), 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 0.0);
}`;

const JFA = `
uniform sampler2D u_src;
uniform int u_step;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 s = textureSize(u_src, 0);
  vec4 best = texelFetch(u_src, p, 0);
  float bd = best.w > 0.0 ? distance(best.xy, vec2(p)) : 1e20;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      ivec2 q = p + ivec2(i, j) * u_step;
      if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) continue;
      vec4 c = texelFetch(u_src, q, 0);
      if (c.w <= 0.0) continue;
      float d = distance(c.xy, vec2(p));
      if (d < bd) { bd = d; best = c; }
    }
  o0 = best;
}`;

/** Nearest seed of every pixel (jump flooding with a final step of 1). */
export function jumpFlood(x: NodeCtx, seeds: Texture, d: Domain): Texture {
  let cur = seeds;
  let step = 1;
  while (step * 2 < Math.max(d.w, d.h)) step *= 2;
  const steps: number[] = [];
  for (let s = step; s >= 1; s = Math.floor(s / 2)) steps.push(s);
  steps.push(1);
  for (const s of steps) {
    const t = x.alloc(d, 'jfa');
    x.pass('jfa', JFA, t, { u_src: cur, u_step: s });
    if (cur !== seeds) x.ev.release(cur);
    cur = t;
  }
  return cur;
}

function seedPass(x: NodeCtx, d: Domain, cond: string, a: Texture, b: Texture, edges = 0): Texture {
  const t = x.alloc(d, 'seeds');
  x.pass(`seed:${cond}`, SEED(cond), t, { u_a: a, u_b: b, u_edges: edges });
  return t;
}

// ---------------------------------------------------------------------------
// Mask To SDF: distance to the nearest edge pixel of the mask, negative inside

const SDF = `
uniform sampler2D u_mask;
uniform sampler2D u_near;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 n = texelFetch(u_near, p, 0);
  bool inside = texelFetch(u_mask, p, 0).r > 0.5;
  float dist = n.w > 0.0 ? distance(n.xy, vec2(p)) : 0.0;
  o0 = vec4(vec3(inside ? -dist : dist), 1.0);
  o1 = vec4(n.w > 0.0 ? n.xy : vec2(p), 0.0, 0.0);
}`;

registerExec('CompositorNodeMaskToSDF', (x) => {
  const r = x.input('Mask');
  if (!r.domain) {
    x.out('SDF', Result.single('FLOAT', 0));
    x.out('Nearest Pixel', Result.single('VECTOR', [0, 0, 0]));
    return;
  }
  const d = r.domain;
  const m = x.ev.realize(x.ev.convert(r, 'FLOAT'), d);
  const near = jumpFlood(x, seedPass(x, d, 'edgeA(p)', m, m), d);
  const sdf = x.alloc(d),
    np = x.alloc(d);
  x.pass('mask-sdf', SDF, [sdf, np], { u_mask: m, u_near: near });
  x.out('SDF', Result.image('FLOAT', sdf, d));
  x.out('Nearest Pixel', Result.image('VECTOR', np, d));
});

// ---------------------------------------------------------------------------
// Double Edge Mask: gradient from the inner mask's edge (1) to the outer mask's edge (0)

const DOUBLE_EDGE = `
uniform sampler2D u_inner;
uniform sampler2D u_outer;
uniform sampler2D u_ni;
uniform sampler2D u_no;
uniform int u_only_inside;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool inner = texelFetch(u_inner, p, 0).r > 0.5;
  bool outer = texelFetch(u_outer, p, 0).r > 0.5;
  float v = 0.0;
  if (inner) v = (u_only_inside == 1 && !outer) ? 0.0 : 1.0;
  else if (outer) {
    vec4 a = texelFetch(u_ni, p, 0), b = texelFetch(u_no, p, 0);
    float di = a.w > 0.0 ? distance(a.xy, vec2(p)) : 1e20;
    float dO = b.w > 0.0 ? distance(b.xy, vec2(p)) : 0.0;
    v = a.w > 0.0 ? dO / max(dO + di, 1e-6) : 0.0;
  }
  o0 = vec4(vec3(v), 1.0);
}`;

registerExec('CompositorNodeDoubleEdgeMask', (x) => {
  const inner = x.input('Inner Mask'),
    outer = x.input('Outer Mask');
  const d = outer.domain ?? inner.domain;
  if (!d) {
    const vi = x.num('Inner Mask') > 0.5,
      vo = x.num('Outer Mask') > 0.5;
    return x.out('Mask', Result.single('FLOAT', vi && (vo || !x.bool('Only Inside Outer')) ? 1 : 0));
  }
  const ti = x.ev.realize(x.ev.convert(inner, 'FLOAT'), d),
    to = x.ev.realize(x.ev.convert(outer, 'FLOAT'), d);
  const ni = jumpFlood(x, seedPass(x, d, 'edgeA(p)', ti, to), d);
  const no = jumpFlood(x, seedPass(x, d, 'edgeB(p)', ti, to, x.bool('Image Edges') ? 1 : 0), d);
  const t = x.alloc(d);
  x.pass('double-edge', DOUBLE_EDGE, t, { u_inner: ti, u_outer: to, u_ni: ni, u_no: no, u_only_inside: x.bool('Only Inside Outer') ? 1 : 0 });
  x.out('Mask', Result.image('FLOAT', t, d));
});

// ---------------------------------------------------------------------------
// Inpaint: transparent pixels within `Size` of opaque ones take the colour of the nearest opaque
// pixel, smoothed more the further they are from it

const INPAINT_FILL = `
uniform sampler2D u_src;
uniform sampler2D u_near;
uniform float u_size;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  vec4 n = texelFetch(u_near, p, 0);
  float dist = n.w > 0.0 ? distance(n.xy, vec2(p)) : 1e20;
  if (c.a >= 1.0 || dist > u_size) { o0 = c; o1 = vec4(0.0); return; }
  vec4 f = texelFetch(u_src, ivec2(n.xy), 0);
  o0 = vec4(c.rgb + f.rgb * (1.0 - c.a), 1.0);
  o1 = vec4(dist, 1.0, 0.0, 0.0);
}`;

const INPAINT_SMOOTH = `
uniform sampler2D u_fill;
uniform sampler2D u_info;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 info = texelFetch(u_info, p, 0);
  vec4 c = texelFetch(u_fill, p, 0);
  if (info.g < 0.5) { o0 = c; return; }
  float r = min(info.r * 0.5, 16.0);
  int R = int(ceil(r));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  float s2 = max(r * r * 0.5, 1e-3);
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      vec4 q = cmpFetch(u_fill, p + ivec2(i, j), 1, 1);
      if (q.a < 1.0) continue;
      float w = exp(-float(i * i + j * j) / (2.0 * s2));
      acc += q * w;
      wsum += w;
    }
  o0 = wsum > 0.0 ? acc / wsum : c;
}`;

registerExec('CompositorNodeInpaint', (x) => {
  const r = x.input('Image');
  const size = Math.max(0, Math.round(x.num('Size')));
  if (!r.domain || size <= 0) return x.out('Image', r);
  const d = r.domain;
  const src = x.ev.realize(r, d);
  // seeds are the opaque pixels (read from an alpha copy)
  const alpha = x.alloc(d, 'alpha');
  x.pass('inpaint-alpha', `uniform sampler2D u_src;\nlayout(location = 0) out vec4 o0;\nvoid main() { float a = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).a; o0 = vec4(vec3(a), 1.0); }`, alpha, {
    u_src: src,
  });
  const near = jumpFlood(x, seedPass(x, d, 'A(p) >= 0.999', alpha, alpha), d);
  const fill = x.alloc(d),
    info = x.alloc(d);
  x.pass('inpaint-fill', INPAINT_FILL, [fill, info], { u_src: src, u_near: near, u_size: size });
  const out = x.alloc(d);
  x.pass('inpaint-smooth', INPAINT_SMOOTH, out, { u_fill: fill, u_info: info });
  x.out('Image', Result.image('RGBA', out, d));
});

// ---------------------------------------------------------------------------
// ID Mask

const ID_MASK = `
uniform sampler2D u_id;
uniform float u_index;
layout(location = 0) out vec4 o0;
void main() {
  float id = cmpPx(u_id).r;
  o0 = vec4(vec3(floor(id + 0.5) == u_index ? 1.0 : 0.0), 1.0);
}`;

const ID_SMOOTH = `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = texelFetch(u_src, p, 0).r;
  float n = cmpFetch(u_src, p + ivec2(0, 1), 1, 1).r, s = cmpFetch(u_src, p + ivec2(0, -1), 1, 1).r;
  float e = cmpFetch(u_src, p + ivec2(1, 0), 1, 1).r, w = cmpFetch(u_src, p + ivec2(-1, 0), 1, 1).r;
  float ne = cmpFetch(u_src, p + ivec2(1, 1), 1, 1).r, nw = cmpFetch(u_src, p + ivec2(-1, 1), 1, 1).r;
  float se = cmpFetch(u_src, p + ivec2(1, -1), 1, 1).r, sw = cmpFetch(u_src, p + ivec2(-1, -1), 1, 1).r;
  // straight (axis-aligned) edges stay sharp; corners and staircases of diagonal edges are smoothed
  bool vertical = n == c && s == c;
  bool horizontal = e == c && w == c;
  float blur = (4.0 * c + 2.0 * (n + s + e + w) + ne + nw + se + sw) / 16.0;
  o0 = vec4(vec3(vertical || horizontal ? c : blur), 1.0);
}`;

registerExec('CompositorNodeIDMask', (x) => {
  const id = x.input('ID value');
  const index = Math.round(x.num('Index'));
  if (!id.domain) return x.out('Alpha', Result.single('FLOAT', Math.floor(x.num('ID value') + 0.5) === index ? 1 : 0));
  const d = id.domain;
  let t = x.alloc(d);
  x.pass('id-mask', ID_MASK, t, { u_id: id.tex!, u_index: index });
  if (x.bool('Anti-Alias')) {
    const s = x.alloc(d);
    x.pass('id-smooth', ID_SMOOTH, s, { u_src: t });
    t = s;
  }
  x.out('Alpha', Result.image('FLOAT', t, d));
});

// ---------------------------------------------------------------------------
// Convolve: correlation of the image with a kernel image centred on its middle pixel

const CONVOLVE = `
uniform sampler2D u_src;
uniform sampler2D u_k;
uniform vec4 u_norm;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 ks = textureSize(u_k, 0);
  ivec2 c = ks / 2;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < ks.y; j++)
    for (int i = 0; i < ks.x; i++) {
      vec4 k = texelFetch(u_k, ivec2(i, j), 0);
      acc += k * cmpFetch(u_src, p + ivec2(i, j) - c, 0, 0);
    }
  o0 = acc / u_norm;
}`;

const MAX_KERNEL = 129;

registerExec('CompositorNodeConvolve', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const color = menuValue(x.node, 'Kernel Data Type') === 'Color';
  const kr = x.input(color ? 'Color Kernel' : 'Float Kernel');
  let kt: Texture;
  let sum: number[];
  if (!kr.domain) {
    const v = color ? x.vec('Color Kernel', 4) : [0, 0, 0, 0].fill(x.num('Float Kernel'));
    kt = x.ev.tex(Result.single('RGBA', v));
    sum = v;
  } else {
    if (kr.domain.w > MAX_KERNEL || kr.domain.h > MAX_KERNEL) {
      x.error(`Kernels larger than ${MAX_KERNEL}×${MAX_KERNEL} pixels are not supported`);
      return x.out('Image', r);
    }
    const kk = x.ev.convert(kr, 'RGBA');
    kt = kk.tex!;
    const px = x.gpu.read(kt);
    sum = [0, 0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 4; c++) sum[c] += color ? px[i + c] : px[i];
    if (!color) {
      // a float kernel weighs every channel the same
      const f = x.alloc(kr.domain, 'kernel');
      x.pass('kernel-float', `uniform sampler2D u_k;\nlayout(location = 0) out vec4 o0;\nvoid main() { o0 = vec4(texelFetch(u_k, ivec2(gl_FragCoord.xy), 0).r); }`, f, { u_k: kt });
      kt = f;
    }
  }
  const norm = x.bool('Normalize Kernel') ? sum.map((s) => (Math.abs(s) > 1e-12 ? s : 1)) : [1, 1, 1, 1];
  const t = x.alloc(r.domain);
  x.pass('convolve', CONVOLVE, t, { u_src: r.tex!, u_k: kt, u_norm: norm });
  x.out('Image', Result.image('RGBA', t, r.domain));
});
