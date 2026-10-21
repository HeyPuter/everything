// @vitest-environment happy-dom
// The same scripting API in Python (Pyodide, loaded from the local package; skipped when it can't load).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { pythonAvailable, runPy } from './support/python';
import { handlers } from '../../src/scripting/handlers';

let has = false;
beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  has = await pythonAvailable();
}, 90000);

beforeEach(() => {
  setApp(new App(startupDocument()));
  for (const l of Object.values(handlers) as unknown[]) if (Array.isArray(l)) l.length = 0;
  if (has) runPy('import bpy\nfor n in ("frame_change_post", "depsgraph_update_post", "load_post"):\n    getattr(bpy.app.handlers, n).clear()');
});

const obj = (name: string) => Object.values(app.doc.objects).find((o) => o.name === name)!;
const py = (name: string, fn: () => void) => it(name, () => (has ? fn() : undefined));

describe('Python scripts', () => {
  py('import bpy submodules the usual ways', () => {
    expect(
      runPy(`
      from bpy.types import Operator, Panel
      from bpy.props import FloatProperty
      from bpy.app.handlers import persistent
      import bpy
      print(Operator.__name__, FloatProperty(default=1).type, callable(persistent))
    `),
    ).toBe('Operator FLOAT True');
  });

  py('operators return sets and raise on poll failure', () => {
    expect(
      runPy(`
      import bpy
      print(bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0, 0, 2)))
      try:
          bpy.ops.mesh.subdivide()
      except RuntimeError as e:
          print("poll" in str(e))
    `),
    ).toBe("{'FINISHED'}\nTrue");
  });

  py('keyframes, drivers and NLA', () => {
    expect(
      runPy(`
      import bpy
      ob = bpy.data.objects["Cube"]
      ob.keyframe_insert("location", index=0, frame=1)
      ob.location.x = 4
      ob.keyframe_insert(data_path="location", index=0, frame=11)
      fc = ob.animation_data.action.fcurves.find("location", index=0)
      print(len(fc.keyframe_points), round(fc.evaluate(11), 3))
      d = ob.driver_add("scale", 2).driver
      v = d.variables.new()
      v.targets[0].id = bpy.data.objects["Light"]
      v.targets[0].data_path = "location[2]"
      d.expression = "var / 2"
      track = ob.animation_data.nla_tracks.new()
      strip = track.strips.new("Clip", 50, ob.animation_data.action)
      print(d.type, strip.frame_start, strip.frame_end)
    `),
    ).toBe('2 4.0\nSCRIPTED 50.0 60.0');
    app.evaluate();
    expect(obj('Cube').scale[2]).toBeCloseTo(obj('Light').location[2] / 2);
  });

  py('mesh foreach_get/foreach_set and attributes', () => {
    expect(
      runPy(`
      import bpy
      me = bpy.data.objects["Cube"].data
      co = [0.0] * (len(me.vertices) * 3)
      me.vertices.foreach_get("co", co)
      me.vertices.foreach_set("co", [c * 2 for c in co])
      print(me.vertices[0].co.length > 3, len(me.edges), len(me.loop_triangles))
      attr = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
      attr.data[0].color = (0.0, 1.0, 0.0, 1.0)
      print(attr.domain, round(me.attributes["Col"].data[0].color[1], 2))
    `),
    ).toBe('True 12 12\nCORNER 1.0');
  });

  py('grease pencil from Python', () => {
    expect(
      runPy(`
      import bpy
      gp = bpy.data.grease_pencils.new("GP")
      layer = gp.layers.new("Ink")
      drawing = layer.frames.new(1).drawing
      drawing.add_strokes([4])
      for i, p in enumerate(drawing.strokes[0].points):
          p.position = (i, 0, 0)
      ob = bpy.data.objects.new("GP", gp)
      bpy.context.collection.objects.link(ob)
      print(ob.type, [round(p.position.x) for p in drawing.strokes[0].points])
    `),
    ).toBe('GREASEPENCIL [0, 1, 2, 3]');
  });

  py('frame change handlers and timers', async () => {
    runPy(`
      import bpy

      def follow(scene):
          bpy.data.objects["Cube"].location.y = scene.frame_current

      bpy.app.handlers.frame_change_post.append(follow)

      def tick():
          bpy.data.objects["Cube"].location.z += 1
          return None

      bpy.app.timers.register(tick, first_interval=0.001)
      print(bpy.app.timers.is_registered(tick))
    `);
    app.setFrame(7);
    expect(obj('Cube').location[1]).toBe(7);
    await new Promise((r) => setTimeout(r, 40));
    expect(obj('Cube').location[2]).toBe(1);
  });

  py('temp_override with a context manager', () => {
    expect(
      runPy(`
      import bpy
      cam = bpy.data.objects["Camera"]
      with bpy.context.temp_override(active_object=cam, selected_objects=[cam]):
          print(bpy.context.object.name)
          bpy.ops.object.delete()
      print("Camera" in bpy.data.objects, bpy.context.object.name)
    `),
    ).toBe('Camera\nFalse Cube');
  });

  py('path_resolve and keyframes on data through the object', () => {
    expect(
      runPy(`
      import bpy
      light = bpy.data.lights["Light"]
      light.energy = 250
      light.keyframe_insert("energy", frame=2)
      ob = bpy.data.objects["Light"]
      print(ob.animation_data.action.fcurves[0].data_path, ob.path_resolve("data.energy"))
    `),
    ).toBe('data.energy 250');
  });

  py('geometry node group interface and modifier inputs', () => {
    expect(
      runPy(`
      import bpy
      ng = bpy.data.node_groups.new("Lift", "GeometryNodeTree")
      sock = ng.interface.new_socket(name="Amount", in_out="INPUT", socket_type="NodeSocketFloat")
      mod = bpy.data.objects["Cube"].modifiers.new(name="GN", type="NODES")
      mod.node_group = ng
      mod[sock.identifier] = 3.5
      print(mod[sock.identifier], sock.identifier in mod.keys(), [i.name for i in ng.interface.items_tree])
    `),
    ).toBe("3.5 True ['Amount']"); // a new group made from Python is empty, as on the desktop
  });

  py('property groups and properties added to types', () => {
    expect(
      runPy(`
      import bpy
      from bpy.props import FloatProperty, IntProperty, PointerProperty, CollectionProperty

      class Tool(bpy.types.PropertyGroup):
          size: FloatProperty(default=0.5)
          steps: IntProperty(default=4)

      bpy.utils.register_class(Tool)
      bpy.types.Scene.tool = PointerProperty(type=Tool)
      bpy.types.Object.marks = CollectionProperty(type=Tool)
      bpy.types.Object.mass_hint = FloatProperty(default=2.0)
      scene = bpy.context.scene
      scene.tool.steps = 9
      ob = bpy.data.objects["Cube"]
      m = ob.marks.add()
      m.size = 1.25
      print(scene.tool.size, scene.tool.steps, len(ob.marks), ob.marks[0].size, ob.mass_hint)
      del bpy.types.Object.mass_hint
      print(hasattr(ob, "mass_hint"))
    `),
    ).toBe('0.5 9 1 1.25 2.0\nFalse'); // FloatProperty values read back as floats
  });

  py('menus from Python', async () => {
    runPy(`
      import bpy

      class MyMenu(bpy.types.Menu):
          bl_idname = "OBJECT_MT_py_menu"
          bl_label = "Py Menu"

          def draw(self, context):
              self.layout.operator("object.shade_flat", text="Flat")

      bpy.utils.register_class(MyMenu)
    `);
    const { menuItems } = await import('../../src/scripting/menus');
    expect(menuItems('OBJECT_MT_py_menu')).toMatchObject([{ label: 'Flat', op: 'object.shade_flat' }]);
  });
});
