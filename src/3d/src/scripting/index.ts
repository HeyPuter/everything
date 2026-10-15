// scripting subsystem entry point: import feature files here for their registration side effects.
//
//   api.ts / rna.ts / mathutils.ts  bpy-style object model (JavaScript core)
//   registry.ts                     script operators & panels, bpy.props / bpy.types / bpy.utils
//   runner.ts / python.ts           JavaScript execution and lazily loaded Pyodide (Python)
//   textedit.ts console.ts info.ts  Text Editor, Python Console, Info editors
//   prefs_editor.ts  Preferences editor/window (implemented in src/prefs/)
//   wmops.ts                        About, Keyboard Shortcuts, Preferences, Recover, Purge operators
//   panels_ui.ts                    script panels in the 3D viewport sidebar
//
// Supported scripting subset (Python and JavaScript share one object model; tests run both):
//   bpy.data.<objects|meshes|materials|collections|cameras|lights|actions|images|texts|node_groups|
//             worlds|curves|armatures|lattices|metaballs|grease_pencils|speakers|masks|movieclips|
//             fonts|particles|brushes|scenes>
//       coll["Name"], coll[0], get(), new(), remove(), len()/length, iteration, keys/values/items, find
//   Every struct (api_anim.ts): keyframe_insert/keyframe_delete/driver_add/driver_remove on any
//       property an object reaches (data, modifiers, material node inputs, pose bones, shape keys),
//       path_resolve, path_from_id, id_data; generic fields by name (rna.ts)
//   Object: transforms (live vectors), matrix_world/basis/local, dimensions, modifiers (incl.
//       GREASE_PENCIL_* on grease pencil objects), constraints, shader_effects, vertex_groups,
//       shape keys, pose.bones (matrix, constraints), animation_data (action, nla_tracks/strips,
//       drivers with variables), selection, visibility, materials, children, copy(), ob["prop"]
//   Mesh (api_mesh.ts): vertices/edges (incl. loose)/polygons/loops/loop_triangles with flags and
//       foreach_get/foreach_set, from_pydata, low-level add() + update(), attributes,
//       color_attributes, vertex_colors, face sets, custom split normals, one UV map
//   Armature: bones, edit_bones (Edit Mode), bone collections (modes/armature/scripting.ts)
//   Grease pencil (api_data.ts): layers, frames, drawing.strokes/points, add_strokes; Curves:
//       splines.new, bezier_points/points.add (api_shapes.ts); Metaballs: elements (metaball/)
//   Material/World: node_tree nodes/links/sockets (socket keyframes), color ramps, image nodes;
//       Images: new, load (files offered by the app, scripting/files.ts), pixels (api_image.ts)
//   Action: fcurves new/find/remove, keyframe_points insert/add/remove/foreach, modifiers
//   Scene: frame_set, render.*, view_layers (passes), keying_sets, timeline_markers,
//       sequence_editor (strips.new_effect/new_scene/new_meta, active_strip), cursor, camera, world
//   bpy.context (api_context.ts): objects, selection, mode, bones/pose bones, paint objects, data
//       by type, tool_settings, area/region/screen/window, strips, temp_override
//   bpy.app.handlers (frame change, depsgraph update, load, save, render, undo/redo, playback) and
//       bpy.app.timers (handlers.ts)
//   bpy.ops.<module>.<op>(**props[, 'INVOKE_DEFAULT']) → {'FINISHED'} / {'CANCELLED'}; poll()
//   mathutils: Vector, Matrix, Euler, Quaternion, Color, geometry, kdtree, bvhtree, noise
//   bpy_extras.object_utils.world_to_camera_view(scene, camera, co)
//   bpy.props: Float/Int/Bool/String/Enum/FloatVector/IntVector/BoolVectorProperty, and
//       Pointer/CollectionProperty of PropertyGroups; bpy.types.<Type>.<name> = <prop> adds a
//       property to a data type, stored in its custom properties (typeprops.ts)
//   bpy.types.Operator: bl_idname, bl_label, bl_description, bl_options ('REGISTER', 'UNDO',
//       'INTERNAL'), annotated properties, poll(), execute(), invoke() (no modal), self.report()
//   bpy.types.Panel: bl_space_type='VIEW_3D', bl_region_type='UI', bl_category (sidebar tab;
//       'Item'/'Tool'/'View' append to existing tabs), bl_label, bl_order, bl_options
//       DEFAULT_CLOSED/HIDE_HEADER, poll(), draw(); layout: label, prop (numbers, booleans,
//       strings, vectors, colours), operator (returns settable properties), row, column, box,
//       split, separator, enabled/alert flags. Other space types draw in the 3D sidebar too.
//   bmesh (bmesh*.ts, py/bmesh.py): new(), from_edit_mesh / update_edit_mesh, BMesh from_mesh /
//       to_mesh / from_object, verts/edges/faces/loops with adjacency and layers (uv, color,
//       deform, shape, float/int/string), bmesh.ops (create_*, extrude, transforms, delete,
//       merge, subdivide, triangulate, inset, bevel, bridge, spin, mirror, dissolve, …),
//       bmesh.utils / bmesh.geometry subsets, bmesh.types for isinstance()
//   bpy.types.Menu (menus.ts): wm.call_menu(name=…), layout.menu(…), submenus
//   Not supported: modal operators, data-block PointerProperty, file-system access (only
//       files the app offers), several scenes or view layers.
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
import './api_ext';
import './bmesh';
import { startPreferences } from './prefs_editor';
import { bpy } from './api';
import { mathutils } from './mathutils';

// All modules have registered their keymaps once the current task finishes.
setTimeout(() => startPreferences(), 0);

// Scripting API on the window for browser devtools (same object scripts receive).
Object.assign(window as unknown as Record<string, unknown>, { bpy, mathutils });

export {};
