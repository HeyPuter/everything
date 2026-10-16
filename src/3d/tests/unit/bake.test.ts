import { describe, it, expect } from 'vitest';
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import { ShaderLib } from 'three';
import { swizzle, toTangentSpace, toObjectSpace, encodeUnit, extendMargin, adjacentFacesMargin, seamEdges, composite, storeBytes, newBuffer, BAKED, MARGIN, EMPTY } from '../../src/bake/encode';
import { contributions, contributionProblem, defaultBakeSettings, bakeSettings, passFilterOf } from '../../src/bake/settings';
import { planTargets, bakeImageNode } from '../../src/bake/targets';
import { patchBakeTracingShader } from '../../src/bake/tracer';
import { patchBakeShader } from '../../src/bake/raster';
import { startupDocument } from '../../src/data/defaults';
import type { DocumentData, NodeData } from '../../src/data/types';

describe('normal encoding', () => {
  it('a flat surface in tangent space is (0.5, 0.5, 1)', () => {
    const c = encodeUnit(swizzle(toTangentSpace([0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]), 'POS_X', 'POS_Y', 'POS_Z'));
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(1);
  });
  it('inverts a non-orthogonal tangent frame', () => {
    const T = [1, 0, 0],
      B = [Math.SQRT1_2, Math.SQRT1_2, 0],
      N = [0, 0, 1];
    // decode as the shading nodes do: normalize(T x + B y + N z)
    const c = [0.3, -0.2, 0.9];
    const w = [0, 1, 2].map((i) => T[i] * c[0] + B[i] * c[1] + N[i] * c[2]);
    const back = toTangentSpace(w, T, B, N);
    const l = Math.hypot(...c);
    back.forEach((v, i) => expect(v).toBeCloseTo(c[i] / l, 5));
  });
  it('swizzles and flips channels', () => {
    expect(swizzle([0.1, 0.2, 0.3], 'NEG_Y', 'POS_Z', 'NEG_X')).toEqual([-0.2, 0.3, -0.1]);
  });
  it('object space undoes the object rotation', () => {
    // object rotated 90° about Z: its local +X points along world +Y
    const m = [0, 1, 0, -1, 0, 0, 0, 0, 1];
    const c = toObjectSpace([0, 1, 0], m);
    expect(c[0]).toBeCloseTo(1);
    expect(c[1]).toBeCloseTo(0);
  });
});

describe('margins', () => {
  const island = () => {
    // 8×8 image, baked 2×2 block in the middle with value 1
    const b = newBuffer(8, 8);
    for (const [x, y] of [
      [3, 3],
      [4, 3],
      [3, 4],
      [4, 4],
    ]) {
      const i = y * 8 + x;
      b.mask[i] = BAKED;
      b.data.set([1, 0.5, 0.25, 1], i * 4);
    }
    return b;
  };
  it('extend grows the island by the margin size only', () => {
    const b = island();
    extendMargin(b, 1);
    expect(b.mask[2 * 8 + 2]).toBe(MARGIN);
    expect(b.mask[1 * 8 + 1]).toBe(EMPTY);
    expect(Array.from(b.data.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4))).toEqual([1, 0.5, 0.25, 1]);
    const c = island();
    extendMargin(c, 2);
    expect(c.mask[1 * 8 + 1]).toBe(MARGIN);
    expect(c.mask[0]).toBe(EMPTY);
  });
  it('adjacent faces continue across a seam into the neighbouring face', () => {
    // two faces sharing the vertical edge v1–v2 on the mesh, laid out apart in UV space
    // face A covers u 0..0.25 (left island), face B covers u 0.5..0.75 (right island)
    const mesh = {
      offsets: [0, 4, 8],
      indices: [0, 1, 2, 3, 1, 4, 5, 2],
      uvs: [0, 0, 0.25, 0, 0.25, 1, 0, 1, /* B */ 0.5, 0, 0.75, 0, 0.75, 1, 0.5, 1],
    };
    const W = 16,
      H = 4;
    const b = newBuffer(W, H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const i = y * W + x;
        if (u < 0.25) (b.mask[i] = BAKED), b.data.set([0.2, 0.2, 0.2, 1], i * 4);
        else if (u > 0.5 && u < 0.75) (b.mask[i] = BAKED), b.data.set([u, 0, 0, 1], i * 4);
      }
    const edges = seamEdges(mesh, W, H, () => true);
    // the shared edge is a seam seen from both faces; the other edges are open borders
    expect(edges.filter((e) => e.across).length).toBe(2);
    adjacentFacesMargin(b, 2, edges);
    // right of face A's seam edge (u = 0.25) continues into face B just right of u = 0.5
    const r = b.data[(1 * W + 4) * 4];
    expect(b.mask[1 * W + 4]).toBe(MARGIN);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(0.6);
  });
});

describe('storing', () => {
  it('composites by priority and keeps or clears the rest', () => {
    const a = newBuffer(2, 1),
      b = newBuffer(2, 1);
    a.mask[0] = MARGIN;
    a.data.set([0.1, 0.1, 0.1, 1], 0);
    b.mask[0] = BAKED;
    b.data.set([1, 1, 1, 1], 0);
    composite(a, b);
    expect(a.data[0]).toBe(1);
    const prev = new Uint8ClampedArray([9, 9, 9, 9, 7, 7, 7, 7]);
    expect(Array.from(storeBytes(a, prev, { srgb: false, clear: null }))).toEqual([255, 255, 255, 255, 7, 7, 7, 7]);
    expect(Array.from(storeBytes(a, prev, { srgb: false, clear: [0.5, 0.5, 1, 1] })).slice(4)).toEqual([128, 128, 255, 255]);
    // sRGB images store display-encoded values
    const g = newBuffer(1, 1);
    g.mask[0] = BAKED;
    g.data.set([0.2159, 0.2159, 0.2159, 1], 0);
    expect(storeBytes(g, null, { srgb: true, clear: null })[0]).toBe(128);
  });
});

describe('bake settings', () => {
  it('pass filters and their problems', () => {
    const b = defaultBakeSettings();
    expect(passFilterOf(b)).toEqual(['EMIT', 'DIRECT', 'INDIRECT', 'COLOR', 'DIFFUSE', 'GLOSSY', 'TRANSMISSION']);
    const c = contributions(['COLOR'], b);
    expect(c).toMatchObject({ color: true, direct: false, indirect: false });
    expect(contributionProblem('DIFFUSE', c)).toBeNull();
    expect(contributionProblem('DIFFUSE', contributions(['EMIT'], b))).toMatch(/Direct, Indirect or Color/);
    expect(contributionProblem('COMBINED', contributions(['DIRECT'], b))).toMatch(/Combined/);
    expect(contributionProblem('COMBINED', contributions(['EMIT'], b))).toBeNull();
  });
  it('fills missing fields of older files', () => {
    const r = { bake: { margin: 3 } } as never;
    const b = bakeSettings(r);
    expect(b.margin).toBe(3);
    expect(b.normal_g).toBe('POS_Y');
  });
});

function docWithImageNode(active: boolean): { doc: DocumentData; node: NodeData } {
  const doc = startupDocument();
  const cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
  const me = doc.meshes[cube.data!];
  const ma = doc.materials[me.materials[0]!];
  doc.images.im1 = { id: 'im1', name: 'Bake', mime: 'image/png', bytes: null, width: 8, height: 8, source: 'GENERATED', colorspace: 'sRGB' };
  const node: NodeData = { id: 'n_img', type: 'ShaderNodeTexImage', name: 'Image Texture', location: [0, 0], inputs: {}, props: { image: 'im1' } };
  ma.tree.nodes.push(node);
  if (active) ma.tree.active_node = node.id;
  return { doc, node };
}

describe('bake targets', () => {
  it('uses the active Image Texture node, or the only unconnected one', () => {
    const { doc } = docWithImageNode(true);
    const cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
    const plan = planTargets(doc, [cube], 'IMAGE_TEXTURES');
    expect(plan.errors).toEqual([]);
    expect(plan.targets).toEqual([expect.objectContaining({ kind: 'IMAGE', image: 'im1', slots: [0] })]);
    const loose = docWithImageNode(false);
    const ma = loose.doc.materials[Object.values(loose.doc.meshes)[0].materials[0]!];
    expect(bakeImageNode(loose.doc, ma)?.id).toBe('n_img');
  });
  it('explains what is missing', () => {
    const doc = startupDocument();
    const cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
    expect(planTargets(doc, [cube], 'IMAGE_TEXTURES').errors[0]).toMatch(/no Image Texture node/);
    expect(planTargets(doc, [cube], 'VERTEX_COLORS').errors[0]).toMatch(/no color attribute/);
  });
});

describe('bake shaders', () => {
  it('the path tracer gains per-texel rays and first-hit outputs', () => {
    const src = patchBakeTracingShader(new PhysicalPathTracingMaterial().fragmentShader);
    expect(src).toBeTruthy();
    expect(src).toContain('bakeCameraRay()');
    expect(src).toContain('bakeOverrideLobe( surf )');
    expect(src).not.toContain('gl_FragColor.rgb += ptClamp(');
    // one extra texture unit only (the rays)
    expect((src!.match(/uniform sampler2D bake/g) ?? []).length).toBe(1);
  });
  it('material shaders draw in UV space and output the requested channel', () => {
    const p = patchBakeShader(ShaderLib.physical.vertexShader, ShaderLib.physical.fragmentShader, 'ROUGHNESS');
    expect(p.vertex).toContain('gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);');
    expect(p.fragment).toContain('vec3(roughnessFactor)');
    expect(p.fragment).not.toContain('gl_FrontFacing');
  });
});
