// @vitest-environment happy-dom
// Compositor nodes of the shader/compositor parity round: colour space conversions, Hue Correct
// and Image Info math against expected values (tests/fixtures/shcomp/compositor-expected.json),
// node registration and the Add menu.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import '../../src/compositor/nodes/defs';
import '../../src/compositor/nodes/extra';
import { convertColorSpace, COLOR_SPACES, conversionMatrix, hueCorrect, defaultHueCurves, hueCurveEval } from '../../src/compositor/color/colorspace';
import { domainInfo } from '../../src/compositor/ops/info';
import { COMPOSITOR_MENU } from '../../src/compositor/nodes/defs';
import { getNodeType, nodeSockets } from '../../src/nodes/registry';
import { addNode } from '../../src/nodes/tree';
import { readCurve } from '../../src/nodes/curves';
import { rgbToHsv } from '../../src/compositor/color/colorops';

interface Case {
  W: number;
  H: number;
  combined?: number[][];
  nodes: Record<string, { type: string; inputs?: Record<string, unknown>; props?: Record<string, string>; curve?: Record<string, number[][]> }>;
  expected: number[][];
}
const cases = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/shcomp/compositor-expected.json'), 'utf8')).cases as Record<string, Case>;

describe('Convert Colorspace', () => {
  it('converts between the supported spaces like the expected values', () => {
    let checked = 0;
    for (const [name, c] of Object.entries(cases)) {
      if (!name.startsWith('cs_')) continue;
      const p = c.nodes.X.props!;
      if (!COLOR_SPACES[p.from_color_space] || !COLOR_SPACES[p.to_color_space]) continue;
      c.combined!.forEach((px, i) => {
        const got = convertColorSpace(px, p.from_color_space, p.to_color_space);
        for (let ch = 0; ch < 4; ch++) expect(Math.abs(got[ch] - c.expected[i][ch]), `${name} pixel ${i}`).toBeLessThan(1e-3);
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(12);
  });
  it('builds inverse matrices for round trips', () => {
    const a = conversionMatrix('scene_linear', 'ACEScg'),
      b = conversionMatrix('ACEScg', 'scene_linear');
    const v = [0.3, 0.6, 0.1];
    const t = [0, 1, 2].map((r) => a[r * 3] * v[0] + a[r * 3 + 1] * v[1] + a[r * 3 + 2] * v[2]);
    const back = [0, 1, 2].map((r) => b[r * 3] * t[0] + b[r * 3 + 1] * t[1] + b[r * 3 + 2] * t[2]);
    back.forEach((x, i) => expect(x).toBeCloseTo(v[i], 6));
    expect(convertColorSpace([0.2, 0.3, 0.4, 1], 'sRGB', 'sRGB')).toEqual([0.2, 0.3, 0.4, 1]);
  });
});

describe('Hue Correct', () => {
  const props = (c: Case) => {
    const p = defaultHueCurves();
    for (const [ci, pts] of Object.entries(c.nodes.X.curve ?? {})) p[`curve_${ci}`] = pts.flatMap((q) => [q[0], q[1], 0]);
    return p;
  };
  it('shifts hue, scales saturation and value, and mixes by the factor like the expected values', () => {
    for (const name of ['hc_default', 'hc_h', 'hc_s', 'hc_v', 'hc_sfac']) {
      const c = cases[name];
      const fac = (c.nodes.X.inputs?.Fac as number | undefined) ?? 1;
      c.combined!.forEach((px, i) => {
        const got = hueCorrect(props(c), px, fac);
        for (let ch = 0; ch < 4; ch++) expect(Math.abs(got[ch] - c.expected[i][ch]), `${name} pixel ${i} channel ${ch}`).toBeLessThan(2e-3);
      });
    }
  });
  it('evaluates the curves periodically around the hue circle', () => {
    const c = cases.hc_bump;
    const pts = readCurve(props(c), 0);
    for (let i = 0; i < c.combined!.length; i++) {
      const px = c.combined![i];
      const [h, s] = rgbToHsv(px[0], px[1], px[2]);
      if (s < 0.05) continue;
      const [he] = rgbToHsv(c.expected[i][0], c.expected[i][1], c.expected[i][2]);
      const want = (((he - h + 1.5) % 1) + 1) % 1;
      expect(Math.abs(hueCurveEval(pts, h) - want), `hue ${h}`).toBeLessThan(0.025);
    }
    // continuity across the wrap point
    expect(hueCurveEval(pts, 0.999)).toBeCloseTo(hueCurveEval(pts, 0.001), 1);
  });
});

describe('Image Info', () => {
  it('reports dimensions, resolution and transform of a transformed image', () => {
    const i = domainInfo({ w: 8, h: 4, xf: [2 * Math.cos(0.5), 2 * Math.sin(0.5), -2 * Math.sin(0.5), 2 * Math.cos(0.5), 3, -2] });
    expect(i.dimensions).toEqual([cases.info_Dimensions.expected[0][0], cases.info_Dimensions.expected[0][1]]);
    expect(i.resolution).toEqual([8, 4]);
    expect(i.location).toEqual([3, -2]);
    expect(i.rotation).toBeCloseTo(0.5, 6);
    expect(i.scale[0]).toBeCloseTo(2, 6);
  });
});

describe('compositor registration', () => {
  it('lists every Add menu entry and registers the new node types', () => {
    const walk = (items: unknown[]): string[] =>
      items.flatMap((i) => (typeof i === 'string' ? [] : 'idname' in (i as object) ? [(i as { idname: string }).idname] : walk((i as { items: unknown[] }).items)));
    const ids = walk(COMPOSITOR_MENU);
    for (const id of [
      'CompositorNodeBlankImage',
      'CompositorNodeImageInfo',
      'CompositorNodeImageCoordinates',
      'CompositorNodeHueCorrect',
      'CompositorNodeConvertColorSpace',
      'CompositorNodeConvertToDisplay',
      'CompositorNodeConvolve',
      'CompositorNodeInpaint',
      'CompositorNodeMaskToSDF',
      'CompositorNodeDoubleEdgeMask',
      'CompositorNodeIDMask',
      'CompositorNodeKeying',
    ])
      expect(ids, id).toContain(id);
    const filter = COMPOSITOR_MENU.find((c) => c.label === 'Filter')!;
    const fids = walk(filter.items);
    expect(fids.indexOf('CompositorNodeMaskToSDF')).toBe(fids.indexOf('CompositorNodeDilateErode') + 1);
    expect(getNodeType('CompositorNodeGamma')?.idname).toBe('ShaderNodeGamma');
  });
  it('shows the kernel socket of the chosen kernel type', () => {
    const t = { type: 'COMPOSITOR' as const, nodes: [], links: [] };
    const n = addNode(t, 'CompositorNodeConvolve', [0, 0]);
    expect(nodeSockets(n).inputs.map((s) => s.identifier)).toEqual(['Image', 'Kernel Data Type', 'Float Kernel', 'Normalize Kernel']);
    n.inputs['Kernel Data Type'] = 'Color';
    expect(nodeSockets(n).inputs.map((s) => s.identifier)).toEqual(['Image', 'Kernel Data Type', 'Color Kernel', 'Normalize Kernel']);
  });
});

describe('Track Position', () => {
  it('reports absolute, relative and frame positions and speeds like the expected values', async () => {
    const { trackPosition } = await import('../../src/compositor/ops/clip');
    const { newMovieClip, newTrack, newMarker, insertMarker } = await import('../../src/tracking/types');
    const exp = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/shcomp/tracking-expected.json'), 'utf8'));
    const clip = newMovieClip('mc1', 'Clip', { size: [32, 16], frame_duration: 3 });
    const t = newTrack(clip.tracking, 'T1');
    clip.tracking.tracks.push(t);
    for (const [f, co] of [
      [1, [0.25, 0.5]],
      [2, [0.3, 0.55]],
      [3, [0.4, 0.5]],
    ] as [number, [number, number]][])
      insertMarker(t, newMarker(f, co, [32, 16], 4, 8));
    for (const [key, xy] of Object.entries(exp.trackpos as Record<string, [number, number]>)) {
      const [frame, mode] = key.split('_');
      const r = trackPosition(clip, 'T1', mode, Number(frame), 2);
      expect(r.x, key).toBeCloseTo(xy[0], 4);
      expect(r.y, key).toBeCloseTo(xy[1], 4);
    }
    for (const [frame, sp] of Object.entries(exp.speed as Record<string, number[]>)) {
      const r = trackPosition(clip, 'T1', 'Absolute', Number(frame), 0);
      r.speed.forEach((v, i) => expect(v, `speed ${frame}`).toBeCloseTo(sp[i], 4));
    }
    expect(trackPosition(clip, 'missing', 'Absolute', 1, 0)).toEqual({ x: 0, y: 0, speed: [0, 0, 0, 0] });
  });
});

describe('cryptomatte', () => {
  it('hashes names to the IDs other cryptomatte readers expect', async () => {
    const { cryptoId, cryptoHex, murmur3 } = await import('../../src/render/final/extrapasses');
    // values read back from cryptomatte passes rendered elsewhere for the default scene
    expect(cryptoId('Cube')).toBe(Math.fround(-2.8078405282815945e-14));
    expect(cryptoHex('Cube')).toBe('a8fce865');
    expect(cryptoId('Material')).toBe(Math.fround(0.00014031161845196038));
    expect(cryptoHex('Material')).toBe('3913209d');
    expect(murmur3('')).toBe(0);
    expect(Number.isFinite(cryptoId('ünïcödé name'))).toBe(true);
  });
  it('ranks IDs by coverage and sums the coverage of picked names', async () => {
    const { rankCoverage } = await import('../../src/render/final/extrapasses');
    const { cryptoMatte, matteNames } = await import('../../src/compositor/ops/crypto');
    // one pixel, four samples: id 5 three times, id 7 once
    const s = (id: number) => new Float32Array([id, 0, 0, 1]);
    const layers = rankCoverage([s(5), s(7), s(5), s(5)], 0, 1, 4);
    expect(layers.length).toBe(2);
    expect(Array.from(layers[0])).toEqual([5, 0.75, 7, 0.25]);
    expect(cryptoMatte([Array.from(layers[0]), Array.from(layers[1])], [7])).toBe(0.25);
    expect(cryptoMatte([Array.from(layers[0])], [5, 7])).toBe(1);
    expect(matteNames('Cube, "Sphere, big", Plane')).toEqual(['Cube', 'Sphere, big', 'Plane']);
    expect(matteNames('')).toEqual([]);
  });
});
