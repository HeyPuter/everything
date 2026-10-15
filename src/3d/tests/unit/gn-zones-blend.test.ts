// @vitest-environment happy-dom
// Geometry node zones read from a .blend file (tests/fixtures/blend/make_zones.py): items are
// rebuilt from the stored item sockets, zone inputs are paired, and the tree evaluates.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { readBlend } from '../../src/io/blend/convert';
import type { DocumentData, NodeData, NodeTreeData } from '../../src/data/types';
import { evaluateGroup } from '../../src/geonodes/modifier';
import { GeometrySet, MeshComponent } from '../../src/geonodes/geometry';
import { env } from './gnmesh-harness';

let doc: DocumentData;
let tree: NodeTreeData;
const nodeOf = (type: string) => tree.nodes.find((n) => n.type === type) as NodeData;
const items = (n: NodeData, key: string) => JSON.parse(String(n.props[key])).map((i: { id: number; name: string; socket_type: string }) => `${i.id}:${i.name}:${i.socket_type}`);

beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/blend/zones_zstd.blend')));
  doc = (await readBlend(bytes)).doc;
  tree = Object.values(doc.node_groups).find((g) => g.name === 'Zones')!.tree;
});

describe('zones from .blend files', () => {
  it('rebuild items and pairs', () => {
    const ro = nodeOf('GeometryNodeRepeatOutput');
    expect(items(ro, 'repeat_items')).toEqual(['0:Geometry:GEOMETRY', '1:Total:FLOAT']);
    expect(nodeOf('GeometryNodeRepeatInput').props.paired_output).toBe(ro.id);
    expect(nodeOf('GeometryNodeRepeatInput').inputs.Iterations).toBe(3);
    const fo = nodeOf('GeometryNodeForeachGeometryElementOutput');
    expect(nodeOf('GeometryNodeForeachGeometryElementInput').props.paired_output).toBe(fo.id);
    expect(items(fo, 'input_items')).toEqual(['1:Weight:FLOAT']);
    expect(items(fo, 'main_items')).toEqual(['2:Twice:INT']);
    expect(items(fo, 'generation_items')).toEqual(['0:Geometry:GEOMETRY']);
    expect(fo.props.domain).toBe('POINT');
    const so = nodeOf('GeometryNodeSimulationOutput');
    expect(nodeOf('GeometryNodeSimulationInput').props.paired_output).toBe(so.id);
    expect(items(so, 'state_items')).toEqual(['0:Geometry:GEOMETRY', '1:Velocity:VECTOR']);
    expect(items(nodeOf('GeometryNodeBake'), 'bake_items')).toEqual(['0:Geometry:GEOMETRY']);
  });
  it('come with the geometry nodes modifier and evaluate like the saved scene (one point lifted to z = 3)', () => {
    const ob = Object.values(doc.objects).find((o) => o.name === 'Zoned')!;
    const m = ob.modifiers.find((x) => x.type === 'NODES')!;
    const g = doc.node_groups[m.node_group as string];
    expect(g.name).toBe('Zones');
    const input = new GeometrySet(new MeshComponent(new Float32Array([0, 0, 0]), new Uint32Array([0]), new Uint32Array(0)));
    const r = evaluateGroup(g, m, env(doc), input, 'in', 'blendzones', false);
    expect(Array.from(r.geometry.mesh!.positions)).toEqual([0, 0, 3]);
  });
});

describe('geometry nodes modifier inputs from .blend files', () => {
  it('keeps number and vector inputs', () => {
    const ob = Object.values(doc.objects).find((o) => o.name === 'Zoned')!;
    const m = ob.modifiers.find((x) => x.type === 'NODES')!;
    const g = doc.node_groups[m.node_group as string];
    const ids = Object.fromEntries((g.tree.interface ?? []).filter((i) => i.in_out === 'INPUT').map((i) => [i.name, i.identifier]));
    expect(m[ids.Offset]).toEqual([1, 2, 3]);
    expect(m[ids.Scale]).toBe(0.5);
  });
});

describe('geometry node settings from .blend files', () => {
  it('reads enums stored in node fields and menu sockets', () => {
    expect(nodeOf('GeometryNodeMergeByDistance').props.Mode).toBe('Connected');
    expect(nodeOf('GeometryNodeMeshBoolean').props).toMatchObject({ operation: 'UNION', solver: 'EXACT' });
    expect(nodeOf('GeometryNodeMeshLine').props.mode).toBe('END_POINTS');
  });
});
