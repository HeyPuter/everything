// @vitest-environment happy-dom
// Scripts reach the round-4 modeling data: several UV maps, generic attributes, surface objects,
// bevel weights / vertex creases and the new operators.
import { describe, it, expect, beforeEach } from 'vitest';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/modeling/index';
import '../../src/surface/index';
import { runJavaScript, output } from '../../src/scripting/runner';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

beforeEach(() => setApp(new App(startupDocument())));

describe('scripting the modeling data', () => {
  it('UV maps: new keeps the active map, active switches, remove deletes', () => {
    expect(
      run(`
      const me = D.objects['Cube'].data;
      const second = me.uv_layers.new('Second');
      print(me.uv_layers.length, me.uv_layers.active.name, second.name);
      second.data[0].uv = [0.25, 0.75];
      me.uv_layers.active = second;
      print(me.uv_layers.active.name, me.uv_layers.active.data[0].uv[0]);
      me.uv_layers.remove(me.uv_layers['UVMap']);
      print(me.uv_layers.length, me.uv_layers.active.name);
    `),
    ).toBe('2 UVMap Second\nSecond 0.25\n1 Second');
  });
  it('generic attributes and bevel weights', () => {
    expect(
      run(`
      const me = D.objects['Cube'].data;
      const a = me.attributes.new('heat', 'FLOAT', 'POINT'); a.data[3].value = 2.5;
      const bw = me.attributes.new('bevel_weight_edge', 'FLOAT', 'EDGE'); bw.data[0].value = 1;
      print(me.attributes['heat'].data[3].value, me.attributes['bevel_weight_edge'].data[0].value);
    `),
    ).toBe('2.5 1');
  });
  it('surface data makes surface objects; operators by name', () => {
    expect(
      run(`
      const cu = D.curves.new('S', 'SURFACE');
      const ob = D.objects.new('S', cu);
      print(ob.type);
      bpy.ops.surface.primitive_nurbs_surface_torus_add();
      print(C.object.type, C.object.data.splines[0].point_count_u, C.object.data.splines[0].point_count_v);
    `),
    ).toBe('SURFACE\nSURFACE 8 8');
  });
});
