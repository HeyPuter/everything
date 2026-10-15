// Colour nodes as per-pixel GLSL generators (formulas mirrored from color/colorops.ts).
import { nodeGenerators, type NodeGen } from '../../nodes/shader/codegen';
import { registerPixel, runPixelNode, pixelGeneratorFor } from '../eval/pixel';
import { registerExec } from '../eval/evaluator';
import { BLEND_INDEX, YCC_INDEX, balanceParams, brightContrastCoefficients, whitePointMatrix } from '../color/colorops';
import { bakeCurveTable, nodeCurves } from '../color/curvemap';
import { menuValue } from '../nodes/defs';
import type { SocketValue } from '../../data/types';

const num = (v: SocketValue, d = 0) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
/** CPU value of an unlinked input or null when linked (so the generator stays per-pixel). */
const constant = (g: NodeGen, id: string): SocketValue | null => (g.linked(id) ? null : g.value(id));

// ---------------------------------------------------------------------------

registerPixel('CompositorNodeBrightContrast', (g) => {
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const br = constant(g, 'Bright'),
    ct = constant(g, 'Contrast');
  let a: string, b: string;
  if (br !== null && ct !== null) {
    const k = brightContrastCoefficients(num(br), num(ct));
    a = g.uniform('float', k.a);
    b = g.uniform('float', k.b);
  } else {
    const bv = g.tmp('float', `${g.in('Bright', 'float')} / 100.0`);
    const cv = g.tmp('float', g.in('Contrast', 'float'));
    const d = g.tmp('float', `${cv} / 200.0`);
    a = g.tmp('float', `${cv} > 0.0 ? 1.0 / max(1e-6, 1.0 - 2.0 * ${d}) : max(0.0, 1.0 + 2.0 * ${d})`);
    b = g.tmp('float', `${cv} > 0.0 ? ${a} * (${bv} - ${d}) : ${a} * (${bv} - ${d})`);
  }
  g.out('Image', 'vec4', `vec4(${c}.rgb * ${a} + ${b}, ${c}.a)`);
});

registerPixel('CompositorNodeExposure', (g) => {
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  g.out('Image', 'vec4', `vec4(${c}.rgb * exp2(${g.in('Exposure', 'float')}), ${c}.a)`);
});

registerPixel('CompositorNodeInvert', (g) => {
  const c = g.tmp('vec4', g.in('Color', 'vec4'));
  const f = g.tmp('float', g.in('Fac', 'float'));
  const ic = g.in('Invert Color', 'float'),
    ia = g.in('Invert Alpha', 'float');
  g.out('Color', 'vec4', `vec4(${ic} > 0.5 ? mix(${c}.rgb, vec3(1.0) - ${c}.rgb, ${f}) : ${c}.rgb, ${ia} > 0.5 ? mix(${c}.a, 1.0 - ${c}.a, ${f}) : ${c}.a)`);
});

registerPixel('CompositorNodeHueSat', (g) => {
  g.lib('cmp_hsv');
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const hsv = g.tmp('vec3', `cmp_rgb2hsv(${c}.rgb)`);
  g.stmt(`${hsv}.x = fract(${hsv}.x + ${g.in('Hue', 'float')} - 0.5); ${hsv}.y *= ${g.in('Saturation', 'float')}; ${hsv}.z *= ${g.in('Value', 'float')};`);
  g.out('Image', 'vec4', `vec4(mix(${c}.rgb, max(cmp_hsv2rgb(${hsv}), vec3(0.0)), ${g.in('Fac', 'float')}), ${c}.a)`);
});

registerPixel('CompositorNodeColorBalance', (g) => {
  const type = menuValue(g.node, 'Type');
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const fac = g.tmp('float', g.in('Fac', 'float'));
  const param = (kind: Parameters<typeof balanceParams>[0], base: string, color: string) => {
    const b = g.tmp('float', g.in(base, 'float'));
    const col = g.tmp('vec3', g.in(color, 'vec3'));
    return g.tmp('vec3', kind === 'lift' ? `vec3(${b}) + ${col} - 1.0` : kind === 'offset' ? `vec3(${b}) + ${col}` : `${b} * ${col}`);
  };
  let r: string;
  if (type === 'White Point') {
    const vals = ['Input Temperature', 'Input Tint', 'Output Temperature', 'Output Tint'].map((id) => num(g.linked(id) ? null : g.value(id), id.includes('Temperature') ? 6500 : 10));
    // linked temperatures fall back to their stored values (the matrix is computed on the CPU)
    const m = whitePointMatrix(vals[0], vals[1], vals[2], vals[3]);
    const u = g.uniform('vec3', [m[0], m[3], m[6]]),
      v = g.uniform('vec3', [m[1], m[4], m[7]]),
      w = g.uniform('vec3', [m[2], m[5], m[8]]);
    r = `mat3(${u}, ${v}, ${w}) * ${c}.rgb`;
  } else if (type.startsWith('Offset')) {
    const off = param('offset', 'Base Offset', 'Color Offset'),
      pw = param('power', 'Base Power', 'Color Power'),
      sl = param('slope', 'Base Slope', 'Color Slope');
    r = `pow(max(${c}.rgb * ${sl} + ${off}, vec3(0.0)), ${pw})`;
  } else {
    const lift = param('lift', 'Base Lift', 'Color Lift'),
      gam = param('gamma', 'Base Gamma', 'Color Gamma'),
      gain = param('gain', 'Base Gain', 'Color Gain');
    const x = g.tmp('vec3', `((${c}.rgb - 1.0) * (1.0 - ${lift}) + 1.0) * ${gain}`);
    r = `pow(max(${x}, vec3(0.0)), 1.0 / max(${gam}, vec3(1e-6)))`;
  }
  g.out('Image', 'vec4', `vec4(mix(${c}.rgb, ${r}, ${fac}), ${c}.a)`);
});

registerPixel('CompositorNodeAlphaOver', (g) => {
  g.lib('cmp_alpha');
  const t = ['Over', 'Disjoint Over', 'Conjoint Over'].indexOf(menuValue(g.node, 'Type'));
  g.out('Image', 'vec4', `cmp_alpha_over(${g.in('Background', 'vec4')}, ${g.in('Foreground', 'vec4')}, ${g.in('Fac', 'float')}, ${Math.max(0, t)}, ${g.in('Straight Alpha', 'float')} > 0.5)`);
});

registerPixel('CompositorNodeSetAlpha', (g) => {
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const a = g.tmp('float', g.in('Alpha', 'float'));
  g.out('Image', 'vec4', menuValue(g.node, 'Type') === 'Replace Alpha' ? `vec4(${c}.rgb, ${a})` : `${c} * ${a}`);
});

registerPixel('CompositorNodePremulKey', (g) => {
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  g.out('Image', 'vec4', menuValue(g.node, 'Type') === 'To Straight' ? `(${c}.a != 0.0 ? vec4(${c}.rgb / ${c}.a, ${c}.a) : ${c})` : `vec4(${c}.rgb * ${c}.a, ${c}.a)`);
});

registerPixel('CompositorNodeSeparateColor', (g) => {
  g.lib('cmp_hsv', 'cmp_ycc');
  const mode = g.str('mode') || 'RGB';
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const ycc = YCC_INDEX[g.str('ycc_mode') || 'ITUBT709'] ?? 1;
  const v = g.tmp(
    'vec3',
    mode === 'HSV' ? `cmp_rgb2hsv(${c}.rgb)` : mode === 'HSL' ? `cmp_rgb2hsl(${c}.rgb)` : mode === 'YCC' ? `cmp_rgb2ycc(${c}.rgb, ${ycc})` : mode === 'YUV' ? `cmp_rgb2yuv(${c}.rgb)` : `${c}.rgb`,
  );
  g.out('Red', 'float', `${v}.x`);
  g.out('Green', 'float', `${v}.y`);
  g.out('Blue', 'float', `${v}.z`);
  g.out('Alpha', 'float', `${c}.a`);
});

registerPixel('CompositorNodeCombineColor', (g) => {
  g.lib('cmp_hsv', 'cmp_ycc');
  const mode = g.str('mode') || 'RGB';
  const ycc = YCC_INDEX[g.str('ycc_mode') || 'ITUBT709'] ?? 1;
  const v = g.tmp('vec3', `vec3(${g.in('Red', 'float')}, ${g.in('Green', 'float')}, ${g.in('Blue', 'float')})`);
  const rgb = mode === 'HSV' ? `cmp_hsv2rgb(${v})` : mode === 'HSL' ? `cmp_hsl2rgb(${v})` : mode === 'YCC' ? `cmp_ycc2rgb(${v}, ${ycc})` : mode === 'YUV' ? `cmp_yuv2rgb(${v})` : v;
  g.out('Image', 'vec4', `vec4(${rgb}, ${g.in('Alpha', 'float')})`);
});

registerPixel('CompositorNodeRGBToBW', (g) => g.out('Val', 'float', `cmpLuma(${g.in('Image', 'vec3')})`));

registerPixel('CompositorNodePosterize', (g) => {
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const s = g.tmp('float', `clamp(${g.in('Steps', 'float')}, 2.0, 1024.0)`);
  g.out('Image', 'vec4', `vec4(floor(${c}.rgb * ${s}) / ${s}, ${c}.a)`);
});

// Mix: compositor colour blending, shader generator for float/vector
registerPixel('ShaderNodeMix', (g) => {
  if ((g.str('data_type') || 'FLOAT') !== 'RGBA') return nodeGenerators.ShaderNodeMix(g);
  g.lib('cmp_blend');
  let f = g.in('Factor_Float', 'float');
  if (g.prop('clamp_factor') !== false) f = `clamp(${f}, 0.0, 1.0)`;
  const r = `cmp_blend(${BLEND_INDEX[g.str('blend_type')] ?? 0}, ${f}, ${g.in('A_Color', 'vec4')}, ${g.in('B_Color', 'vec4')})`;
  g.out('Result_Color', 'vec4', g.prop('clamp_result') ? `clamp(${r}, 0.0, 1.0)` : r);
});

// RGB Curves: black/white levels, combined curve then the channel curves
registerPixel('CompositorNodeCurveRGB', (g) => {
  g.lib('cmp_curve');
  // curve widget storage: 0 combined, 1–3 red/green/blue
  const curves = nodeCurves(g.node.props, 4);
  const { data, params } = bakeCurveTable(curves);
  const lut = g.uniform('sampler2D', {
    kind: 'lut',
    data,
    width: data.length / 4 / 4,
  });
  const pr = [0, 1, 2, 3].map((i) => g.uniform('vec4', Array.from(params.subarray(i * 4, i * 4 + 4))));
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const bl = g.tmp('vec3', g.in('Black Level', 'vec3')),
    wl = g.tmp('vec3', g.in('White Level', 'vec3'));
  const v = g.tmp('vec3', `(${c}.rgb - ${bl}) / max(${wl} - ${bl}, vec3(1e-6))`);
  const ch = (i: number, comp: string) => `cmp_curve(${lut}, ${pr[i + 1]}, ${i + 1}, cmp_curve(${lut}, ${pr[0]}, 0, ${v}.${comp}))`;
  g.out('Image', 'vec4', `vec4(mix(${c}.rgb, vec3(${ch(0, 'r')}, ${ch(1, 'g')}, ${ch(2, 'b')}), ${g.in('Fac', 'float')}), ${c}.a)`);
});

// Depth Combine (anti-aliasing of the mask edge is done in ops/filter.ts when enabled)
registerPixel('CompositorNodeZcombine', (g) => {
  const a = g.tmp('vec4', g.in('A', 'vec4')),
    b = g.tmp('vec4', g.in('B', 'vec4'));
  const za = g.tmp('float', g.in('Depth A', 'float')),
    zb = g.tmp('float', g.in('Depth B', 'float'));
  const front = g.tmp('vec4', `${za} < ${zb} ? ${a} : ${b}`),
    back = g.tmp('vec4', `${za} < ${zb} ? ${b} : ${a}`);
  const useAlpha = g.in('Use Alpha', 'float');
  g.out('Result', 'vec4', `${useAlpha} > 0.5 ? vec4(mix(${back}.rgb, ${front}.rgb, ${front}.a), max(${front}.a, ${back}.a)) : ${front}`);
  g.out('Depth', 'float', `min(${za}, ${zb})`);
});

// Color Correction: per tonal range saturation/contrast/gamma/gain/offset blended by luminance
registerPixel('CompositorNodeColorCorrection', (g) => {
  const c = g.tmp('vec4', g.in('Image', 'vec4'));
  const lv = g.tmp('float', `(${c}.r + ${c}.g + ${c}.b) / 3.0`);
  const start = g.tmp('float', g.in('Midtones Start', 'float')),
    end = g.tmp('float', g.in('Midtones End', 'float'));
  const margin = '0.1';
  // weights of shadows / midtones / highlights with linear transitions of width 2·margin
  const ws = g.tmp('float', `${lv} < ${start} - ${margin} ? 1.0 : (${lv} < ${start} + ${margin} ? ((${start} - ${lv}) / ${margin} + 1.0) * 0.5 : 0.0)`);
  const wh = g.tmp('float', `${lv} > ${end} + ${margin} ? 1.0 : (${lv} > ${end} - ${margin} ? ((${lv} - ${end}) / ${margin} + 1.0) * 0.5 : 0.0)`);
  const wm = g.tmp('float', `1.0 - ${ws} - ${wh}`);
  const blend = (k: string) => g.tmp('float', `${ws} * ${g.in(`Shadows ${k}`, 'float')} + ${wm} * ${g.in(`Midtones ${k}`, 'float')} + ${wh} * ${g.in(`Highlights ${k}`, 'float')}`);
  const sat = g.tmp('float', `${blend('Saturation')} * ${g.in('Master Saturation', 'float')}`);
  const con = g.tmp('float', `${blend('Contrast')} * ${g.in('Master Contrast', 'float')}`);
  const gam = g.tmp('float', `${blend('Gamma')} * ${g.in('Master Gamma', 'float')}`);
  const gain = g.tmp('float', `${blend('Gain')} * ${g.in('Master Gain', 'float')}`);
  const off = g.tmp('float', `${blend('Offset')} + ${g.in('Master Offset', 'float')}`);
  const luma = g.tmp('float', `cmpLuma(${c}.rgb)`);
  const r = g.tmp('vec3', `vec3(${luma}) + ${sat} * (${c}.rgb - vec3(${luma}))`);
  g.stmt(`${r} = 0.5 + (${r} - 0.5) * ${con};`);
  g.stmt(`${r} = ${r} * ${gain} + ${off};`);
  g.stmt(`${r} = pow(max(${r}, vec3(0.0)), vec3(1.0 / max(${gam}, 1e-6)));`);
  // channels that are not positive are left untouched
  g.stmt(`${r} = mix(${c}.rgb, ${r}, step(vec3(1e-30), ${c}.rgb));`);
  const mask = g.tmp('float', g.in('Mask', 'float'));
  const apply = g.tmp('vec3', `vec3(${g.in('Apply On Red', 'float')} > 0.5 ? 1.0 : 0.0, ${g.in('Apply On Green', 'float')} > 0.5 ? 1.0 : 0.0, ${g.in('Apply On Blue', 'float')} > 0.5 ? 1.0 : 0.0)`);
  g.out('Image', 'vec4', `vec4(mix(${c}.rgb, ${r}, ${apply} * ${mask}), ${c}.a)`);
});

// register the generator-driven nodes as executable nodes
for (const id of [
  'CompositorNodeBrightContrast',
  'CompositorNodeExposure',
  'CompositorNodeInvert',
  'CompositorNodeHueSat',
  'CompositorNodeColorBalance',
  'CompositorNodeAlphaOver',
  'CompositorNodeSetAlpha',
  'CompositorNodePremulKey',
  'CompositorNodeSeparateColor',
  'CompositorNodeCombineColor',
  'CompositorNodeRGBToBW',
  'CompositorNodePosterize',
  'CompositorNodeCurveRGB',
  'CompositorNodeColorCorrection',
  'ShaderNodeMix',
  // shared shader nodes evaluated through their shader generators
  'ShaderNodeMath',
  'ShaderNodeMapRange',
  'ShaderNodeClamp',
  'ShaderNodeValToRGB',
  'ShaderNodeFloatCurve',
  'ShaderNodeGamma',
  'ShaderNodeBlackbody',
  'ShaderNodeCombineXYZ',
  'ShaderNodeSeparateXYZ',
  'ShaderNodeVectorMath',
  'ShaderNodeVectorCurve',
  'ShaderNodeVectorRotate',
]) {
  registerExec(id, (x) => {
    const gen = pixelGeneratorFor(id);
    if (!gen) throw new Error(`No pixel generator for ${id}`);
    runPixelNode(x, gen);
  });
}
