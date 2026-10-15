// scripting subsystem entry point: import feature files here for their registration side effects.
//
//   api.ts / rna.ts / mathutils.ts  bpy-style object model (JavaScript core)
//   registry.ts                     script operators & panels, bpy.props / bpy.types / bpy.utils
//   runner.ts / python.ts           JavaScript execution and lazily loaded Pyodide (Python)
//   textedit.ts console.ts info.ts  Text Editor, Python Console, Info editors
//   prefs_editor.ts keymap_prefs.ts Preferences editor/window and keymap overrides
//   wmops.ts                        About, Keyboard Shortcuts, Preferences, Recover, Purge operators
//   panels_ui.ts                    script panels in the 3D viewport sidebar
//
// Supported scripting subset (Python and JavaScript share one object model):
//   bpy.data.<objects|meshes|materials|collections|cameras|lights|actions|images|texts|
//             node_groups|worlds|curves|armatures|lattices|particles|brushes|scenes>
//       coll["Name"], coll[0], get(), new(), remove(), len()/length, iteration, keys/values/items, find
//   Object: name, type, data, parent, location/rotation_euler/rotation_quaternion/scale (live vectors),
//       any document field, matrix_world (get/set), matrix_basis, matrix_local, dimensions,
//       modifiers.new(name, type)/remove/clear, constraints.new(type)/remove, vertex_groups.new,
//       keyframe_insert/keyframe_delete(data_path, index, frame), driver_add/driver_remove(path, index),
//       select_get/set, hide_get/set,
//       visible_get, active_material, material_slots, children, users_collection, copy(), ob["prop"]
//   Mesh: vertices[i].co/select/normal, edges, polygons (vertices, normal, center, area, use_smooth,
//       material_index), loops, from_pydata(verts, edges, faces) (loose edges are not stored),
//       update(), transform(), clear_geometry(), shade_smooth/flat(), materials.append/pop/clear,
//       vertices/polygons.foreach_get/foreach_set, loops.foreach_get('vertex_index'),
//       uv_layers (one map: active, new(), data[i].uv, foreach_get/foreach_set('uv'))
//   Material/World: node_tree.nodes[name|i].inputs[name].default_value, nodes.new/remove,
//       links.new(output, input)/remove, image nodes' .image; Camera: view_frame(scene);
//   Images: images.new, images.load(name) of files offered by the app (scripting/files.ts,
//       e.g. images attached to the AI assistant's chat); Action: fcurves.new/find/remove, keyframe_points.insert
//   Scene: frame_current, frame_set(), frame_start/end, render.*, cursor, camera, world, collection,
//       objects; Collection: objects.link/unlink, children.link/unlink, all_objects
//   bpy.context: scene, object, active_object, selected_objects, visible_objects, view_layer
//       (objects.active get/set), mode, collection, area, material, evaluated_depsgraph_get()
//   bpy.ops.<module>.<op>(**props[, 'INVOKE_DEFAULT']) → {'FINISHED'} / {'CANCELLED'}; poll()
//   mathutils: Vector, Matrix, Euler, Quaternion, Color, geometry (subset), noise (Python, subset)
//   bpy_extras.object_utils.world_to_camera_view(scene, camera, co)
//   bpy.props: Float/Int/Bool/String/Enum/FloatVector/IntVector/BoolVectorProperty
//   bpy.types.Operator: bl_idname, bl_label, bl_description, bl_options ('REGISTER', 'UNDO',
//       'INTERNAL'), annotated properties, poll(), execute(), invoke() (no modal), self.report()
//   bpy.types.Panel: bl_space_type='VIEW_3D', bl_region_type='UI', bl_category (sidebar tab;
//       'Item'/'Tool'/'View' append to existing tabs), bl_label, bl_order, bl_options
//       DEFAULT_CLOSED/HIDE_HEADER, poll(), draw(); layout: label, prop (numbers, booleans,
//       strings, vectors, colours), operator (returns settable properties), row, column, box,
//       split, separator, enabled/alert flags. Other space types draw in the 3D sidebar too.
//   Not supported: bmesh, bpy.app.handlers, modal operators, menus, PointerProperty /
//       CollectionProperty, file-system access (images.load etc.).
import './scripting.css';
import './icons';
import './registry';
import './oplog';
import './textedit';
import './console';
import './info';
import './prefs_editor';
import './wmops';
import './panels_ui';
import { applyKeymapOverrides } from './keymap_prefs';
import { applyPreferences } from './prefs_editor';
import { bpy } from './api';
import { mathutils } from './mathutils';

// All modules have registered their keymaps once the current task finishes.
setTimeout(() => {
  applyKeymapOverrides();
  applyPreferences();
}, 0);

// Scripting API on the window for browser devtools (same object scripts receive).
Object.assign(window as unknown as Record<string, unknown>, { bpy, mathutils });

export {};
