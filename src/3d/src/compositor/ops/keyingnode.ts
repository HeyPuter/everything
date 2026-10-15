// Keying node: matte from the saturation of the screen's primary channel relative to the key
// colour, edge detection (edges keep their soft values when the levels clip), garbage/core
// mattes, post-processing (blur, dilate/erode, feather) and despill.
import { registerExec } from '../eval/evaluator';
import { Result, type Domain } from '../eval/result';
import type { Texture } from '../gpu/gpu';
import { menuValue } from '../nodes/defs';
import { blurTexture, dilateErodeTexture } from './filter';

const SAT = /* glsl */ `
int keyPrimary(vec3 k) { return k.g >= k.r && k.g >= k.b ? 1 : (k.b >= k.r ? 2 : 0); }
// the balance weighs the two other channels (the one after the primary gets 1 - balance)
float keyOthers(vec3 c, float balance, int p) { return balance * c[(p + 2) % 3] + (1.0 - balance) * c[(p + 1) % 3]; }
float keySaturation(vec3 c, float balance, int p) {
  float v = keyOthers(c, balance, p);
  return (c[p] - v) * abs(1.0 - v);
}
`;

const YCC = /* glsl */ `
vec3 keyToYcc(vec3 c) { float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748); }
vec3 keyFromYcc(vec3 c) { float r = c.x + 1.5748 * c.z, b = c.x + 1.8556 * c.y; return vec3(r, (c.x - 0.2126 * r - 0.0722 * b) / 0.7152, b); }
`;

const TO_YCC = `${YCC}
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() { vec4 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); o0 = vec4(keyToYcc(c.rgb), c.a); }`;

const MATTE = `${SAT}${YCC}
uniform sampler2D u_src;
uniform sampler2D u_chroma;
uniform int u_blurred;
uniform vec3 u_key;
uniform float u_balance;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  vec3 rgb = c.rgb;
  if (u_blurred == 1) {
    vec3 y = keyToYcc(rgb);
    vec3 b = texelFetch(u_chroma, p, 0).xyz;
    rgb = keyFromYcc(vec3(y.x, b.yz));
  }
  int pr = keyPrimary(u_key);
  float s = keySaturation(rgb, u_balance, pr);
  float ks = keySaturation(u_key, u_balance, pr);
  float m;
  if (s < 0.0) m = 1.0;
  else if (s >= ks) m = 0.0;
  else m = 1.0 - s / max(ks, 1e-9);
  o0 = vec4(vec3(m), 1.0);
}`;

const EDGES = `
uniform sampler2D u_m;
uniform int u_r;
uniform float u_tol;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 s = textureSize(u_m, 0);
  float c = texelFetch(u_m, p, 0).r;
  int count = 0;
  for (int j = -u_r; j <= u_r; j++)
    for (int i = -u_r; i <= u_r; i++) {
      ivec2 q = p + ivec2(i, j);
      if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) continue;
      if (abs(texelFetch(u_m, q, 0).r - c) > u_tol) count++;
    }
  float side = float(2 * u_r + 1);
  o0 = vec4(vec3(float(count) > 0.1 * side * side ? 1.0 : 0.0), 1.0);
}`;

const CLIP = `
uniform sampler2D u_m;
uniform sampler2D u_edges;
uniform sampler2D u_garbage;
uniform sampler2D u_core;
uniform float u_black;
uniform float u_white;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = texelFetch(u_m, p, 0).r;
  bool edge = texelFetch(u_edges, p, 0).r > 0.5;
  if (!edge && (u_black > 0.0 || u_white < 1.0)) m = clamp((m - u_black) / max(u_white - u_black, 1e-6), 0.0, 1.0);
  m = min(m, 1.0 - cmpPx(u_garbage).r);
  m = max(m, cmpPx(u_core).r);
  o0 = vec4(vec3(m), 1.0);
}`;

const OUTPUT = `${SAT}
uniform sampler2D u_src;
uniform sampler2D u_m;
uniform vec3 u_key;
uniform float u_strength;
uniform float u_balance;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  float m = texelFetch(u_m, p, 0).r;
  int pr = keyPrimary(u_key);
  if (u_strength > 0.0) {
    float spill = c[pr] - keyOthers(c.rgb, u_balance, pr);
    if (spill > 0.0) c[pr] -= u_strength * spill;
  }
  o0 = c * m;
}`;

registerExec('CompositorNodeKeying', (x) => {
  const r = x.input('Image');
  if (!r.domain) {
    x.out('Image', r);
    x.out('Matte', Result.single('FLOAT', 1));
    x.out('Edges', Result.single('FLOAT', 0));
    return;
  }
  const d: Domain = r.domain;
  const src = r.tex!;
  const key = x.vec('Key Color', 3);
  const balance = Math.min(1, Math.max(0, x.num('Key Balance', 0.5)));
  // pre-process: blur the chroma used to pull the matte
  // blur sizes are box widths: size 1 keeps the pixel, 2–3 average 3×3, 4–5 average 5×5, …
  const pre = Math.floor(Math.max(0, Math.round(x.num('Preprocess Blur Size'))) / 2);
  let chroma: Texture = src;
  if (pre > 0) {
    const ycc = x.alloc(d, 'ycc');
    x.pass('key-ycc', TO_YCC, ycc, { u_src: src });
    chroma = blurTexture(x, ycc, 'Flat', pre, pre, true, 1);
  }
  const matte = x.alloc(d, 'matte');
  x.pass('key-matte', MATTE, matte, { u_src: src, u_chroma: chroma, u_blurred: pre > 0 ? 1 : 0, u_key: key, u_balance: balance });
  const edges = x.alloc(d, 'edges');
  x.pass('key-edges', EDGES, edges, { u_m: matte, u_r: Math.min(64, Math.max(0, Math.round(x.num('Edge Search Size', 3)))), u_tol: x.num('Edge Tolerance', 0.1) });
  let m = x.alloc(d, 'clip');
  x.pass('key-clip', CLIP, m, {
    u_m: matte,
    u_edges: edges,
    u_garbage: x.ev.realize(x.input('Garbage Matte'), d),
    u_core: x.ev.realize(x.input('Core Matte'), d),
    u_black: x.num('Black Level'),
    u_white: x.num('White Level', 1),
  });
  // post-process
  const blur = Math.floor(Math.max(0, Math.round(x.num('Postprocess Blur Size'))) / 2);
  if (blur > 0) m = blurTexture(x, m, 'Flat', blur, blur, true, 1);
  const dilate = Math.round(x.num('Postprocess Dilate Size'));
  if (dilate) m = dilateErodeTexture(x, m, d, dilate, 'Distance', '', 0);
  const feather = Math.round(x.num('Postprocess Feather Size'));
  if (feather) m = dilateErodeTexture(x, m, d, feather, 'Feather', menuValue(x.node, 'Feather Falloff') || 'Smooth', 0);
  const out = x.alloc(d);
  x.pass('key-out', OUTPUT, out, { u_src: src, u_m: m, u_key: key, u_strength: Math.max(0, x.num('Despill Strength', 1)), u_balance: Math.min(1, Math.max(0, x.num('Despill Balance', 0.5))) });
  x.out('Image', Result.image('RGBA', out, d));
  x.out('Matte', Result.image('FLOAT', m, d));
  x.out('Edges', Result.image('FLOAT', edges, d));
});
