// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/nodes/shader/defs';
import '../../src/ops/object';
import '../../src/eval/modifiers_extra';
import { runJavaScript, output } from '../../src/scripting/runner';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}
const cube = () => Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;

beforeEach(() => setApp(new App(startupDocument())));

describe('keyframes on any animatable property', () => {
  it('keys object, data, modifier and material socket properties on the object', () => {
    run(`
      const ob = D.objects['Cube'];
      ob.keyframe_insert('location', {index: 2, frame: 5});
      const m = ob.modifiers.new('Sub', 'SUBSURF'); m.levels = 2;
      m.keyframe_insert('levels', {frame: 1});
      ob.keyframe_insert('modifiers["Sub"].levels', {frame: 10});
      const light = D.objects['Light'].data; light.energy = 500; light.keyframe_insert('energy', {frame: 3});
      const mat = D.materials.new('M'); ob.active_material = mat;
      mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].keyframe_insert('default_value', {frame: 7});
    `);
    const act = app.doc.actions[cube().animation_data!.action!];
    const paths = act.fcurves.map((f) => `${f.data_path}[${f.array_index}]`);
    expect(paths).toContain('location[2]');
    expect(paths).not.toContain('location[0]');
    expect(paths).toContain('modifiers["Sub"].levels[0]');
    expect(act.fcurves.find((f) => f.data_path === 'modifiers["Sub"].levels')!.keyframe_points.map((k) => k.co[0])).toEqual([1, 10]);
    expect(paths.some((p) => p.startsWith('material.nodes["Principled BSDF"].inputs["Roughness"]'))).toBe(true);
    const lightOb = Object.values(app.doc.objects).find((o) => o.name === 'Light')!;
    expect(app.doc.actions[lightOb.animation_data!.action!].fcurves[0].data_path).toBe('data.energy');
  });

  it('keyframe_delete removes keys and raises when there is none', () => {
    expect(run(`
      const ob = D.objects['Cube'];
      ob.keyframe_insert('scale', {frame: 1}); ob.keyframe_insert('scale', {frame: 2});
      ob.keyframe_delete('scale', {frame: 1});
      print(ob.animation_data.action.fcurves.find('scale', 0).keyframe_points.length);
      try { ob.keyframe_delete('scale', {frame: 99}); } catch (e) { print('raised') }
    `)).toBe('1\nraised');
  });

  it('path_resolve, path_from_id and id_data', () => {
    expect(run(`
      const ob = D.objects['Cube']; ob.modifiers.new('Bev', 'BEVEL');
      print(ob.path_resolve('location[1]'), ob.path_resolve('modifiers["Bev"].segments'));
      const m = ob.modifiers['Bev'];
      print(m.path_from_id(), m.path_from_id('width'), m.id_data.name);
    `)).toBe('0 1\nmodifiers["Bev"] modifiers["Bev"].width Cube');
  });
});

describe('drivers', () => {
  it('driver_add makes a scripted driver that evaluates', () => {
    run(`
      const ob = D.objects['Cube'];
      const fc = ob.driver_add('location', 2);
      print(fc.driver.type, fc.driver.expression);
      const v = fc.driver.variables.new(); v.name = 'lx';
      v.targets[0].id = D.objects['Light']; v.targets[0].data_path = 'location[0]';
      fc.driver.expression = 'lx * 2';
      print(ob.driver_add('scale').length);
    `);
    app.evaluate();
    const light = Object.values(app.doc.objects).find((o) => o.name === 'Light')!;
    expect(cube().location[2]).toBeCloseTo(light.location[0] * 2);
    expect(output.lines.map((l) => l.text)).toEqual(['SCRIPTED 0.0', '3']);
    expect(run(`print(D.objects['Cube'].animation_data.drivers.length, D.objects['Cube'].driver_remove('scale'), D.objects['Cube'].animation_data.drivers.length)`)).toBe('4 true 1');
  });
});

describe('NLA, keying sets and markers', () => {
  it('builds NLA tracks and strips', () => {
    expect(run(`
      const ob = D.objects['Cube'];
      ob.location.x = 1; ob.keyframe_insert('location', {frame: 1}); ob.location.x = 3; ob.keyframe_insert('location', {frame: 21});
      const act = ob.animation_data.action;
      ob.animation_data.action = null;
      const t = ob.animation_data.nla_tracks.new(); t.name = 'Walk';
      const s = t.strips.new('Step', 100, act);
      print(t.name, s.frame_start, s.frame_end, s.action.name);
      try { t.strips.new('Overlap', 110, act) } catch (e) { print('overlap') }
    `)).toBe('Walk 100 120 CubeAction\noverlap');
    app.setFrame(110);
    app.evaluate();
    expect(cube().location[0]).toBeCloseTo(2, 1);
  });

  it('keying sets with paths, and timeline markers', () => {
    expect(run(`
      const ks = C.scene.keying_sets.new({idname: 'KS', name: 'Mine'});
      ks.paths.add(D.objects['Cube'], 'location');
      ks.paths.add(D.objects['Light'].data, 'energy');
      print(ks.bl_label, ks.paths.length, ks.paths[1].data_path, C.scene.keying_sets.active.bl_label);
      const m = C.scene.timeline_markers.new('Hit', {frame: 12}); m.camera = D.objects['Camera'];
      print(C.scene.timeline_markers.length, C.scene.timeline_markers['Hit'].frame, m.camera.name);
    `)).toBe('Mine 2 data.energy Mine\n1 12 Camera');
  });

  it('fcurve keyframe_points foreach_set and modifiers', () => {
    expect(run(`
      const act = D.actions.new('Bounce');
      const fc = act.fcurves.new('location', {index: 2});
      fc.keyframe_points.add(3);
      fc.keyframe_points.foreach_set('co', [1, 0, 10, 2, 20, 0]);
      fc.update();
      print(fc.keyframe_points.length, fc.evaluate(10));
      const mod = fc.modifiers.new('CYCLES'); print(mod.type, fc.modifiers.length);
    `)).toBe('3 2\nCYCLES 1');
  });
});
