// @vitest-environment happy-dom
// Scripts reading and writing node fields added in round 4: optional node fields (hide, mute,
// label, width, parent…) and texture mappings.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp } from '../../src/app/app';
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

describe('node fields from scripts', () => {
  it('hide, mute, select, label, width, color and options', () => {
    expect(
      run(`const nt = D.materials['Material'].node_tree;
        const n = nt.nodes.new('ShaderNodeMath');
        print(n.hide, n.mute, n.label === '', n.width, n.show_options);
        n.hide = true; n.mute = true; n.label = 'Twice'; n.width = 200; n.show_options = false; n.color = [1, 0, 0]; n.use_custom_color = true;
        print(n.hide, n.mute, n.label, n.width, n.show_options, n.color[0], n.use_custom_color);`),
    ).toBe('false false true 140 true\ntrue true Twice 200 false 1 true');
  });

  it('parent accepts frames only', () => {
    expect(
      run(`const nt = D.materials['Material'].node_tree;
        const f = nt.nodes.new('NodeFrame'); const n = nt.nodes.new('ShaderNodeMath');
        n.parent = f; print(n.parent.name);
        try { n.parent = nt.nodes.new('ShaderNodeValue'); } catch (e) { print('refused'); }
        n.parent = null; print(n.parent);`),
    ).toBe('Frame\nrefused\nnull');
  });

  it('texture_mapping of texture nodes', () => {
    expect(
      run(`const nt = D.materials['Material'].node_tree;
        const n = nt.nodes.new('ShaderNodeTexNoise');
        const tm = n.texture_mapping;
        print(tm.vector_type, tm.scale[0], tm.mapping_x);
        tm.scale = [2, 3, 4]; tm.rotation[2] = 0.5; tm.vector_type = 'TEXTURE'; tm.mapping_y = 'NONE';
        print(n.texture_mapping.scale.join(','), n.texture_mapping.rotation[2], n.texture_mapping.vector_type, n.texture_mapping.mapping_y);
        try { tm.mapping_z = 'W'; } catch (e) { print('refused'); }
        print(nt.nodes.new('ShaderNodeMath').texture_mapping);`),
    ).toBe('POINT 1 X\n2,3,4 0.5 TEXTURE NONE\nrefused\nundefined');
  });
});
