// @vitest-environment happy-dom
// Compositor filters whose GPU loops grow with an input: the loop sizes passed to the shaders
// are bounded, so a large typed value cannot hang the GPU.
import { describe, it, expect } from 'vitest';
import '../../src/nodes/common';
import '../../src/compositor/nodes/defs';
import '../../src/compositor/ops/filter';
import { registerNodeType } from '../../src/nodes/registry';
import { Evaluator, registerExec } from '../../src/compositor/eval/evaluator';
import { Result, IDENTITY, type Xform } from '../../src/compositor/eval/result';
import { emptyDocument } from '../../src/data/defaults';
import type { NodeData, NodeTreeData } from '../../src/data/types';
import type { Gpu, Texture } from '../../src/compositor/gpu/gpu';

registerNodeType({
  idname: 'TestLimitImage',
  label: 'Image',
  category: 'input',
  treeTypes: ['COMPOSITOR'],
  inputs: [],
  outputs: [{ name: 'Image', identifier: 'Image', type: 'RGBA' }],
  props: [],
  width: 140,
});
const domain = { w: 64, h: 32, xf: [...IDENTITY] as Xform };
registerExec('TestLimitImage', (x) =>
  x.out('Image', Result.image('RGBA', { w: 64, h: 32 } as Texture, domain)),
);

/** GPU stand-in recording the uniforms of every pass. */
function fakeGpu() {
  const passes: { key: string; uniforms: Record<string, unknown> }[] = [];
  const gpu = {
    program: (key: string) => ({ key }),
    alloc: (w: number, h: number) => ({ w, h }) as Texture,
    free: () => {},
    run: (prog: { key: string }, _out: unknown, uniforms: Record<string, unknown>) =>
      passes.push({ key: prog.key, uniforms }),
  } as unknown as Gpu;
  return { gpu, passes };
}

const node = (id: string, type: string, inputs: NodeData['inputs'] = {}): NodeData => ({
  id,
  type,
  name: id,
  location: [0, 0],
  inputs,
  props: {},
});

describe('compositor loop limits', () => {
  it('Bilateral Blur bounds its radius', () => {
    const tree: NodeTreeData = {
      type: 'COMPOSITOR',
      nodes: [
        node('img', 'TestLimitImage'),
        node('bb', 'CompositorNodeBilateralblur', { Size: 100000 }),
        node('out', 'NodeGroupOutput'),
      ],
      links: [
        { id: 'l1', from_node: 'img', from_socket: 'Image', to_node: 'bb', to_socket: 'Image' },
        { id: 'l2', from_node: 'bb', from_socket: 'Image', to_node: 'out', to_socket: 'Socket_1' },
      ],
      interface: [
        { in_out: 'OUTPUT', name: 'Image', socket_type: 'NodeSocketColor', identifier: 'Socket_1' },
      ],
    };
    const { gpu, passes } = fakeGpu();
    const ev = new Evaluator(gpu, {
      doc: emptyDocument(),
      renderSize: [64, 32],
      frame: 1,
      fps: 24,
      layers: null,
      viewer: null,
      composite: true,
    });
    ev.compositeOutput(tree);
    const pass = passes.find((p) => p.key === 'bilateral');
    expect(pass).toBeDefined();
    expect(pass!.uniforms.u_radius).toBe(128);
  });
});
