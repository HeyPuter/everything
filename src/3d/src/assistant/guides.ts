// Short guides to parts of the scripting API, for the assistant's api_help tool. Each one says
// how the part is used from a JavaScript script (Python works the same with keyword arguments)
// and lists what exists right now, read from the registries so it never goes stale.

import { bpyData, Context } from '../scripting/api';
import { mathutils } from '../scripting/mathutils';
import { scriptModules } from '../scripting/jsmodules';
import { HANDLER_NAMES } from '../scripting/handlers';
import { FX_TYPES } from '../greasepencil/fxtypes';
import { modifierTypes } from '../eval/modifiers';

const keysOf = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o as object).filter((k) => !k.startsWith('_') && typeof (o as Record<string, unknown>)[k] === 'function') : []);

function members(proto: object): string[] {
  const out = new Set<string>();
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (!k.startsWith('_') && k !== 'constructor' && !/^temp_override_/.test(k)) out.add(k);
  return [...out].sort();
}

interface Guide {
  title: string;
  text: () => string;
}

export const GUIDES: Record<string, Guide> = {
  data: {
    title: 'bpy.data collections',
    text: () =>
      [
        `Collections: ${Object.keys(bpyData)
          .filter((k) => (bpyData[k] as { __kind?: string })?.__kind === 'collection')
          .join(', ')}.`,
        'Each supports D.<name>[\'Name\'], .get(name) (null when missing), .length, iteration, .new(name, …), .remove(item).',
        "new() arguments: objects.new(name, data_or_null); lights.new(name, 'POINT'|'SUN'|'SPOT'|'AREA'); curves.new(name, 'CURVE'|'FONT'); node_groups.new(name, 'GeometryNodeTree'|'ShaderNodeTree'|'CompositorNodeTree'); images.new(name, width, height); grease_pencils.new(name); speakers.new(name); masks.new(name); metaballs.new(name). New objects must be linked: C.collection.objects.link(ob).",
        'D.orphans_purge() removes unused data-blocks; D.batch_remove([ids]).',
      ].join('\n'),
  },
  context: {
    title: 'bpy.context',
    text: () =>
      [
        `Members: ${members(Context.prototype).join(', ')}.`,
        'C.view_layer.objects.active = ob makes ob active; ob.select_set(true) selects it.',
        "Run operators on other objects without changing the selection for good: C.temp_override({active_object: ob, selected_objects: [ob]}, () => bpy.ops.object.shade_smooth()). In Python: with bpy.context.temp_override(active_object=ob, selected_objects=[ob]): …",
      ].join('\n'),
  },
  mesh: {
    title: 'Mesh data',
    text: () =>
      [
        "Build: me.from_pydata(verts, edges, faces) (edges no face uses stay as loose edges), or the low-level way: me.vertices.add(n); me.vertices.foreach_set('co', flat); me.loops.add(k); me.loops.foreach_set('vertex_index', …); me.polygons.add(f); me.polygons.foreach_set('loop_start', …) and ('loop_total', …); then me.update().",
        "Read: me.vertices[i].co / .normal / .select, me.edges[i].vertices / .use_seam / .use_edge_sharp / .crease / .is_loose, me.polygons[i].vertices / .normal / .center / .area / .material_index / .use_smooth, me.loops[i].vertex_index / .edge_index / .normal, me.loop_triangles. Fast bulk access: foreach_get / foreach_set on vertices ('co', 'select', 'hide'), edges ('vertices', 'use_seam', 'use_edge_sharp', 'crease'), polygons ('use_smooth', 'material_index', 'loop_start', 'loop_total', 'normal', 'center', 'area', 'select', 'hide'), loops ('vertex_index', 'edge_index', 'normal').",
        "Attributes: me.attributes (position, sharp_face, material_index, sharp_edge, crease_edge, .sculpt_face_set (face sets), .sculpt_mask, custom_normal, the UV map, color attributes) with .data[i].value / .vector / .color and foreach_get/set; me.attributes.new(name, type, domain) stores color attributes (FLOAT_COLOR/BYTE_COLOR on POINT or CORNER), face sets ('.sculpt_face_set', 'INT', 'FACE'), the mask and one UV map. me.color_attributes.new(name, type, domain), .active_color; me.vertex_colors (corner colors, legacy).",
        "UVs: one map per mesh, me.uv_layers.active.data[i].uv or foreach_set('uv', flat). Custom normals: me.normals_split_custom_set(perLoop) / me.normals_split_custom_set_from_vertices(perVertex) ([] clears), me.has_custom_normals, me.corner_normals. me.set_sharp_from_angle(radians). Shape keys: ob.shape_key_add({name}), key.data[i].co, key.value, me.shape_keys.key_blocks.",
        'For topology work (extrude, bevel, inset, delete, merge…) use bmesh (api_help "bmesh") or Edit Mode operators.',
      ].join('\n'),
  },
  bmesh: {
    title: 'bmesh',
    text: () => {
      const b = scriptModules.bmesh as { ops?: object } | undefined;
      if (!b) return 'bmesh is not available in this build.';
      return [
        "const bm = bmesh.new(); bm.from_mesh(me) (or bmesh.from_edit_mesh(me) in Edit Mode); edit; bm.to_mesh(me); bm.free() (in Edit Mode: bmesh.update_edit_mesh(me)).",
        'Elements: bm.verts / bm.edges / bm.faces with .new(...), .remove(x), .ensure_lookup_table() before indexing; BMVert.co / .normal / .link_edges / .link_faces, BMEdge.verts / .other_vert(v), BMFace.verts / .edges / .loops / .normal / .calc_center_median(); loop UVs via bm.loops.layers.uv.verify() and loop[uv].uv.',
        "Operators take the BMesh and an options object and return an object of results: const r = bmesh.ops.extrude_face_region(bm, {geom: bm.faces}); bmesh.ops.translate(bm, {vec: [0, 0, 1], verts: r.geom.filter((e) => e.co)}). extrude_face_region keeps the original faces (inside the extrusion); remove them with bmesh.ops.delete(bm, {geom: faces, context: 'FACES_ONLY'}) for a closed shell.",
        `bmesh.ops: ${keysOf(b.ops).sort().join(', ')}.`,
      ].join('\n');
    },
  },
  mathutils: {
    title: 'mathutils',
    text: () => {
      const m = mathutils as unknown as Record<string, unknown>;
      return [
        "Vector, Matrix, Euler, Quaternion, Color are globals in JavaScript. JavaScript has no operators for them: use a.add(b), a.sub(b), a.mul(2), a.dot(b), a.cross(b), M.matmul(v), M.matmul(N), q.matmul(v), M.inverted(), v.normalized(), v.length. Matrix.Translation(v), Matrix.Rotation(angle, 4, 'Z'), Matrix.Scale(f, 4), Matrix.LocRotScale(loc, rot, scale); m.decompose(); e.to_matrix(); q.to_euler().",
        `mathutils.geometry: ${keysOf(m.geometry).sort().join(', ')}.`,
        "mathutils.kdtree.KDTree(n): insert(co, index), balance(), find(co) → [co, index, dist], find_n(co, n), find_range(co, r).",
        "mathutils.bvhtree.BVHTree.FromObject(ob, C.evaluated_depsgraph_get()) / FromPolygons(verts, polys) / FromBMesh(bm): ray_cast(origin, dir) → [location, normal, index, distance] (nulls on a miss; object-local space), find_nearest(co), find_nearest_range(co, r), overlap(other).",
        m.noise ? `mathutils.noise: ${keysOf(m.noise).sort().join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  animation: {
    title: 'Keyframes, drivers, NLA, keying sets',
    text: () =>
      [
        "Any property an object reaches can be keyed: ob.keyframe_insert('location', {frame: 1, index: 2}); ob.data.keyframe_insert('energy') (light/camera/curve data), ob.modifiers['Bevel'].keyframe_insert('width'), node inputs: mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].keyframe_insert('default_value') (the material must be the active material of an object), pose bones: ob.pose.bones['Arm'].keyframe_insert('rotation_quaternion'), shape keys: key.keyframe_insert('value'). Keys go into the object's action; keyframe_delete(path, {frame}) removes them.",
        "F-Curves: ob.animation_data.action.fcurves.find('location', {index: 0}); fc.keyframe_points.insert(frame, value) or add(n) + foreach_set('co', [f0, v0, f1, v1…]) + fc.update(); kp.interpolation = 'LINEAR'|'CONSTANT'|'BEZIER'; fc.modifiers.new('CYCLES'|'NOISE'|…).",
        "Drivers: const fc = ob.driver_add('location', 2); fc.driver.type = 'SCRIPTED'; const v = fc.driver.variables.new(); v.name = 'x'; v.targets[0].id = other; v.targets[0].data_path = 'location[0]'; fc.driver.expression = 'x * 2' (variables and frame are available). Variable types SINGLE_PROP, TRANSFORMS (targets[0].transform_type 'LOC_X'…), LOC_DIFF, ROTATION_DIFF; targets are objects.",
        "NLA: const t = ob.animation_data.nla_tracks.new(); const s = t.strips.new('Walk', 1, action); s.repeat, s.scale, s.blend_type, s.influence; strips on a track may not overlap. Meta strips and transitions: bpy.ops.nla.meta_add / transition_add on selected strips.",
        "Keying sets: const ks = C.scene.keying_sets.new({name: 'Mine'}); ks.paths.add(ob, 'location'); C.scene.keying_sets.active. Markers: C.scene.timeline_markers.new('Hit', {frame: 12}), marker.camera = camOb.",
      ].join('\n'),
  },
  armature: {
    title: 'Armatures',
    text: () =>
      [
        "bpy.ops.object.armature_add() makes one bone. In Edit Mode (mode_set({mode: 'EDIT'})): const b = arm.data.edit_bones.new('Forearm'); b.head = [..]; b.tail = [..]; b.parent = arm.data.edit_bones['Upper']; b.use_connect = true; edit_bones.remove(b).",
        "Outside Edit Mode: arm.data.bones['Name'] (rest head_local / tail_local / matrix_local, parent, children). Pose: arm.pose.bones['Name'].location / rotation_quaternion / rotation_euler (set rotation_mode first) / scale, .matrix (armature space, settable), .matrix_basis, .constraints.new('IK'|'COPY_ROTATION'|…), .keyframe_insert(...).",
        "Bone collections: arm.data.collections.new('Arms'), coll.assign(bone), coll.is_visible. Selection sets: ob.selection_sets.add() then bpy.ops.pose.selection_set_assign().",
        "Skinning: parent the mesh with bpy.ops.object.parent_set({type: 'ARMATURE_AUTO'}) (mesh and armature selected, armature active).",
      ].join('\n'),
  },
  'grease pencil': {
    title: 'Grease Pencil',
    text: () =>
      [
        "const gp = D.grease_pencils.new('Sketch'); const layer = gp.layers.new('Lines'); const frame = layer.frames.new(1); frame.drawing.add_strokes([4]); const st = frame.drawing.strokes[0]; st.points[i].position = [x, y, z]; .radius, .opacity, .vertex_color; st.cyclic, st.material_index, st.fill_color; then const ob = D.objects.new('Sketch', gp); C.collection.objects.link(ob).",
        "Colors come from materials with a grease pencil style: const m = D.materials.new('Ink'); D.materials.create_gpencil_data(m); m.grease_pencil.color = [r, g, b, 1]; m.grease_pencil.show_fill = true; gp.materials.append(m). Or bpy.ops.object.grease_pencil_add({type: 'STROKE'}).",
        `Modifiers on grease pencil objects use the GREASE_PENCIL_* types: ${Object.keys(modifierTypes)
          .filter((t) => t.startsWith('GREASE_PENCIL_'))
          .join(', ')}.`,
        `Visual effects: ob.shader_effects.new(name, type), types ${FX_TYPES.map((f) => f.type).join(', ')}.`,
      ].join('\n'),
  },
  handlers: {
    title: 'Handlers and timers',
    text: () =>
      [
        `bpy.app.handlers lists: ${HANDLER_NAMES.join(', ')}. In JavaScript push a function: bpy.app.handlers.frame_change_post.push((scene) => { … }) (a second parameter receives the depsgraph). bpy.app.handlers.persistent(fn) keeps it across file loads; other handlers are dropped when a file loads.`,
        "bpy.app.timers.register(fn, first_interval_seconds): fn runs later and again after the number of seconds it returns (return null to stop); unregister(fn), is_registered(fn).",
        'Handlers and timers keep running after the script ends and are not undone with it: add them only when the user asks for something that must react over time, name the functions, and say how to remove them.',
      ].join('\n'),
  },
  sequencer: {
    title: 'Video Sequencer',
    text: () =>
      [
        "const ed = C.scene.sequence_editor_create(); ed.strips.new_effect(name, 'COLOR'|'TEXT'|'ADJUSTMENT'|'CROSS'|'WIPE'|'ALPHA_OVER'|…, channel, frame_start, {frame_end, input1, input2}); ed.strips.new_scene(name, C.scene, channel, frame_start); ed.strips.new_meta(name, channel, frame_start); ed.strips.remove(strip); ed.active_strip; ed.strips_all.",
        'Strip fields: frame_start, frame_final_start/end/duration (read), channel, mute, blend_type, blend_alpha, color (COLOR strips), text / font_size (TEXT strips), transform.offset_x… Images, movies and sounds are added in the Video Sequencer (scripts have no file access); retiming and connecting strips are operators in the sequencer module (bpy.ops.sequencer.*).',
      ].join('\n'),
  },
  render: {
    title: 'Render settings and passes',
    text: () =>
      [
        "C.scene.render: engine ('RASTER', 'PATHTRACE'), resolution_x / resolution_y / resolution_percentage, fps, samples, film_transparent, file_format, and the color management fields; read them with api_help \"C.scene.render\".",
        "Passes: C.view_layer.use_pass_z / use_pass_mist / use_pass_normal / use_pass_position / use_pass_uv / use_pass_diffuse_color / use_pass_emit / use_pass_ambient_occlusion / use_pass_object_index / use_pass_material_index (the Render Layers compositor node gets matching outputs). World: C.scene.world.",
      ].join('\n'),
  },
};

/** The guide for a topic name (case and plural forms ignored), or null. */
export function findGuide(topic: string): Guide | null {
  const t = topic.trim().toLowerCase().replace(/^bpy\./, '').replace(/s$/, '');
  for (const [k, g] of Object.entries(GUIDES)) if (k === t || `${k}s` === topic.trim().toLowerCase() || k.replace(/s$/, '') === t || (k === 'grease pencil' && /^(gp|grease ?pencil|grease_pencil)$/.test(t)) || (k === 'animation' && /^(keyframe|driver|nla|keying ?set)$/.test(t)) || (k === 'handlers' && /^(handler|timer|app\.handler|app\.timer)$/.test(t)) || (k === 'render' && /^(render setting|pass|view ?layer)$/.test(t))) return g;
  return null;
}
