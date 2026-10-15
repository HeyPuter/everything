// Vector Blur: motion blur from a speed pass (xy: displacement towards the previous frame,
// zw: displacement from the next frame, in pixels). Each pixel averages the image along its own
// motion over the shutter interval; pixels further away than the sampled one (Z) are not pulled
// over nearer ones.
import { registerExec } from '../eval/evaluator';
import { Result } from '../eval/result';

const VECBLUR = `
uniform sampler2D u_src;
uniform sampler2D u_speed;
uniform sampler2D u_z;
uniform int u_samples;
uniform float u_shutter;
uniform int u_useZ;
layout(location = 0) out vec4 o0;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 v = cmpPx(u_speed);
  float z0 = cmpPx(u_z).r;
  vec2 toPrev = v.xy, toNext = -v.zw;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  int n = max(u_samples, 1);
  for (int i = 0; i < 256; i++) {
    if (i >= n) break;
    float t = (n == 1 ? 0.0 : float(i) / float(n - 1) - 0.5) * u_shutter;
    vec2 off = t < 0.0 ? -t * toPrev : t * toNext;
    vec2 q = p + off;
    if (u_useZ == 1) {
      float zq = cmpBilinear(u_z, q, 1, 1).r;
      // keep nearer surfaces from being covered by the blur of farther ones
      if (zq > z0 + 1e-3 && z0 < 1e9) continue;
    }
    acc += cmpBilinear(u_src, q, 1, 1);
    wsum += 1.0;
  }
  o0 = wsum > 0.0 ? acc / wsum : cmpPx(u_src);
}`;

registerExec('CompositorNodeVecBlur', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const d = r.domain;
  const t = x.alloc(d);
  x.pass('vecblur', VECBLUR, t, {
    u_src: r.tex!,
    u_speed: x.realized('Speed', d),
    u_z: x.realized('Depth', d),
    u_samples: Math.max(1, Math.min(256, Math.round(x.num('Samples', 32)))),
    u_shutter: Math.max(0, x.num('Shutter', 0.5)),
    u_useZ: x.linked('Depth') ? 1 : 0,
  });
  x.out('Image', Result.image('RGBA', t, d));
});
