import { describe, expect, it } from 'vitest';
import { addEdge, addNode, createFlow, orderNodes, runFlow } from '../src/engine/flow.js';

describe('workflow flow', () => {
  it('orders from trigger', () => {
    const order = orderNodes(createFlow()).map((n) => n.id);
    expect(order[0]).toBe('t1');
    expect(order).toContain('a2');
  });

  it('runs happy path and appends', () => {
    const result = runFlow(createFlow());
    expect(result.ok).toBe(true);
    const last = result.steps[result.steps.length - 1];
    expect(last.output.greeting).toBe('hello world');
  });

  it('stops when filter fails', () => {
    const flow = createFlow();
    flow.nodes.find((n) => n.id === 'f1').config.equals = 'nope';
    const result = runFlow(flow);
    expect(result.ok).toBe(true);
    expect(result.steps.some((s) => s.nodeId === 'a2')).toBe(false);
  });

  it('adds nodes and edges', () => {
    let flow = createFlow();
    flow = addNode(flow, {
      id: 'a3',
      type: 'action',
      kind: 'set_var',
      config: { key: 'x', value: 1 },
    });
    flow = addEdge(flow, { id: 'e9', from: 'a2', to: 'a3' });
    expect(flow.nodes.some((n) => n.id === 'a3')).toBe(true);
  });
});
