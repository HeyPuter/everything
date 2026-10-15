// Convert Colorspace, Convert to Display and Hue Correct (formulas mirrored from
// color/colorspace.ts and render/final/colormanage.ts).
import { registerExec } from '../eval/evaluator';
import { registerPixel, runPixelNode, pixelGeneratorFor, CMP_LIB } from '../eval/pixel';
import { COLOR_SPACES, COLORSPACE_GLSL, TRANSFER_INDEX, conversionMatrix, bakeHueCurves, defaultHueCurves } from '../color/colorspace';
import { displayGLSL, VIEW_INDEX, type ViewTransform } from '../../render/final/colormanage';
import { fmt } from '../../nodes/shader/codegen';

Object.assign(CMP_LIB, {
  cmp_colorspace: { code: COLORSPACE_GLSL },
  cmp_display: {
    code:
      displayGLSL +
      `
vec3 cmpSrgbEncodeX(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
vec3 cmpSrgbDecodeX(vec3 c) { return mix(c / 12.92, pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4)), step(vec3(0.04045), c)); }
// view: 0 standard, 1 agx, 2 filmic, 3 neutral, 4 raw
vec3 cmpDisplayForward(vec3 c, int view, float exposure, float invGamma) {
  c *= exposure;
  if (view == 0) c = cmpSrgbEncodeX(c);
  else if (view == 1) c = cmSrgb(cmAgx(c));
  else if (view == 2) c = vec3(cmFilmic1(c.r), cmFilmic1(c.g), cmFilmic1(c.b));
  else if (view == 3) c = cmSrgb(cmNeutral(c));
  if (invGamma != 1.0) c = sign(c) * pow(abs(c), vec3(invGamma));
  return c;
}
vec3 cmpDisplayInverse(vec3 c, int view, float exposure, float invGamma) {
  if (invGamma != 1.0) c = sign(c) * pow(abs(c), vec3(1.0 / invGamma));
  if (view == 0) c = cmpSrgbDecodeX(c);
  return c / max(exposure, 1e-6);
}
`,
  },
});

const mat3 = (m: number[]) => `mat3(${[0, 1, 2].flatMap((c) => [0, 1, 2].map((r) => fmt(m[r * 3 + c]))).join(', ')})`;

registerPixel('CompositorNodeConvertColorSpace', (g) => {
  const from = g.str('from_color_space') || 'scene_linear',
    to = g.str('to_color_space') || 'scene_linear';
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const a = COLOR_SPACES[from],
    b = COLOR_SPACES[to];
  if (!a || !b || from === to || !a.primaries || !b.primaries) {
    if (!a || !b) g.error('Unsupported color space');
    g.out('Image', 'vec4', c);
    return;
  }
  g.lib('cmp_colorspace');
  const m = conversionMatrix(from, to);
  g.out('Image', 'vec4', `vec4(cmpConvertSpace(${c}.rgb, ${TRANSFER_INDEX[a.transfer]}, ${mat3(m)}, ${TRANSFER_INDEX[b.transfer]}), ${c}.a)`);
});

// the view transform applies to the stored values as they are (no un-premultiplying, alpha kept);
// Standard is the plain (unclamped) sRGB encoding, which Invert undoes
registerPixel('CompositorNodeConvertToDisplay', (g) => {
  g.lib('cmp_display');
  const view = VIEW_INDEX[(g.str('view_transform') || 'STANDARD') as ViewTransform] ?? 0;
  const ex = Math.pow(2, Number(g.prop('exposure') ?? 0));
  const gm = Number(g.prop('gamma') ?? 1);
  const ig = gm > 0 ? 1 / gm : 1;
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const inv = g.tmp('float', g.in('Invert', 'float'));
  if (view !== 0 && view !== 4 && (g.value('Invert') === true || g.linked('Invert'))) g.error('Only the Standard and Raw views can be inverted');
  g.out('Image', 'vec4', `${inv} > 0.5 ? vec4(cmpDisplayInverse(${c}.rgb, ${view}, ${fmt(ex)}, ${fmt(ig)}), ${c}.a) : vec4(cmpDisplayForward(${c}.rgb, ${view}, ${fmt(ex)}, ${fmt(ig)}), ${c}.a)`);
});

registerPixel('CompositorNodeHueCorrect', (g) => {
  g.lib('cmp_hsv');
  if (!g.node.props.curve_0) Object.assign(g.node.props, defaultHueCurves());
  const lut = g.uniform('sampler2D', { kind: 'lut', data: bakeHueCurves(g.node.props, 256), width: 256 });
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const hsv = g.tmp('vec3', `cmp_rgb2hsv(${c}.rgb)`);
  const k = g.tmp('vec3', `texture(${lut}, vec2(clamp(${hsv}.x, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb`);
  g.stmt(`${hsv}.x = fract(${hsv}.x + ${k}.x - 0.5); ${hsv}.y = clamp(${hsv}.y * ${k}.y * 2.0, 0.0, 1.0); ${hsv}.z = ${hsv}.z * ${k}.z * 2.0;`);
  const f = g.tmp('float', g.in('Fac', 'float'));
  g.out('Image', 'vec4', `vec4(mix(${c}.rgb, cmp_hsv2rgb(${hsv}), ${f}), ${c}.a)`);
});

for (const id of ['CompositorNodeConvertColorSpace', 'CompositorNodeConvertToDisplay', 'CompositorNodeHueCorrect']) registerExec(id, (x) => runPixelNode(x, pixelGeneratorFor(id)!));
