import { describe, it, expect, beforeEach } from 'vitest';

// The app schedules redraws with requestAnimationFrame; provide a stub in Node.
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, registerOperators, operators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { bpy, callOperator, purgeOrphanData } from '../../src/scripting/api';
import { Vector, Matrix, Euler, Quaternion } from '../../src/scripting/mathutils';
import { runJavaScript, inScript, output, evalConsoleJS } from '../../src/scripting/runner';
import { registerScriptOperator, scriptOperators, unregisterScriptOperator, UILayout } from '../../src/scripting/registry';
import { formatOpCall } from '../../src/scripting/oplog';
import type { MeshData } from '../../src/data/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const B = bpy as Any;

beforeEach(() => {
  setApp(new App(startupDocument()));
  output.clear();
});

describe('bpy.data collections', () => {
  it('supports [name], get, len, iteration, index and keys', () => {
    const objs = B.data.objects;
    expect(objs.length).toBe(3);
    expect(objs['Cube'].name).toBe('Cube');
    expect(objs.get('Nope')).toBeNull();
    expect(objs.get('Camera').type).toBe('CAMERA');
    expect([...objs].map((o: Any) => o.name).sort()).toEqual(['Camera', 'Cube', 'Light']);
    expect(objs[0].name).toBe(objs.getItem(0).name);
    expect(objs.keys()).toContain('Light');
    expect(objs.contains('Cube')).toBe(true);
    expect(() => objs.getItem('Nope')).toThrow(/KeyError/);
  });

  it('wrappers are identity-stable and survive undo', () => {
    const a = B.data.objects['Cube'];
    expect(B.data.objects['Cube']).toBe(a);
    inScript('Run Script', () => (a.location.x = 3));
    expect(app.doc.objects[a.__id].location[0]).toBe(3);
    app.undoStep();
    expect(a.location.x).toBe(0);
  });

  it('creates and removes data-blocks with unique names', () => {
    const m1 = B.data.materials.new('Red');
    const m2 = B.data.materials.new('Red');
    expect(m1.name).toBe('Red');
    expect(m2.name).toBe('Red.001');
    B.data.materials.remove(m2);
    expect(B.data.materials.get('Red.001')).toBeNull();
    const light = B.data.lights.new('Key', 'SUN');
    expect(light.type).toBe('SUN');
    const ob = B.data.objects.new('KeyLight', light);
    expect(ob.type).toBe('LIGHT');
    expect(ob.data.name).toBe('Key');
    B.context.scene.collection.objects.link(ob);
    expect(B.context.scene.objects.contains('KeyLight')).toBe(true);
    expect(() => B.data.lights.new('x', 'LASER')).toThrow(/TypeError/);
  });

  it('removing mesh data removes objects that use it', () => {
    const cube = B.data.objects['Cube'];
    const me = cube.data;
    B.data.meshes.remove(me);
    expect(B.data.objects.get('Cube')).toBeNull();
    expect(app.doc.scene.active_object).toBeNull();
  });
});

describe('objects', () => {
  it('location / rotation_euler / scale are live vectors', () => {
    const ob = B.data.objects['Cube'];
    ob.location = [1, 2, 3];
    expect(Array.from(app.doc.objects[ob.__id].location)).toEqual([1, 2, 3]);
    ob.location.z += 1;
    expect(ob.location.z).toBe(4);
    ob.scale[0] = 2;
    expect(ob.scale.x).toBe(2);
    ob.rotation_euler = new Euler([0.1, 0.2, 0.3]);
    expect(ob.rotation_euler).toBeInstanceOf(Euler);
    expect(ob.rotation_euler.order).toBe('XYZ');
    expect(() => (ob.location = [1, 2])).toThrow(/ValueError/);
    expect(() => (ob.no_such_prop = 1)).toThrow(/AttributeError/);
    expect(() => (ob.hide_render = 'yes')).toThrow(/TypeError/);
  });

  it('name, parent, select/hide, custom properties', () => {
    const cube = B.data.objects['Cube'];
    const cam = B.data.objects['Camera'];
    cube.name = 'Camera';
    expect(cube.name).toBe('Camera.001');
    cube.parent = cam;
    expect(cube.parent).toBe(cam);
    expect(() => (cam.parent = cube)).toThrow(/loop/);
    cube.parent = null;
    cube.select_set(false);
    expect(cube.select_get()).toBe(false);
    cube.hide_set(true);
    expect(cube.hide_get()).toBe(true);
    cube.setItem('weight', 5);
    expect(cube.getItem('weight')).toBe(5);
  });

  it('matrix_world reflects transforms and can be assigned', () => {
    const ob = B.data.objects['Cube'];
    ob.location = [1, 2, 3];
    const m: Matrix = ob.matrix_world;
    expect(m.translation.toArray()).toEqual([1, 2, 3]);
    ob.matrix_world = Matrix.Translation([4, 5, 6]).matmul(Matrix.Rotation(Math.PI / 2, 4, 'Z')) as Matrix;
    expect(ob.location.toArray().map((v: number) => +v.toFixed(5))).toEqual([4, 5, 6]);
    expect(+ob.rotation_euler.z.toFixed(5)).toBe(+(Math.PI / 2).toFixed(5));
  });

  it('modifiers.new / remove and constraints.new', () => {
    const ob = B.data.objects['Cube'];
    const m = ob.modifiers.new('Sub', 'SUBSURF');
    m.levels = 2;
    expect(ob.modifiers['Sub'].levels).toBe(2);
    expect(app.doc.objects[ob.__id].modifiers[0].type).toBe('SUBSURF');
    expect(() => ob.modifiers.new('x', 'NOPE')).toThrow(/enum "NOPE" not found/);
    ob.modifiers.remove(m);
    expect(ob.modifiers.length).toBe(0);
    const c = ob.constraints.new('COPY_LOCATION');
    c.target = B.data.objects['Camera'];
    expect(app.doc.objects[ob.__id].constraints[0].target).toBe(B.data.objects['Camera'].__id);
    expect(c.target.name).toBe('Camera');
  });

  it('keyframe_insert creates an action with F-curves', () => {
    const ob = B.data.objects['Cube'];
    ob.location = [0, 0, 0];
    expect(ob.keyframe_insert('location', { frame: 1 })).toBe(true);
    ob.location.x = 5;
    ob.keyframe_insert('location', -1, 10);
    const act = ob.animation_data.action;
    expect(act.fcurves.length).toBe(3);
    const fc = act.fcurves.find('location', 0);
    expect(fc.keyframe_points.length).toBe(2);
    expect(fc.evaluate(10)).toBeCloseTo(5);
    expect(() => ob.keyframe_insert('nonexistent')).toThrow(/TypeError/);
  });
});

describe('meshes', () => {
  it('from_pydata builds polygon meshes; vertices/polygons are accessible', () => {
    const me = B.data.meshes.new('Tri');
    me.from_pydata([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], [], [[0, 1, 3, 2]]);
    me.update();
    expect(me.vertices.length).toBe(4);
    expect(me.polygons.length).toBe(1);
    expect(me.polygons[0].vertices).toEqual([0, 1, 3, 2]);
    expect(me.polygons[0].area).toBeCloseTo(1);
    expect(me.edges.length).toBe(4);
    me.vertices[1].co.x = 2;
    expect((app.doc.meshes[me.__id] as MeshData).positions[3]).toBe(2);
    const ob = B.data.objects.new('Tri', me);
    expect(ob.type).toBe('MESH');
    expect(() => me.from_pydata([[0, 0, 0]], [], [[0, 1, 2]])).toThrow(/IndexError/);
  });

  it('material slots on mesh data', () => {
    const me = B.data.objects['Cube'].data;
    const mat = B.data.materials.new('Blue');
    me.materials.append(mat);
    expect(me.materials.length).toBe(2);
    expect(me.materials[1].name).toBe('Blue');
    me.materials.pop();
    expect(me.materials.length).toBe(1);
  });
});

describe('materials and node trees', () => {
  it('reads and writes socket default values and links', () => {
    const mat = B.data.materials['Material'];
    const bsdf = mat.node_tree.nodes['Principled BSDF'];
    expect(bsdf.bl_idname).toBe('ShaderNodeBsdfPrincipled');
    bsdf.inputs['Base Color'].default_value = [1, 0, 0, 1];
    expect(bsdf.inputs['Base Color'].default_value.r).toBe(1);
    expect(bsdf.inputs['Roughness'].default_value).toBe(0.5);
    bsdf.inputs['Roughness'].default_value = 0.2;
    const n = app.doc.materials[mat.__id].tree.nodes.find((x) => x.name === 'Principled BSDF')!;
    expect(n.inputs['Roughness']).toBe(0.2);
    const tex = mat.node_tree.nodes.new('ShaderNodeTexImage');
    expect(tex.name).toBe('Image Texture');
    const link = mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color']);
    expect(link.from_node.name).toBe('Image Texture');
    expect(bsdf.inputs['Base Color'].is_linked).toBe(true);
    mat.node_tree.links.remove(link);
    expect(bsdf.inputs['Base Color'].is_linked).toBe(false);
    mat.node_tree.nodes.remove(tex);
    expect(mat.node_tree.nodes.get('Image Texture')).toBeNull();
  });
});

describe('context and scene', () => {
  it('exposes active/selected objects, view layer and frames', () => {
    expect(B.context.object.name).toBe('Cube');
    expect(B.context.selected_objects.map((o: Any) => o.name)).toEqual(['Cube']);
    B.context.view_layer.objects.active = B.data.objects['Camera'];
    expect(B.context.active_object.name).toBe('Camera');
    expect(B.context.mode).toBe('OBJECT');
    const sc = B.context.scene;
    sc.frame_end = 120;
    expect(app.doc.scene.frame_end).toBe(120);
    sc.frame_set(24);
    expect(sc.frame_current).toBe(24);
    sc.render.resolution_x = 1280;
    expect(app.doc.scene.render.resolution_x).toBe(1280);
    expect(sc.camera.name).toBe('Camera');
    expect(B.context.collection.name).toBe('Collection');
  });

  it('refuses a frame that is not a number instead of setting NaN', () => {
    const sc = B.context.scene;
    sc.frame_set(12);
    expect(() => (sc.frame_current = 'a')).toThrow(/TypeError/);
    expect(() => sc.frame_set(NaN)).toThrow(/TypeError/);
    expect(() => sc.frame_set(undefined)).toThrow(/TypeError/);
    expect(() => sc.frame_set(5, 'x')).toThrow(/TypeError/);
    expect(app.doc.scene.frame_current).toBe(12);
    expect(app.doc.scene.frame_subframe).toBe(0);
    sc.frame_current = 7.6;
    expect(app.doc.scene.frame_current).toBe(8);
    sc.frame_current = true;
    expect(app.doc.scene.frame_current).toBe(1);
  });
});

describe('bpy.ops', () => {
  it('maps to app.run and returns FINISHED / raises on poll failure', () => {
    let got: Record<string, unknown> | null = null;
    registerOperators([
      { idname: 'test.do_thing', label: 'Do Thing', props: [{ id: 'size', type: 'float', default: 1 }], exec: (_c, p) => void (got = p) },
      { idname: 'test.never', label: 'Never', poll: () => false, exec: () => 'FINISHED' },
      { idname: 'test.fail', label: 'Fail', exec: () => { throw new Error('boom'); } },
    ]);
    const r = B.ops.test.do_thing({ size: 2, location: new Vector([0, 0, 1]) });
    expect([...r]).toEqual(['FINISHED']);
    expect(got).toMatchObject({ size: 2, location: [0, 0, 1] });
    expect(() => B.ops.test.never()).toThrow(/poll\(\) failed/);
    expect(() => B.ops.test.fail()).toThrow(/RuntimeError: Error: Fail: boom/);
    expect(B.ops.test.missing).toBeUndefined();
    expect(() => callOperator('test.missing')).toThrow(/could not be found/);
  });

  it('checks number properties: a wrong type raises, a value past the limits is clamped', () => {
    let got: Record<string, unknown> = {};
    registerOperators([{ idname: 'test.numbers', label: 'Numbers', props: [{ id: 'size', type: 'float', default: 1, min: 0 }, { id: 'count', type: 'int', default: 4, min: 3, max: 100 }], exec: (_c, p) => void (got = p) }]);
    expect(() => B.ops.test.numbers({ size: 'big' })).toThrow(/TypeError: .*size.* expected a number/);
    expect(() => B.ops.test.numbers({ size: NaN })).toThrow(/TypeError/);
    expect(() => B.ops.test.numbers({ count: [1] })).toThrow(/TypeError/);
    B.ops.test.numbers({ size: -2, count: 1e9 });
    expect(got).toMatchObject({ size: 0, count: 100 });
    B.ops.test.numbers({ count: 4.6, size: true });
    expect(got).toMatchObject({ size: 1, count: 5 });
  });

  it('groups a script run into one undo step named "Run Script"', () => {
    registerOperators([{ idname: 'test.add_empty', label: 'Add Empty', exec: (ctx) => void (ctx.doc.scene.frame_end += 1) }]);
    const before = app.undo.history.length;
    const res = runJavaScript(`
      bpy.ops.test.add_empty();
      bpy.ops.test.add_empty();
      bpy.data.objects['Cube'].location.x = 7;
    `);
    expect(res.ok).toBe(true);
    const h = app.undo.history;
    expect(h.length).toBe(before + 1);
    expect(h[h.length - 1].label).toBe('Run Script');
    app.undoStep();
    expect(app.doc.objects[B.data.objects['Cube'].__id].location[0]).toBe(0);
  });

  it('reports JavaScript errors with line numbers', () => {
    const res = runJavaScript('const a = 1;\nconst b = 2;\nbpy.data.objects["Nope"].name = "x";');
    expect(res.ok).toBe(false);
    expect(res.line).toBe(3);
    const syn = runJavaScript('let x = 1;\nlet y = ;\n');
    expect(syn.ok).toBe(false);
    expect(syn.error).toMatch(/SyntaxError/);
    expect(syn.line).toBe(2);
  });

  it('JS console keeps variables between lines and echoes values', () => {
    evalConsoleJS('let n = bpy.data.objects.length');
    evalConsoleJS('n + 1');
    expect(output.lines[output.lines.length - 1].text).toBe('4');
  });
});

describe('script operators', () => {
  it('registers operators with props visible to app.run', () => {
    let seen = 0;
    registerScriptOperator({
      idname: 'object.script_test',
      label: 'Script Test',
      options: ['REGISTER', 'UNDO'],
      props: { count: { __kind: 'propdef', type: 'INT', default: 3, min: 1 } },
      exec: (p) => {
        seen = p.count as number;
        return new Set(['FINISHED']);
      },
      language: 'javascript',
    });
    expect(operators.get('object.script_test')!.props![0]).toMatchObject({ id: 'count', type: 'int', default: 3, label: 'Count' });
    expect([...B.ops.object.script_test({ count: 5 })]).toEqual(['FINISHED']);
    expect(seen).toBe(5);
    expect(scriptOperators.has('object.script_test')).toBe(true);
    unregisterScriptOperator('object.script_test');
    expect(operators.has('object.script_test')).toBe(false);
    expect(() => registerScriptOperator({ idname: 'BadName', label: '', props: {}, exec: () => 'FINISHED', language: 'javascript' })).toThrow(/bl_idname/);
  });

  it('UILayout records items with keyword arguments', () => {
    const l = new UILayout();
    l.label({ text: 'Hello' });
    const row = l.row({ align: true });
    row.prop(B.context.object, 'location');
    const props = l.operator('object.select_all', { text: 'All' });
    props.action = 'SELECT';
    expect(l.items.map((i) => i.t)).toEqual(['label', 'layout', 'operator']);
    expect((l.items[0] as { text: string }).text).toBe('Hello');
  });
});

describe('orphans purge', () => {
  it('removes unused data-blocks but keeps fake users', () => {
    B.data.materials.new('Unused');
    const keep = B.data.materials.new('Keep');
    keep.use_fake_user = true;
    B.data.meshes.new('LooseMesh');
    const n = purgeOrphanData(app.doc);
    expect(n).toBe(2);
    expect(B.data.materials.get('Keep')).not.toBeNull();
    expect(B.data.materials.get('Material')).not.toBeNull();
  });
});

describe('operator log formatting', () => {
  it('formats Python calls', () => {
    expect(formatOpCall('transform.translate', { value: [1, 0, 0], orient_type: 'GLOBAL', mirror: false })).toBe("bpy.ops.transform.translate(value=(1, 0, 0), orient_type='GLOBAL', mirror=False)");
    expect(formatOpCall('object.delete', {})).toBe('bpy.ops.object.delete()');
  });
});

describe('mathutils (JS)', () => {
  it('euler/matrix/quaternion round trips for every order', () => {
    for (const order of ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'] as const) {
      const e = new Euler([0.3, -0.7, 1.1], order);
      const back = e.to_matrix().to_euler(order);
      expect(back.toArray().map((v) => +v.toFixed(6))).toEqual([0.3, -0.7, 1.1]);
      expect(e.to_quaternion().to_matrix().equals(e.to_matrix(), 1e-9)).toBe(true);
    }
    const q = new Quaternion([0, 0, 1], Math.PI / 2);
    const v = q.matmul([1, 0, 0]) as Vector;
    expect(v.toArray().map((x) => +x.toFixed(6))).toEqual([0, 1, 0]);
    const m = Matrix.LocRotScale([1, 2, 3], new Euler([0.1, 0.2, 0.3]), [2, 2, 2]);
    expect((m.inverted().matmul(m) as Matrix).equals(Matrix.Identity(4))).toBe(true);
    expect(new Vector([3, 4, 0]).length).toBe(5);
    expect((new Vector([1, 0, 0]).cross([0, 1, 0]) as Vector).toArray()).toEqual([0, 0, 1]);
  });
});
