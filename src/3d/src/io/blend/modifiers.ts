// Modifier and constraint conversion. The DNA struct type of each modifier/constraint data
// block identifies its kind; settings map onto the RNA property names used by the document.
import type { Constraint, ModifierBase } from '../../data/types';
import { uid } from '../../data/defaults';
import { modifierTypes, newModifier } from '../../eval/modifiers';
import { boneOnlyConstraints, constraintTypes, newConstraint } from '../../eval/constraints';
// registers the constraint types defined outside the core table (Action, Armature, IK, …)
import '../../eval/constraints_more';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { importGeometryNodes } from './geonodes';
import { convertAction } from './anim';

type P = Record<string, unknown>;
const bit = (v: number, b: number) => (v & b) !== 0;
const pick = <T>(arr: readonly T[], i: number, d: T): T => arr[i] ?? d;

const TEX_TYPES: Record<number, string> = { 1: 'CLOUDS', 2: 'WOOD', 3: 'MARBLE', 4: 'MAGIC', 5: 'BLEND', 6: 'STUCCI', 7: 'NOISE', 12: 'VORONOI' };

function texture(d: BStruct, ctx: Ctx, owner: string): P | null {
  const tex = d.ref('texture');
  if (!tex) return null;
  const type = TEX_TYPES[tex.num('type')];
  if (!type) {
    ctx.warn.add('Modifier textures of unsupported type ignored', `${owner} (${tex.idName})`);
    return null;
  }
  return { type, noise_scale: tex.num('noisesize') || 0.25, noise_depth: tex.num('noisedepth'), contrast: tex.num('contrast') || 1, brightness: tex.num('bright') || 1, turbulence: tex.num('turbul') };
}

/** IDProperty float/double/int value (used by geometry-node modifier inputs). */
function idpNumber(prop: BStruct, ctx: Ctx): number | null {
  const type = prop.num('type');
  const data = prop.sub('data');
  if (!data) return null;
  const off = data.offset + (data.field('val')?.offset ?? 0);
  if (type === 1) return data.num('val');
  if (type === 2) return ctx.f.dv.getFloat32(off, ctx.f.littleEndian);
  if (type === 8) return ctx.f.dv.getFloat64(off, ctx.f.littleEndian);
  return null;
}

type ModMap = (d: BStruct, ctx: Ctx, o: (s: BStruct | null) => string | null) => { type: string; p: P } | null;

const MODS: Record<string, ModMap> = {
  SubsurfModifierData: (d) => ({
    type: 'SUBSURF',
    p: {
      subdivision_type: d.num('subdivType') === 1 ? 'SIMPLE' : 'CATMULL_CLARK',
      levels: d.num('levels'),
      render_levels: d.num('renderLevels'),
      quality: d.num('quality'),
      use_creases: bit(d.num('flags'), 16),
      use_limit_surface: !bit(d.num('flags'), 64),
      uv_smooth: pick(['NONE', 'PRESERVE_CORNERS', 'PRESERVE_CORNERS_AND_JUNCTIONS', 'PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE', 'PRESERVE_BOUNDARIES', 'SMOOTH_ALL'], d.num('uv_smooth'), 'PRESERVE_BOUNDARIES'),
      boundary_smooth: d.num('boundary_smooth') === 1 ? 'PRESERVE_CORNERS' : 'ALL',
    },
  }),
  MirrorModifierData: (d, _c, o) => {
    const f = d.num('flag');
    return {
      type: 'MIRROR',
      p: {
        use_axis: [bit(f, 8), bit(f, 16), bit(f, 32)],
        use_bisect_axis: [bit(f, 256), bit(f, 512), bit(f, 1024)],
        use_bisect_flip_axis: [bit(f, 2048), bit(f, 4096), bit(f, 8192)],
        use_clip: bit(f, 1),
        use_mirror_merge: !bit(f, 128),
        merge_threshold: d.num('tolerance'),
        bisect_threshold: d.num('bisect_threshold'),
        use_mirror_u: bit(f, 2),
        use_mirror_v: bit(f, 4),
        mirror_offset_u: d.num('uv_offset', 0, 0),
        mirror_offset_v: d.num('uv_offset', 0, 1),
        use_mirror_vertex_groups: bit(f, 64),
        mirror_object: o(d.ref('mirror_ob')),
      },
    };
  },
  ArrayModifierData: (d, ctx, o) => {
    const ot = d.num('offset_type');
    if (d.ptr('start_cap') || d.ptr('end_cap')) ctx.warn.add('Array start/end caps not supported', d.sub('modifier')!.str('name'));
    return {
      type: 'ARRAY',
      p: {
        count: d.num('count'),
        fit_type: pick(['FIXED_COUNT', 'FIT_LENGTH', 'FIT_CURVE'], d.num('fit_type'), 'FIXED_COUNT'),
        fit_length: d.num('length'),
        curve: o(d.ref('curve_ob')),
        use_relative_offset: bit(ot, 2),
        relative_offset_displace: d.nums('scale', 3),
        use_constant_offset: bit(ot, 1),
        constant_offset_displace: d.nums('offset', 3),
        use_object_offset: bit(ot, 4),
        offset_object: o(d.ref('offset_ob')),
        use_merge_vertices: bit(d.num('flags'), 1),
        use_merge_vertices_cap: bit(d.num('flags'), 2),
        merge_threshold: d.num('merge_dist'),
        offset_u: d.num('uv_offset', 0, 0),
        offset_v: d.num('uv_offset', 0, 1),
      },
    };
  },
  SolidifyModifierData: (d) => {
    const f = d.num('flag');
    return {
      type: 'SOLIDIFY',
      p: {
        thickness: d.num('offset'),
        offset: d.num('offset_fac'),
        use_even_offset: bit(f, 2),
        use_quality_normals: bit(f, 4),
        use_rim: bit(f, 1),
        use_rim_only: bit(f, 64),
        use_flip_normals: bit(f, 32),
        invert_vertex_group: bit(f, 8),
        material_offset: d.num('mat_ofs'),
        material_offset_rim: d.num('mat_ofs_rim'),
        vertex_group: d.str('defgrp_name'),
        solidify_mode: d.num('mode') === 1 ? 'NON_MANIFOLD' : 'EXTRUDE',
      },
    };
  },
  BevelModifierData: (d) => ({
    type: 'BEVEL',
    p: {
      width: d.num('value'),
      segments: d.num('res'),
      profile: d.num('profile'),
      affect: d.num('affect_type') === 0 ? 'VERTICES' : 'EDGES',
      limit_method: ({ 0: 'NONE', 8: 'ANGLE', 16: 'WEIGHT', 32: 'VGROUP' } as Record<number, string>)[d.num('lim_flags')] ?? 'ANGLE',
      angle_limit: d.num('bevel_angle'),
      vertex_group: d.str('defgrp_name'),
      material: d.num('mat'),
    },
  }),
  DisplaceModifierData: (d, ctx) => ({
    type: 'DISPLACE',
    p: {
      strength: d.num('strength'),
      mid_level: d.num('midlevel'),
      direction: pick(['X', 'Y', 'Z', 'NORMAL', 'RGB_TO_XYZ', 'CUSTOM_NORMAL'], d.num('direction'), 'NORMAL'),
      space: d.num('space') === 1 ? 'GLOBAL' : 'LOCAL',
      texture_coords: pick(['LOCAL', 'GLOBAL', 'OBJECT', 'UV'], d.num('texmapping'), 'LOCAL'),
      vertex_group: d.str('defgrp_name'),
      texture: texture(d, ctx, d.sub('modifier')!.str('name')),
    },
  }),
  SmoothModifierData: (d) => {
    const f = d.num('flag');
    return { type: 'SMOOTH', p: { factor: d.num('fac'), iterations: d.num('repeat'), use_x: bit(f, 2), use_y: bit(f, 4), use_z: bit(f, 8), vertex_group: d.str('defgrp_name') } };
  },
  LaplacianSmoothModifierData: (d) => ({ type: 'LAPLACIANSMOOTH', p: { iterations: d.num('repeat'), lambda_factor: d.num('lambda'), lambda_border: d.num('lambda_border'), vertex_group: d.str('defgrp_name') } }),
  WaveModifierData: (d, ctx) => {
    const f = d.num('flag');
    return {
      type: 'WAVE',
      p: {
        use_x: bit(f, 2),
        use_y: bit(f, 4),
        use_cyclic: bit(f, 8),
        use_normal: bit(f, 16),
        use_normal_x: bit(f, 32),
        use_normal_y: bit(f, 64),
        use_normal_z: bit(f, 128),
        time_offset: d.num('timeoffs'),
        height: d.num('height'),
        width: d.num('width'),
        narrowness: d.num('narrow'),
        speed: d.num('speed'),
        start_position_x: d.num('startx'),
        start_position_y: d.num('starty'),
        falloff_radius: d.num('falloff'),
        damping_time: d.num('damp'),
        lifetime: d.num('lifetime'),
        vertex_group: d.str('defgrp_name'),
        texture: texture(d, ctx, d.sub('modifier')!.str('name')),
      },
    };
  },
  SimpleDeformModifierData: (d, _c, o) => {
    const method = pick(['TWIST', 'TWIST', 'BEND', 'TAPER', 'STRETCH'], d.num('mode'), 'TWIST');
    return { type: 'SIMPLE_DEFORM', p: { deform_method: method, angle: d.num('factor'), factor: d.num('factor'), deform_axis: pick(['X', 'Y', 'Z'], d.num('deform_axis'), 'Z'), origin: o(d.ref('origin')), limits: d.nums('limit', 2), vertex_group: d.str('vgroup_name') } };
  },
  LatticeModifierData: (d, _c, o) => ({ type: 'LATTICE', p: { object: o(d.ref('object')), strength: d.num('strength'), vertex_group: d.str('name') } }),
  CurveModifierData: (d, _c, o) => ({ type: 'CURVE', p: { object: o(d.ref('object')), deform_axis: pick(['POS_X', 'POS_X', 'POS_Y', 'POS_Z', 'NEG_X', 'NEG_Y', 'NEG_Z'], d.num('defaxis'), 'POS_X'), vertex_group: d.str('name') } }),
  TriangulateModifierData: (d) => ({ type: 'TRIANGULATE', p: { quad_method: pick(['BEAUTY', 'FIXED', 'FIXED_ALTERNATE', 'SHORTEST_DIAGONAL', 'LONGEST_DIAGONAL'], d.num('quad_method'), 'BEAUTY'), ngon_method: d.num('ngon_method') === 1 ? 'CLIP' : 'BEAUTY', min_vertices: d.num('min_vertices') } }),
  WeldModifierData: (d) => ({ type: 'WELD', p: { merge_threshold: d.num('merge_dist'), mode: d.num('mode') === 1 ? 'CONNECTED' : 'ALL', vertex_group: d.str('defgrp_name') } }),
  EdgeSplitModifierData: (d) => ({ type: 'EDGE_SPLIT', p: { split_angle: d.num('split_angle'), use_edge_angle: bit(d.num('flags'), 2), use_edge_sharp: bit(d.num('flags'), 4) } }),
  ScrewModifierData: (d, _c, o) => {
    const f = d.num('flag');
    return {
      type: 'SCREW',
      p: { angle: d.num('angle'), steps: d.num('steps'), render_steps: d.num('render_steps'), screw_offset: d.num('screw_ofs'), iterations: d.num('iter'), axis: pick(['X', 'Y', 'Z'], d.num('axis'), 'Z'), object: o(d.ref('ob_axis')), use_merge_vertices: bit(f, 256), merge_threshold: d.num('merge_dist'), use_smooth_shade: bit(f, 32), use_flip: bit(f, 1), use_normal_calculate: bit(f, 2) },
    };
  },
  BuildModifierData: (d) => ({ type: 'BUILD', p: { frame_start: d.num('start'), frame_duration: d.num('length'), use_random_order: bit(d.num('flag'), 1), seed: d.num('seed'), use_reverse: bit(d.num('flag'), 2) } }),
  MaskModifierData: (d, _c, o) => ({ type: 'MASK', p: { mode: d.num('mode') === 1 ? 'ARMATURE' : 'VERTEX_GROUP', vertex_group: d.str('vgroup'), invert_vertex_group: bit(d.num('flag'), 1), threshold: d.num('threshold'), armature: o(d.ref('ob_arm')) } }),
  CastModifierData: (d, _c, o) => {
    const f = d.num('flag');
    return { type: 'CAST', p: { cast_type: pick(['SPHERE', 'CYLINDER', 'CUBOID'], d.num('type'), 'SPHERE'), factor: d.num('fac'), radius: d.num('radius'), size: d.num('size'), use_x: bit(f, 2), use_y: bit(f, 4), use_z: bit(f, 8), use_transform: bit(f, 16), use_radius_as_size: bit(f, 32), object: o(d.ref('object')), vertex_group: d.str('defgrp_name') } };
  },
  ShrinkwrapModifierData: (d, _c, o) => ({ type: 'SHRINKWRAP', p: { target: o(d.ref('target')), auxiliary_target: o(d.ref('auxTarget')), wrap_method: pick(['NEAREST_SURFACEPOINT', 'PROJECT', 'NEAREST_VERTEX', 'TARGET_PROJECT'], d.num('shrinkType'), 'NEAREST_SURFACEPOINT'), offset: d.num('keepDist'), vertex_group: d.str('vgroup_name') } }),
  WarpModifierData: (d, _c, o) => ({ type: 'WARP', p: { object_from: o(d.ref('object_from')), object_to: o(d.ref('object_to')), strength: d.num('strength'), falloff_radius: d.num('falloff_radius'), vertex_group: d.str('defgrp_name') } }),
  HookModifierData: (d, ctx, o) => {
    const n = Math.max(0, Math.min(10_000_000, d.num('totindex')));
    const idx = n ? ctx.f.int32(d.ptr('indexar'), n, d.block) : null;
    return { type: 'HOOK', p: { object: o(d.ref('object')), subtarget: d.str('subtarget'), strength: d.num('force'), falloff_radius: d.num('falloff'), center: d.nums('cent', 3), matrix_inverse: d.nums('parentinv', 16), vertex_indices: idx ? Array.from(idx) : [], vertex_group: d.str('name') } };
  },
  ArmatureModifierData: (d, _c, o) => {
    const f = d.num('deformflag');
    return { type: 'ARMATURE', p: { object: o(d.ref('object')), use_vertex_groups: bit(f, 1), use_bone_envelopes: bit(f, 2), use_deform_preserve_volume: bit(f, 4), use_multi_modifier: d.num('multi') !== 0, vertex_group: d.str('defgrp_name') } };
  },
  WireframeModifierData: (d) => ({ type: 'WIREFRAME', p: { thickness: d.num('offset') } }),
  NodesModifierData: (d, ctx) => {
    const ng = d.ref('node_group');
    const name = ng?.idName ?? '';
    if (/^Smooth by Angle/.test(name) && modifierTypes.SMOOTH_BY_ANGLE) {
      let angle: number | null = null;
      const props = d.sub('settings')?.ref('properties');
      const kids = props?.sub('data')?.list('group') ?? [];
      const first = kids.find((k) => k.str('name') === 'Input_1') ?? kids.find((k) => [2, 8].includes(k.num('type')));
      if (first) angle = idpNumber(first, ctx);
      return { type: 'SMOOTH_BY_ANGLE', p: angle !== null && Number.isFinite(angle) ? { angle } : {} };
    }
    const gn = modifierTypes.NODES ? importGeometryNodes(d, ctx) : null;
    if (gn) return { type: 'NODES', p: { node_group: gn.node_group, ...gn.inputs } };
    if (!modifierTypes.NODES) ctx.warn.add('Geometry Nodes modifiers not supported (skipped)', `${d.sub('modifier')!.str('name')}${name ? ` (${name})` : ''}`);
    return null;
  },
};

const MOD_LABELS: Record<string, string> = {
  BooleanModifierData: 'Boolean',
  DecimateModifierData: 'Decimate',
  RemeshModifierData: 'Remesh',
  MultiresModifierData: 'Multiresolution',
  WeightedNormalModifierData: 'Weighted Normal',
  ParticleSystemModifierData: 'Particle System',
  ClothModifierData: 'Cloth',
  CollisionModifierData: 'Collision',
};

export function convertModifiers(ob: BStruct, ctx: Ctx, o: (s: BStruct | null) => string | null): ModifierBase[] {
  const out: ModifierBase[] = [];
  for (const d of ob.list('modifiers', 1000)) {
    const md = d.sub('modifier');
    if (!md) continue;
    const name = md.str('name');
    const conv = MODS[d.type];
    if (!conv) {
      if (d.type !== 'NodesModifierData') ctx.warn.add('Modifiers not supported (skipped)', `${name} (${MOD_LABELS[d.type] ?? d.type.replace(/ModifierData$/, '')})`);
      continue;
    }
    const r = conv(d, ctx, o);
    if (!r) continue;
    const m = newModifier(r.type, uid('md'), out);
    for (const [k, v] of Object.entries(r.p)) if (v !== undefined) m[k] = v;
    m.name = name || m.name;
    const mode = md.num('mode');
    m.show_viewport = bit(mode, 1);
    m.show_render = bit(mode, 2);
    m.show_in_editmode = bit(mode, 4);
    m.show_on_cage = bit(mode, 8);
    m.show_expanded = bit(md.num('ui_expand_flag'), 1);
    if (!modifierTypes[r.type]) ctx.warn.add('Modifiers imported but not evaluated by this app', `${name} (${r.type})`);
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constraints

const SPACE: Constraint['owner_space'][] = ['WORLD', 'LOCAL', 'POSE', 'LOCAL_WITH_PARENT', 'LOCAL_OWNER_ORIENT', 'CUSTOM'];
const TRACK = ['TRACK_X', 'TRACK_Y', 'TRACK_Z', 'TRACK_NEGATIVE_X', 'TRACK_NEGATIVE_Y', 'TRACK_NEGATIVE_Z'];
const UP = ['UP_X', 'UP_Y', 'UP_Z'];
const EULER = ['AUTO', 'XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
const actionCaches = new WeakMap<Ctx, Map<string, string>>();

type ConMap = (d: BStruct, ctx: Ctx, o: (s: BStruct | null) => string | null) => { type: string; p: P } | null;
const xyz = (f: number, b: [number, number, number], prefix: string, suffix = ''): P => ({ [`${prefix}x${suffix}`]: bit(f, b[0]), [`${prefix}y${suffix}`]: bit(f, b[1]), [`${prefix}z${suffix}`]: bit(f, b[2]) });

const CONS: Record<string, ConMap> = {
  bLocateLikeConstraint: (d) => {
    const f = d.num('flag');
    return { type: 'COPY_LOCATION', p: { ...xyz(f, [1, 2, 4], 'use_'), ...xyz(f, [16, 32, 64], 'invert_'), use_offset: bit(f, 128) } };
  },
  bRotateLikeConstraint: (d) => {
    const f = d.num('flag');
    return { type: 'COPY_ROTATION', p: { ...xyz(f, [1, 2, 4], 'use_'), ...xyz(f, [16, 32, 64], 'invert_'), mix_mode: pick(['REPLACE', 'OFFSET', 'ADD', 'BEFORE', 'AFTER'], d.num('mix_mode'), 'REPLACE'), euler_order: pick(['AUTO', 'XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'], d.num('euler_order'), 'AUTO') } };
  },
  bSizeLikeConstraint: (d) => {
    const f = d.num('flag');
    return { type: 'COPY_SCALE', p: { ...xyz(f, [1, 2, 4], 'use_'), use_offset: bit(f, 8), use_add: !bit(f, 16), use_make_uniform: bit(f, 32), power: d.num('power') } };
  },
  bTransLikeConstraint: (d) => ({ type: 'COPY_TRANSFORMS', p: { mix_mode: pick(['REPLACE', 'BEFORE_FULL', 'AFTER_FULL', 'BEFORE', 'AFTER', 'BEFORE_SPLIT', 'AFTER_SPLIT'], d.num('mix_mode'), 'REPLACE'), remove_target_shear: bit(d.num('flag'), 1) } }),
  bLocLimitConstraint: (d) => limits(d, 'LIMIT_LOCATION'),
  bSizeLimitConstraint: (d) => limits(d, 'LIMIT_SCALE'),
  bRotLimitConstraint: (d) => {
    const f = d.num('flag');
    return { type: 'LIMIT_ROTATION', p: { use_limit_x: bit(f, 1), use_limit_y: bit(f, 2), use_limit_z: bit(f, 4), use_legacy_behavior: bit(f, 8), min_x: d.num('xmin'), max_x: d.num('xmax'), min_y: d.num('ymin'), max_y: d.num('ymax'), min_z: d.num('zmin'), max_z: d.num('zmax'), euler_order: pick(EULER, d.num('euler_order'), 'AUTO'), use_transform_limit: bit(d.num('flag2'), 2) } };
  },
  bDistLimitConstraint: (d) => ({ type: 'LIMIT_DISTANCE', p: { distance: d.num('dist'), limit_mode: pick(['LIMITDIST_INSIDE', 'LIMITDIST_OUTSIDE', 'LIMITDIST_ONSURFACE'], d.num('mode'), 'LIMITDIST_INSIDE'), use_transform_limit: bit(d.num('flag'), 2) } }),
  bTrackToConstraint: (d) => ({ type: 'TRACK_TO', p: { track_axis: pick(TRACK, d.num('reserved1'), 'TRACK_Y'), up_axis: pick(UP, d.num('reserved2'), 'UP_Z'), use_target_z: bit(d.num('flags'), 1) } }),
  bDampTrackConstraint: (d) => ({ type: 'DAMPED_TRACK', p: { track_axis: pick(TRACK, d.num('trackflag'), 'TRACK_Y') } }),
  bLockTrackConstraint: (d) => ({ type: 'LOCKED_TRACK', p: { track_axis: pick(TRACK, d.num('trackflag'), 'TRACK_Y'), lock_axis: pick(['LOCK_X', 'LOCK_Y', 'LOCK_Z'], d.num('lockflag'), 'LOCK_Z') } }),
  bStretchToConstraint: (d) => {
    const f = d.num('flag');
    return {
      type: 'STRETCH_TO',
      p: {
        rest_length: d.num('orglength'),
        bulge: d.num('bulge'),
        volume: pick(['VOLUME_XZX', 'VOLUME_X', 'VOLUME_Z', 'NO_VOLUME'], d.num('volmode'), 'VOLUME_XZX'),
        keep_axis: pick(['PLANE_X', 'SWING_Y', 'PLANE_Z'], d.num('plane'), 'SWING_Y'),
        use_bulge_min: bit(f, 1),
        use_bulge_max: bit(f, 2),
        bulge_min: d.num('bulge_min', 1),
        bulge_max: d.num('bulge_max', 1),
        bulge_smooth: d.num('bulge_smooth'),
      },
    };
  },
  bChildOfConstraint: (d) => {
    const f = d.num('flag');
    return { type: 'CHILD_OF', p: { inverse_matrix: d.nums('invmat', 16), set_inverse_pending: bit(f, 512), ...xyz(f, [1, 2, 4], 'use_location_'), ...xyz(f, [8, 16, 32], 'use_rotation_'), ...xyz(f, [64, 128, 256], 'use_scale_') } };
  },
  bFollowPathConstraint: (d) => {
    const ff = d.num('followflag');
    const tgt = d.ref('tar');
    const cu = tgt?.ref('data');
    const p: P = { offset: d.num('offset'), offset_factor: d.num('offset_fac'), use_curve_follow: bit(ff, 1), use_fixed_location: bit(ff, 2), use_curve_radius: bit(ff, 4), forward_axis: pick(['FORWARD_X', 'FORWARD_Y', 'FORWARD_Z', 'TRACK_NEGATIVE_X', 'TRACK_NEGATIVE_Y', 'TRACK_NEGATIVE_Z'], d.num('trackflag'), 'FORWARD_Y'), up_axis: pick(UP, d.num('upflag'), 'UP_Z') };
    if (cu?.type === 'Curve' && cu.num('pathlen') > 0) p.path_duration = cu.num('pathlen');
    return { type: 'FOLLOW_PATH', p };
  },
  bMinMaxConstraint: (d) => ({ type: 'FLOOR', p: { floor_location: pick(['FLOOR_X', 'FLOOR_Y', 'FLOOR_Z', 'FLOOR_NEGATIVE_X', 'FLOOR_NEGATIVE_Y', 'FLOOR_NEGATIVE_Z'], d.num('minmaxflag'), 'FLOOR_Z'), offset: d.num('offset'), use_rotation: bit(d.num('flag'), 4) } }),
  bShrinkwrapConstraint: (d, _c, o) => {
    const f = d.num('flag');
    return {
      type: 'SHRINKWRAP',
      p: {
        target: o(d.ref('target')),
        distance: d.num('dist'),
        shrinkwrap_type: pick(['NEAREST_SURFACE', 'PROJECT', 'NEAREST_VERTEX', 'TARGET_PROJECT'], d.num('shrinkType'), 'NEAREST_SURFACE'),
        wrap_mode: pick(['ON_SURFACE', 'INSIDE', 'OUTSIDE', 'OUTSIDE_SURFACE', 'ABOVE_SURFACE'], d.num('shrinkMode'), 'ON_SURFACE'),
        project_axis: pick(['POS_X', 'POS_Y', 'POS_Z', 'NEG_X', 'NEG_Y', 'NEG_Z'], d.num('projAxis'), 'POS_Z'),
        project_axis_space: d.num('projAxisSpace') === 0 ? 'WORLD' : 'LOCAL',
        project_limit: d.num('projLimit'),
        use_project_opposite: bit(f, 1),
        use_invert_cull: bit(f, 2),
        use_track_normal: bit(f, 4),
        cull_face: bit(f, 8) ? 'FRONT' : bit(f, 16) ? 'BACK' : 'OFF',
        track_axis: pick(TRACK, d.num('trackAxis'), 'TRACK_X'),
      },
    };
  },
  bPivotConstraint: (d) => ({ type: 'PIVOT', p: { offset: d.nums('offset', 3), rotation_range: d.num('rotAxis') < 0 ? 'ALWAYS_ACTIVE' : pick(['NX', 'NY', 'NZ', 'X', 'Y', 'Z'], d.num('rotAxis'), 'NX'), use_relative_location: !bit(d.num('flag'), 1) } }),
  bSameVolumeConstraint: (d) => ({ type: 'MAINTAIN_VOLUME', p: { free_axis: pick(['SAMEVOL_X', 'SAMEVOL_Y', 'SAMEVOL_Z'], d.num('free_axis'), 'SAMEVOL_Y'), volume: d.num('volume'), mode: pick(['STRICT', 'UNIFORM', 'SINGLE_AXIS'], d.num('mode'), 'STRICT') } }),
  bClampToConstraint: (d) => ({ type: 'CLAMP_TO', p: { main_axis: pick(['CLAMPTO_AUTO', 'CLAMPTO_X', 'CLAMPTO_Y', 'CLAMPTO_Z'], d.num('flag'), 'CLAMPTO_AUTO'), use_cyclic: bit(d.num('flag2'), 1) } }),
  bActionConstraint: (d, ctx) => {
    const t = d.num('type');
    const channel = t >= 20 ? `LOCATION_${'XYZ'[t - 20] ?? 'X'}` : t >= 10 ? `SCALE_${'XYZ'[t - 10] ?? 'X'}` : `ROTATION_${'XYZ'[t] ?? 'X'}`;
    const act = d.ref('act');
    let cache = actionCaches.get(ctx);
    if (!cache) actionCaches.set(ctx, (cache = new Map()));
    return {
      type: 'ACTION',
      p: {
        transform_channel: channel,
        mix_mode: pick(['AFTER_FULL', 'AFTER', 'BEFORE', 'BEFORE_FULL', 'AFTER_SPLIT', 'BEFORE_SPLIT', 'REPLACE'], d.num('mix_mode'), 'AFTER'),
        frame_start: d.num('start'),
        frame_end: d.num('end'),
        min: d.num('min'),
        max: d.num('max'),
        eval_time: d.num('eval_time'),
        use_bone_object_action: bit(d.num('flag'), 1),
        use_eval_time: bit(d.num('flag'), 2),
        action: act ? convertAction(act, d.num('action_slot_handle'), ctx, '', cache) : null,
      },
    };
  },
  bArmatureConstraint: (d, _c, o) => {
    const f = d.num('flag');
    return {
      type: 'ARMATURE',
      p: {
        use_deform_preserve_volume: bit(f, 1),
        use_bone_envelopes: bit(f, 2),
        use_current_location: bit(f, 4),
        targets: d.list('targets').map((t) => ({ target: o(t.ref('tar')), subtarget: t.str('subtarget'), weight: t.num('weight') })),
      },
    };
  },
  bSplineIKConstraint: (d) => {
    const f = d.num('flag');
    return {
      type: 'SPLINE_IK',
      p: {
        chain_count: d.num('chainlen') || 1,
        use_chain_offset: bit(f, 2),
        use_even_divisions: bit(f, 8),
        use_curve_radius: !bit(f, 16),
        use_bulge_min: bit(f, 32),
        use_bulge_max: bit(f, 64),
        use_original_scale: bit(f, 128),
        xz_scale_mode: pick(['NONE', 'BONE_ORIGINAL', 'INVERSE_PRESERVE', 'VOLUME_PRESERVE'], d.num('xzScaleMode'), 'NONE'),
        y_scale_mode: pick(['NONE', 'FIT_CURVE', 'BONE_ORIGINAL'], d.num('yScaleMode'), 'FIT_CURVE'),
        bulge: d.num('bulge', 1),
        bulge_min: d.num('bulge_min', 1),
        bulge_max: d.num('bulge_max', 1),
        bulge_smooth: d.num('bulge_smooth'),
      },
    };
  },
  bGeometryAttributeConstraint: (d, _c, o) => {
    const f = d.num('flags');
    return {
      type: 'GEOMETRY_ATTRIBUTE',
      p: {
        target: o(d.ref('target')),
        attribute_name: d.cstr('attribute_name') || 'position',
        sample_index: d.num('sample_index'),
        apply_target_transform: !!d.num('apply_target_transform'),
        mix_mode: pick(['REPLACE', 'BEFORE_SPLIT', 'AFTER_SPLIT', 'BEFORE_FULL', 'AFTER_FULL'], d.num('mix_mode'), 'REPLACE'),
        domain: pick(['POINT', 'EDGE', 'FACE', 'FACE_CORNER', 'CURVE', 'INSTANCE'], d.num('domain'), 'POINT'),
        data_type: pick(['VECTOR', 'QUATERNION', 'FLOAT4X4'], d.num('data_type'), 'VECTOR'),
        mix_loc: bit(f, 2),
        mix_rot: bit(f, 4),
        mix_scl: bit(f, 8),
      },
    };
  },
  bTransformConstraint: (d) => {
    const MAP = ['LOCATION', 'ROTATION', 'SCALE'];
    const map = d.nums('map', 3);
    const p: P = {
      map_from: pick(MAP, d.num('from'), 'LOCATION'),
      map_to: pick(MAP, d.num('to'), 'LOCATION'),
      map_to_x_from: pick(['X', 'Y', 'Z'], map[0] ?? 0, 'X'),
      map_to_y_from: pick(['X', 'Y', 'Z'], map[1] ?? 1, 'Y'),
      map_to_z_from: pick(['X', 'Y', 'Z'], map[2] ?? 2, 'Z'),
      use_motion_extrapolate: !!d.num('expo'),
      from_rotation_mode: pick([...EULER, 'QUATERNION', 'SWING_TWIST_X', 'SWING_TWIST_Y', 'SWING_TWIST_Z'], d.num('from_rotation_mode'), 'AUTO'),
      to_euler_order: pick(EULER, d.num('to_euler_order'), 'AUTO'),
      mix_mode: pick(['ADD', 'REPLACE'], d.num('mix_mode_loc'), 'ADD'),
      mix_mode_rot: pick(['ADD', 'REPLACE', 'BEFORE', 'AFTER'], d.num('mix_mode_rot'), 'ADD'),
      mix_mode_scale: pick(['REPLACE', 'MULTIPLY'], d.num('mix_mode_scale'), 'REPLACE'),
    };
    for (const [field, suffix] of [
      ['', ''],
      ['_rot', '_rot'],
      ['_scale', '_scale'],
    ])
      for (const kind of ['from_min', 'from_max', 'to_min', 'to_max']) {
        const v = d.nums(kind + field, 3);
        ['x', 'y', 'z'].forEach((a, i) => (p[`${kind}_${a}${suffix}`] = v[i] ?? (field === '_scale' ? 1 : 0)));
      }
    return { type: 'TRANSFORM', p };
  },
  bKinematicConstraint: (d, _c, o) => {
    const f = d.num('flag');
    return { type: 'IK', p: { chain_count: d.num('rootbone'), iterations: d.num('iterations'), pole_target: o(d.ref('poletar')), pole_subtarget: d.str('polesubtarget'), pole_angle: d.num('poleangle'), use_tail: bit(f, 1), use_rotation: bit(f, 2), use_stretch: bit(f, 16), use_location: bit(f, 32), weight: d.num('weight'), orient_weight: d.num('orientweight') } };
  },
};

function limits(d: BStruct, type: string) {
  const f = d.num('flag');
  return {
    type,
    p: { use_min_x: bit(f, 1), use_max_x: bit(f, 2), use_min_y: bit(f, 4), use_max_y: bit(f, 8), use_min_z: bit(f, 16), use_max_z: bit(f, 32), min_x: d.num('xmin'), max_x: d.num('xmax'), min_y: d.num('ymin'), max_y: d.num('ymax'), min_z: d.num('zmin'), max_z: d.num('zmax'), use_transform_limit: bit(d.num('flag2'), 2) },
  };
}

export function convertConstraints(list: BStruct[], ctx: Ctx, o: (s: BStruct | null) => string | null, isBone: boolean, owner: string): Constraint[] {
  const out: Constraint[] = [];
  for (const c of list) {
    const d = c.ref('data');
    const name = c.str('name');
    const conv = d ? CONS[d.type] : undefined;
    if (!d || !conv) {
      ctx.warn.add('Constraints not supported (skipped)', `${owner}: ${name}${d ? ` (${d.type.replace(/^b|Constraint$/g, '')})` : ''}`);
      continue;
    }
    const r = conv(d, ctx, o);
    if (!r) continue;
    if (!constraintTypes[r.type] && !(isBone && boneOnlyConstraints[r.type])) {
      ctx.warn.add('Constraints not supported (skipped)', `${owner}: ${name}`);
      continue;
    }
    const con = newConstraint(r.type, uid('con'));
    for (const [k, v] of Object.entries(r.p)) if (v !== undefined) con[k] = v;
    con.name = name || con.name;
    con.mute = bit(c.num('flag'), 512);
    con.influence = c.num('enforce');
    con.owner_space = SPACE[c.num('ownspace')] ?? 'WORLD';
    con.target_space = SPACE[c.num('tarspace')] ?? 'WORLD';
    con.show_expanded = bit(c.num('ui_expand_flag'), 1);
    if (d.has('tar') && r.p.target === undefined) {
      const t = d.ref('tar');
      con.target = o(t);
      if (t && !con.target) ctx.warn.add('Constraint targets outside the imported scene cleared', `${owner}: ${name}`);
    }
    if (d.has('subtarget')) con.subtarget = d.str('subtarget');
    const ht = c.num('headtail');
    if (ht) con.head_tail = ht;
    if (con.owner_space === 'CUSTOM' || con.target_space === 'CUSTOM') con.space_object = o(c.ref('space_object'));
    out.push(con);
  }
  return out;
}
