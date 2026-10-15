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
vec3 cmpSrgbDecode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
// inverse of the Standard / Raw display transform (display-encoded → scene linear)
vec4 cmpDisplayInverse(vec4 p, int view, float exposure, float invGamma) {
  vec3 c = clamp(p.rgb, 0.0, 1.0);
  if (invGamma != 1.0) c = pow(c, vec3(1.0 / invGamma));
  if (view != 4) c = cmpSrgbDecode(c);
  c /= max(exposure, 1e-6);
  return vec4(c * p.a, p.a);
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

registerPixel('CompositorNodeConvertToDisplay', (g) => {
  g.lib('cmp_display');
  const view = VIEW_INDEX[(g.str('view_transform') || 'STANDARD') as ViewTransform] ?? 0;
  const ex = Math.pow(2, Number(g.prop('exposure') ?? 0));
  const gm = Number(g.prop('gamma') ?? 1);
  const ig = gm > 0 ? 1 / gm : 1;
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const inv = g.tmp('float', g.in('Invert', 'float'));
  // the forward transform returns display values with straight alpha: premultiply them back
  const fwd = g.tmp('vec4', `cmDisplay(${c}, ${view}, ${fmt(ex)}, ${fmt(ig)})`);
  const back = view === 0 || view === 4 ? `cmpDisplayInverse(${c}, ${view}, ${fmt(ex)}, ${fmt(ig)})` : c;
  if (view !== 0 && view !== 4 && (g.value('Invert') === true || g.linked('Invert'))) g.error('Only the Standard and Raw views can be inverted');
  g.out('Image', 'vec4', `${inv} > 0.5 ? ${back} : vec4(${fwd}.rgb * ${fwd}.a, ${fwd}.a)`);
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
