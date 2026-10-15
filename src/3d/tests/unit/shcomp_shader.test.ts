// @vitest-environment happy-dom
// Shader nodes added in the shader/compositor parity round: Radial Tiling and IES Texture math
// against expected sample values, menu wiring, socket availability and GLSL generation.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import '../../src/nodes/shader/extra';
import { getNodeType, nodeMenu, nodeSockets, nodeTypes } from '../../src/nodes/registry';
import { addNode, connect, activeOutput, ctxOf } from '../../src/nodes/tree';
import { compileTree } from '../../src/nodes/shader/codegen';
import { radialTiling } from '../../src/nodes/shader/radial';
import { parseIes, sampleIes, iesAngles, IES_SCALE, iesGrid } from '../../src/nodes/shader/ies';
import { hairColor } from '../../src/nodes/shader/extra';
import { shaderEntryPoll } from '../../src/nodes/shader/defs';
import { emptyDocument, newMaterial, newText } from '../../src/data/defaults';

const fixture = (name: string) => readFileSync(resolve(process.cwd(), 'tests/fixtures/shcomp', name), 'utf8');

/** Points exactly on a segment boundary may fall on either side depending on float precision. */
function onBoundary(p: number[], sides: number) {
  const n = Math.max(2, sides);
  let a = Math.atan2(p[1], p[0]);
  if (a < 0) a += Math.PI * 2;
  const f = a / ((Math.PI * 2) / n);
  return Math.abs(f - Math.round(f)) < 1e-6;
}

describe('Radial Tiling', () => {
  const ref = JSON.parse(fixture('radial-tiling.json')) as {
    cases: { sides: number; roundness: number; normalize: boolean; rows: [number[], number[], number, number, number][] }[];
  };
  it('matches the expected values for polygonal and circular segments, fractional and low side counts', () => {
    let checked = 0;
    for (const c of ref.cases) {
      // corner rounding between the two extremes is approximated (checked separately below)
      if (c.roundness > 0 && c.roundness < 1) continue;
      for (const [p, co, id, w, rot] of c.rows) {
        if (onBoundary(p, c.sides)) continue;
        const r = radialTiling(p[0], p[1], c.sides, c.roundness, c.normalize);
        const tag = `${c.sides}/${c.roundness}/${c.normalize} at ${p}`;
        expect(r.id, tag).toBe(id);
        expect(r.rotation, tag).toBeCloseTo(rot, 3);
        expect(Math.abs(r.width - w), tag).toBeLessThan(1e-3 * Math.max(1, Math.abs(w)));
        expect(r.co[0], tag).toBeCloseTo(co[0], 3);
        expect(r.co[1], tag).toBeCloseTo(co[1], 3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
  it('rounds the corners: exact depth everywhere, exact across-coordinate on straight edges, close on corners', () => {
    for (const c of ref.cases) {
      if (!(c.roundness > 0 && c.roundness < 1) || c.normalize) continue;
      for (const [p, co, id, w, rot] of c.rows) {
        if (onBoundary(p, c.sides)) continue;
        const r = radialTiling(p[0], p[1], c.sides, c.roundness, false);
        const tag = `${c.sides}/${c.roundness} at ${p}`;
        expect(r.id, tag).toBe(id);
        expect(r.rotation, tag).toBeCloseTo(rot, 3);
        expect(Math.abs(r.width - w), tag).toBeLessThan(0.05);
        if (Number.isInteger(c.sides)) expect(r.co[1], tag).toBeCloseTo(co[1], 3);
        expect(Math.abs(r.co[0] - co[0]), tag).toBeLessThan(0.06 * Math.max(1, Math.hypot(p[0], p[1])));
      }
    }
  });
});

describe('IES Texture', () => {
  const ref = JSON.parse(fixture('ies-expected.json')) as Record<string, number[][]>;
  it('parses LM-63 files (multiplier and ballast factors applied)', () => {
    const d = parseIes(fixture('bilateral.ies'))!;
    expect(d.vertical).toEqual([0, 45, 90, 135, 180]);
    expect(d.horizontal).toEqual([0, 90, 180]);
    expect(d.candela[1][0]).toBe(1200);
    const b = parseIes(fixture('ballast.ies'))!;
    expect(b.candela[0][0]).toBe(500);
    expect(parseIes('not a photometric file')).toBeNull();
  });
  it('samples with spline interpolation and the symmetry of the file', () => {
    for (const file of ['symmetric.ies', 'bilateral.ies', 'ballast.ies']) {
      const d = parseIes(fixture(file))!;
      const rows = ref[file];
      rows.forEach((row, y) => {
        const phi = (y * Math.PI) / 4;
        row.forEach((want, x) => {
          const t = ((x + 0.5) / 16) * Math.PI;
          const [v, h] = iesAngles(Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), -Math.cos(t));
          const got = sampleIes(d, v, h) * IES_SCALE;
          expect(Math.abs(got - want), `${file} row ${y} col ${x}`).toBeLessThan(Math.max(0.02, want * 0.012));
        });
      });
    }
  });
  it('resamples into a lookup grid (one row for rotationally symmetric files)', () => {
    const sym = iesGrid(parseIes(fixture('symmetric.ies'))!);
    expect(sym.height).toBe(1);
    expect(sym.data[0]).toBeCloseTo(1000 * IES_SCALE, 3);
    const asym = iesGrid(parseIes(fixture('bilateral.ies'))!, 16, 8);
    expect(asym.height).toBe(8);
    expect(asym.width).toBe(16);
  });
  it('compiles a lookup texture from the node text data-block', () => {
    const doc = emptyDocument();
    const txt = newText('lamp.ies', fixture('symmetric.ies'), 'text');
    doc.texts[txt.id] = txt;
    const ma = newMaterial();
    const t = ma.tree;
    const ctx = ctxOf(doc, t);
    const ies = addNode(t, 'ShaderNodeTexIES', [-400, 0]);
    ies.props.ies = txt.id;
    const em = addNode(t, 'ShaderNodeEmission', [-200, 0]);
    connect(ctx, ies.id, 'Fac', em.id, 'Strength');
    connect(ctx, em.id, 'Emission', activeOutput(t, 'ShaderNodeOutputMaterial')!.id, 'Surface');
    const ct = compileTree(doc, t, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).toMatch(/nd_ies\(/);
    expect(ct.uniforms.some((u) => typeof u.value === 'object' && !Array.isArray(u.value) && u.value.kind === 'lut')).toBe(true);
  });
});

describe('new shader nodes', () => {
  it('appear in the Add menu in order, world trees offering background nodes only', () => {
    const shader = nodeMenu('SHADER').find((c) => c.label === 'Shader')!;
    const ids = shader.items.filter((i) => typeof i !== 'string').map((i) => (i as { idname: string }).idname);
    expect(ids.indexOf('ShaderNodeBsdfHair')).toBe(ids.indexOf('ShaderNodeBsdfAnisotropic') + 1);
    expect(ids.indexOf('ShaderNodeBsdfHairPrincipled')).toBe(ids.indexOf('ShaderNodeBsdfPrincipled') + 1);
    expect(ids.indexOf('ShaderNodeBsdfRayPortal')).toBe(ids.indexOf('ShaderNodeBsdfHairPrincipled') + 1);
    expect(ids[ids.length - 1]).toBe('ShaderNodeVolumeCoefficients');
    expect(shaderEntryPoll('ShaderNodeBsdfPrincipled', 'WORLD')).toBe(false);
    expect(shaderEntryPoll('ShaderNodeBackground', 'WORLD')).toBe(true);
    expect(shaderEntryPoll('ShaderNodeBackground', 'OBJECT')).toBe(false);
    expect(shaderEntryPoll('ShaderNodeVolumeCoefficients', 'WORLD')).toBe(true);
    const tex = nodeMenu('SHADER').find((c) => c.label === 'Texture')!;
    expect(tex.items.map((i) => (i as { idname: string }).idname)).toContain('ShaderNodeTexIES');
  });
  it('shows the sockets of the chosen hair parametrization and model', () => {
    const t = newMaterial().tree;
    const h = addNode(t, 'ShaderNodeBsdfHairPrincipled', [0, 0], { parametrization: 'MELANIN' });
    expect(nodeSockets(h).inputs.map((s) => s.name)).toEqual([
      'Melanin',
      'Melanin Redness',
      'Tint',
      'Roughness',
      'Radial Roughness',
      'Coat',
      'IOR',
      'Offset',
      'Random Color',
      'Random Roughness',
      'Random',
    ]);
    h.props.model = 'HUANG';
    h.props.parametrization = 'COLOR';
    expect(nodeSockets(h).inputs.map((s) => s.name)).toEqual([
      'Color',
      'Aspect Ratio',
      'Roughness',
      'IOR',
      'Offset',
      'Random Roughness',
      'Random',
      'Reflection',
      'Transmission',
      'Secondary Reflection',
    ]);
    const v = addNode(t, 'ShaderNodeVolumeCoefficients', [0, 0], { phase: 'MIE' });
    expect(nodeSockets(v).inputs.map((s) => s.name)).toEqual(['Absorption Coefficients', 'Scatter Coefficients', 'Diameter', 'Emission Coefficients']);
  });
  it('derives hair colours from melanin and absorption (lighter for less melanin)', () => {
    const base = { color: [0, 0, 0], tint: [1, 1, 1], absorption: [0, 0, 0], radial: 0.3, redness: 0 };
    const dark = hairColor('MELANIN', { ...base, melanin: 0.9 });
    const light = hairColor('MELANIN', { ...base, melanin: 0.2 });
    expect(light[0]).toBeGreaterThan(dark[0]);
    expect(hairColor('ABSORPTION', { ...base, melanin: 0 })).toEqual([1, 1, 1]);
    // brown: red channel brightest
    const brown = hairColor('MELANIN', { ...base, melanin: 0.5, redness: 0.5 });
    expect(brown[0]).toBeGreaterThan(brown[2]);
  });
  it('compiles every new node without errors', () => {
    const d = emptyDocument();
    for (const id of [
      'ShaderNodeBsdfHair',
      'ShaderNodeBsdfHairPrincipled',
      'ShaderNodeBsdfRayPortal',
      'ShaderNodeVolumeCoefficients',
      'ShaderNodeHairInfo',
      'ShaderNodeParticleInfo',
      'ShaderNodePointInfo',
      'ShaderNodeVolumeInfo',
      'ShaderNodeRadialTiling',
      'ShaderNodeTexIES',
    ]) {
      expect(nodeTypes[id], id).toBeDefined();
      const ma = newMaterial();
      const t = ma.tree;
      const ctx = ctxOf(d, t);
      const out = activeOutput(t, 'ShaderNodeOutputMaterial')!;
      const bsdf = t.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
      const n = addNode(t, id, [-300, 0]);
      for (const o of nodeSockets(n, ctx).outputs) {
        if (o.type === 'SHADER') connect(ctx, n.id, o.identifier, out.id, o.identifier === 'Volume' ? 'Volume' : 'Surface');
        else connect(ctx, n.id, o.identifier, bsdf.id, o.type === 'VECTOR' ? 'Normal' : o.type === 'RGBA' ? 'Base Color' : 'Roughness');
      }
      const ct = compileTree(d, t, 'MATERIAL');
      expect(ct.errors, id).toEqual([]);
      expect(getNodeType(id)!.description, id).toBeTruthy();
    }
  });
});
