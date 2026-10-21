// @vitest-environment happy-dom
// Utility nodes shared with geometry nodes in shader trees: the Repeat zone compiles to a loop,
// Menu Switch picks its item while compiling, Implicit Conversion converts.
import { describe, it, expect } from 'vitest';
import '../../src/nodes/index';
import '../../src/geonodes/core';
import { shareShaderUtilities } from '../../src/nodes/shader/sharedutil';
import { compileTree } from '../../src/nodes/shader/codegen';
import { addNode, connect, ctxOf, activeOutput } from '../../src/nodes/tree';
import { emptyDocument, newMaterial } from '../../src/data/defaults';
import { getNodeType } from '../../src/nodes/registry';
import { SHADER_MENU } from '../../src/nodes/shader/defs';
import type { MenuCategory } from '../../src/nodes/types';

shareShaderUtilities();

describe('shader utility nodes', () => {
  it('are available in shader trees and the Add menu', () => {
    for (const id of ['GeometryNodeRepeatInput', 'GeometryNodeRepeatOutput', 'GeometryNodeMenuSwitch', 'FunctionNodeInputMenu', 'NodeImplicitConversion']) expect(getNodeType(id)?.treeTypes, id).toContain('SHADER');
    const util = SHADER_MENU.find((c) => c.label === 'Utilities')!;
    const ids = util.items.filter((i): i is { idname: string } => typeof i !== 'string' && 'idname' in i).map((i) => i.idname);
    expect(ids).toEqual(expect.arrayContaining(['GeometryNodeRepeatInput', 'NodeImplicitConversion', 'GeometryNodeMenuSwitch']));
    const constants = (SHADER_MENU.find((c) => c.label === 'Input')!.items.find((i) => typeof i !== 'string' && 'items' in i) as MenuCategory).items;
    expect(constants.some((i) => typeof i !== 'string' && 'idname' in i && i.idname === 'FunctionNodeInputMenu')).toBe(true);
  });

  it('compiles a repeat zone into a loop over its items', () => {
    const doc = emptyDocument();
    const ma = newMaterial('R');
    const t = ma.tree;
    const ctx = ctxOf(doc, t);
    const rin = addNode(t, 'GeometryNodeRepeatInput', [0, 0]);
    const rout = addNode(t, 'GeometryNodeRepeatOutput', [300, 0]);
    rin.props.paired_output = rout.id;
    rout.props.repeat_items = JSON.stringify([{ id: 0, name: 'Value', socket_type: 'FLOAT' }]);
    rin.inputs.Iterations = 5;
    rin.inputs.Item_0 = 1;
    const m = addNode(t, 'ShaderNodeMath', [150, 0], { operation: 'MULTIPLY' });
    m.inputs.Value_001 = 2;
    connect(ctx, rin.id, 'Item_0', m.id, 'Value');
    connect(ctx, m.id, 'Value', rout.id, 'Item_0');
    const em = addNode(t, 'ShaderNodeEmission', [500, 0]);
    connect(ctx, rout.id, 'Item_0', em.id, 'Strength');
    connect(ctx, em.id, 'Emission', activeOutput(t, 'ShaderNodeOutputMaterial')!.id, 'Surface');
    const ct = compileTree(doc, t, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).toMatch(/for \(int i\d+ = 0; i\d+ < \d+; i\d+\+\+\) \{/);
    expect(ct.body).toMatch(/if \(float\(i\d+\) >= v\d+\) break;/);
    // the multiply happens inside the loop and feeds the loop variable
    const loop = ct.body.slice(ct.body.indexOf('for ('), ct.body.lastIndexOf('}') + 1);
    expect(loop).toMatch(/\*/);
    expect(ct.uniforms.map((u) => u.value)).toEqual(expect.arrayContaining([5, 1, 2]));
  });

  it('Menu Switch picks the item named by its menu, also through a Menu node', () => {
    const doc = emptyDocument();
    const ma = newMaterial('M');
    const t = ma.tree;
    const ctx = ctxOf(doc, t);
    const sw = addNode(t, 'GeometryNodeMenuSwitch', [0, 0], { data_type: 'RGBA' });
    sw.props.enum_items = JSON.stringify([
      { id: 0, name: 'Red' },
      { id: 1, name: 'Blue' },
    ]);
    sw.inputs.Item_0 = [1, 0, 0, 1];
    sw.inputs.Item_1 = [0, 0, 1, 1];
    sw.inputs.Menu = 'Blue';
    const em = addNode(t, 'ShaderNodeEmission', [300, 0]);
    connect(ctx, sw.id, 'Output', em.id, 'Color');
    connect(ctx, em.id, 'Emission', activeOutput(t, 'ShaderNodeOutputMaterial')!.id, 'Surface');
    const blue = compileTree(doc, t, 'MATERIAL');
    expect(blue.errors).toEqual([]);
    expect(blue.uniforms.some((u) => JSON.stringify(u.value) === JSON.stringify([0, 0, 1, 1]))).toBe(true);
    expect(blue.uniforms.some((u) => JSON.stringify(u.value) === JSON.stringify([1, 0, 0, 1]))).toBe(false);
    const menu = addNode(t, 'FunctionNodeInputMenu', [-200, 0]);
    menu.props.value = 'Red';
    connect(ctx, menu.id, 'Menu', sw.id, 'Menu');
    const red = compileTree(doc, t, 'MATERIAL');
    expect(red.uniforms.some((u) => JSON.stringify(u.value) === JSON.stringify([1, 0, 0, 1]))).toBe(true);
    expect(red.key).not.toBe(blue.key);
  });
});

describe('shader bundles and closures', () => {
  const emissionOf = (doc: ReturnType<typeof emptyDocument>, t: ReturnType<typeof newMaterial>['tree'], from: string, socket: string) => {
    const ctx = ctxOf(doc, t);
    const em = addNode(t, 'ShaderNodeEmission', [600, 0]);
    connect(ctx, from, socket, em.id, 'Color');
    connect(ctx, em.id, 'Emission', activeOutput(t, 'ShaderNodeOutputMaterial')!.id, 'Surface');
  };

  it('a combined bundle is separated by name while compiling', () => {
    const doc = emptyDocument();
    const t = newMaterial('B').tree;
    const ctx = ctxOf(doc, t);
    const cb = addNode(t, 'NodeCombineBundle', [0, 0]);
    cb.props.bundle_items = JSON.stringify([
      { id: 0, name: 'Tint', socket_type: 'RGBA' },
      { id: 1, name: 'Amount', socket_type: 'FLOAT' },
    ]);
    cb.inputs.Item_0 = [0.25, 0.5, 0.75, 1];
    const sb = addNode(t, 'NodeSeparateBundle', [200, 0]);
    sb.props.bundle_items = JSON.stringify([
      { id: 3, name: 'Tint', socket_type: 'RGBA' },
      { id: 4, name: 'Missing', socket_type: 'FLOAT' },
    ]);
    connect(ctx, cb.id, 'Bundle', sb.id, 'Bundle');
    emissionOf(doc, t, sb.id, 'Item_3');
    const ct = compileTree(doc, t, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).not.toContain('__nd_value');
    expect(ct.uniforms.some((u) => JSON.stringify(u.value) === JSON.stringify([0.25, 0.5, 0.75, 1]))).toBe(true);
  });

  it('Evaluate Closure inlines the closure body with its inputs', () => {
    const doc = emptyDocument();
    const t = newMaterial('C').tree;
    const ctx = ctxOf(doc, t);
    const ci = addNode(t, 'NodeClosureInput', [0, 0]);
    const co = addNode(t, 'NodeClosureOutput', [300, 0]);
    ci.props.paired_output = co.id;
    co.props.input_items = JSON.stringify([{ id: 0, name: 'Value', socket_type: 'FLOAT' }]);
    co.props.output_items = JSON.stringify([{ id: 1, name: 'Result', socket_type: 'FLOAT' }]);
    const m = addNode(t, 'ShaderNodeMath', [150, 0], { operation: 'MULTIPLY' });
    m.inputs.Value_001 = 7.5;
    connect(ctx, ci.id, 'Item_0', m.id, 'Value');
    connect(ctx, m.id, 'Value', co.id, 'Item_1');
    const ev = addNode(t, 'NodeEvaluateClosure', [450, 0]);
    ev.props.input_items = JSON.stringify([{ id: 0, name: 'Value', socket_type: 'FLOAT' }]);
    ev.props.output_items = JSON.stringify([{ id: 1, name: 'Result', socket_type: 'FLOAT' }]);
    ev.inputs.Item_0 = 0.25;
    connect(ctx, co.id, 'Closure', ev.id, 'Closure');
    emissionOf(doc, t, ev.id, 'Item_1');
    const ct = compileTree(doc, t, 'MATERIAL');
    expect(ct.errors).toEqual([]);
    expect(ct.body).not.toContain('__nd_value');
    expect(ct.uniforms.map((u) => u.value)).toEqual(expect.arrayContaining([7.5, 0.25]));
    expect(ct.body).toMatch(/\*/);
  });
});
