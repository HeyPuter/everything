import type {
  CameraData,
  CollectionData,
  DocumentData,
  LightData,
  MaterialData,
  MeshData,
  NodeTreeData,
  ObjectData,
  ObjectType,
  RenderSettings,
  SceneData,
  ToolSettings,
  WorldData,
  CurveData,
  ArmatureData,
  ID,
  Mat4,
  ImageData,
  TextData,
  ActionData,
  NodeGroupData,
  LatticeData,
  BrushData,
} from './types';
import { startupCube } from '../mesh/primitives';
import { defaultBakeSettings } from '../bake/settings';

let counter = 0;
export function uid(prefix = 'id'): ID {
  counter = (counter + 1) % 1e9;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter.toString(36)}`;
}

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function defaultRender(): RenderSettings {
  return {
    engine: 'RASTER',
    bake: defaultBakeSettings(),
    bake_type: 'COMBINED',
    resolution_x: 1920,
    resolution_y: 1080,
    resolution_percentage: 100,
    pixel_aspect_x: 1,
    pixel_aspect_y: 1,
    film_transparent: false,
    fps: 24,
    fps_base: 1,
    file_format: 'PNG',
    color_mode: 'RGBA',
    filepath: '//render/',
    samples: 128,
    preview_samples: 32,
    raster_samples: 16,
    max_bounces: 8,
    diffuse_bounces: 4,
    glossy_bounces: 4,
    transmission_bounces: 8,
    use_denoising: true,
    preview_denoising: true,
    use_gtao: false,
    gtao_distance: 0.2,
    use_bloom: false,
    bloom_threshold: 0.8,
    bloom_intensity: 0.05,
    bloom_radius: 6.5,
    use_ssr: false,
    shadow_cube_size: 512,
    shadow_cascade_size: 1024,
    use_soft_shadows: true,
    use_motion_blur: false,
    motion_blur_shutter: 0.5,
    view_transform: 'AGX',
    look: 'None',
    exposure: 0,
    gamma: 1,
    use_pass_combined: true,
    use_pass_z: false,
    use_pass_normal: false,
    use_pass_mist: false,
    use_compositing: true,
    dither_intensity: 1,
    preview_raster_samples: 16,
    time_limit: 0,
    sample_clamp_direct: 0,
    sample_clamp_indirect: 10,
    blur_glossy: 1,
    direct_light_intensity: 1,
    indirect_light_intensity: 1,
    use_simplify: false,
    simplify_subdivision: 6,
    simplify_subdivision_render: 6,
    simplify_child_particles: 1,
    simplify_child_particles_render: 1,
    use_bokeh_jittered: true,
    motion_blur_position: 'CENTER',
    filter_size: 1.5,
    pixel_filter_type: 'BLACKMAN_HARRIS',
    filter_width: 1.5,
    film_exposure: 1,
    preview_pixel_size: 'AUTO',
    use_auto_tile: true,
    tile_size: 640,
    display_device: 'sRGB',
    sequencer_colorspace: 'sRGB',
    use_white_balance: false,
    white_balance_temperature: 6500,
    white_balance_tint: 10,
    use_curve_mapping: false,
    curve_mapping: [
      [0, 0],
      [1, 1],
    ],
    frame_map_old: 100,
    frame_map_new: 100,
    use_border: false,
    border_min_x: 0,
    border_min_y: 0,
    border_max_x: 1,
    border_max_y: 1,
    use_crop_to_border: false,
    use_file_extension: true,
    quality: 90,
    use_lock_interface: false,
    use_stamp: false,
    use_stamp_date: true,
    use_stamp_time: true,
    use_stamp_render_time: true,
    use_stamp_frame: true,
    use_stamp_frame_range: false,
    use_stamp_memory: false,
    use_stamp_hostname: false,
    use_stamp_camera: true,
    use_stamp_lens: false,
    use_stamp_scene: true,
    use_stamp_marker: false,
    use_stamp_filename: true,
    use_stamp_note: false,
    stamp_note_text: '',
    use_stamp_labels: true,
    stamp_font_size: 12,
    stamp_foreground: [0.8, 0.8, 0.8, 1],
    stamp_background: [0, 0, 0, 0.25],
    display_shading: {
      light: 'STUDIO',
      color_type: 'MATERIAL',
      single_color: [0.8, 0.8, 0.8],
      show_backface_culling: false,
      show_xray: false,
      xray_alpha: 0.5,
      show_shadows: false,
      show_cavity: false,
      show_object_outline: true,
      show_specular_highlight: true,
    },
    use_view_layer: true,
    use_sky: true,
    use_solid: true,
    use_pass_position: false,
    use_pass_uv: false,
    use_pass_object_index: false,
    use_pass_material_index: false,
    use_pass_diffuse_color: false,
    use_pass_emit: false,
    use_pass_ambient_occlusion: false,
  };
}

export function defaultToolSettings(): ToolSettings {
  return {
    use_snap: false,
    snap_elements: ['INCREMENT'],
    snap_target: 'CLOSEST',
    use_proportional_edit: false,
    use_proportional_edit_objects: false,
    proportional_edit_falloff: 'SMOOTH',
    proportional_size: 1,
    use_proportional_connected: false,
    transform_pivot_point: 'MEDIAN_POINT',
    mesh_select_mode: [true, false, false],
    use_mesh_automerge: false,
    double_threshold: 0.001,
    use_keyframe_insert_auto: false,
    keyframe_type: 'KEYFRAME',
    use_uv_select_sync: false,
    uv_select_mode: 'VERTEX',
    sculpt: {
      brush: 'brush_draw',
      use_symmetry_x: true,
      use_symmetry_y: false,
      use_symmetry_z: false,
      radius: 50,
      strength: 0.5,
      falloff: 'SMOOTH',
      autosmooth_factor: 0,
      direction: 'ADD',
      use_frontface: false,
      spacing: 10,
    },
    unified_paint: { size: 50, strength: 1, color: [1, 1, 1], secondary_color: [0, 0, 0], weight: 1 },
    use_auto_normalize: false,
    vertex_group_weight: 1,
  };
}

// ---------------------------------------------------------------------------
// Node tree defaults

export function principledTree(color: [number, number, number, number] = [0.8, 0.8, 0.8, 1]): NodeTreeData {
  return {
    type: 'SHADER',
    nodes: [
      {
        id: uid('node'),
        type: 'ShaderNodeBsdfPrincipled',
        name: 'Principled BSDF',
        location: [10, 300],
        width: 240,
        inputs: { 'Base Color': color },
        props: { distribution: 'MULTI_GGX', subsurface_method: 'RANDOM_WALK' },
      },
      {
        id: uid('node'),
        type: 'ShaderNodeOutputMaterial',
        name: 'Material Output',
        location: [300, 300],
        inputs: {},
        props: { target: 'ALL', is_active_output: true },
      },
    ] as NodeTreeData["nodes"],
    links: [],
  };
}

export function linkPrincipled(tree: NodeTreeData) {
  const bsdf = tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled'),
    out = tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial');
  if (bsdf && out)
    tree.links.push({ id: uid('link'), from_node: bsdf.id, from_socket: 'BSDF', to_node: out.id, to_socket: 'Surface' });
  return tree;
}

export function newMaterial(name = 'Material', color: [number, number, number, number] = [0.8, 0.8, 0.8, 1]): MaterialData {
  return {
    id: uid('ma'),
    name,
    use_nodes: true,
    tree: linkPrincipled(principledTree(color)),
    diffuse_color: [...color] as [number, number, number, number],
    metallic: 0,
    roughness: 0.5,
    blend_method: 'OPAQUE',
    alpha_threshold: 0.5,
    use_backface_culling: false,
    shadow_method: 'OPAQUE',
  };
}

export function newWorld(name = 'World'): WorldData {
  const bg = {
    id: uid('node'),
    type: 'ShaderNodeBackground',
    name: 'Background',
    location: [10, 300] as [number, number],
    inputs: { Color: [0.050876, 0.050876, 0.050876, 1], Strength: 1 },
    props: {},
  };
  const out = {
    id: uid('node'),
    type: 'ShaderNodeOutputWorld',
    name: 'World Output',
    location: [300, 300] as [number, number],
    inputs: {},
    props: { target: 'ALL', is_active_output: true },
  };
  return {
    id: uid('wo'),
    name,
    color: [0.050876, 0.050876, 0.050876],
    use_nodes: true,
    tree: {
      type: 'WORLD',
      nodes: [bg, out],
      links: [{ id: uid('link'), from_node: bg.id, from_socket: 'Background', to_node: out.id, to_socket: 'Surface' }],
    },
    mist_start: 5,
    mist_falloff: 'QUADRATIC',
    mist_depth: 25,
  };
}

export function compositorTree(): NodeTreeData {
  const rl = {
    id: uid('node'),
    type: 'CompositorNodeRLayers',
    name: 'Render Layers',
    location: [-300, 300] as [number, number],
    inputs: {},
    props: {},
  };
  const comp = {
    id: uid('node'),
    type: 'CompositorNodeComposite',
    name: 'Composite',
    location: [200, 300] as [number, number],
    inputs: {},
    props: {},
  };
  const viewer = {
    id: uid('node'),
    type: 'CompositorNodeViewer',
    name: 'Viewer',
    location: [200, 120] as [number, number],
    inputs: {},
    props: {},
  };
  return {
    type: 'COMPOSITOR',
    nodes: [rl, comp, viewer],
    links: [
      { id: uid('link'), from_node: rl.id, from_socket: 'Image', to_node: comp.id, to_socket: 'Image' },
      { id: uid('link'), from_node: rl.id, from_socket: 'Image', to_node: viewer.id, to_socket: 'Image' },
    ],
  };
}

export function geometryNodesTree(): NodeTreeData {
  const gi = {
    id: uid('node'),
    type: 'NodeGroupInput',
    name: 'Group Input',
    location: [-200, 0] as [number, number],
    inputs: {},
    props: {},
  };
  const go = {
    id: uid('node'),
    type: 'NodeGroupOutput',
    name: 'Group Output',
    location: [200, 0] as [number, number],
    inputs: {},
    props: {},
  };
  return {
    type: 'GEOMETRY',
    nodes: [gi, go],
    links: [{ id: uid('link'), from_node: gi.id, from_socket: 'Geometry', to_node: go.id, to_socket: 'Geometry' }],
    interface: [
      { in_out: 'INPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Geometry' },
      { in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Geometry' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Data-block factories

export function newMeshData(name: string, arrays: Partial<MeshData> & Pick<MeshData, 'positions' | 'offsets' | 'indices' | 'uvs' | 'normals'>): MeshData {
  return {
    id: uid('me'),
    name,
    vertex_groups: [],
    weights: [],
    shape_keys: [],
    active_shape_key_index: 0,
    color_attributes: [],
    active_color_index: 0,
    uv_map_name: 'UVMap',
    materials: [],
    ...arrays,
  };
}

export function newLight(type: LightData['type'] = 'POINT', name = type === 'SUN' ? 'Sun' : type === 'SPOT' ? 'Spot' : type === 'AREA' ? 'Area' : 'Point'): LightData {
  return {
    id: uid('la'),
    name,
    type,
    color: [1, 1, 1],
    energy: type === 'SUN' ? 1 : type === 'AREA' ? 1000 : 1000,
    shadow_soft_size: type === 'SUN' ? 0 : 0.1,
    angle: (0.526 * Math.PI) / 180,
    spot_size: Math.PI / 4,
    spot_blend: 0.15,
    show_cone: false,
    shape: 'SQUARE',
    size: 1,
    size_y: 1,
    use_shadow: true,
    diffuse_factor: 1,
    specular_factor: 1,
    volume_factor: 1,
    cutoff_distance: 40,
  };
}

export function newCamera(name = 'Camera'): CameraData {
  return {
    id: uid('ca'),
    name,
    type: 'PERSP',
    lens: 50,
    lens_unit: 'MILLIMETERS',
    sensor_width: 36,
    sensor_height: 24,
    sensor_fit: 'AUTO',
    ortho_scale: 6,
    clip_start: 0.1,
    clip_end: 1000,
    shift_x: 0,
    shift_y: 0,
    dof: { use_dof: false, focus_object: null, focus_distance: 10, aperture_fstop: 2.8, aperture_blades: 0 },
    display_size: 1,
    show_passepartout: true,
    passepartout_alpha: 0.5,
  };
}

export function newCurve(name = 'BezierCurve'): CurveData {
  return {
    id: uid('cu'),
    name,
    dimensions: '3D',
    splines: [],
    resolution_u: 12,
    bevel_depth: 0,
    bevel_resolution: 4,
    extrude: 0,
    offset: 0,
    fill_mode: 'FULL',
    use_fill_caps: false,
    materials: [],
  };
}

export function newArmature(name = 'Armature'): ArmatureData {
  return {
    id: uid('ar'),
    name,
    bones: [],
    display_type: 'OCTAHEDRAL',
    pose_position: 'POSE',
    show_names: false,
    show_axes: false,
  };
}

export function newLattice(name = 'Lattice'): LatticeData {
  const u = 2,
    v = 2,
    w = 2,
    pts: number[] = [];
  for (let k = 0; k < w; k++) for (let j = 0; j < v; j++) for (let i = 0; i < u; i++) pts.push(i / (u - 1) - 0.5, j / (v - 1) - 0.5, k / (w - 1) - 0.5);
  return { id: uid('lt'), name, points_u: u, points_v: v, points_w: w, points: new Float32Array(pts), interpolation: 'KEY_BSPLINE' };
}

export function newImage(name: string, width: number, height: number, generated: ImageData['generated_type'] = 'BLANK', color: [number, number, number, number] = [0, 0, 0, 1]): ImageData {
  return {
    id: uid('im'),
    name,
    mime: 'image/png',
    bytes: null,
    width,
    height,
    source: 'GENERATED',
    generated_type: generated,
    generated_color: color,
    colorspace: 'sRGB',
    revision: 0,
  };
}

export function newText(name = 'Text', body = '', language: TextData['language'] = 'javascript'): TextData {
  return { id: uid('tx'), name, body, language };
}

export function newAction(name = 'Action'): ActionData {
  return { id: uid('ac'), name, fcurves: [] };
}

export function newNodeGroup(name = 'Geometry Nodes'): NodeGroupData {
  return { id: uid('ng'), name, tree: geometryNodesTree(), is_modifier: true };
}

export function newObject(name: string, type: ObjectType, data: ID | null): ObjectData {
  return {
    id: uid('ob'),
    name,
    type,
    data,
    parent: null,
    parent_type: 'OBJECT',
    parent_bone: '',
    matrix_parent_inverse: [...IDENTITY],
    location: [0, 0, 0],
    rotation_mode: 'XYZ',
    rotation_euler: [0, 0, 0],
    rotation_quaternion: [1, 0, 0, 0],
    rotation_axis_angle: [0, 0, 1, 0],
    scale: [1, 1, 1],
    delta_location: [0, 0, 0],
    delta_rotation_euler: [0, 0, 0],
    delta_scale: [1, 1, 1],
    lock_location: [false, false, false],
    lock_rotation: [false, false, false],
    lock_scale: [false, false, false],
    hide_viewport: false,
    hide: false,
    hide_render: false,
    hide_select: false,
    select: false,
    display_type: 'TEXTURED',
    show_wire: false,
    show_in_front: false,
    show_name: false,
    show_axis: false,
    color: [1, 1, 1, 1],
    empty_display_type: 'PLAIN_AXES',
    empty_display_size: 1,
    instance_type: 'NONE',
    instance_faces_scale: 1,
    instance_collection: null,
    modifiers: [],
    constraints: [],
    animation_data: null,
    pose: null,
    active_material_index: 0,
    rigid_body: null,
    particle_systems: [],
    field: null,
    collision: null,
    custom: {},
  };
}

export function newCollection(name = 'Collection'): CollectionData {
  return {
    id: uid('co'),
    name,
    objects: [],
    children: [],
    hide_viewport: false,
    hide_render: false,
    hide_select: false,
    exclude: false,
    hide: false,
    color_tag: 'NONE',
    instance_offset: [0, 0, 0],
  };
}

export function defaultBrushes(): Record<ID, BrushData> {
  const b = (id: string, name: string, tool: string, extra: Partial<BrushData> = {}): BrushData => ({
    id,
    name,
    sculpt_tool: tool,
    mode: 'SCULPT',
    strength: 0.5,
    radius: 50,
    falloff: 'SMOOTH',
    direction: 'ADD',
    auto_smooth_factor: 0,
    spacing: 10,
    ...extra,
  });
  const list = [
    b('brush_draw', 'Draw', 'DRAW'),
    b('brush_draw_sharp', 'Draw Sharp', 'DRAW_SHARP', { falloff: 'SHARP' }),
    b('brush_clay', 'Clay', 'CLAY'),
    b('brush_clay_strips', 'Clay Strips', 'CLAY_STRIPS', { strength: 0.6 }),
    b('brush_layer', 'Layer', 'LAYER'),
    b('brush_inflate', 'Inflate/Deflate', 'INFLATE'),
    b('brush_blob', 'Blob', 'BLOB'),
    b('brush_crease', 'Crease', 'CREASE', { direction: 'SUBTRACT' }),
    b('brush_smooth', 'Smooth', 'SMOOTH', { strength: 0.5 }),
    b('brush_flatten', 'Flatten/Contrast', 'FLATTEN'),
    b('brush_fill', 'Fill/Deepen', 'FILL'),
    b('brush_scrape', 'Scrape/Peaks', 'SCRAPE'),
    b('brush_pinch', 'Pinch/Magnify', 'PINCH'),
    b('brush_grab', 'Grab', 'GRAB', { strength: 1 }),
    b('brush_snake_hook', 'Snake Hook', 'SNAKE_HOOK', { strength: 1 }),
    b('brush_thumb', 'Thumb', 'THUMB', { strength: 0.5 }),
    b('brush_nudge', 'Nudge', 'NUDGE'),
    b('brush_rotate', 'Rotate', 'ROTATE'),
    b('brush_mask', 'Mask', 'MASK', { strength: 1 }),
    b('brush_texpaint', 'Paint', 'TEXDRAW', { mode: 'TEXTURE_PAINT', strength: 1, color: [1, 1, 1], blend: 'MIX' }),
    b('brush_vertpaint', 'Paint', 'DRAW', { mode: 'VERTEX_PAINT', strength: 1, color: [1, 1, 1], blend: 'MIX' }),
    b('brush_weight', 'Paint', 'DRAW', { mode: 'WEIGHT_PAINT', strength: 1, blend: 'MIX' }),
  ];
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

export function defaultScene(collection: ID, world: ID): SceneData {
  return {
    id: uid('sc'),
    name: 'Scene',
    frame_start: 1,
    frame_end: 250,
    frame_step: 1,
    frame_current: 1,
    camera: null,
    world,
    collection,
    cursor: { location: [0, 0, 0], rotation_euler: [0, 0, 0] },
    render: defaultRender(),
    tool_settings: defaultToolSettings(),
    unit_settings: { system: 'METRIC', scale_length: 1, length_unit: 'METERS', system_rotation: 'DEGREES' },
    gravity: [0, 0, -9.81],
    use_gravity: true,
    timeline_markers: [],
    rigidbody_world: null,
    compositor: null,
    use_nodes: false,
    sync_mode: 'FRAME_DROP',
    active_object: null,
    custom: {},
    keying_set: 'LocRotScale',
  };
}

export function emptyDocument(): DocumentData {
  const master = newCollection('Scene Collection');
  const world = newWorld();
  return {
    version: 1,
    scene: defaultScene(master.id, world.id),
    objects: {},
    collections: { [master.id]: master },
    meshes: {},
    curves: {},
    lights: {},
    cameras: {},
    armatures: {},
    lattices: {},
    materials: {},
    worlds: { [world.id]: world },
    images: {},
    actions: {},
    node_groups: {},
    particles: {},
    texts: {},
    brushes: defaultBrushes(),
    mode: 'OBJECT',
    object_order: [],
  };
}

/** The startup scene: a cube, a camera and a light in "Collection". */
export function startupDocument(): DocumentData {
  const doc = emptyDocument();
  const col = newCollection('Collection');
  doc.collections[col.id] = col;
  doc.collections[doc.scene.collection].children.push(col.id);

  const mat = newMaterial('Material');
  doc.materials[mat.id] = mat;
  const me = newMeshData('Cube', startupCube());
  me.materials = [mat.id];
  me.select_vert = new Uint8Array(8).fill(1);
  doc.meshes[me.id] = me;
  const cubeOb = newObject('Cube', 'MESH', me.id);
  cubeOb.select = true;

  const ca = newCamera('Camera');
  doc.cameras[ca.id] = ca;
  const caOb = newObject('Camera', 'CAMERA', ca.id);
  caOb.location = [7.3589, -6.9258, 4.9583];
  caOb.rotation_euler = [(63.6 * Math.PI) / 180, 0, (46.7 * Math.PI) / 180];

  const la = newLight('POINT', 'Light');
  doc.lights[la.id] = la;
  const laOb = newObject('Light', 'LIGHT', la.id);
  laOb.location = [4.0762, 1.0055, 5.9039];
  laOb.rotation_euler = [(37.3 * Math.PI) / 180, (3.16 * Math.PI) / 180, (106.9 * Math.PI) / 180];

  for (const ob of [caOb, cubeOb, laOb]) {
    doc.objects[ob.id] = ob;
    doc.object_order.push(ob.id);
    col.objects.push(ob.id);
  }
  doc.scene.camera = caOb.id;
  doc.scene.active_object = cubeOb.id;
  return doc;
}
