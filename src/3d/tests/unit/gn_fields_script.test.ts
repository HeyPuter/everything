// @vitest-environment happy-dom
// Scripts building function and switch nodes: item lists and menu inputs.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { runJavaScript, output } from '../../src/scripting/runner';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

beforeEach(() => setApp(new App(startupDocument())));

describe('function nodes from scripts', () => {
  it('Format String items are added, renamed and typed', () => {
    expect(
      run(`const g = D.node_groups.new('F', 'GeometryNodeTree');
        const f = g.nodes.new('FunctionNodeFormatString');
        const a = f.format_items.new('FLOAT', 'x'); f.format_items.new('INT', 'count');
        print(f.format_items.length, a.name, a.socket_type, f.inputs[1].name, f.inputs[2].type);
        a.name = 'width'; print(f.inputs[1].name);
        f.format_items.remove(a); print(f.format_items.length, f.inputs[1].name);`),
    ).toBe('2 x FLOAT x INT\nwidth\n1 count');
  });
  it('Index Switch and Menu Switch items', () => {
    expect(
      run(`const g = D.node_groups.new('S', 'GeometryNodeTree');
        const i = g.nodes.new('GeometryNodeIndexSwitch'); i.index_switch_items.new();
        print(i.index_switch_items.length, i.inputs.length);
        const m = g.nodes.new('GeometryNodeMenuSwitch'); m.enum_items.new('Cone');
        print(m.enum_items.length, m.enum_items[2].name, m.outputs[3].name);`),
    ).toBe('3 5\n3 Cone Cone');
  });
  it('menu inputs shown as properties take values by name', () => {
    expect(
      run(`const g = D.node_groups.new('M', 'GeometryNodeTree');
        const n = g.nodes.new('FunctionNodeMatchString');
        n.inputs['Operation'].default_value = 'Contains'; print(n.inputs['Operation'].default_value);
        try { n.inputs['Operation'].default_value = 'Nope'; } catch (e) { print('refused'); }`),
    ).toBe('Contains\nrefused');
    const tree = Object.values(app.doc.node_groups).find((x) => x.name === 'M')!.tree;
    expect(tree.nodes.find((n) => n.type === 'FunctionNodeMatchString')!.props.Operation).toBe('Contains');
  });
});
