// Box Mask and Ellipse Mask. Coordinates: texel / (size − 1) relative to the
// position, y scaled by the aspect ratio, rotated, compared with half the size.
import { registerExec } from '../eval/evaluator';
import { Result, IDENTITY, type Domain, type Xform } from '../eval/result';
import { menuValue } from '../nodes/defs';
import { renderSize } from '../../render/final/units';

const OPS: Record<string, number> = {
  Add: 0,
  Subtract: 1,
  Multiply: 2,
  Not: 3,
};

const MASK = (ellipse: boolean) => `
uniform sampler2D u_mask;
uniform sampler2D u_value;
uniform vec2 u_pos;
uniform vec2 u_half;
uniform float u_cos;
uniform float u_sin;
uniform int u_op;
layout(location = 0) out vec4 o0;
void main() {
  vec2 size = vec2(textureSize(u_mask, 0));
  vec2 uv = floor(gl_FragCoord.xy) / max(size - 1.0, vec2(1.0)) - u_pos;
  uv.y *= size.y / size.x;
  uv = vec2(u_cos * uv.x + u_sin * uv.y, -u_sin * uv.x + u_cos * uv.y);
  bool inside = ${ellipse ? 'length(uv / u_half) < 1.0' : 'all(lessThan(abs(uv), u_half))'};
  float m = cmpPx(u_mask).r;
  float v = cmpPx(u_value).r;
  float r = m;
  if (u_op == 0) r = inside ? max(m, v) : m;
  else if (u_op == 1) r = inside ? clamp(m - v, 0.0, 1.0) : m;
  else if (u_op == 2) r = inside ? m * v : 0.0;
  else r = inside ? (m > 0.0 ? 0.0 : v) : m;
  o0 = vec4(vec3(r), 1.0);
}`;

for (const [id, ellipse] of [
  ['CompositorNodeBoxMask', false],
  ['CompositorNodeEllipseMask', true],
] as const) {
  registerExec(id, (x) => {
    const mask = x.input('Mask');
    // a mask needs an image domain: the Mask input's, or the render size
    let d: Domain | null = mask.domain ?? x.input('Value').domain ?? null;
    if (!d) {
      const [W, H] = renderSize(x.env.doc.scene.render);
      d = { w: W, h: H, xf: [...IDENTITY] as Xform };
    }
    const [px, py] = x.vec('Position', 2);
    const [sx, sy] = x.vec('Size', 2);
    const a = x.num('Rotation');
    const t = x.alloc(d);
    x.pass(`mask:${ellipse}`, MASK(ellipse), t, {
      u_mask: x.ev.realize(mask, d),
      u_value: x.ev.realize(x.input('Value'), d),
      u_pos: [px, py],
      u_half: [Math.max(1e-6, sx / 2), Math.max(1e-6, sy / 2)],
      u_cos: Math.cos(a),
      u_sin: Math.sin(a),
      u_op: OPS[menuValue(x.node, 'Operation')] ?? 0,
    });
    x.out('Mask', Result.image('FLOAT', t, d));
  });
}
