// @vitest-environment happy-dom
// Geometry utility nodes added in round 4: material replacement, components, names and bundles,
// attribute names, collection children, string splitting, tag filters and image sampling.
import { describe, it, expect } from 'vitest';
import { runSpec } from './gnspec';
import '../../src/geonodes/index';
import { tagFilterMatch, attributeNames, splitComponent, nestedPaths } from '../../src/geonodes/nodes/gnmisc';
import { sampleImage } from '../../src/geonodes/nodes/imagetex';
import { BundleValue } from '../../src/geonodes/bundles/values';
import { GeometrySet, PointsComponent } from '../../src/geonodes/geometry';
import { getNodeType } from '../../src/nodes/registry';
import { GEOMETRY_MENU } from '../../src/geonodes/menu';
import type { MenuCategory, MenuEntry } from '../../src/nodes/types';

const grid = { type: 'GeometryNodeMeshGrid', inputs: { 'Size X': 1, 'Size Y': 1, 'Vertices X': 3, 'Vertices Y': 3 } };

describe('geometry utility nodes', () => {
  it('Split String gives a list (empty separators keep the whole string)', () => {
    const lengths: Record<string, number> = {};
    for (const [s, sep, n] of [
      ['a,b,c', ',', 3],
      ['a,,b', ',', 3],
      ['abc', '', 1],
      ['', ',', 1],
      ['a--b--c', '--', 3],
    ] as const) {
      const r = runSpec({
        geometry: ['g', 'Mesh'],
        nodes: {
          g: { type: 'GeometryNodeMeshLine', inputs: { Count: 1 } },
          t: { type: 'FunctionNodeSplitString', inputs: { String: s, Separator: sep } },
          l: { type: 'GeometryNodeListLength', props: { data_type: 'STRING' } },
        },
        links: [['t', 'List', 'l', 'List']],
        outputs: [['n', 'l', 'Length', 'INT', 'POINT']],
      });
      expect(r.errors).toEqual([]);
      lengths[`${s}|${sep}`] = r.values.n[0] as number;
      expect(r.values.n[0], `${s} split by ${sep}`).toBe(n);
    }
  });

  it('Tag Filter matches any of the comma separated tags', () => {
    expect(tagFilterMatch('red', ['red', 'big'])).toBe(true);
    expect(tagFilterMatch('red, blue', ['blue'])).toBe(true);
    expect(tagFilterMatch(' red ', ['red'])).toBe(true);
    expect(tagFilterMatch('red & big', ['red', 'big'])).toBe(false);
    expect(tagFilterMatch('RED', ['red'])).toBe(false);
    expect(tagFilterMatch('red', ['red '])).toBe(false);
    expect(tagFilterMatch('', [])).toBe(true);
  });

  it('Get Attribute Names lists position and stored attributes with filters', () => {
    const r = runSpec({
      geometry: ['g', 'Mesh'],
      nodes: { g: grid, v: { type: 'ShaderNodeValue' } },
      outputs: [['heat', 'v', 'Value', 'FLOAT', 'FACE']],
    });
    const names = attributeNames(r.geometry, null, null);
    expect(names).toContain('position');
    expect(attributeNames(r.geometry, 'FLOAT_VECTOR', 'POINT')).toEqual(['position']);
    expect(attributeNames(r.geometry, 'FLOAT2', null)).toEqual([]);
    expect(names).toContain('heat');
    expect(attributeNames(r.geometry, null, 'FACE')).toContain('heat');
    expect(attributeNames(r.geometry, null, 'EDGE')).not.toContain('heat');
  });

  it('Replace Material swaps material slots', () => {
    const r = runSpec({
      materials: ['A', 'B'],
      geometry: ['rm', 'Geometry'],
      nodes: {
        g: grid,
        sm: { type: 'GeometryNodeSetMaterial', inputs: { Material: '@A' } },
        rm: { type: 'GeometryNodeReplaceMaterial', inputs: { Old: '@A', New: '@B' } },
      },
      links: [
        ['g', 'Mesh', 'sm', 'Geometry'],
        ['sm', 'Geometry', 'rm', 'Geometry'],
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.geometry.mesh?.materials).toEqual(['B']);
  });

  it('Get Geometry Component splits a component off', () => {
    const g = new GeometrySet(undefined, new PointsComponent(new Float32Array(3)));
    const r = splitComponent(g, 'Point Cloud');
    expect(r.exists).toBe(true);
    expect(r.component.points).toBe(g.points);
    expect(r.rest.points).toBeUndefined();
    expect(splitComponent(g, 'Mesh').exists).toBe(false);
  });

  it('nested bundle paths walk into inner bundles', () => {
    const inner = BundleValue.of([['Size', { type: 'FLOAT', value: 2 }]]);
    const b = BundleValue.of([
      ['Name', { type: 'STRING', value: 'x' }],
      ['Settings', { type: 'BUNDLE', value: inner }],
    ]);
    expect(nestedPaths(b, null)).toEqual(['Name', 'Settings', 'Settings/Size']);
    expect(nestedPaths(b, 'FLOAT')).toEqual(['Settings/Size']);
  });

  it('image sampling interpolates, clips and repeats', () => {
    // 2×1 image: black, white (linear)
    const px = { key: '', w: 2, h: 1, data: new Float32Array([0, 0, 0, 1, 1, 1, 1, 1]) };
    const c = [0, 0, 0, 0];
    expect(sampleImage(px, 0.5, 0.5, 'Linear', 'EXTEND', c)[0]).toBeCloseTo(0.5);
    expect(sampleImage(px, 0.25, 0.5, 'Closest', 'REPEAT', c)[0]).toBe(0);
    expect(sampleImage(px, 0.75, 0.5, 'Closest', 'REPEAT', c)[0]).toBe(1);
    expect(sampleImage(px, 1.25, 0.5, 'Closest', 'REPEAT', c)[0]).toBe(0);
    expect(sampleImage(px, 1.25, 0.5, 'Closest', 'CLIP', c)[3]).toBe(0);
    expect(sampleImage(px, 1.25, 0.5, 'Closest', 'MIRROR', c)[0]).toBe(1);
  });

  it('the Add menu lists the new nodes', () => {
    const ids: string[] = [];
    const walk = (items: MenuCategory['items']) => {
      for (const it of items) {
        if (typeof it === 'string') continue;
        if ('items' in it) walk(it.items);
        else ids.push((it as MenuEntry).idname);
      }
    };
    walk(GEOMETRY_MENU);
    for (const id of ['GeometryNodeReplaceMaterial', 'GeometryNodeImageTexture', 'ShaderNodeTexVoronoi', 'ShaderNodeValToRGB', 'FunctionNodeSplitString', 'GeometryNodeGetAttributeNames', 'GeometryNodeCollectionChildren']) {
      expect(getNodeType(id), id).toBeDefined();
      expect(ids, id).toContain(id);
    }
  });
});

describe('Transfer Attributes helpers', () => {
  it('wildcards match * and ?', async () => {
    const { wildcardMatch } = await import('../../src/geonodes/nodes/gnmisc');
    expect(wildcardMatch('h*', 'heat')).toBe(true);
    expect(wildcardMatch('h?at', 'heat')).toBe(true);
    expect(wildcardMatch('h*', 'cold')).toBe(false);
    expect(wildcardMatch('a.b', 'axb')).toBe(false);
  });
});
