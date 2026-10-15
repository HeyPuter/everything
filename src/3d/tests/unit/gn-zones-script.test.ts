// @vitest-environment happy-dom
// Zones from scripts: item collections and pairing.
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

describe('zones from scripts', () => {
  it('pair zone nodes and edit their items', () => {
    expect(
      run(`const g = D.node_groups.new('Z', 'GeometryNodeTree');
        const i = g.nodes.new('GeometryNodeRepeatInput'); const o = g.nodes.new('GeometryNodeRepeatOutput');
        print(i.pair_with_output(o), i.paired_output.name);
        const v = o.repeat_items.new('FLOAT', 'Value');
        print(o.repeat_items.length, v.name, v.socket_type, i.inputs.length, i.inputs[2].name);
        v.name = 'Height'; v.socket_type = 'VECTOR';
        print(o.repeat_items[1].name, o.outputs['Height'].type);
        o.repeat_items.move(1, 0); print(o.repeat_items[0].name);
        o.repeat_items.remove(o.repeat_items['Geometry']); print(o.repeat_items.length);
        print(i.repeat_items);`),
    ).toBe('true Repeat Output\n2 Value FLOAT 4 Value\nHeight VECTOR\nHeight\n1\nundefined');
    const tree = Object.values(app.doc.node_groups)[0].tree;
    expect(tree.nodes.find((n) => n.type === 'GeometryNodeRepeatInput')!.props.paired_output).toBe(tree.nodes.find((n) => n.type === 'GeometryNodeRepeatOutput')!.id);
  });
  it('simulation state items have a domain; for-each lists accept only field types for inputs', () => {
    expect(
      run(`const g = D.node_groups.new('S', 'GeometryNodeTree');
        const o = g.nodes.new('GeometryNodeSimulationOutput');
        const s = o.state_items.new('FLOAT', 'Speed'); s.attribute_domain = 'FACE'; print(s.attribute_domain);
        const f = g.nodes.new('GeometryNodeForeachGeometryElementOutput');
        print(f.generation_items.length, f.main_items.new('INT', 'Count').socket_type);
        try { f.input_items.new('GEOMETRY', 'G'); } catch (e) { print('refused'); }`),
    ).toBe('FACE\n1 INT\nrefused');
  });
});
