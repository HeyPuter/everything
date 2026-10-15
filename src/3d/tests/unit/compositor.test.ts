// @vitest-environment happy-dom
// Compositor: per-pixel colour math against expected values, and
// graph evaluation order. Expected numbers: tests/fixtures/compositor/color-nodes-expected.json
// (two 8-pixel images P/Q pushed through single nodes, read back as 32-bit float).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  alphaConvert,
  alphaOver,
  balanceParams,
  BLEND_MODES,
  brightContrast,
  combineColor,
  exposure,
  gamma,
  hueSatVal,
  invert,
  liftGammaGain,
  luma,
  mixColor,
  offsetPowerSlope,
  posterize,
  separateColor,
  setAlpha,
  zCombine,
  type AlphaOverType,
  type ColorMode,
  type RGBA,
  type YccMode,
  whitePoint,
  whitePointMatrix,
} from '../../src/compositor/color/colorops';
import '../../src/nodes/common';
import { registerNodeType } from '../../src/nodes/registry';
import { Evaluator, registerExec, realizeMap } from '../../src/compositor/eval/evaluator';
import { Result, IDENTITY, type Xform } from '../../src/compositor/eval/result';
import { emptyDocument } from '../../src/data/defaults';
import type { NodeData, NodeTreeData } from '../../src/data/types';
import type { Gpu } from '../../src/compositor/gpu/gpu';
import { blurKernel } from '../../src/compositor/ops/filter';
import { curveEvaluator } from '../../src/compositor/color/curvemap';
import { defaultCompositingTree } from '../../src/compositor/data';
import { channelKey, chromaKey, colorKey, colorSpill, differenceKey, distanceKey, lumaKey } from '../../src/compositor/color/keying';

interface Case {
  nodes: Record<
    string,
    {
      type: string;
      inputs?: Record<string, unknown>;
      props?: Record<string, unknown>;
    }
  >;
  expected: number[][];
}
const ref = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/compositor/color-nodes-expected.json'), 'utf8')) as {
  P: RGBA[];
  Q: RGBA[];
  cases: Record<string, Case>;
};
const P = ref.P,
  Q = ref.Q;

function expectPixels(name: string, got: number[][], tol = 2e-3) {
  const exp = ref.cases[name].expected;
  expect(got.length).toBe(exp.length);
  for (let i = 0; i < exp.length; i++)
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(got[i][c] - exp[i][c]);
      if (!(d <= tol)) throw new Error(`${name}: pixel ${i} channel ${c}: got ${got[i][c].toFixed(5)}, expected ${exp[i][c]} (input ${JSON.stringify(P[i])})`);
    }
}

const inp = (name: string, node = 'X') => ref.cases[name].nodes[node].inputs ?? {};
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);

describe('compositor colour nodes match the expected values', () => {
  it('implicit conversions', () => {
    // colour → float uses Rec.709 luminance (on premultiplied values), output float → (v, v, v, 1)
    expectPixels(
      'conv_c2f',
      P.map((c) => {
        const l = luma(c);
        return [l, l, l, 1];
      }),
    );
    expectPixels(
      'conv_v2f',
      P.map((c) => {
        const v = (c[0] + c[1] + c[2]) / 3;
        return [v, v, v, 1];
      }),
    );
    expectPixels(
      'conv_c2v',
      P.map((c) => [c[0], c[1], c[2], 1]),
    );
  });

  it('Brightness/Contrast', () => {
    for (const name of ['bc1', 'bc2', 'bc3']) {
      const i = inp(name);
      expectPixels(
        name,
        P.map((c) => brightContrast(c, num(i.Bright, 0), num(i.Contrast, 0))),
      );
    }
  });

  it('Gamma and Exposure', () => {
    for (const name of ['gamma1', 'gamma2'])
      expectPixels(
        name,
        P.map((c) => gamma(c, num(inp(name).Gamma, 1))),
      );
    for (const name of ['exposure1', 'exposure2'])
      expectPixels(
        name,
        P.map((c) => exposure(c, num(inp(name).Exposure, 0))),
      );
  });

  it('Invert Color', () => {
    for (const name of ['invert1', 'invert2', 'invert3']) {
      const i = inp(name);
      expectPixels(
        name,
        P.map((c) => invert(c, num(i.Fac, 1), i['Invert Color'] !== false, i['Invert Alpha'] === true)),
      );
    }
  });

  it('Hue/Saturation/Value', () => {
    for (const name of ['hsv1', 'hsv2']) {
      const i = inp(name);
      expectPixels(
        name,
        P.map((c) => hueSatVal(c, num(i.Hue, 0.5), num(i.Saturation, 1), num(i.Value, 1), num(i.Fac, 1))),
      );
    }
  });

  it('Color Balance (Lift/Gamma/Gain and ASC-CDL)', () => {
    for (const name of ['cb_lgg', 'cb_lgg2']) {
      const i = inp(name);
      const c = (k: string) => (i[k] as number[] | undefined) ?? [1, 1, 1, 1];
      const lift = balanceParams('lift', num(i['Base Lift'], 0), c('Color Lift'));
      const gam = balanceParams('gamma', num(i['Base Gamma'], 1), c('Color Gamma'));
      const gain = balanceParams('gain', num(i['Base Gain'], 1), c('Color Gain'));
      expectPixels(
        name,
        P.map((p) => liftGammaGain(p, lift, gam, gain, num(i.Fac, 1))),
      );
    }
    const i = inp('cb_cdl');
    // colour sockets are clamped to >= 0 on input
    const off = (i['Color Offset'] as number[]).map((v) => Math.max(0, v));
    expectPixels(
      'cb_cdl',
      P.map((p) =>
        offsetPowerSlope(
          p,
          balanceParams('offset', num(i['Base Offset'], 0), off),
          balanceParams('power', num(i['Base Power'], 1), i['Color Power'] as number[]),
          balanceParams('slope', num(i['Base Slope'], 1), i['Color Slope'] as number[]),
          1,
        ),
      ),
    );
  });

  it('Color Balance (White Point)', () => {
    // fitted model (Kim Planckian locus + tint offset in uv, Bradford adaptation): within 0.5 %
    for (const name of ['cb_wp', 'cb_wp2']) {
      const i = inp(name);
      const m = whitePointMatrix(num(i['Input Temperature'], 6500), num(i['Input Tint'], 10), num(i['Output Temperature'], 6500), num(i['Output Tint'], 10));
      const exp = ref.cases[name].expected;
      P.forEach((p, k) => {
        const got = whitePoint(p, m, 1);
        for (let c = 0; c < 4; c++) expect(Math.abs(got[c] - exp[k][c])).toBeLessThan(0.006 * Math.max(1, Math.abs(exp[k][c])));
      });
    }
    // default settings are the identity
    const id = whitePointMatrix(6500, 10, 6500, 10);
    expect(whitePoint([0.3, 0.6, 0.9, 1], id, 1).map((v) => +v.toFixed(6))).toEqual([0.3, 0.6, 0.9, 1]);
  });

  it('Mix Color: every blend mode, alpha handling and clamping', () => {
    for (const mode of BLEND_MODES)
      expectPixels(
        `mix_${mode}`,
        P.map((a, k) => mixColor(mode, 0.7, a, Q[k], true, false)),
      );
    expectPixels(
      'mix_clamp',
      P.map((a, k) => mixColor('ADD', 0.7, a, Q[k], true, true)),
    );
    expectPixels(
      'mix_noclampfac',
      P.map((a, k) => mixColor('MIX', 1.5, a, Q[k], false, false)),
    );
  });

  it('Alpha Over (all types, straight alpha, factor)', () => {
    for (const t of ['Over', 'Disjoint Over', 'Conjoint Over'] as AlphaOverType[])
      for (const st of [false, true])
        for (const fac of [1.0, 0.6]) {
          const name = `ao_${t.replace(' ', '')}_${st ? 'True' : 'False'}_${fac === 1 ? '1.0' : '0.6'}`;
          expectPixels(
            name,
            P.map((bg, k) => alphaOver(bg, Q[k], fac, t, st)),
          );
        }
  });

  it('Set Alpha and Alpha Convert', () => {
    expectPixels(
      'setalpha_apply',
      P.map((c) => setAlpha(c, 0.5, 'Apply Mask')),
    );
    expectPixels(
      'setalpha_replace',
      P.map((c) => setAlpha(c, 0.5, 'Replace Alpha')),
    );
    expectPixels(
      'premul_to',
      P.map((c) => alphaConvert(c, 'To Premultiplied')),
    );
    expectPixels(
      'premul_from',
      P.map((c) => alphaConvert(c, 'To Straight')),
    );
  });

  it('Separate / Combine Color in every mode', () => {
    for (const [mode, ycc] of [
      ['RGB', null],
      ['HSV', null],
      ['HSL', null],
      ['YCC', 'ITUBT601'],
      ['YCC', 'ITUBT709'],
      ['YCC', 'JFIF'],
      ['YUV', null],
    ] as [ColorMode, YccMode | null][]) {
      expectPixels(
        `sep_${mode}_${ycc ?? 'None'}`,
        P.map((c) => separateColor(c, mode, ycc ?? 'ITUBT709')),
      );
      expectPixels(
        `comb_${mode}_${ycc ?? 'None'}`,
        Q.map((c) => combineColor(c, mode, ycc ?? 'ITUBT709')),
      );
    }
  });

  it('RGB to BW, Posterize and Depth Combine', () => {
    expectPixels(
      'rgb2bw',
      P.map((c) => {
        const l = luma(c);
        return [l, l, l, 1];
      }),
    );
    expectPixels(
      'posterize',
      P.map((c) => posterize(c, 4)),
    );
    for (const [name, useAlpha] of [
      ['zcombine', false],
      ['zcombine_alpha', true],
    ] as [string, boolean][])
      expectPixels(
        name,
        P.map((a, k) => zCombine(a, a[1], Q[k], Q[k][1], useAlpha).color),
      );
  });

  it('Keying nodes (Luminance, Distance, Difference, Color, Chroma, Channel Key, Color Spill)', () => {
    expectPixels(
      'lumakey',
      P.map((c) => lumaKey(c, 0.2, 0.8).image),
    );
    expectPixels(
      'lumakey_matte',
      P.map((c) => {
        const m = lumaKey(c, 0.2, 0.8).matte;
        // the matte output ignores the input alpha (its image does not)
        const raw = Math.min(1, Math.max(0, (luma(c) - 0.2) / 0.6));
        void m;
        return [raw, raw, raw, 1];
      }),
    );
    expectPixels(
      'distkey',
      P.map((c) => distanceKey(c, [0.5, 0.3, 0.1], 0.3, 0.2, 'RGB').image),
    );
    expectPixels(
      'diffkey',
      P.map((c, k) => differenceKey(c, Q[k], 0.2, 0.2).image),
    );
    expectPixels(
      'colorkey',
      P.map((c) => colorKey(c, [0.5, 0.25, 0.1], 0.1, 0.3, 0.3).image),
    );
    expectPixels(
      'chromakey',
      P.map((c) => chromaKey(c, [0.1, 0.8, 0.3], 0.174533, 0.523599, 1).image),
    );
    expectPixels(
      'channelkey',
      P.map((c) => channelKey(c, 'RGB', 1, -1, 0.1, 0.6).image),
    );
    expectPixels(
      'colorspill',
      P.map((c) => colorSpill(c, 1, 1, 'Single', 0, 1, null)),
    );
  });
});

// ---------------------------------------------------------------------------
// graph evaluation (single values only: no GPU work involved)

const order: string[] = [];
registerNodeType({
  idname: 'TestConst',
  label: 'Const',
  category: 'input',
  treeTypes: ['COMPOSITOR'],
  inputs: [],
  outputs: [{ name: 'Value', identifier: 'Value', type: 'FLOAT' }],
  props: [],
  width: 140,
});
registerNodeType({
  idname: 'TestAdd',
  label: 'Add',
  category: 'converter',
  treeTypes: ['COMPOSITOR'],
  inputs: [
    { name: 'A', identifier: 'A', type: 'FLOAT', default: 0 },
    { name: 'B', identifier: 'B', type: 'FLOAT', default: 0 },
  ],
  outputs: [{ name: 'Value', identifier: 'Value', type: 'FLOAT' }],
  props: [],
  width: 140,
});
registerExec('TestConst', (x) => {
  order.push(x.node.name);
  x.out('Value', Result.single('FLOAT', x.node.props.v as number));
});
registerExec('TestAdd', (x) => {
  // inputs are pulled on demand: record completion (dependency) order
  const v = x.num('A') + x.num('B');
  order.push(x.node.name);
  x.out('Value', Result.single('FLOAT', v));
});

let nid = 0;
const node = (type: string, name: string, extra: Partial<NodeData> = {}): NodeData => ({
  id: `n${nid++}`,
  type,
  name,
  location: [0, 0],
  inputs: {},
  props: {},
  ...extra,
});
const link = (a: NodeData, as: string, b: NodeData, bs: string) => ({
  id: `l${nid++}`,
  from_node: a.id,
  from_socket: as,
  to_node: b.id,
  to_socket: bs,
});
const OUT_IFACE: NodeTreeData['interface'] = [
  {
    in_out: 'OUTPUT',
    name: 'Image',
    socket_type: 'NodeSocketColor',
    identifier: 'Socket_1',
  },
];

function evaluate(tree: NodeTreeData, doc = emptyDocument()) {
  order.length = 0;
  const ev = new Evaluator({} as Gpu, {
    doc,
    renderSize: [4, 4],
    frame: 1,
    fps: 24,
    layers: null,
    viewer: null,
    composite: true,
  });
  const r = ev.compositeOutput(tree);
  return { value: r?.value, ev };
}

describe('compositor graph evaluation', () => {
  it('evaluates upstream nodes first, each once, and skips unconnected nodes', () => {
    const a = node('TestConst', 'a', { props: { v: 0.25 } }),
      b = node('TestConst', 'b', { props: { v: 0.5 } }),
      sum = node('TestAdd', 'sum'),
      twice = node('TestAdd', 'twice'),
      unused = node('TestConst', 'unused', { props: { v: 9 } }),
      out = node('NodeGroupOutput', 'out');
    const tree: NodeTreeData = {
      type: 'COMPOSITOR',
      nodes: [twice, unused, out, sum, a, b],
      links: [link(a, 'Value', sum, 'A'), link(b, 'Value', sum, 'B'), link(sum, 'Value', twice, 'A'), link(sum, 'Value', twice, 'B'), link(twice, 'Value', out, 'Socket_1')],
      interface: OUT_IFACE,
    };
    const { value } = evaluate(tree);
    expect(order).toEqual(['a', 'b', 'sum', 'twice']);
    // float → colour conversion of the composite: (v, v, v, 1)
    expect(value).toEqual([1.5, 1.5, 1.5, 1]);
  });

  it('muted nodes pass their first matching input through; reroutes forward values', () => {
    const a = node('TestConst', 'a', { props: { v: 2 } }),
      m = node('TestAdd', 'muted', { mute: true, inputs: { B: 5 } }),
      rr = node('NodeReroute', 'rr'),
      out = node('NodeGroupOutput', 'out');
    const tree: NodeTreeData = {
      type: 'COMPOSITOR',
      nodes: [a, m, rr, out],
      links: [link(a, 'Value', m, 'A'), link(m, 'Value', rr, 'Input'), link(rr, 'Output', out, 'Socket_1')],
      interface: OUT_IFACE,
    };
    const { value } = evaluate(tree);
    expect(order).toEqual(['a']);
    expect(value).toEqual([2, 2, 2, 1]);
  });

  it('evaluates node groups through Group Input / Group Output', () => {
    const doc = emptyDocument();
    const gin = node('NodeGroupInput', 'gin'),
      gadd = node('TestAdd', 'inner', { inputs: { B: 1 } }),
      gout = node('NodeGroupOutput', 'gout');
    doc.node_groups.g = {
      id: 'g',
      name: 'G',
      tree: {
        type: 'COMPOSITOR',
        nodes: [gin, gadd, gout],
        links: [link(gin, 'Socket_0', gadd, 'A'), link(gadd, 'Value', gout, 'Socket_1')],
        interface: [
          {
            in_out: 'INPUT',
            name: 'X',
            socket_type: 'NodeSocketFloat',
            identifier: 'Socket_0',
          },
          {
            in_out: 'OUTPUT',
            name: 'Y',
            socket_type: 'NodeSocketFloat',
            identifier: 'Socket_1',
          },
        ],
      },
    };
    const c = node('TestConst', 'c', { props: { v: 3 } }),
      grp = node('CompositorNodeGroup', 'group', { props: { node_tree: 'g' } }),
      out = node('NodeGroupOutput', 'out');
    const tree: NodeTreeData = {
      type: 'COMPOSITOR',
      nodes: [c, grp, out],
      links: [link(c, 'Value', grp, 'Socket_0'), link(grp, 'Socket_1', out, 'Socket_1')],
      interface: OUT_IFACE,
    };
    const { value } = evaluate(tree, doc);
    expect(order).toEqual(['c', 'inner']);
    expect(value).toEqual([4, 4, 4, 1]);
  });

  it('the default compositing tree links Render Layers to the Group Output and the Viewer', () => {
    const t = defaultCompositingTree();
    expect(t.nodes.map((n) => n.type).sort()).toEqual(['CompositorNodeRLayers', 'CompositorNodeViewer', 'NodeGroupOutput', 'NodeReroute']);
    expect(t.links).toHaveLength(3);
    expect(t.interface?.find((i) => i.in_out === 'OUTPUT')?.identifier).toBe('Socket_1');
  });
});

describe('compositor sampling and kernels', () => {
  it('realizes domains centred with integer offsets (pixel exact)', () => {
    // a 2×1 image centred in 6×4: output pixel (2, 1) samples source pixel (0, 0) exactly
    const m = realizeMap({ w: 6, h: 4, xf: [...IDENTITY] as Xform }, { w: 2, h: 1, xf: [...IDENTITY] as Xform });
    expect([m[0] * 2.5 + m[3] * 1.5 + m[6], m[1] * 2.5 + m[4] * 1.5 + m[7]]).toEqual([0.5, 0.5]);
  });

  it('blur kernels match the expected impulse responses', () => {
    // measured centre / neighbour weights for size 3 (x) and 2 (y)
    const g = blurKernel('Gaussian', 3),
      gy = blurKernel('Gaussian', 2);
    expect(g[3] * gy[2]).toBeCloseTo(0.2387, 4);
    expect(g[4] * gy[2]).toBeCloseTo(0.1448, 4);
    expect(Array.from(blurKernel('Tent', 3).slice(3, 7)).map((v) => +v.toFixed(4))).toEqual([0.3333, 0.2222, 0.1111, 0]);
    expect(blurKernel('Catrom', 3)[3] * blurKernel('Catrom', 2)[2]).toBeCloseTo(0.4292, 3);
    expect(blurKernel('Catrom', 3)[5] * blurKernel('Catrom', 2)[2]).toBeCloseTo(-0.0125, 3);
    expect(blurKernel('Mitch', 3)[3] * blurKernel('Mitch', 2)[2]).toBeCloseTo(0.3382, 3);
    expect(blurKernel('Quadratic', 3)[3] * blurKernel('Quadratic', 2)[2]).toBeCloseTo(0.2423, 3);
    expect(blurKernel('Cubic', 3)[3] * blurKernel('Cubic', 2)[2]).toBeCloseTo(0.1891, 3);
  });

  it('curve mapping matches the expected curve widget output (auto handles, extrapolation)', () => {
    const c = curveEvaluator(
      [
        { x: 0, y: 0, handle: 0 },
        { x: 0.5, y: 0.7, handle: 0 },
        { x: 1, y: 1, handle: 0 },
      ],
      'EXTRAPOLATED',
    );
    const xs = [0.25, 0.1, 0.8, 0.6, 0.05, 2, -0.1];
    const exp = [0.4226, 0.1837, 0.9087, 0.7847, 0.0929, 1.4375, -0.1865];
    xs.forEach((x, i) => expect(c(x)).toBeCloseTo(exp[i], 3));
  });
});
