import { describe, it, expect } from 'vitest';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import { getNodeType, nodeSockets, nodeTypes, nodeMenu, canConvert, interfaceSocketType, nodeLabel } from '../../src/nodes/registry';
import {
  addNode,
  connect,
  linkStatus,
  dissolveNodes,
  duplicateNodes,
  makeGroup,
  ungroup,
  makeLinks,
  joinInFrame,
  insertOnLink,
  toggleHiddenSockets,
  uniqueNodeName,
  activeOutput,
  ctxOf,
} from '../../src/nodes/tree';
import { compileTree, convert, literal } from '../../src/nodes/shader/codegen';
import { readRamp, evalRamp, bakeRamp, defaultRamp, evalCurve, readCurve, defaultCurves, bakeCurves, wavelengthToRgb, blackbodyToRgb, writeRamp } from '../../src/nodes/curves';
import { collectLib } from '../../src/nodes/shader/glsl/lib';
import { emptyDocument, newMaterial, newWorld } from '../../src/data/defaults';
import type { DocumentData, NodeTreeData } from '../../src/data/types';

function doc(): DocumentData {
  return emptyDocument();
}
function tree(): NodeTreeData {
  return { type: 'SHADER', nodes: [], links: [] };
}

describe('node registry', () => {
  it('has the expected socket names and defaults for the Principled BSDF', () => {
    const d = getNodeType('ShaderNodeBsdfPrincipled')!;
    expect(d.label).toBe('Principled BSDF');
    expect(d.width).toBe(240);
    const base = d.inputs.find((s) => s.identifier === 'Base Color')!;
    expect(base.type).toBe('RGBA');
    expect(base.default).toEqual([0.8, 0.8, 0.8, 1]);
    const rough = d.inputs.find((s) => s.identifier === 'Roughness')!;
    expect(rough.default).toBe(0.5);
    expect(rough.subtype).toBe('FACTOR');
    expect(d.outputs.map((s) => s.identifier)).toEqual(['BSDF']);
    expect(d.panels?.map((p) => p.name)).toContain('Subsurface');
  });
  it('resolves aliases and dynamic sockets', () => {
    expect(getNodeType('ShaderNodeBsdfGlossy')?.idname).toBe('ShaderNodeBsdfAnisotropic');
    const t = tree();
    const m = addNode(t, 'ShaderNodeMath', [0, 0]);
    expect(nodeSockets(m).inputs.map((s) => s.identifier)).toEqual(['Value', 'Value_001']);
    m.props.operation = 'MULTIPLY_ADD';
    const ins = nodeSockets(m).inputs;
    expect(ins.map((s) => s.label)).toEqual(['Value', 'Multiplier', 'Addend']);
    m.props.operation = 'SINE';
    expect(nodeSockets(m).inputs).toHaveLength(1);
    expect(nodeLabel(m)).toBe('Sine');
    const mix = addNode(t, 'ShaderNodeMix', [0, 0], { data_type: 'RGBA' });
    expect(nodeSockets(mix).inputs.map((s) => s.identifier)).toEqual(['Factor_Float', 'A_Color', 'B_Color']);
    const cc = addNode(t, 'ShaderNodeCombineColor', [0, 0], { mode: 'HSV' });
    expect(nodeSockets(cc).inputs.map((s) => s.label)).toEqual(['Hue', 'Saturation', 'Value']);
  });
  it('registers every add-menu entry', () => {
    const walk = (items: unknown[]): string[] =>
      items.flatMap((i) => (typeof i === 'string' ? [] : 'idname' in (i as object) ? [(i as { idname: string }).idname] : walk((i as { items: unknown[] }).items)));
    const ids = walk(nodeMenu('SHADER'));
    expect(ids.length).toBeGreaterThan(70);
    for (const id of ids) expect(nodeTypes[id], id).toBeDefined();
  });
  it('maps interface socket types and conversions', () => {
    expect(interfaceSocketType('NodeSocketFloatFactor')).toEqual({
      type: 'FLOAT',
      subtype: 'FACTOR',
    });
    expect(interfaceSocketType('NodeSocketColor').type).toBe('RGBA');
    expect(canConvert('RGBA', 'FLOAT')).toBe(true);
    expect(canConvert('SHADER', 'RGBA')).toBe(false);
    expect(canConvert('RGBA', 'SHADER')).toBe(true);
  });
});

describe('tree editing', () => {
  it('connects, replaces and rejects cycles', () => {
    const d = doc();
    const t = tree();
    const ctx = ctxOf(d, t);
    const a = addNode(t, 'ShaderNodeTexNoise', [0, 0]);
    const b = addNode(t, 'ShaderNodeBsdfPrincipled', [300, 0]);
    expect(connect(ctx, a.id, 'Color', b.id, 'Base Color')).not.toBeNull();
    expect(connect(ctx, a.id, 'Fac', b.id, 'Base Color')).not.toBeNull();
    expect(t.links).toHaveLength(1);
    expect(t.links[0].from_socket).toBe('Fac');
    const m = addNode(t, 'ShaderNodeMath', [0, 0]);
    connect(ctx, a.id, 'Fac', m.id, 'Value');
    expect(connect(ctx, m.id, 'Value', a.id, 'Scale')).toBeNull();
    // shader into color is invalid
    const e = addNode(t, 'ShaderNodeEmission', [0, 0]);
    expect(connect(ctx, b.id, 'BSDF', e.id, 'Color')).toBeNull();
    expect(uniqueNodeName(t, 'Math')).toBe('Math.001');
  });
  it('dissolves nodes keeping the data flow (Ctrl+X)', () => {
    const d = doc();
    const t = tree();
    const ctx = ctxOf(d, t);
    const a = addNode(t, 'ShaderNodeTexChecker', [0, 0]);
    const b = addNode(t, 'ShaderNodeInvert', [200, 0]);
    const c = addNode(t, 'ShaderNodeBsdfDiffuse', [400, 0]);
    connect(ctx, a.id, 'Color', b.id, 'Color');
    connect(ctx, b.id, 'Color', c.id, 'Color');
    dissolveNodes(ctx, new Set([b.id]));
    expect(t.nodes).toHaveLength(2);
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({
      from_node: a.id,
      from_socket: 'Color',
      to_node: c.id,
      to_socket: 'Color',
    });
  });
  it('duplicates nodes with internal links only', () => {
    const t = tree();
    const ctx = ctxOf(doc(), t);
    const a = addNode(t, 'ShaderNodeValue', [0, 0]);
    const b = addNode(t, 'ShaderNodeMath', [200, 0]);
    const c = addNode(t, 'ShaderNodeMath', [400, 0]);
    connect(ctx, a.id, 'Value', b.id, 'Value');
    connect(ctx, b.id, 'Value', c.id, 'Value');
    const map = duplicateNodes(t, new Set([b.id, c.id]), [0, -100]);
    expect(map.size).toBe(2);
    expect(t.links).toHaveLength(3);
    expect(map.get(b.id)!.name).toBe('Math.002');
  });
  it('makes and ungroups node groups', () => {
    const d = doc();
    const t = tree();
    const ctx = ctxOf(d, t);
    const tex = addNode(t, 'ShaderNodeTexNoise', [0, 0]);
    const ramp = addNode(t, 'ShaderNodeValToRGB', [200, 0]);
    const inv = addNode(t, 'ShaderNodeInvert', [400, 0]);
    const bsdf = addNode(t, 'ShaderNodeBsdfDiffuse', [600, 0]);
    connect(ctx, tex.id, 'Fac', ramp.id, 'Fac');
    connect(ctx, ramp.id, 'Color', inv.id, 'Color');
    connect(ctx, inv.id, 'Color', bsdf.id, 'Color');
    const g = makeGroup(d, t, new Set([ramp.id, inv.id]))!;
    expect(g.type).toBe('ShaderNodeGroup');
    const grp = d.node_groups[g.props.node_tree as string];
    expect(grp.tree.interface!.filter((i) => i.in_out === 'INPUT')).toHaveLength(1);
    expect(grp.tree.interface!.filter((i) => i.in_out === 'OUTPUT')).toHaveLength(1);
    expect(t.nodes.map((n) => n.type).sort()).toEqual(['ShaderNodeBsdfDiffuse', 'ShaderNodeGroup', 'ShaderNodeTexNoise']);
    expect(nodeSockets(g, ctx).inputs).toHaveLength(1);
    expect(t.links).toHaveLength(2);
    for (const l of t.links) expect(linkStatus(ctx, l).valid).toBe(true);
    // the group compiles
    t.nodes.push({
      id: 'out',
      type: 'ShaderNodeOutputMaterial',
      name: 'Material Output',
      location: [800, 0],
      inputs: {},
      props: { is_active_output: true },
    });
    connect(ctx, bsdf.id, 'BSDF', 'out', 'Surface');
    const ct = compileTree(d, t, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).toContain('ndU');
    ungroup(d, t, g.id);
    expect(t.nodes.map((n) => n.type).sort()).toEqual(['ShaderNodeBsdfDiffuse', 'ShaderNodeInvert', 'ShaderNodeOutputMaterial', 'ShaderNodeTexNoise', 'ShaderNodeValToRGB']);
    expect(t.links).toHaveLength(4);
  });
  it('makes links, frames, inserts on links and hides sockets', () => {
    const d = doc();
    const t = tree();
    const ctx = ctxOf(d, t);
    const a = addNode(t, 'ShaderNodeTexChecker', [0, 0]);
    const b = addNode(t, 'ShaderNodeBsdfDiffuse', [300, 0]);
    expect(makeLinks(ctx, [b.id, a.id])).toBe(1);
    expect(t.links[0]).toMatchObject({
      from_node: a.id,
      to_node: b.id,
      to_socket: 'Color',
    });
    const inv = addNode(t, 'ShaderNodeInvert', [150, 0]);
    expect(insertOnLink(ctx, inv.id, t.links[0].id)).toBe(true);
    expect(t.links).toHaveLength(2);
    const f = joinInFrame(t, [a.id, inv.id])!;
    expect(a.parent).toBe(f.id);
    toggleHiddenSockets(ctx, a);
    expect(a.hidden_sockets).toContain('in:Scale');
    expect(a.hidden_sockets).not.toContain('out:Color');
  });
});

describe('GLSL generation', () => {
  it('compiles the default material with uniforms for values', () => {
    const d = doc();
    const ma = newMaterial('M', [0.2, 0.4, 0.6, 1]);
    const ct = compileTree(d, ma.tree, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).toContain('nd_cl_bsdf(');
    expect(ct.body).toContain('NdClosure ndC =');
    const base = ct.uniforms.find((u) => Array.isArray(u.value) && (u.value as number[]).length === 4);
    expect(base?.value).toEqual([0.2, 0.4, 0.6, 1]);
    expect(ct.decls).toMatch(/uniform vec4 ndU\d+;/);
    expect(ct.lib).toContain('struct NdClosure');
  });
  it('keeps the structural key when only values change', () => {
    const d = doc();
    const ma = newMaterial();
    const k1 = compileTree(d, ma.tree, 'MATERIAL').key;
    ma.tree.nodes[0].inputs['Roughness'] = 0.9;
    expect(compileTree(d, ma.tree, 'MATERIAL').key).toBe(k1);
    ma.tree.nodes[0].inputs['Coat Weight'] = 0.5;
    const ct = compileTree(d, ma.tree, 'MATERIAL');
    expect(ct.key).not.toBe(k1);
    expect(ct.features.coat).toBe(true);
  });
  it('generates texture, math and mix code', () => {
    const d = doc();
    const ma = newMaterial();
    const t = ma.tree;
    const ctx = ctxOf(d, t);
    const bsdf = t.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
    const noise = addNode(t, 'ShaderNodeTexNoise', [-400, 0]);
    const vor = addNode(t, 'ShaderNodeTexVoronoi', [-400, -200], {
      feature: 'SMOOTH_F1',
      distance: 'MINKOWSKI',
    });
    const mix = addNode(t, 'ShaderNodeMix', [-200, 0], {
      data_type: 'RGBA',
      blend_type: 'OVERLAY',
    });
    const math = addNode(t, 'ShaderNodeMath', [-200, -200], {
      operation: 'PINGPONG',
      use_clamp: true,
    });
    connect(ctx, noise.id, 'Color', mix.id, 'A_Color');
    connect(ctx, vor.id, 'Color', mix.id, 'B_Color');
    connect(ctx, mix.id, 'Result_Color', bsdf.id, 'Base Color');
    connect(ctx, vor.id, 'Distance', math.id, 'Value');
    connect(ctx, math.id, 'Value', bsdf.id, 'Roughness');
    const ct = compileTree(d, t, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).toContain('nd_noise_tex3(');
    expect(ct.body).toContain('nd_voronoi3(');
    expect(ct.body).toMatch(/nd_blend\(8,/);
    expect(ct.body).toContain('nd_pingpong(');
    expect(ct.body).toContain('clamp(nd_pingpong(');
    expect(ct.lib).toContain('float nd_snoise(vec3 p)');
    expect(ct.lib).toContain('NdVor nd_voronoi3(');
    // default texture coordinate is Generated
    expect(ct.body).toContain('ndOrco');
  });
  it('compiles bump, normal map and displacement', () => {
    const d = doc();
    const ma = newMaterial();
    const t = ma.tree;
    const ctx = ctxOf(d, t);
    const bsdf = t.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
    const out = activeOutput(t, 'ShaderNodeOutputMaterial')!;
    const tex = addNode(t, 'ShaderNodeTexWave', [-400, 0]);
    const bump = addNode(t, 'ShaderNodeBump', [-200, 0]);
    connect(ctx, tex.id, 'Fac', bump.id, 'Height');
    connect(ctx, bump.id, 'Normal', bsdf.id, 'Normal');
    const disp = addNode(t, 'ShaderNodeDisplacement', [0, -300]);
    connect(ctx, tex.id, 'Fac', disp.id, 'Height');
    connect(ctx, disp.id, 'Displacement', out.id, 'Displacement');
    const ct = compileTree(d, t, 'MATERIAL');
    expect(ct.features.displacement).toBe(true);
    expect(ct.body).toContain('nd_bump(');
    expect(ct.body).toContain('vec3 ndDisp =');
    expect(ct.body).toContain('/*ND_DISPLACE*/');
    expect(ct.body.indexOf('vec3 ndDisp')).toBeLessThan(ct.body.indexOf('NdClosure ndC'));
  });
  it('compiles mix/add shader and transparency features', () => {
    const d = doc();
    const ma = newMaterial();
    const t = ma.tree;
    const ctx = ctxOf(d, t);
    const out = activeOutput(t, 'ShaderNodeOutputMaterial')!;
    const bsdf = t.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
    const tr = addNode(t, 'ShaderNodeBsdfTransparent', [0, 0]);
    const mix = addNode(t, 'ShaderNodeMixShader', [0, 0]);
    connect(ctx, bsdf.id, 'BSDF', mix.id, 'Shader');
    connect(ctx, tr.id, 'BSDF', mix.id, 'Shader_001');
    connect(ctx, mix.id, 'Shader', out.id, 'Surface');
    const ct = compileTree(d, t, 'MATERIAL');
    expect(ct.body).toContain('nd_cl_mix(');
    expect(ct.features.alpha).toBe(true);
  });
  it('compiles worlds (background, sky, environment) and reports missing outputs', () => {
    const d = doc();
    const w = newWorld();
    let ct = compileTree(d, w.tree, 'WORLD');
    expect(ct.errors).toEqual([]);
    expect(ct.body).toContain('nd_cl_emission(');
    const ctx = ctxOf(d, w.tree);
    const bg = w.tree.nodes.find((n) => n.type === 'ShaderNodeBackground')!;
    const sky = addNode(w.tree, 'ShaderNodeTexSky', [-300, 0]);
    connect(ctx, sky.id, 'Color', bg.id, 'Color');
    ct = compileTree(d, w.tree, 'WORLD');
    expect(ct.body).toContain('nd_sky(');
    expect(ct.lib).toContain('vec3 nd_sky(');
    const empty: NodeTreeData = { type: 'WORLD', nodes: [], links: [] };
    expect(compileTree(d, empty, 'WORLD').errors[0]).toMatch(/No World Output/);
  });
  it('compiles every registered shader node without generator errors', () => {
    const d = doc();
    for (const def of Object.values(nodeTypes)) {
      if (!def.treeTypes.includes('SHADER') || def.layout || def.dynamicSockets || def.category === 'output') continue;
      const ma = newMaterial();
      const t = ma.tree;
      const ctx = ctxOf(d, t);
      const out = activeOutput(t, 'ShaderNodeOutputMaterial')!;
      const bsdf = t.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
      const n = addNode(t, def.idname, [-300, 0]);
      const outs = nodeSockets(n, ctx).outputs;
      for (const o of outs) {
        if (o.type === 'SHADER') connect(ctx, n.id, o.identifier, out.id, 'Surface');
        else connect(ctx, n.id, o.identifier, bsdf.id, o.type === 'VECTOR' ? 'Normal' : o.type === 'RGBA' ? 'Base Color' : 'Roughness');
      }
      const ct = compileTree(d, t, 'MATERIAL');
      expect(ct.errors, def.idname).toEqual([]);
    }
  });
  it('converts between socket types', () => {
    expect(convert('x', 'float', 'vec4')).toBe('vec4(vec3(x), 1.0)');
    expect(convert('c', 'vec4', 'float')).toBe('nd_luma((c).rgb)');
    expect(convert('v', 'vec3', 'float')).toBe('dot(v, vec3(1.0 / 3.0))');
    expect(convert('c', 'vec4', 'NdClosure')).toContain('nd_cl_emission');
    expect(literal('vec3', [1, 2, 3])).toBe('vec3(1.0, 2.0, 3.0)');
  });
  it('orders library chunks by dependency', () => {
    const lib = collectLib(['nd_noise_tex']);
    expect(lib.indexOf('uint nd_pcg')).toBeLessThan(lib.indexOf('float nd_snoise(float p)'));
    expect(lib.indexOf('float nd_snoise(vec4 p)')).toBeLessThan(lib.indexOf('float nd_fbm(float p'));
  });
});

describe('ramps and curves', () => {
  it('evaluates color ramps with all interpolations', () => {
    const props = defaultRamp();
    const r = readRamp(props);
    expect(evalRamp(r, 0.5)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(evalRamp(r, -1)).toEqual([0, 0, 0, 1]);
    expect(evalRamp({ ...r, interpolation: 'CONSTANT' }, 0.99)).toEqual([0, 0, 0, 1]);
    expect(evalRamp({ ...r, interpolation: 'EASE' }, 0.25)[0]).toBeCloseTo(0.15625);
    writeRamp(props, [
      { pos: 0, color: [1, 0, 0, 1] },
      { pos: 1, color: [0, 0, 1, 1] },
    ]);
    const hsv = evalRamp({ ...readRamp(props), colorMode: 'HSV' }, 0.5);
    expect(hsv[0]).toBeCloseTo(1);
    expect(hsv[2]).toBeCloseTo(1);
    expect(bakeRamp(readRamp(props), 16)).toHaveLength(64);
  });
  it('evaluates curves (auto and vector handles, extrapolation)', () => {
    const props = defaultCurves('FLOAT');
    const pts = readCurve(props, 0);
    expect(evalCurve(pts, 0.25)).toBeCloseTo(0.25);
    const bent = [
      { x: 0, y: 0, handle: 0 },
      { x: 0.5, y: 0.8, handle: 0 },
      { x: 1, y: 1, handle: 0 },
    ];
    expect(evalCurve(bent, 0.5)).toBeCloseTo(0.8);
    expect(evalCurve(bent, 0.25)).toBeGreaterThan(0.4);
    expect(evalCurve(bent, 2, 'HORIZONTAL')).toBe(1);
    expect(evalCurve(bent, 2, 'EXTRAPOLATED')).toBeGreaterThan(1);
    const vec = [
      { x: 0, y: 0, handle: 1 },
      { x: 1, y: 1, handle: 1 },
    ];
    expect(evalCurve(vec, 0.3)).toBeCloseTo(0.3);
    const rgb = defaultCurves('RGB');
    const lut = bakeCurves(rgb, 'RGB', 8);
    expect(lut.data[4 * 7]).toBeCloseTo(1);
    const v = bakeCurves(defaultCurves('VECTOR'), 'VECTOR', 3);
    expect(v.min).toBe(-1);
    expect(v.data[0]).toBeCloseTo(-1);
  });
  it('computes physical colours', () => {
    const red = wavelengthToRgb(650);
    expect(red[0]).toBeGreaterThan(red[1]);
    // unit luminance: warm temperatures exceed 1 in red, cool ones in blue
    const warm = blackbodyToRgb(1550);
    expect(Math.abs(warm[0] - 3.17)).toBeLessThan(0.15);
    expect(warm[2]).toBeLessThan(0.1);
    const cool = blackbodyToRgb(10050);
    expect(cool[2]).toBeCloseTo(1.43, 1);
    expect(0.2126 * cool[0] + 0.7152 * cool[1] + 0.0722 * cool[2]).toBeCloseTo(1, 2);
  });
});
