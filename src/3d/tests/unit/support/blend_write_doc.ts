// A document using most of what the .blend writer stores, for its tests (and for checking the files it
// writes in other programs: tests/unit/blend-write.test.ts writes them when BLEND_WRITE_OUT is set).
import type { DocumentData, ImageData, MeshData, NodeData } from '../../../src/data/types';
import { newCamera, newCollection, newCurve, newImage, newLight, newMaterial, newMeshData, newObject, newWorld, startupDocument, uid } from '../../../src/data/defaults';
import { newModifier } from '../../../src/eval/modifiers';

/** A 1×1 PNG (red). */
export const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

/** A pentagonal prism: two pentagons and five quads (10 vertices, 7 faces, 20 corners). */
export function prismMesh(name = 'Prism'): MeshData {
  const positions: number[] = [];
  for (const z of [0, 1]) for (let i = 0; i < 5; i++) positions.push(Math.cos((i * 2 * Math.PI) / 5), Math.sin((i * 2 * Math.PI) / 5), z);
  const faces: number[][] = [
    [4, 3, 2, 1, 0],
    [5, 6, 7, 8, 9],
  ];
  for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 5 + ((i + 1) % 5), 5 + i]);
  const offsets = [0];
  const indices: number[] = [];
  for (const f of faces) {
    indices.push(...f);
    offsets.push(indices.length);
  }
  const n = indices.length;
  const uvs = new Float32Array(n * 2).map((_, i) => (i % 7) / 7);
  const me = newMeshData(name, { positions: Float32Array.from(positions), offsets: Uint32Array.from(offsets), indices: Uint32Array.from(indices), uvs, normals: new Float32Array(n * 3) });
  me.uv_map_name = 'Main';
  me.uv_layers_extra = [{ name: 'Lightmap', data: new Float32Array(n * 2).map((_, i) => (i % 3) / 3) }];
  me.uv_active_index = 1; // the active map is second in the list
  me.uv_render_name = 'Lightmap';
  me.smooth = Uint8Array.from(faces.map((_, i) => (i < 2 ? 0 : 1)));
  me.material_index = Uint16Array.from(faces.map((_, i) => (i < 2 ? 1 : 0)));
  // the edge starting at corner 0 (0→4 of the bottom pentagon) is a seam, sharp and creased
  me.seams = new Uint32Array(n);
  me.seams[0] = 1;
  me.sharp = new Uint32Array(n);
  me.sharp[0] = 1;
  me.creases = new Float32Array(n);
  me.creases[0] = 0.5;
  me.bevel_weight_edge = new Float32Array(n);
  me.bevel_weight_edge[0] = 0.25;
  me.crease_vert = new Float32Array(10).map((_, i) => (i === 3 ? 0.75 : 0));
  me.vertex_groups = [{ name: 'Top' }, { name: 'Bottom' }];
  me.weights = [new Float32Array(10).map((_, i) => (i >= 5 ? 1 : 0)), new Float32Array(10).map((_, i) => (i < 5 ? 0.5 : 0))];
  me.color_attributes = [
    { name: 'Paint', domain: 'CORNER', data: new Float32Array(n * 4).map((_, i) => (i % 4 === 3 ? 1 : (i % 5) / 5)) },
    { name: 'Heat', domain: 'POINT', data: new Float32Array(40).map((_, i) => (i % 4 === 3 ? 1 : (i % 4) / 4)) },
  ];
  me.active_color_index = 0;
  me.attributes = [
    { name: 'height', domain: 'POINT', data_type: 'FLOAT', data: new Float32Array(10).map((_, i) => i * 0.1) },
    { name: 'face_id', domain: 'FACE', data_type: 'INT', data: Int32Array.from(faces.map((_, i) => i * 10)) },
    { name: 'offset', domain: 'POINT', data_type: 'FLOAT_VECTOR', data: new Float32Array(30).map((_, i) => i) },
    { name: 'tier', domain: 'FACE', data_type: 'INT8', data: Int32Array.from(faces.map((_, i) => i - 3)) },
  ];
  return me;
}

export function richDocument(): DocumentData {
  const doc = startupDocument();
  const s = doc.scene;
  s.name = 'Shot';
  s.frame_start = 10;
  s.frame_end = 90;
  s.frame_current = 33;
  s.render.fps = 30;
  s.render.resolution_x = 1280;
  s.render.resolution_y = 720;
  s.render.resolution_percentage = 50;
  s.render.engine = 'PATHTRACE';
  s.render.view_transform = 'FILMIC';
  s.render.film_transparent = true;
  s.cursor.location = [1, 2, 3];
  const master = doc.collections[s.collection];

  // collections: Props (tagged, not rendered, not selectable) holding Inner (hidden in the view layer)
  const props = newCollection('Props');
  props.color_tag = 'COLOR_03';
  props.hide_render = true;
  props.hide_select = true;
  const inner = newCollection('Inner');
  inner.hide = true;
  doc.collections[props.id] = props;
  doc.collections[inner.id] = inner;
  master.children.push(props.id);
  props.children.push(inner.id);

  // image, materials, world
  const img: ImageData = { ...newImage('Swatch', 1, 1), source: 'FILE', bytes: PNG_1PX, mime: 'image/png', colorspace: 'Non-Color' };
  doc.images[img.id] = img;
  const painted = newMaterial('Painted', [0.2, 0.4, 0.6, 1]);
  const bsdf = painted.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
  bsdf.inputs.Roughness = 0.25;
  bsdf.inputs.Metallic = 0.75;
  bsdf.inputs['Base Color'] = [0.2, 0.4, 0.6, 1];
  const node = (type: string, name: string, x: number, extra: Partial<NodeData> = {}): NodeData => ({ id: uid('node'), type, name, location: [x, 0], inputs: {}, props: {}, ...extra });
  const frame = node('NodeFrame', 'Group', -900, { label: 'Inputs' });
  const tex = node('ShaderNodeTexImage', 'Image Texture', -600, { props: { image: img.id }, parent: frame.id });
  const math = node('ShaderNodeMath', 'Math', -300, { props: { operation: 'MULTIPLY' }, inputs: { Value_001: 3 } });
  const ramp = node('ShaderNodeValToRGB', 'Color Ramp', -300, { props: { color_ramp: [0, 0, 0, 0, 1, 0.5, 1, 0, 0, 1, 1, 1, 1, 1, 1], ramp_interpolation: 'CONSTANT' } });
  const curves = node('ShaderNodeRGBCurve', 'RGB Curves', -300, { props: { curve_0: [0, 0, 0, 0.5, 0.7, 0, 1, 1, 0] }, mute: true });
  const value = node('ShaderNodeValue', 'Value', -600, { props: { 'outputs.Value': 0.25 }, hide: true });
  painted.tree.nodes.push(frame, tex, math, ramp, curves, value);
  const link = (from: NodeData, fs: string, to: NodeData, ts: string, muted = false) => painted.tree.links.push({ id: uid('link'), from_node: from.id, from_socket: fs, to_node: to.id, to_socket: ts, ...(muted ? { is_muted: true } : {}) });
  link(tex, 'Color', bsdf, 'Base Color');
  link(value, 'Value', math, 'Value');
  link(math, 'Value', ramp, 'Fac');
  link(ramp, 'Color', bsdf, 'Emission Color', true);
  doc.materials[painted.id] = painted;
  const plain = newMaterial('Plain', [0.9, 0.1, 0.1, 1]);
  plain.use_backface_culling = true;
  doc.materials[plain.id] = plain;
  const sky = newWorld('Sky');
  const bg = sky.tree.nodes.find((n) => n.type === 'ShaderNodeBackground')!;
  bg.inputs.Color = [0.2, 0.3, 0.4, 1];
  bg.inputs.Strength = 2;
  sky.color = [0.2, 0.3, 0.4];
  doc.worlds[sky.id] = sky;
  s.world = sky.id;

  // objects
  const add = (ob: ReturnType<typeof newObject>, col = master) => {
    doc.objects[ob.id] = ob;
    doc.object_order.push(ob.id);
    col.objects.push(ob.id);
    return ob;
  };
  const pivot = add(newObject('Pivot', 'EMPTY', null), props);
  pivot.empty_display_type = 'ARROWS';
  pivot.empty_display_size = 2;
  pivot.location = [0, 0, 1];
  pivot.rotation_mode = 'QUATERNION';
  pivot.rotation_quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

  const prism = prismMesh();
  prism.materials = [painted.id, plain.id];
  doc.meshes[prism.id] = prism;
  const a = add(newObject('Prism', 'MESH', prism.id));
  a.parent = pivot.id;
  a.matrix_parent_inverse = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1];
  a.location = [2, 0, 0];
  a.rotation_mode = 'ZYX';
  a.rotation_euler = [0.1, 0.2, 0.3];
  a.scale = [1, 2, 3];
  a.delta_location = [0, 0, 0.5];
  a.lock_location = [true, false, true];
  a.lock_scale = [false, true, false];
  a.show_wire = true;
  a.show_in_front = true;
  a.hide_render = true;
  a.color = [1, 0.5, 0.25, 1];
  a.select = true;
  const b = add(newObject('Prism Twin', 'MESH', prism.id), inner);
  b.location = [-2, 0, 0];
  b.material_slots_link = ['DATA', 'OBJECT'];
  b.object_materials = [null, painted.id];
  b.hide = true;

  const cubeOb = doc.objects[doc.object_order.find((id) => doc.objects[id].type === 'MESH' && doc.objects[id].name === 'Cube')!];
  cubeOb.name = 'Rounded';
  cubeOb.modifiers.push(newModifier('SUBSURF', uid('md'), []));
  s.active_object = cubeOb.id;

  const cu = newCurve('Path');
  cu.bevel_depth = 0.1;
  cu.splines.push({ type: 'BEZIER', points: [], bezier_points: [0, 1, 2].map((i) => ({ co: [i, 0, 0], handle_left: [i - 0.3, -0.3, 0], handle_right: [i + 0.3, 0.3, 0], handle_left_type: 'ALIGNED', handle_right_type: 'ALIGNED', radius: 1, tilt: 0 })), use_cyclic_u: false, resolution_u: 6, order_u: 4, use_endpoint_u: false, use_smooth: true, material_index: 0 });
  doc.curves[cu.id] = cu;
  add(newObject('Path', 'CURVE', cu.id));

  const ortho = newCamera('Ortho');
  ortho.type = 'ORTHO';
  ortho.ortho_scale = 7;
  ortho.shift_x = 0.1;
  ortho.clip_start = 0.5;
  ortho.clip_end = 250;
  ortho.dof.use_dof = true;
  ortho.dof.focus_object = pivot.id;
  ortho.dof.focus_distance = 4;
  doc.cameras[ortho.id] = ortho;
  add(newObject('Ortho Cam', 'CAMERA', ortho.id));

  const spot = newLight('SPOT', 'Spot');
  spot.energy = 250;
  spot.color = [1, 0.8, 0.6];
  spot.spot_size = 0.9;
  spot.spot_blend = 0.3;
  spot.shadow_soft_size = 0.4;
  doc.lights[spot.id] = spot;
  add(newObject('Spot', 'LIGHT', spot.id));
  const area = newLight('AREA', 'Panel');
  area.shape = 'RECTANGLE';
  area.size = 2;
  area.size_y = 0.5;
  area.energy = 40;
  doc.lights[area.id] = area;
  add(newObject('Panel', 'LIGHT', area.id));
  const sun = newLight('SUN', 'Sun');
  sun.energy = 3;
  sun.angle = 0.1;
  doc.lights[sun.id] = sun;
  add(newObject('Sun', 'LIGHT', sun.id));
  return doc;
}
