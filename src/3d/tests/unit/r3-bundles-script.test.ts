// @vitest-environment happy-dom
// Scripts building bundle, closure, list, capture and viewer item lists.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import '../../src/geonodes/editor';
import { runJavaScript, output } from '../../src/scripting/runner';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

beforeEach(() => setApp(new App(startupDocument())));

describe('item lists from scripts', () => {
  it('bundle, closure and list items', () => {
    expect(
      run(`const g = D.node_groups.new('B', 'GeometryNodeTree');
        const c = g.nodes.new('NodeCombineBundle');
        const a = c.bundle_items.new('GEOMETRY', 'Mesh'); c.bundle_items.new('FLOAT');
        print(c.bundle_items.length, a.socket_type, c.inputs[0].name, c.inputs[1].name);
        const e = g.nodes.new('NodeEvaluateClosure');
        e.input_items.new('INT', 'Count'); e.output_items.new('GEOMETRY', 'Result');
        print(e.inputs[1].name, e.outputs[0].name);
        const ci = g.nodes.new('NodeClosureInput'); const co = g.nodes.new('NodeClosureOutput');
        print(ci.pair_with_output(co)); co.input_items.new('FLOAT', 'X'); print(ci.outputs[0].name);
        const l = g.nodes.new('GeometryNodeFieldToList'); l.list_items.new('VECTOR', 'P');
        print(l.inputs[1].name, l.outputs[0].name);`),
    ).toBe('2 GEOMETRY Mesh Float\nCount Result\ntrue\nX\nP P');
  });
  it('capture and viewer items', () => {
    expect(
      run(`const g = D.node_groups.new('C', 'GeometryNodeTree');
        const c = g.nodes.new('GeometryNodeCaptureAttribute');
        const a = c.capture_items.new('FLOAT_VECTOR', 'Pos'); print(c.capture_items.length, a.data_type, c.outputs[1].name);
        c.capture_items.remove(a); print(c.capture_items.length);
        const v = g.nodes.new('GeometryNodeViewer'); v.viewer_items.new('INT', 'Id'); print(v.inputs[2].name);`),
    ).toBe('1 FLOAT_VECTOR Pos\n0\nId');
  });
});
