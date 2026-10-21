// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, operators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript, output } from '../../src/scripting/runner';
import { callOperator } from '../../src/scripting/api';
import { handlers } from '../../src/scripting/handlers';
import type { MeshData } from '../../src/data/types';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}
const obj = (name: string) => Object.values(app.doc.objects).find((o) => o.name === name)!;
const mesh = (name: string) => app.doc.meshes[obj(name).data!] as MeshData;

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  await new Promise((r) => setTimeout(r, 10));
}, 60000);

beforeEach(() => {
  setApp(new App(startupDocument()));
  for (const l of Object.values(handlers) as unknown[]) if (Array.isArray(l)) l.length = 0;
});

describe('every operator is callable from scripts', () => {
  it('exposes each registered operator under bpy.ops with poll()', () => {
    const ids = [...operators.keys()];
    expect(ids.length).toBeGreaterThan(1000);
    const missing = run(`const out = []; for (const id of ${JSON.stringify(ids)}) { const [m, n] = id.split('.'); const f = bpy.ops[m]?.[n]; if (typeof f !== 'function' || typeof f.poll !== 'function' || typeof f.poll() !== 'boolean') out.push(id); } print(out.join(','))`);
    expect(missing).toBe('');
  }, 30_000);

  it('returns FINISHED / CANCELLED and raises when poll fails', () => {
    expect(run(`print([...bpy.ops.mesh.primitive_cube_add({size: 1})][0])`)).toBe('FINISHED');
    expect(() => run(`bpy.ops.object.mode_set({mode: 'OBJECT'}); bpy.ops.mesh.subdivide()`)).toThrow(/poll\(\) failed/);
    expect(callOperator('object.select_all', { action: 'DESELECT' })).toBe('FINISHED');
  });
});

describe('mesh access', () => {
  it('edges include loose edges from from_pydata, with seam and sharp flags on face edges', () => {
    expect(
      run(`
      const me = D.meshes.new('M');
      me.from_pydata([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[2,2,0]], [[2,4]], [[0,1,2,3]]);
      print(me.vertices.length, me.edges.length, me.polygons.length, me.loops.length);
      const e = me.edges[0]; e.use_seam = true; e.use_edge_sharp = true; e.crease = 0.5;
      print(me.edges[0].use_seam, me.edges[0].crease, me.edges[4].is_loose, me.edges[4].vertices);
      const flat = new Array(me.edges.length * 2).fill(0); me.edges.foreach_get('vertices', flat); print(flat.length);
    `),
    ).toBe('5 5 1 4\ntrue 0.5 true [2, 4]\n10');
  });

  it('builds a mesh with add() + foreach_set + update()', () => {
    run(`
      const me = D.meshes.new('Tri');
      me.vertices.add(4);
      me.vertices.foreach_set('co', [0,0,0, 1,0,0, 1,1,0, 0,1,0]);
      me.loops.add(4); me.loops.foreach_set('vertex_index', [0,1,2,3]);
      me.polygons.add(1); me.polygons.foreach_set('loop_start', [0]); me.polygons.foreach_set('loop_total', [4]);
      me.update();
      const ob = D.objects.new('Quad', me); C.collection.objects.link(ob);
      print(me.polygons.length, me.polygons[0].area);
    `);
    expect(output.lines[0].text).toBe('1 1');
    expect(mesh('Quad').offsets.length).toBe(2);
  });

  it('attributes, color attributes, vertex colors and face sets', () => {
    expect(
      run(`
      const me = D.objects['Cube'].data;
      print(me.attributes['position'].data.length, me.attributes['position'].data_type);
      const col = me.color_attributes.new('Paint', 'FLOAT_COLOR', 'POINT');
      col.data[0].color = [1, 0, 0, 1];
      print(me.color_attributes.length, me.color_attributes.active_color.name, me.attributes['Paint'].data[0].color[0]);
      const vc = me.vertex_colors.new('Corners'); print(vc.domain, vc.data.length);
      const fs = me.attributes.new('.sculpt_face_set', 'INT', 'FACE'); fs.data[2].value = 7;
      print(me.attributes['.sculpt_face_set'].data[2].value);
      const w = me.attributes.new('weird', 'FLOAT', 'EDGE'); w.data[3].value = 0.5;
      print(w.data.length, me.attributes['weird'].data[3].value);
    `),
    ).toBe('8 FLOAT_VECTOR\n1 Paint 1\nCORNER 24\n7\n12 0.5');
    expect(mesh('Cube').sculpt_face_set![2]).toBe(7);
  });

  it('custom split normals and loop triangles', () => {
    expect(
      run(`
      const me = D.objects['Cube'].data;
      print(me.has_custom_normals, me.loop_triangles.length);
      me.normals_split_custom_set_from_vertices(Array.from({length: me.vertices.length}, () => [0, 0, 1]));
      print(me.has_custom_normals, me.loops[5].normal.z, me.corner_normals[0].vector.z);
      me.normals_split_custom_set([]); print(me.has_custom_normals);
    `),
    ).toBe('false 12\ntrue 1 1\nfalse');
  });
});

describe('data-blocks', () => {
  it('grease pencil layers, frames, strokes and points', () => {
    run(`
      const gp = D.grease_pencils.new('Sketch');
      const layer = gp.layers.new('Lines');
      const frame = layer.frames.new(1);
      frame.drawing.add_strokes([3]);
      const st = frame.drawing.strokes[0];
      st.points[1].position = [1, 0, 0]; st.points[2].position = [1, 1, 0]; st.points[2].radius = 0.05;
      st.cyclic = true;
      const ob = D.objects.new('Sketch', gp); C.collection.objects.link(ob);
      const m = ob.modifiers.new('Thick', 'GREASE_PENCIL_THICKNESS');
      const fx = ob.shader_effects.new('Glow', 'FX_GLOW');
      print(ob.type, gp.layers.length, layer.frames.length, frame.drawing.strokes.length, st.points.length, st.cyclic, m.type, fx.type);
      try { D.objects['Cube'].modifiers.new('x', 'GREASE_PENCIL_TINT') } catch (e) { print('mesh refused') }
    `);
    expect(output.lines.map((l) => l.text)).toEqual(['GREASEPENCIL 1 1 1 3 true GREASE_PENCIL_THICKNESS FX_GLOW', 'mesh refused']);
    const gp = Object.values(app.doc.grease_pencils!)[0];
    expect(Array.from(gp.drawings[0].position)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
  });

  it('speakers, masks and metaballs', () => {
    expect(
      run(`
      const spk = D.speakers.new('Voice'); spk.volume = 0.5;
      const ob = D.objects.new('Voice', spk); C.collection.objects.link(ob);
      print(ob.type, ob.data.volume, D.speakers.length);
      const mask = D.masks.new('Matte');
      const layer = mask.layers.new('Shape');
      const spline = layer.splines.new(); spline.points.add(3); spline.use_cyclic = true;
      print(mask.layers.length, layer.splines[0].points.length);
      const mb = D.metaballs.new('Blob'); mb.elements.new(); print(mb.elements.length);
    `),
    ).toBe('SPEAKER 0.5 2\n2 3\n1');
    expect(obj('Voice').speaker!.volume).toBe(0.5);
  });

  it('pose bones, bones and edit bones', () => {
    expect(
      run(`
      bpy.ops.object.armature_add();
      const arm = C.object;
      bpy.ops.object.mode_set({mode: 'EDIT'});
      const eb = arm.data.edit_bones.new('Tip'); eb.head = [0, 0, 1]; eb.tail = [0, 0, 1.5]; eb.parent = arm.data.edit_bones['Bone'];
      bpy.ops.object.mode_set({mode: 'POSE'});
      print(arm.data.bones.length, arm.data.bones['Tip'].parent.name, arm.pose.bones.length);
      const pb = arm.pose.bones['Bone']; pb.rotation_mode = 'XYZ'; pb.rotation_euler.x = 0.5;
      pb.keyframe_insert('rotation_euler', {frame: 4});
      const c = pb.constraints.new('IK'); print(c.type, pb.matrix.to_translation().length < 1e-6);
      print(arm.animation_data.action.fcurves[0].data_path);
      try { arm.data.edit_bones.new('x') } catch (e) { print('not in edit mode') }
    `),
    ).toBe('2 Bone 2\nIK true\npose.bones["Bone"].rotation_euler\nnot in edit mode');
  });

  it('sequencer strips, view layer passes and render settings', () => {
    expect(
      run(`
      const ed = C.scene.sequence_editor_create();
      const color = ed.strips.new_effect('Red', 'COLOR', 1, 1, {frame_end: 25});
      color.color = [1, 0, 0];
      const scene = ed.strips.new_scene('Shot', C.scene, 2, 1);
      const cross = ed.strips.new_effect('Mix', 'CROSS', 3, 1, 25, color, scene);
      print(ed.strips.length, cross.input_1.name, cross.input_2.name, color.frame_final_duration);
      ed.active_strip = cross; print(C.active_strip.name);
      C.view_layer.use_pass_z = true; C.scene.view_layers['ViewLayer'].use_pass_normal = true;
      C.scene.render.resolution_x = 640;
      print(C.scene.render.use_pass_z, C.scene.render.use_pass_normal, C.scene.render.resolution_x);
    `),
    ).toBe('3 Red Shot 24\nMix\ntrue true 640');
  });
});

describe('context', () => {
  it('temp_override sets the active object and selection for operators, then restores them', () => {
    expect(
      run(`
      const cam = D.objects['Camera'];
      C.temp_override({active_object: cam, selected_objects: [cam]}, () => {
        print(C.object.name, C.selected_objects.length);
        bpy.ops.object.delete();
      });
      print(D.objects.get('Camera') === null, C.object.name);
    `),
    ).toBe('Camera 1\ntrue Cube');
  });

  it('exposes data by type and tool settings', () => {
    expect(run(`print(C.mesh.name, C.light, C.tool_settings.keyframe_type, C.mode, C.region === null || typeof C.region.type)`)).toMatch(/^Cube null KEYFRAME OBJECT /);
  });
});

describe('handlers and timers', () => {
  it('frame_change_post handlers run with the scene after a frame change', () => {
    run(`
      bpy.app.handlers.frame_change_post.push((scene) => { D.objects['Cube'].location.z = scene.frame_current / 10; });
    `);
    app.setFrame(20);
    expect(obj('Cube').location[2]).toBeCloseTo(2);
    run(`C.scene.frame_set(30)`);
    expect(obj('Cube').location[2]).toBeCloseTo(3);
  });

  it('depsgraph_update_post runs after evaluation; non-persistent handlers go away on load', () => {
    let n = 0;
    handlers.depsgraph_update_post.push(() => n++);
    const keep = handlers.persistent(() => n++);
    handlers.load_post.push(keep);
    app.evaluate();
    expect(n).toBe(1);
    app.setDocument(startupDocument());
    expect(handlers.depsgraph_update_post.length).toBe(0);
    expect(handlers.load_post).toEqual([keep]);
  });

  it('timers run again after the delay they return', async () => {
    run(`
      let k = 0;
      bpy.app.timers.register(() => { k++; D.objects['Cube'].location.x = k; return k < 3 ? 0.001 : null; });
    `);
    await new Promise((r) => setTimeout(r, 60));
    expect(obj('Cube').location[0]).toBe(3);
  });
});

describe('curves and shape keys', () => {
  it('splines.new and points.add build curves', () => {
    expect(
      run(`
      const cu = D.curves.new('Path', 'CURVE'); cu.dimensions = '3D';
      const sp = cu.splines.new('BEZIER'); sp.bezier_points.add(2);
      sp.bezier_points[2].co = [2, 0, 0];
      const poly = cu.splines.new('POLY'); poly.points.add(3);
      print(cu.splines.length, sp.bezier_points.length, poly.points.length, sp.bezier_points[2].co.x, poly.points[0].co.w);
      const ob = D.objects.new('Path', cu); C.collection.objects.link(ob);
    `),
    ).toBe('2 3 4 2 1');
  });

  it('shape keys with point data and keyframed values', () => {
    expect(
      run(`
      const ob = D.objects['Cube'];
      ob.shape_key_add({name: 'Basis'}); const k = ob.shape_key_add({name: 'Up'});
      k.data[0].co.z += 1; k.value = 0.5;
      k.keyframe_insert('value', {frame: 3});
      const keys = ob.data.shape_keys.key_blocks;
      print(keys.length, keys['Up'].relative_key.name, ob.active_shape_key_index, ob.animation_data.action.fcurves[0].data_path);
      ob.shape_key_remove(k); print(ob.data.shape_keys.key_blocks.length);
    `),
    ).toBe('2 Basis 0 data.shape_keys.key_blocks["Up"].value\n1');
  });
});

describe('geometry node groups from scripts', () => {
  it('interface sockets feed the modifier, set as mod["Socket_n"]', () => {
    expect(
      run(`
      const ng = D.node_groups.new('Grow', 'GeometryNodeTree');
      const s = ng.interface.new_socket({name: 'Height', in_out: 'INPUT', socket_type: 'NodeSocketFloat'});
      s.default_value = 2;
      const inp = ng.nodes['Group Input'], out = ng.nodes['Group Output'];
      const tr = ng.nodes.new('GeometryNodeTransform');
      const comb = ng.nodes.new('ShaderNodeCombineXYZ');
      ng.links.new(inp.outputs['Geometry'], tr.inputs['Geometry']);
      ng.links.new(inp.outputs['Height'], comb.inputs['Z']);
      ng.links.new(comb.outputs['Vector'], tr.inputs['Translation']);
      ng.links.new(tr.outputs['Geometry'], out.inputs['Geometry']);
      const ob = D.objects['Cube'];
      const mod = ob.modifiers.new('GN', 'NODES'); mod.node_group = ng;
      print(s.identifier, mod[s.identifier], ng.interface.items_tree.length);
      mod[s.identifier] = 5;
      print(mod.keys().join(','), ob.dimensions.z);
    `),
    ).toMatch(/^Socket_\d+ 2 3\nSocket_\d+ 2$/);
    app.evaluate();
    const ev = app.graph.get(obj('Cube').id)!;
    let maxZ = -Infinity;
    for (let i = 2; i < ev.mesh!.positions.length; i += 3) maxZ = Math.max(maxZ, ev.mesh!.positions[i]);
    expect(maxZ).toBeCloseTo(6);
  });
});

describe('object helpers', () => {
  it('bound_box corners and the plain duplicate operator', () => {
    expect(
      run(`
      const ob = D.objects['Cube'];
      print(ob.bound_box[0].join(','), ob.bound_box[6].join(','));
      bpy.ops.object.select_all({action: 'DESELECT'}); ob.select_set(true); C.view_layer.objects.active = ob;
      print([...bpy.ops.object.duplicate()][0], C.object.name, C.object.location.x);
    `),
    ).toBe('-1,-1,-1 1,1,1\nFINISHED Cube.001 0');
  });
});

describe('properties added to data types', () => {
  it('scalar properties, property groups and collections on objects and the scene', () => {
    expect(
      run(`
      bpy.types.Object.weight = bpy.props.FloatProperty({default: 1.5, min: 0, max: 10});
      class Settings extends bpy.types.PropertyGroup { static properties = { count: bpy.props.IntProperty({default: 3}), label: bpy.props.StringProperty({default: 'x'}) } }
      bpy.utils.register_class(Settings);
      bpy.types.Scene.settings = bpy.props.PointerProperty({type: Settings});
      bpy.types.Scene.items = bpy.props.CollectionProperty({type: Settings});
      const ob = D.objects['Cube'];
      print(ob.weight); ob.weight = 20; print(ob.weight, ob['weight']);
      print(C.scene.settings.count); C.scene.settings.count = 7;
      const it = C.scene.items.add(); it.label = 'first';
      print(C.scene.settings.count, C.scene.items.length, C.scene.items[0].label, C.scene.items[0].count);
    `),
    ).toBe('1.5\n10 10\n3\n7 1 first 3');
  });
});

describe('sequencer retiming and connections', () => {
  it('adds retiming keys, changes a segment speed and connects strips', () => {
    expect(
      run(`
      const ed = C.scene.sequence_editor_create();
      const shot = ed.strips.new_scene('Shot', C.scene, 1, 1);
      const col = ed.strips.new_effect('Tint', 'COLOR', 2, 1, {frame_end: 50});
      const k = shot.retiming_keys.add(51);
      print(shot.retiming_keys.length, k.timeline_frame);
      shot.retiming_keys[0].speed = 2;
      print(shot.retiming_keys[0].speed, shot.frame_final_duration);
      shot.connect([col]); print(shot.connected_strips.map((x) => x.name).join(','), col.connected_strips[0].name);
      col.disconnect(); print(shot.connected_strips.length);
    `),
    ).toBe('3 51\n2 225\nTint Shot\n0');
  });
});

describe('script menus', () => {
  it('a registered menu draws operators, labels and submenus', async () => {
    const { menuItems } = await import('../../src/scripting/menus');
    run(`
      class Tools extends bpy.types.Menu {
        static bl_idname = 'VIEW3D_MT_my_tools'; static bl_label = 'My Tools';
        draw(context) { const l = this.layout; l.label('Add'); l.operator('mesh.primitive_cube_add', {text: 'Box'}).size = 0.5; l.separator(); l.menu('VIEW3D_MT_my_more'); }
      }
      class More extends bpy.types.Menu { static bl_idname = 'VIEW3D_MT_my_more'; static bl_label = 'More'; draw() { this.layout.operator('object.shade_smooth'); } }
      bpy.utils.register_class(Tools); bpy.utils.register_class(More);
    `);
    const items = menuItems('VIEW3D_MT_my_tools');
    expect(items.map((i) => i.heading ?? i.label ?? (i.separator ? '—' : '?'))).toEqual(['Add', 'Box', '—', 'More']);
    expect(items[1]).toMatchObject({ op: 'mesh.primitive_cube_add', props: { size: 0.5 } });
    expect(items[3].submenu!().map((i) => i.op)).toEqual(['object.shade_smooth']);
  });
});
