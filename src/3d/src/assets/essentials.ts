// The built-in "Essentials" library: a small set of original assets made in code (materials,
// node groups, worlds, props and actions). Built once on first use; ids are fixed so that
// "Append (Reuse Data)" recognises data appended in earlier sessions.
import type { BrushData, DocumentData, MaterialData, NodeGroupData, NodeTreeData, ObjectData, SocketValue, WorldData, FCurve } from '../data/types';
import { emptyDocument, newMaterial, newWorld, newMeshData, newObject, newCollection, newAction, uid, geometryNodesTree } from '../data/defaults';
import { cylinder, uvSphere, plane, grid } from '../mesh/primitives';
import { addNode, connect, ctxOf, addInterfaceSocket } from '../nodes/tree';
import { insertKeyframe } from '../anim/fcurve';
import { ensureCatalogPath } from './catalogs';
import { newMetaData, type AssetMetaData } from './types';

const AUTHOR = 'Built-in';
const LICENSE = 'CC0';

type Rgba = [number, number, number, number];

function meta(doc: DocumentData, catalog: string, description: string, tags: string[]): AssetMetaData {
  return { ...newMetaData(), description, author: AUTHOR, license: LICENSE, tags, catalog_id: ensureCatalogPath((doc.asset_catalogs ??= []), catalog) };
}

function shaderTree(ma: MaterialData) {
  const tree = ma.tree;
  const bsdf = tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
  const out = tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial')!;
  return { tree, bsdf, out, ctx: ctxOf({} as DocumentData, tree) };
}

function material(doc: DocumentData, name: string, color: Rgba, inputs: Record<string, SocketValue>, catalog: string, description: string, tags: string[]): MaterialData {
  const ma = newMaterial(name, color);
  const { bsdf } = shaderTree(ma);
  Object.assign(bsdf.inputs, inputs);
  if (typeof inputs.Metallic === 'number') ma.metallic = inputs.Metallic;
  if (typeof inputs.Roughness === 'number') ma.roughness = inputs.Roughness;
  doc.materials[ma.id] = ma;
  (ma as MaterialData & { asset_data?: AssetMetaData }).asset_data = meta(doc, catalog, description, tags);
  return ma;
}

function buildMaterials(doc: DocumentData) {
  const clay = material(doc, 'Matte Clay', [0.62, 0.52, 0.45, 1], { Roughness: 0.92 }, 'Materials/Basic', 'A soft, warm, fully rough surface for look-development and sculpt reviews.', ['matte', 'neutral']);
  material(doc, 'Glossy Plastic', [0.7, 0.06, 0.05, 1], { Roughness: 0.22, 'Coat Weight': 0.3 }, 'Materials/Basic', 'Saturated red plastic with a light clear coat.', ['plastic', 'shiny']);
  material(doc, 'Rubber', [0.03, 0.03, 0.035, 1], { Roughness: 0.75, 'Specular IOR Level': 0.3 }, 'Materials/Basic', 'Dark, slightly dull rubber.', ['rubber', 'dark']);
  // UV checker
  {
    const ma = material(doc, 'Checker Test', [0.8, 0.8, 0.8, 1], { Roughness: 0.6 }, 'Materials/Basic', 'Two-tone checker pattern for checking UV layouts and texture stretching.', ['uv', 'pattern', 'test']);
    const { tree, bsdf, ctx } = shaderTree(ma);
    const coord = addNode(tree, 'ShaderNodeTexCoord', [-520, 300]);
    const ch = addNode(tree, 'ShaderNodeTexChecker', [-280, 300]);
    Object.assign(ch.inputs, { Scale: 8, Color1: [0.85, 0.85, 0.82, 1], Color2: [0.12, 0.32, 0.6, 1] });
    connect(ctx, coord.id, 'UV', ch.id, 'Vector');
    connect(ctx, ch.id, 'Color', bsdf.id, 'Base Color');
  }
  material(doc, 'Polished Gold', [1, 0.71, 0.29, 1], { Metallic: 1, Roughness: 0.12 }, 'Materials/Metal', 'Bright, mirror-like yellow metal.', ['metal', 'gold']);
  // brushed steel: stretched noise drives roughness and a fine bump
  {
    const ma = material(doc, 'Brushed Steel', [0.56, 0.57, 0.58, 1], { Metallic: 1, Roughness: 0.35 }, 'Materials/Metal', 'Steel with fine directional streaks.', ['metal', 'steel', 'brushed']);
    const { tree, bsdf, ctx } = shaderTree(ma);
    const coord = addNode(tree, 'ShaderNodeTexCoord', [-760, 300]);
    const map = addNode(tree, 'ShaderNodeMapping', [-560, 300]);
    map.inputs.Scale = [1, 60, 1];
    const noise = addNode(tree, 'ShaderNodeTexNoise', [-360, 300]);
    Object.assign(noise.inputs, { Scale: 6, Detail: 6 });
    const ramp = addNode(tree, 'ShaderNodeValToRGB', [-160, 380]);
    ramp.props.color_ramp = [0.3, 0.25, 0.25, 0.25, 1, 0.7, 0.45, 0.45, 0.45, 1];
    const bump = addNode(tree, 'ShaderNodeBump', [-160, 120]);
    Object.assign(bump.inputs, { Strength: 0.08 });
    connect(ctx, coord.id, 'Object', map.id, 'Vector');
    connect(ctx, map.id, 'Vector', noise.id, 'Vector');
    connect(ctx, noise.id, 'Fac', ramp.id, 'Fac');
    connect(ctx, ramp.id, 'Color', bsdf.id, 'Roughness');
    connect(ctx, noise.id, 'Fac', bump.id, 'Height');
    connect(ctx, bump.id, 'Normal', bsdf.id, 'Normal');
  }
  // copper with a teal patina in the crevices of a noise pattern
  {
    const ma = material(doc, 'Copper Patina', [0.95, 0.5, 0.33, 1], { Metallic: 1, Roughness: 0.3 }, 'Materials/Metal', 'Copper partly covered with a weathered green-blue layer.', ['metal', 'copper', 'weathered']);
    const { tree, bsdf, ctx } = shaderTree(ma);
    const noise = addNode(tree, 'ShaderNodeTexNoise', [-560, 300]);
    Object.assign(noise.inputs, { Scale: 3.5, Detail: 8, Roughness: 0.62 });
    const ramp = addNode(tree, 'ShaderNodeValToRGB', [-340, 300]);
    ramp.props.color_ramp = [0.48, 0, 0, 0, 1, 0.56, 1, 1, 1, 1];
    const col = addNode(tree, 'ShaderNodeMix', [-100, 420], { data_type: 'RGBA' });
    Object.assign(col.inputs, { A_Color: [0.95, 0.5, 0.33, 1], B_Color: [0.23, 0.55, 0.47, 1] });
    const metal = addNode(tree, 'ShaderNodeMath', [-100, 200], { operation: 'SUBTRACT' });
    metal.inputs.Value = 1;
    connect(ctx, noise.id, 'Fac', ramp.id, 'Fac');
    connect(ctx, ramp.id, 'Color', col.id, 'Factor_Float');
    connect(ctx, col.id, 'Result_Color', bsdf.id, 'Base Color');
    connect(ctx, ramp.id, 'Color', metal.id, 'Value_001');
    connect(ctx, metal.id, 'Value', bsdf.id, 'Metallic');
  }
  // glass
  {
    const ma = newMaterial('Clear Glass', [1, 1, 1, 1]);
    const { tree, bsdf, out, ctx } = shaderTree(ma);
    tree.nodes = tree.nodes.filter((n) => n !== bsdf);
    tree.links = [];
    const glass = addNode(tree, 'ShaderNodeBsdfGlass', [40, 300]);
    Object.assign(glass.inputs, { Roughness: 0.02, IOR: 1.45 });
    connect(ctx, glass.id, 'BSDF', out.id, 'Surface');
    ma.blend_method = 'BLEND';
    doc.materials[ma.id] = ma;
    (ma as MaterialData & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Materials/Special', 'Clean, colourless glass.', ['glass', 'transparent']);
  }
  // emission
  {
    const ma = newMaterial('Neon Glow', [0.1, 0.9, 1, 1]);
    const { tree, bsdf, out, ctx } = shaderTree(ma);
    tree.nodes = tree.nodes.filter((n) => n !== bsdf);
    tree.links = [];
    const em = addNode(tree, 'ShaderNodeEmission', [40, 300]);
    Object.assign(em.inputs, { Color: [0.1, 0.9, 1, 1], Strength: 6 });
    connect(ctx, em.id, 'Emission', out.id, 'Surface');
    ma.diffuse_color = [0.1, 0.9, 1, 1];
    doc.materials[ma.id] = ma;
    (ma as MaterialData & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Materials/Special', 'Strong cyan light emitter, for signs and accent lights.', ['emission', 'light']);
  }
  // wood rings
  {
    const ma = material(doc, 'Wood Rings', [0.45, 0.27, 0.13, 1], { Roughness: 0.55 }, 'Materials/Special', 'Procedural wood with concentric growth rings.', ['wood', 'procedural']);
    const { tree, bsdf, ctx } = shaderTree(ma);
    const coord = addNode(tree, 'ShaderNodeTexCoord', [-760, 300]);
    const wave = addNode(tree, 'ShaderNodeTexWave', [-520, 300], { wave_type: 'RINGS' });
    Object.assign(wave.inputs, { Scale: 2.2, Distortion: 3, Detail: 3 });
    const ramp = addNode(tree, 'ShaderNodeValToRGB', [-280, 300]);
    ramp.props.color_ramp = [0, 0.3, 0.16, 0.07, 1, 1, 0.55, 0.33, 0.16, 1];
    connect(ctx, coord.id, 'Object', wave.id, 'Vector');
    connect(ctx, wave.id, 'Fac', ramp.id, 'Fac');
    connect(ctx, ramp.id, 'Color', bsdf.id, 'Base Color');
  }
  return clay;
}

function shaderGroup(name: string): NodeGroupData {
  const tree: NodeTreeData = { type: 'SHADER', nodes: [], links: [], interface: [] };
  return { id: uid('ng'), name, tree };
}

function buildNodeGroups(doc: DocumentData) {
  const asset = (g: NodeGroupData, catalog: string, description: string, tags: string[]) => {
    doc.node_groups[g.id] = g;
    g.tree.description = description;
    (g as NodeGroupData & { asset_data?: AssetMetaData }).asset_data = meta(doc, catalog, description, tags);
  };
  // shading: tint the edges of a surface
  {
    const g = shaderGroup('Edge Tint');
    const t = g.tree;
    const ctx = ctxOf(doc, t);
    addInterfaceSocket(t, 'INPUT', 'Base', 'RGBA', [0.8, 0.8, 0.8, 1]);
    addInterfaceSocket(t, 'INPUT', 'Edge', 'RGBA', [0.2, 0.4, 1, 1]);
    addInterfaceSocket(t, 'INPUT', 'Width', 'FLOAT', 0.35);
    addInterfaceSocket(t, 'OUTPUT', 'Color', 'RGBA');
    const gi = addNode(t, 'NodeGroupInput', [-420, 0]);
    const lw = addNode(t, 'ShaderNodeLayerWeight', [-200, 120]);
    const mix = addNode(t, 'ShaderNodeMix', [20, 0], { data_type: 'RGBA' });
    const go = addNode(t, 'NodeGroupOutput', [240, 0]);
    const [base, edge, width] = t.interface!.filter((i) => i.in_out === 'INPUT');
    const out = t.interface!.find((i) => i.in_out === 'OUTPUT')!;
    connect(ctx, gi.id, width.identifier, lw.id, 'Blend');
    connect(ctx, lw.id, 'Facing', mix.id, 'Factor_Float');
    connect(ctx, gi.id, base.identifier, mix.id, 'A_Color');
    connect(ctx, gi.id, edge.identifier, mix.id, 'B_Color');
    connect(ctx, mix.id, 'Result_Color', go.id, out.identifier);
    asset(g, 'Node Groups/Shading', 'Blends from a base colour to an edge colour where the surface turns away from the view.', ['shading', 'fresnel', 'edge']);
  }
  // shading: soft noise mask
  {
    const g = shaderGroup('Grunge Mask');
    const t = g.tree;
    const ctx = ctxOf(doc, t);
    addInterfaceSocket(t, 'INPUT', 'Scale', 'FLOAT', 4);
    addInterfaceSocket(t, 'INPUT', 'Coverage', 'FLOAT', 0.5);
    addInterfaceSocket(t, 'OUTPUT', 'Mask', 'FLOAT');
    const gi = addNode(t, 'NodeGroupInput', [-480, 0]);
    const noise = addNode(t, 'ShaderNodeTexNoise', [-260, 60]);
    Object.assign(noise.inputs, { Detail: 10, Roughness: 0.7 });
    const cmp = addNode(t, 'ShaderNodeMath', [-40, 0], { operation: 'SUBTRACT' });
    const sm = addNode(t, 'ShaderNodeMath', [160, 0], { operation: 'MULTIPLY', use_clamp: true });
    sm.inputs.Value_001 = 4;
    const go = addNode(t, 'NodeGroupOutput', [360, 0]);
    const [scale, cover] = t.interface!.filter((i) => i.in_out === 'INPUT');
    const out = t.interface!.find((i) => i.in_out === 'OUTPUT')!;
    connect(ctx, gi.id, scale.identifier, noise.id, 'Scale');
    connect(ctx, noise.id, 'Fac', cmp.id, 'Value');
    connect(ctx, gi.id, cover.identifier, cmp.id, 'Value_001');
    connect(ctx, cmp.id, 'Value', sm.id, 'Value');
    connect(ctx, sm.id, 'Value', go.id, out.identifier);
    asset(g, 'Node Groups/Shading', 'A blotchy black-and-white mask for dirt, wear and variation.', ['mask', 'noise']);
  }
  // geometry: push the surface along its normals
  {
    const g: NodeGroupData = { id: uid('ng'), name: 'Inflate', tree: geometryNodesTree(), is_modifier: true };
    const t = g.tree;
    const ctx = ctxOf(doc, t);
    t.links = [];
    const gi = t.nodes.find((n) => n.type === 'NodeGroupInput')!;
    const go = t.nodes.find((n) => n.type === 'NodeGroupOutput')!;
    gi.location = [-460, 0];
    go.location = [260, 0];
    const amt = addInterfaceSocket(t, 'INPUT', 'Amount', 'FLOAT', 0.1);
    const nrm = addNode(t, 'GeometryNodeInputNormal', [-460, -160]);
    const sc = addNode(t, 'ShaderNodeVectorMath', [-240, -120], { operation: 'SCALE' });
    const sp = addNode(t, 'GeometryNodeSetPosition', [20, 0]);
    connect(ctx, gi.id, 'Geometry', sp.id, 'Geometry');
    connect(ctx, nrm.id, 'Normal', sc.id, 'Vector');
    connect(ctx, gi.id, amt.identifier, sc.id, 'Scale');
    connect(ctx, sc.id, 'Vector', sp.id, 'Offset');
    connect(ctx, sp.id, 'Geometry', go.id, 'Geometry');
    asset(g, 'Node Groups/Geometry', 'Moves every point outwards along the surface normal.', ['deform', 'normal']);
  }
  // geometry: scatter small spheres over the surface
  {
    const g: NodeGroupData = { id: uid('ng'), name: 'Scatter Pebbles', tree: geometryNodesTree(), is_modifier: true };
    const t = g.tree;
    const ctx = ctxOf(doc, t);
    t.links = [];
    const gi = t.nodes.find((n) => n.type === 'NodeGroupInput')!;
    const go = t.nodes.find((n) => n.type === 'NodeGroupOutput')!;
    gi.location = [-620, 0];
    go.location = [420, 0];
    const dens = addInterfaceSocket(t, 'INPUT', 'Density', 'FLOAT', 20);
    const rad = addInterfaceSocket(t, 'INPUT', 'Radius', 'FLOAT', 0.05);
    const seed = addInterfaceSocket(t, 'INPUT', 'Seed', 'INT', 0);
    const dist = addNode(t, 'GeometryNodeDistributePointsOnFaces', [-360, -60]);
    const ico = addNode(t, 'GeometryNodeMeshIcoSphere', [-360, -300]);
    const inst = addNode(t, 'GeometryNodeInstanceOnPoints', [-120, -60]);
    const real = addNode(t, 'GeometryNodeRealizeInstances', [60, -60]);
    const join = addNode(t, 'GeometryNodeJoinGeometry', [240, 0]);
    connect(ctx, gi.id, 'Geometry', dist.id, 'Mesh');
    connect(ctx, gi.id, dens.identifier, dist.id, 'Density');
    connect(ctx, gi.id, seed.identifier, dist.id, 'Seed');
    connect(ctx, gi.id, rad.identifier, ico.id, 'Radius');
    connect(ctx, dist.id, 'Points', inst.id, 'Points');
    connect(ctx, ico.id, 'Mesh', inst.id, 'Instance');
    connect(ctx, inst.id, 'Instances', real.id, 'Geometry');
    connect(ctx, gi.id, 'Geometry', join.id, 'Geometry');
    connect(ctx, real.id, 'Geometry', join.id, 'Geometry');
    connect(ctx, join.id, 'Geometry', go.id, 'Geometry');
    asset(g, 'Node Groups/Geometry', 'Covers the surface with small round stones.', ['scatter', 'instances']);
  }
}

function world(doc: DocumentData, name: string, catalog: string, description: string, tags: string[], build: (w: WorldData, bg: NonNullable<WorldData['tree']>['nodes'][number]) => void) {
  const w = newWorld(name);
  const bg = w.tree.nodes.find((n) => n.type === 'ShaderNodeBackground')!;
  build(w, bg);
  doc.worlds[w.id] = w;
  (w as WorldData & { asset_data?: AssetMetaData }).asset_data = meta(doc, catalog, description, tags);
}

function buildWorlds(doc: DocumentData) {
  world(doc, 'Studio Grey', 'Worlds', 'Even mid-grey surroundings, good for judging materials.', ['studio', 'neutral'], (w, bg) => {
    bg.inputs.Color = [0.18, 0.18, 0.18, 1];
    w.color = [0.18, 0.18, 0.18];
  });
  world(doc, 'Clear Day', 'Worlds', 'Blue daytime sky with a bright horizon.', ['sky', 'outdoor'], (w, bg) => {
    const sky = addNode(w.tree, 'ShaderNodeTexSky', [-240, 300]);
    sky.props.sun_elevation = 0.6;
    connect(ctxOf(doc, w.tree), sky.id, 'Color', bg.id, 'Color');
    w.color = [0.4, 0.55, 0.8];
  });
  world(doc, 'Night Blue', 'Worlds', 'Dim, cool surroundings for night scenes.', ['night', 'dark'], (w, bg) => {
    bg.inputs.Color = [0.012, 0.018, 0.045, 1];
    bg.inputs.Strength = 1;
    w.color = [0.012, 0.018, 0.045];
  });
}

function link(doc: DocumentData, ob: ObjectData, collection: string) {
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[collection].objects.push(ob.id);
}

function meshObject(doc: DocumentData, name: string, arrays: ReturnType<typeof cylinder>, mat: string, smooth = false) {
  const me = newMeshData(name, arrays);
  me.materials = [mat];
  if (smooth && me.smooth) me.smooth.fill(1);
  doc.meshes[me.id] = me;
  return newObject(name, 'MESH', me.id);
}

function buildObjects(doc: DocumentData, clay: MaterialData) {
  const master = doc.scene.collection;
  const plastic = Object.values(doc.materials).find((m) => m.name === 'Glossy Plastic')!;
  // props are kept in the scene collection of the library
  const ped = meshObject(doc, 'Pedestal', cylinder(48, 0.6, 0.3), clay.id);
  // sit the pedestal on the ground
  ped.delta_location = [0, 0, 0];
  const me = doc.meshes[ped.data!];
  const P = new Float32Array(me.positions);
  for (let i = 2; i < P.length; i += 3) P[i] += 0.15;
  me.positions = P;
  link(doc, ped, master);
  (ped as ObjectData & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Objects/Props', 'A low round stand for presenting a model.', ['stand', 'display']);
  const sph = meshObject(doc, 'Display Sphere', uvSphere(48, 24, 0.5), plastic.id, true);
  const sme = doc.meshes[sph.data!];
  const S = new Float32Array(sme.positions);
  for (let i = 2; i < S.length; i += 3) S[i] += 0.5;
  sme.positions = S;
  link(doc, sph, master);
  (sph as ObjectData & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Objects/Props', 'A smooth ball resting on the ground, for testing materials.', ['sphere', 'test']);
  // a floor and a back wall, grouped as one collection
  const col = newCollection('Backdrop Set');
  doc.collections[col.id] = col;
  doc.collections[master].children.push(col.id);
  const floor = meshObject(doc, 'Backdrop Floor', grid(4, 4, 6), clay.id);
  link(doc, floor, col.id);
  const wall = meshObject(doc, 'Backdrop Wall', plane(6), clay.id);
  wall.location = [0, 3, 3];
  wall.rotation_euler = [Math.PI / 2, 0, 0];
  link(doc, wall, col.id);
  (col as typeof col & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Collections', 'A floor and back wall forming a simple photo set.', ['studio', 'set']);
}

function curve(path: string, index: number, keys: [number, number][], interpolation: 'LINEAR' | 'BEZIER' = 'BEZIER', group = 'Object Transforms'): FCurve {
  const fc: FCurve = { data_path: path, array_index: index, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], group };
  for (const [f, v] of keys) insertKeyframe(fc, f, v, { interpolation, select_control_point: false, select_left_handle: false, select_right_handle: false });
  return fc;
}

function buildActions(doc: DocumentData) {
  const turn = newAction('Turntable');
  turn.fcurves.push(curve('rotation_euler', 2, [[1, 0], [121, Math.PI * 2]], 'LINEAR'));
  turn.frame_range = [1, 121];
  doc.actions[turn.id] = turn;
  (turn as typeof turn & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Animation', 'One full turn around the vertical axis over 120 frames.', ['rotation', 'loop']);
  const hop = newAction('Hop');
  hop.fcurves.push(curve('location', 2, [[1, 0], [10, 1], [19, 0]]));
  hop.fcurves.push(curve('scale', 2, [[1, 1], [10, 1.1], [19, 1]]));
  hop.frame_range = [1, 19];
  doc.actions[hop.id] = hop;
  (hop as typeof hop & { asset_data?: AssetMetaData }).asset_data = meta(doc, 'Animation', 'A single jump up and back down.', ['jump', 'motion']);
}

function buildBrushes(doc: DocumentData) {
  const brush = (name: string, mode: BrushData['mode'], tool: string, catalog: string, description: string, tags: string[], extra: Partial<BrushData>) => {
    const b: BrushData = { id: uid('br'), name, sculpt_tool: tool, mode, strength: 0.5, radius: 50, falloff: 'SMOOTH', direction: 'ADD', auto_smooth_factor: 0, spacing: 10, ...extra };
    doc.brushes[b.id] = b;
    (b as BrushData & { asset_data?: AssetMetaData }).asset_data = meta(doc, catalog, description, tags);
  };
  brush('Soft Clay', 'SCULPT', 'CLAY_STRIPS', 'Brushes/Sculpt', 'Gentle clay strips that smooth as they build, for blocking in forms.', ['clay', 'build'], { strength: 0.35, radius: 70, auto_smooth_factor: 0.3 });
  brush('Crisp Crease', 'SCULPT', 'CREASE', 'Brushes/Sculpt', 'A narrow, hard crease for panel lines and folds.', ['crease', 'detail'], { strength: 0.7, radius: 25, falloff: 'SHARP' });
  brush('Red Airbrush', 'TEXTURE_PAINT', 'TEXDRAW', 'Brushes/Paint', 'A wide, soft red spray for texture painting.', ['paint', 'soft'], { strength: 0.25, radius: 80, color: [0.8, 0.05, 0.04], hardness: 0 });
  brush('Yellow Marker', 'VERTEX_PAINT', 'DRAW', 'Brushes/Paint', 'A small, firm yellow marker for vertex colors.', ['paint', 'marker'], { strength: 1, radius: 18, color: [1, 0.8, 0.05], hardness: 0.9 });
  // paint presets built from the stroke and falloff options
  const x = (o: Record<string, unknown>) => o as Partial<BrushData>;
  brush('Airbrush', 'TEXTURE_PAINT', 'TEXDRAW', 'Brushes/Paint', 'Builds up color while held still, like a spray can.', ['paint', 'spray', 'soft'], x({ strength: 0.08, radius: 60, falloff: 'SMOOTHER', stroke_method: 'AIRBRUSH', rate: 0.05, use_accumulate: true }));
  brush('Pencil', 'TEXTURE_PAINT', 'TEXDRAW', 'Brushes/Paint', 'A tiny, solid tip for line work.', ['paint', 'line', 'hard'], x({ strength: 1, radius: 2, falloff: 'CONSTANT', spacing: 5 }));
  brush('Paint Soft Pressure', 'TEXTURE_PAINT', 'TEXDRAW', 'Brushes/Paint', 'A soft round brush whose size follows pen pressure.', ['paint', 'pressure'], x({ strength: 0.6, radius: 40, falloff: 'SMOOTH', use_pressure_size: true }));
  brush('Speckle', 'TEXTURE_PAINT', 'TEXDRAW', 'Brushes/Paint', 'Scattered dots around the stroke.', ['paint', 'scatter'], x({ strength: 1, radius: 6, falloff: 'SHARP', spacing: 150, jitter: 4, jitter_unit: 'BRUSH' }));
  brush('Noise Detail', 'SCULPT', 'DRAW', 'Brushes/Sculpt', 'Draw modulated by a noise texture, for skin and stone breakup.', ['detail', 'texture'], x({ strength: 0.3, radius: 60, texture_slot: { source: 'NOISE', map_mode: '3D', angle: 0, scale: 0.15, strength: 1 } }));
  brush('Steady Line', 'SCULPT', 'CREASE', 'Brushes/Sculpt', 'A stabilized crease for long, clean lines.', ['crease', 'line'], x({ strength: 0.5, radius: 20, use_smooth_stroke: true, smooth_stroke_radius: 60, smooth_stroke_factor: 0.9 }));
}

/** Replace the random ids of the library's data-blocks with fixed ones. */
function fixIds(doc: DocumentData): DocumentData {
  const map = new Map<string, string>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  for (const [table, t] of Object.entries(doc)) {
    if (!t || typeof t !== 'object' || Array.isArray(t) || table === 'scene') continue;
    for (const b of Object.values(t as Record<string, { id?: string; name?: string }>)) if (b && typeof b.id === 'string' && b.name) map.set(b.id, `ess_${table}_${slug(b.name)}`);
  }
  const remap = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) return v.map(remap);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[map.get(k) ?? k] = remap(x);
    return out;
  };
  return remap(doc) as DocumentData;
}

let built: DocumentData | null = null;

/** The Essentials library document (built on first use). */
export function essentialsDocument(): DocumentData {
  if (built) return built;
  const doc = emptyDocument();
  doc.brushes = {};
  doc.asset_catalogs = [];
  const clay = buildMaterials(doc);
  buildNodeGroups(doc);
  buildWorlds(doc);
  buildObjects(doc, clay);
  buildActions(doc);
  buildBrushes(doc);
  built = fixIds(doc);
  return built;
}
