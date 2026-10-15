// @vitest-environment happy-dom
// Function, field, topology and input geometry nodes: trees from tests/fixtures/geonodes are
// evaluated and their stored attributes compared with the recorded expected values.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSpec, firstMismatch, type GnSpec } from './gnspec';

const dir = join(__dirname, '../fixtures/geonodes');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cases = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { name: string; spec: GnSpec; expected: Record<string, unknown[]> }[];
  describe(`geometry nodes: ${file.replace('.json', '')}`, () => {
    for (const c of cases)
      it(c.name, () => {
        const r = runSpec(c.spec);
        expect(r.errors).toEqual([]);
        for (const [label, exp] of Object.entries(c.expected)) {
          const got = r.values[label];
          expect(got, `${label} missing`).toBeDefined();
          const i = firstMismatch(exp, got);
          expect(i, `${label}[${i}]: expected ${JSON.stringify(exp[i])}, got ${JSON.stringify(got?.[i])}`).toBe(-1);
        }
      });
  });
}

// ---------------------------------------------------------------------------
// behaviour that is not a stored attribute

import { emptyDocument, uid } from '../../src/data/defaults';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { evaluateGroup } from '../../src/geonodes/modifier';
import { GeometrySet } from '../../src/geonodes/geometry';
import { groupInputMenuItems } from '../../src/geonodes/nodes/switches';
import { resolveItemLinks, ITEM_SOCKET } from '../../src/geonodes/nodes/items';
import { formatItems } from '../../src/geonodes/nodes/fn_string';
import { formatString, shortestFloat } from '../../src/geonodes/strformat';
import { testEnv } from './gnspec';
import type { ModifierBase, NodeGroupData, NodeTreeData } from '../../src/data/types';

function group(): { doc: ReturnType<typeof emptyDocument>; g: NodeGroupData; tree: NodeTreeData } {
  const doc = emptyDocument();
  const tree: NodeTreeData = {
    type: 'GEOMETRY',
    nodes: [],
    links: [],
    interface: [
      { in_out: 'INPUT', name: 'Mode', socket_type: 'NodeSocketMenu', identifier: 'Socket_0' },
      { in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_1' },
    ],
  };
  const g: NodeGroupData = { id: uid('ng'), name: 'G', tree, is_modifier: true };
  doc.node_groups[g.id] = g;
  return { doc, g, tree };
}

describe('menus', () => {
  it('a group menu input takes the items of the menu switch it feeds, and the modifier value picks the branch', () => {
    const { doc, g, tree } = group();
    const gi = addNode(tree, 'NodeGroupInput', [0, 0]);
    const out = addNode(tree, 'NodeGroupOutput', [400, 0]);
    const ms = addNode(tree, 'GeometryNodeMenuSwitch', [200, 0], {
      enum_items: JSON.stringify([
        { id: 0, name: 'Cube' },
        { id: 1, name: 'Line' },
      ]),
    } as Record<string, never>);
    const cube = addNode(tree, 'GeometryNodeMeshCube', [0, 0]);
    const line = addNode(tree, 'GeometryNodeMeshLine', [0, 0]);
    const ctx = ctxOf(doc, tree);
    expect(connect(ctx, gi.id, 'Socket_0', ms.id, 'Menu')).toBeTruthy();
    connect(ctx, cube.id, 'Mesh', ms.id, 'Item_0');
    connect(ctx, line.id, 'Mesh', ms.id, 'Item_1');
    connect(ctx, ms.id, 'Output', out.id, 'Socket_1');
    expect(groupInputMenuItems(doc, tree, 'Socket_0')).toEqual(['Cube', 'Line']);
    const run = (v?: string) => {
      const m = { id: 'md', name: 'GN', type: 'NODES', node_group: g.id, ...(v ? { Socket_0: v } : {}) } as unknown as ModifierBase;
      return evaluateGroup(g, m, testEnv(doc), GeometrySet.empty(), 'in', `menu/${uid('k')}`, false).geometry.mesh!.vertCount;
    };
    expect(run()).toBe(8);
    expect(run('Line')).toBe(10);
  });
});

describe('node items', () => {
  it('linking to the empty item socket of Format String adds an input of the linked type', () => {
    const doc = emptyDocument();
    const tree: NodeTreeData = { type: 'GEOMETRY', nodes: [], links: [], interface: [] };
    doc.node_groups.x = { id: 'x', name: 'X', tree };
    const f = addNode(tree, 'FunctionNodeFormatString', [0, 0]);
    const i = addNode(tree, 'FunctionNodeInputInt', [0, 0]);
    tree.links.push({ id: 'l', from_node: i.id, from_socket: 'Integer', to_node: f.id, to_socket: ITEM_SOCKET });
    expect(resolveItemLinks(doc)).toBe(true);
    expect(formatItems(f)).toEqual([{ id: 0, name: 'Integer', type: 'INT' }]);
    expect(tree.links.map((l) => l.to_socket)).toEqual(['Item_0']);
  });
});

describe('text formatting', () => {
  it('formats numbers like the template language describes', () => {
    const v = (value: number | string, type: 'FLOAT' | 'INT' | 'STRING' = 'FLOAT') => [{ name: 'x', type, value }];
    expect(formatString('{x:.2f}', v(Math.fround(0.125))).text).toBe('0.12');
    expect(formatString('{x:>6}|', v('ab', 'STRING')).text).toBe('    ab|');
    expect(formatString('{x:+05}', v(42, 'INT')).text).toBe('+0042');
    expect(formatString('{y}', v(1)).error).toBeTruthy();
    expect(shortestFloat(Math.fround(0.1))).toBe('0.1');
    expect(shortestFloat(1e7)).toBe('1e+07');
  });
});

describe('warning node', () => {
  it('reports its message when shown', () => {
    const r = runSpec({
      nodes: { g: { type: 'GeometryNodeMeshLine' }, w: { type: 'GeometryNodeWarning', inputs: { Message: 'Too many points' } }, s: { type: 'GeometryNodeSwitch', props: { input_type: 'GEOMETRY' } } },
      links: [
        ['w', 'Show', 's', 'Switch'],
        ['g', 'Mesh', 's', 'True'],
      ],
      geometry: ['s', 'Output'],
    });
    expect(r.warnings).toContain('Too many points');
  });
});
