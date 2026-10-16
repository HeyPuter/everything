// @vitest-environment happy-dom
// Geometry node groups run as tools: selection in and out, mesh replaced, mode/type filters.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import '../../src/geonodes/editor';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { runTool, toolApplies } from '../../src/geonodes/tools/exec';
import { newToolGroup } from '../../src/geonodes/tools/editor';

beforeEach(() => setApp(new App(startupDocument())));

function cubeMesh() {
  const ob = Object.values(app.doc.objects).find((o) => o.type === 'MESH')!;
  return { ob, me: app.doc.meshes[ob.data!] };
}

describe('node tools', () => {
  it('moves the selected vertices and sets a new selection', () => {
    const g = newToolGroup('Lift');
    const t = g.tree;
    const gin = t.nodes.find((n) => n.type === 'NodeGroupInput')!;
    const gout = t.nodes.find((n) => n.type === 'NodeGroupOutput')!;
    t.links = [];
    const sel = addNode(t, 'GeometryNodeToolSelection', [0, 0]);
    const sp = addNode(t, 'GeometryNodeSetPosition', [0, 0]);
    sp.inputs.Offset = [0, 0, 1];
    const ss = addNode(t, 'GeometryNodeToolSetSelection', [0, 0]);
    const pos = addNode(t, 'GeometryNodeInputPosition', [0, 0]);
    const sep = addNode(t, 'ShaderNodeSeparateXYZ', [0, 0]);
    const cmp = addNode(t, 'FunctionNodeCompare', [0, 0], { data_type: 'FLOAT', operation: 'LESS_THAN' });
    cmp.inputs.B = 0;
    const c = ctxOf(app.doc, t);
    connect(c, gin.id, 'Geometry', sp.id, 'Geometry');
    connect(c, sel.id, 'Selection', sp.id, 'Selection');
    connect(c, sp.id, 'Geometry', ss.id, 'Geometry');
    connect(c, pos.id, 'Position', sep.id, 'Vector');
    connect(c, sep.id, 'X', cmp.id, 'A');
    connect(c, cmp.id, 'Result', ss.id, 'Selection');
    connect(c, ss.id, 'Geometry', gout.id, 'Geometry');
    const { ob, me } = cubeMesh();
    const nv = me.positions.length / 3;
    me.select_vert = new Uint8Array(nv);
    // select the vertices with y > 0
    for (let i = 0; i < nv; i++) me.select_vert[i] = me.positions[i * 3 + 1] > 0 ? 1 : 0;
    const before = Array.from(me.positions);
    expect(runTool(app.doc, ob, g, 'EDIT')).toBeNull();
    for (let i = 0; i < nv; i++) expect(me.positions[i * 3 + 2]).toBeCloseTo(before[i * 3 + 2] + (before[i * 3 + 1] > 0 ? 1 : 0));
    // new selection: x < 0
    for (let i = 0; i < nv; i++) expect(me.select_vert![i]).toBe(me.positions[i * 3] < 0 ? 1 : 0);
    // in Object Mode everything is selected
    const z0 = me.positions[2];
    expect(runTool(app.doc, ob, g, 'OBJECT')).toBeNull();
    expect(me.positions[2]).toBeCloseTo(z0 + 1);
  });
  it('is offered for the modes and types it is made for', () => {
    const g = newToolGroup();
    expect(toolApplies(g, 'EDIT', 'MESH')).toBe(true);
    g.is_mode_edit = false;
    expect(toolApplies(g, 'EDIT', 'MESH')).toBe(false);
    expect(toolApplies(g, 'OBJECT', 'CURVES')).toBe(false);
    g.is_tool = false;
    expect(toolApplies(g, 'OBJECT', 'MESH')).toBe(false);
  });
});
