// @vitest-environment happy-dom
// Scripting compatibility of the general API layer (checked against the same scripts' output in
// the reference app): rotation mode conversion, Object.to_mesh, node type identifiers, layered
// action access, typed struct classes, float properties, modifier names in operators.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { emptyDocument, startupDocument } from '../../src/data/defaults';
import { pythonAvailable, runPy } from './support/python';

let has = false;
beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  has = await pythonAvailable();
}, 90000);
beforeEach(() => setApp(new App(emptyDocument())));

const py = (name: string, fn: () => void) => it(name, () => (has ? fn() : undefined));

describe('scripting compatibility', () => {
  py('changing rotation_mode converts the rotation', () => {
    const out = runPy(`
      import bpy
      bpy.ops.mesh.primitive_cube_add()
      ob = bpy.context.object
      ob.rotation_mode = 'QUATERNION'
      ob.rotation_quaternion = (0.7071068, 0.7071068, 0, 0)
      ob.rotation_mode = 'XYZ'
      print([round(x, 3) for x in ob.rotation_euler])
      ob.rotation_mode = 'AXIS_ANGLE'
      print([round(x, 3) for x in ob.rotation_axis_angle])
    `);
    expect(out.split('\n')).toEqual(['[1.571, 0.0, 0.0]', '[1.571, 1.0, 0.0, 0.0]']);
  });

  py('Object.to_mesh gives the evaluated mesh outside bpy.data', () => {
    const out = runPy(`
      import bpy
      bpy.ops.mesh.primitive_cube_add()
      ob = bpy.context.object
      ob.modifiers.new('Sub', 'SUBSURF').levels = 1
      dg = bpy.context.evaluated_depsgraph_get()
      me = ob.evaluated_get(dg).to_mesh()
      print(len(me.vertices), len(me.polygons), len(bpy.data.meshes))
      ob.evaluated_get(dg).to_mesh_clear()
      print(len(ob.data.vertices))
    `);
    expect(out.split('\n')).toEqual(['26 24 1', '8']);
  });

  py('node type identifiers, struct class names and float values', () => {
    const out = runPy(`
      import bpy
      mat = bpy.data.materials.new('M')
      mat.use_nodes = True
      print(sorted(n.type for n in mat.node_tree.nodes))
      ramp = mat.node_tree.nodes.new('ShaderNodeValToRGB')
      print(ramp.type, ramp.color_ramp.elements[0].position)
      bpy.ops.mesh.primitive_cube_add()
      print(type(bpy.context.object).__name__, isinstance(bpy.context.object, bpy.types.Object))
      print(bpy.context.scene.unit_settings.scale_length, bpy.app.version >= (0, 0, 0))
    `);
    expect(out.split('\n')).toEqual(["['BSDF_PRINCIPLED', 'OUTPUT_MATERIAL']", 'VALTORGB 0.0', 'Object True', '1.0 True']);
  });

  py('layered action access through slots and channelbags', () => {
    const out = runPy(`
      import bpy
      from bpy_extras import anim_utils
      bpy.ops.mesh.primitive_cube_add()
      ob = bpy.context.object
      ob.keyframe_insert('location', frame=1)
      ob.location.x = 4
      ob.keyframe_insert('location', frame=5)
      act = ob.animation_data.action
      slot = ob.animation_data.action_slot
      cb = anim_utils.action_get_channelbag_for_slot(act, slot)
      print(slot.identifier, len(cb.fcurves), len(act.layers[0].strips[0].channelbag(slot).fcurves))
      fc = cb.fcurves.find('location', index=0)
      print(type(fc).__name__, fc.evaluate(5))
    `);
    expect(out.split('\n')).toEqual(['OBCube 3 3', 'FCurve 4.0']);
  });

  py('operators that take a modifier accept its name', () => {
    runPy(`
      import bpy
      bpy.ops.mesh.primitive_cube_add()
      ob = bpy.context.object
      ob.modifiers.new('Arr', 'ARRAY').count = 3
      bpy.ops.object.modifier_apply(modifier='Arr')
    `);
    const ob = Object.values(app.doc.objects)[0];
    expect(ob.modifiers.length).toBe(0);
    expect(app.doc.meshes[ob.data!].positions.length / 3).toBe(24);
  });
});
