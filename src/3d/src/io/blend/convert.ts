// .blend → DocumentData conversion. Both apps are Z-up, metres and radians, so transforms and
// geometry are copied without axis changes.
import { Quaternion, Vector3 } from 'three';
import type { RenderSettings, ArmatureData, Bone, CameraData, CollectionData, CurveData, DocumentData, ID, ImageData, LatticeData, LightData, MaterialData, ObjectData, ObjectType, PoseBone, RotationMode, Spline, WorldData, BezierPoint, HandleType, AnimData } from '../../data/types';
import { emptyDocument, newArmature, newCamera, newCollection, newCurve, newLight, newMaterial, newObject, newWorld, uid } from '../../data/defaults';
import { resolve } from '../../data/rna';
import { BlendFile, BlendError, type BStruct } from './reader';
import { Warnings, finite, mat4, vec3, type Ctx } from './context';
import { convertMesh } from './mesh';
import { convertNodeTree } from './nodes';
import { convertModifiers, convertConstraints } from './modifiers';
import { convertAnimData, mergeAnimData } from './anim';
import { readAssetMarks } from './assets';

export interface BlendImport {
  doc: DocumentData;
  warnings: string[];
  /** e.g. "5.2" */
  version: string;
  sceneName: string;
  compression: 'none' | 'gzip' | 'zstd';
  /** ids of the collections/objects directly inside the imported scene collection */
  topCollections: ID[];
  topObjects: ID[];
  stats: { objects: number; meshes: number; materials: number; actions: number };
}

const ROT_MODES: Record<number, RotationMode> = { [-1]: 'AXIS_ANGLE', 0: 'QUATERNION', 1: 'XYZ', 2: 'XZY', 3: 'YXZ', 4: 'YZX', 5: 'ZXY', 6: 'ZYX' };
const EMPTY_DRAW: ObjectData['empty_display_type'][] = ['PLAIN_AXES', 'ARROWS', 'PLAIN_AXES', 'CIRCLE', 'SINGLE_ARROW', 'CUBE', 'SPHERE', 'CONE', 'IMAGE'];
const HANDLE_TYPES: HandleType[] = ['FREE', 'AUTO', 'VECTOR', 'ALIGNED', 'AUTO'];
const COLOR_TAGS: CollectionData['color_tag'][] = ['COLOR_01', 'COLOR_02', 'COLOR_03', 'COLOR_04', 'COLOR_05', 'COLOR_06', 'COLOR_07', 'COLOR_08'];
const OB_TYPE_NAMES: Record<number, string> = { 3: 'Surface', 5: 'Metaball', 9: 'Grease Pencil (legacy)', 12: 'Speaker', 13: 'Light Probe', 26: 'Curves (hair)', 27: 'Point Cloud', 28: 'Volume', 30: 'Grease Pencil' };

/** Parse and convert a .blend file. Throws BlendError on unreadable files. */
export async function readBlend(bytes: Uint8Array): Promise<BlendImport> {
  const f = await BlendFile.open(bytes);
  return convertBlend(f);
}

function mimeOf(b: Uint8Array): { mime: string; displayable: boolean } {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return { mime: 'image/png', displayable: true };
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', displayable: true };
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return { mime: 'image/webp', displayable: true };
  if (s(0, 3) === 'GIF') return { mime: 'image/gif', displayable: true };
  if (s(0, 2) === 'BM') return { mime: 'image/bmp', displayable: true };
  if (b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01) return { mime: 'image/x-exr', displayable: false };
  if (s(0, 2) === '#?') return { mime: 'image/vnd.radiance', displayable: false };
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return { mime: 'image/tiff', displayable: false };
  return { mime: 'application/octet-stream', displayable: false };
}

function pngSize(b: Uint8Array): [number, number] {
  if (b.length < 24 || b[0] !== 0x89) return [0, 0];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [dv.getUint32(16), dv.getUint32(20)];
}

/** Bone roll matching this app's bone basis (shortest arc from +Y, then roll about the bone axis). */
function rollFromMatrix(head: number[], tail: number[], m: number[] | null, fallback: number): number {
  if (!m) return fallback;
  const y = new Vector3(tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]);
  if (y.lengthSq() < 1e-12) return fallback;
  y.normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), y);
  if (y.y < -0.99999) q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  const x0 = new Vector3(1, 0, 0).applyQuaternion(q);
  const xa = new Vector3(m[0], m[1], m[2]).normalize();
  const c = new Vector3().crossVectors(x0, xa);
  return Math.atan2(c.dot(y), x0.dot(xa));
}

export function convertBlend(f: BlendFile): BlendImport {
  const version = f.header.version;
  if (version < 250) throw new BlendError(`Blender ${Math.floor(version / 100)}.${version % 100} files are too old (2.50 or newer required)`);
  const warn = new Warnings();
  const doc = emptyDocument();
  const defaultWorld = doc.scene.world;
  const ids = new Map<number, ID>();
  const objectIds = new Map<number, ID>();
  const actionCache = new Map<string, string>();

  // ---------------------------------------------------------------- scene selection
  const scenes = f.ids('SC');
  if (!scenes.length) throw new BlendError('The file contains no scene');
  const glob = f.ids('GLOB')[0];
  const cur = glob?.ref('curscene');
  const sc = (cur && scenes.find((s) => s.offset === cur.offset)) ?? scenes[0];
  if (scenes.length > 1) warn.add('Only the active scene was imported; other scenes skipped', scenes.filter((s) => s !== sc).map((s) => s.idName).join(', '));
  if (f.ids('LI').length) warn.add('Linked library data is not available (only local data imported)', f.ids('LI').map((l) => l.idName).join(', '));

  const ctx: Ctx = {
    f,
    doc,
    warn,
    version,
    ids,
    objectIds,
    objectRef: (s) => (s ? objectIds.get(s.offset) ?? null : null),
    image: (s) => (s ? convertImage(s) : null),
    material: (s) => (s ? convertMaterial(s) : null),
    collection: (s) => (s ? ids.get(s.offset) ?? null : null),
  };

  // ---------------------------------------------------------------- images
  function convertImage(im: BStruct): ID | null {
    const done = ids.get(im.offset);
    if (done) return done;
    if (im.type !== 'Image') return null;
    const id = uid('im');
    const filepath = im.str('name');
    const source = im.num('source');
    const img: ImageData = { id, name: im.idName, mime: 'image/png', bytes: null, width: 0, height: 0, source: 'FILE', colorspace: 'sRGB', revision: 0 };
    const cs = im.sub('colorspace_settings')?.str('name') ?? '';
    if (/non-color|raw|data/i.test(cs)) img.colorspace = 'Non-Color';
    else if (/linear/i.test(cs)) img.colorspace = 'Linear';
    if (filepath) img.filepath = filepath;
    let pf = im.ref('packedfile');
    if (!pf) pf = im.list('packedfiles')[0]?.ref('packedfile') ?? null;
    if (pf) {
      const size = pf.num('size');
      const bytes = size > 0 ? f.bytesAt(pf.ptr('data'), size, pf.block) : null;
      if (bytes) {
        const m = mimeOf(bytes);
        img.bytes = bytes;
        img.mime = m.mime;
        [img.width, img.height] = pngSize(bytes);
        if (!m.displayable) warn.add('Packed images in formats the browser cannot display (kept, not shown)', `${img.name} (${m.mime})`);
      } else warn.add('Packed images with unreadable data', img.name);
    } else if (source === 4) {
      img.source = 'GENERATED';
      img.width = im.num('gen_x');
      img.height = im.num('gen_y');
      img.generated_type = (['BLANK', 'UV_GRID', 'COLOR_GRID'] as const)[im.num('gen_type')] ?? 'BLANK';
      const gc = im.nums('gen_color', 4);
      if (gc.length === 4) img.generated_color = [gc[0], gc[1], gc[2], gc[3]];
    } else if (source === 5 || im.num('type') === 4 || im.num('type') === 5) {
      ids.set(im.offset, '');
      return null; // viewer / render result images are runtime-only
    } else {
      warn.add('External image files are not embedded (pack them in Blender: File ▸ External Data ▸ Pack Resources)', `${img.name}${filepath ? ` (${filepath})` : ''}`);
    }
    doc.images[id] = img;
    ids.set(im.offset, id);
    return id;
  }

  // ---------------------------------------------------------------- materials
  function convertMaterial(ma: BStruct): ID | null {
    const done = ids.get(ma.offset);
    if (done !== undefined) return done || null;
    if (ma.type !== 'Material') return null;
    const color: [number, number, number, number] = [ma.num('r'), ma.num('g'), ma.num('b'), ma.has('a') ? ma.num('a') : 1];
    const mat: MaterialData = newMaterial(ma.idName, color);
    ids.set(ma.offset, mat.id);
    mat.diffuse_color = color;
    mat.metallic = ma.num('metallic');
    mat.roughness = ma.num('roughness');
    mat.alpha_threshold = ma.num('alpha_threshold');
    mat.use_backface_culling = (ma.num('blend_flag') & 4) !== 0;
    mat.pass_index = ma.num('index');
    const nt = ma.ref('nodetree');
    const useNodes = ma.num('use_nodes') !== 0 || version >= 500;
    if (nt && useNodes) {
      mat.tree = convertNodeTree(nt, 'SHADER', ctx);
      mat.use_nodes = true;
    } else {
      mat.use_nodes = false;
      const bsdf = mat.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled');
      if (bsdf) {
        bsdf.inputs.Metallic = mat.metallic;
        bsdf.inputs.Roughness = mat.roughness;
      }
    }
    const bsdf = mat.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled');
    const alpha = typeof bsdf?.inputs.Alpha === 'number' ? (bsdf.inputs.Alpha as number) : 1;
    const alphaLinked = !!bsdf && mat.tree.links.some((l) => l.to_node === bsdf.id && l.to_socket === 'Alpha');
    if (version >= 402 && ma.has('surface_render_method')) {
      mat.blend_method = ma.num('surface_render_method') === 1 ? 'BLEND' : alpha < 1 || alphaLinked ? 'HASHED' : 'OPAQUE';
    } else {
      mat.blend_method = (({ 0: 'OPAQUE', 3: 'CLIP', 4: 'HASHED', 5: 'BLEND' }) as Record<number, MaterialData['blend_method']>)[ma.num('blend_method')] ?? 'OPAQUE';
    }
    doc.materials[mat.id] = mat;
    if (ma.ref('adt')) warn.add('Material animation not imported', mat.name);
    return mat.id;
  }

  // ---------------------------------------------------------------- world
  function convertWorld(wo: BStruct): ID {
    const done = ids.get(wo.offset);
    if (done) return done;
    const w: WorldData = newWorld(wo.idName);
    w.color = [wo.num('horr'), wo.num('horg'), wo.num('horb')];
    w.mist_start = wo.num('miststa');
    w.mist_depth = wo.num('mistdist');
    const lg = wo.ref('lightgroup')?.str('name');
    if (lg) w.lightgroup = lg;
    const nt = wo.ref('nodetree');
    if (nt && (wo.num('use_nodes') !== 0 || version >= 500)) {
      w.tree = convertNodeTree(nt, 'WORLD', ctx);
      w.use_nodes = true;
    } else {
      w.use_nodes = false;
      const bg = w.tree.nodes.find((n) => n.type === 'ShaderNodeBackground');
      if (bg) bg.inputs.Color = [...w.color, 1];
    }
    doc.worlds[w.id] = w;
    ids.set(wo.offset, w.id);
    if (wo.ref('adt')) warn.add('World animation not imported', w.name);
    return w.id;
  }

  // ---------------------------------------------------------------- lights / cameras
  function convertLight(la: BStruct): LightData {
    const t = la.num('type');
    const type = ({ 0: 'POINT', 1: 'SUN', 2: 'SPOT', 4: 'AREA' } as Record<number, LightData['type']>)[t];
    if (!type) warn.add('Hemi lights converted to sun lights', la.idName);
    const l = newLight(type ?? 'SUN', la.idName);
    l.color = [la.num('r'), la.num('g'), la.num('b')];
    l.energy = la.has('energy_new') ? la.num('energy_new') : la.num('energy');
    l.shadow_soft_size = la.num('radius');
    l.angle = la.num('sun_angle');
    l.spot_size = la.num('spotsize');
    l.spot_blend = la.num('spotblend');
    const mode = la.num('mode');
    l.use_shadow = (mode & 1) !== 0;
    l.show_cone = (mode & (1 << 17)) !== 0;
    l.shape = (({ 0: 'SQUARE', 1: 'RECTANGLE', 4: 'DISK', 5: 'ELLIPSE' }) as Record<number, LightData['shape']>)[la.num('area_shape')] ?? 'SQUARE';
    l.size = la.num('area_size');
    l.size_y = la.num('area_sizey');
    if (la.has('diff_fac')) l.diffuse_factor = la.num('diff_fac');
    if (la.has('spec_fac')) l.specular_factor = la.num('spec_fac');
    if (la.has('volume_fac')) l.volume_factor = la.num('volume_fac');
    if (la.has('att_dist')) l.cutoff_distance = la.num('att_dist');
    if (version < 280) warn.add('Light intensity of pre-2.80 files may differ', la.idName);
    return l;
  }

  function convertCamera(ca: BStruct): CameraData {
    const c = newCamera(ca.idName);
    c.type = (['PERSP', 'ORTHO', 'PANO'] as const)[ca.num('type')] ?? 'PERSP';
    c.lens = ca.num('lens');
    c.sensor_width = ca.num('sensor_x');
    c.sensor_height = ca.num('sensor_y');
    c.sensor_fit = (['AUTO', 'HORIZONTAL', 'VERTICAL'] as const)[ca.num('sensor_fit')] ?? 'AUTO';
    c.ortho_scale = ca.num('ortho_scale');
    c.clip_start = ca.num('clipsta');
    c.clip_end = ca.num('clipend');
    c.shift_x = ca.num('shiftx');
    c.shift_y = ca.num('shifty');
    c.display_size = ca.num('drawsize') || 1;
    c.passepartout_alpha = ca.num('passepartalpha');
    const flag = ca.num('flag');
    c.show_limits = (flag & 1) !== 0;
    c.show_passepartout = (flag & 4) !== 0;
    const dof = ca.sub('dof');
    if (dof) {
      c.dof = {
        use_dof: (dof.num('flag') & 1) !== 0,
        focus_object: null, // resolved after objects exist
        focus_distance: dof.num('focus_distance'),
        aperture_fstop: dof.num('aperture_fstop'),
        aperture_blades: dof.num('aperture_blades'),
      };
    }
    if (c.type === 'PANO') warn.add('Panoramic cameras imported as perspective in the viewport', c.name);
    return c;
  }

  // ---------------------------------------------------------------- curves / text
  function convertCurve(cu: BStruct, isFont: boolean): CurveData {
    const c = newCurve(cu.idName);
    const flag = cu.num('flag');
    c.dimensions = flag & 1 ? '3D' : '2D';
    const fill = flag & 6;
    c.fill_mode = c.dimensions === '3D' ? (({ 0: 'FULL', 2: 'FRONT', 4: 'BACK', 6: 'HALF' }) as Record<number, CurveData['fill_mode']>)[fill] : (({ 0: 'NONE', 2: 'FRONT', 4: 'BACK', 6: 'BOTH' }) as Record<number, CurveData['fill_mode']>)[fill];
    c.resolution_u = cu.num('resolu') || 12;
    c.bevel_depth = cu.num('ext2');
    c.extrude = cu.num('ext1');
    c.bevel_resolution = cu.num('bevresol');
    c.offset = cu.num('width') - 1;
    c.materials = cu.ptrArray('mat', Math.max(0, cu.num('totcol'))).map((a) => (a === 0 ? null : convertMaterial(cu.at(a)!)));
    if (isFont) {
      const len = Math.max(0, cu.num('len'));
      const raw = len ? f.bytesAt(cu.ptr('str'), len, cu.block) : null;
      c.body = raw ? new TextDecoder().decode(raw) : cu.cstr('str');
      c.size = cu.num('fsize');
      c.align_x = (['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'JUSTIFY'] as const)[cu.num('spacemode')] ?? 'LEFT';
      c.align_y = (['TOP', 'TOP', 'CENTER', 'BOTTOM', 'BOTTOM'] as const)[cu.num('align_y')] ?? 'TOP';
      c.space_line = cu.num('linedist');
      c.space_character = cu.num('spacing');
      const vf = cu.ref('vfont');
      if (vf && vf.idName !== 'Bfont Regular' && vf.idName !== 'Bfont') warn.add('Text fonts replaced by the default font', `${c.name} (${vf.idName})`);
      return c;
    }
    for (const nu of cu.list('nurb', 100_000)) {
      const type = nu.num('type');
      const pu = Math.max(0, nu.num('pntsu')),
        pv = Math.max(1, nu.num('pntsv'));
      if (pv > 1) {
        warn.add('NURBS surfaces not supported (skipped)', c.name);
        continue;
      }
      const flagu = nu.num('flagu');
      const sp: Spline = {
        type: type === 1 ? 'BEZIER' : type === 4 ? 'NURBS' : 'POLY',
        bezier_points: [],
        points: [],
        use_cyclic_u: (flagu & 1) !== 0,
        resolution_u: nu.num('resolu') || c.resolution_u,
        order_u: nu.num('orderu'),
        use_endpoint_u: (flagu & 2) !== 0,
        use_smooth: (nu.num('flag') & 1) !== 0,
        material_index: nu.num('mat_nr'),
      };
      if (type === 1) {
        for (const b of f.structsAt(nu.ptr('bezt'), 'BezTriple', pu, nu.block)) {
          const v = b.nums('vec', 9);
          const bp: BezierPoint = {
            co: [v[3], v[4], v[5]],
            handle_left: [v[0], v[1], v[2]],
            handle_right: [v[6], v[7], v[8]],
            handle_left_type: HANDLE_TYPES[b.num('h1')] ?? 'AUTO',
            handle_right_type: HANDLE_TYPES[b.num('h2')] ?? 'AUTO',
            radius: b.num('radius'),
            tilt: b.num('alfa'),
          };
          sp.bezier_points.push(bp);
        }
      } else {
        for (const p of f.structsAt(nu.ptr('bp'), 'BPoint', pu, nu.block)) {
          const v = p.nums('vec', 4);
          sp.points.push({ co: [v[0], v[1], v[2], v[3]], radius: p.num('radius'), tilt: p.num('alfa') });
        }
      }
      if (sp.bezier_points.length || sp.points.length) c.splines.push(sp);
    }
    return c;
  }

  function convertLattice(lt: BStruct): LatticeData {
    const u = Math.max(1, lt.num('pntsu')),
      v = Math.max(1, lt.num('pntsv')),
      w = Math.max(1, lt.num('pntsw'));
    const pts = f.structsAt(lt.ptr('def'), 'BPoint', u * v * w, lt.block);
    const points = new Float32Array(u * v * w * 3);
    pts.forEach((p, i) => points.set(p.nums('vec', 3), i * 3));
    return { id: uid('lt'), name: lt.idName, points_u: u, points_v: v, points_w: w, points, interpolation: lt.num('typeu') === 2 ? 'KEY_BSPLINE' : 'KEY_LINEAR' };
  }

  // ---------------------------------------------------------------- armatures
  function convertArmature(ar: BStruct): ArmatureData {
    const arm = newArmature(ar.idName);
    const walk = (b: BStruct, parent: string | null, depth: number) => {
      if (depth > 1000) return;
      const flag = b.num('flag');
      const head = b.nums('arm_head', 3),
        tail = b.nums('arm_tail', 3);
      const bone: Bone = {
        name: b.str('name'),
        parent,
        head: [head[0], head[1], head[2]],
        tail: [tail[0], tail[1], tail[2]],
        roll: rollFromMatrix(head, tail, mat4(b, 'arm_mat'), b.num('arm_roll')),
        use_connect: (flag & 16) !== 0,
        use_deform: (flag & 4096) === 0,
        use_inherit_rotation: (flag & 512) === 0,
        inherit_scale: (['FULL', 'FIX_SHEAR', 'AVERAGE', 'NONE', 'NONE_LEGACY', 'ALIGNED'] as const)[b.num('inherit_scale_mode')] ?? 'FULL',
        envelope_distance: b.num('dist'),
        head_radius: b.num('rad_head'),
        tail_radius: b.num('rad_tail'),
        bbone_segments: b.num('segments') || 1,
      };
      if (flag & 1024) bone.hide = true;
      arm.bones.push(bone);
      for (const c of b.list('childbase', 100_000)) walk(c, bone.name, depth + 1);
    };
    for (const b of ar.list('bonebase', 100_000)) walk(b, null, 0);
    arm.display_type = (['OCTAHEDRAL', 'STICK', 'BBONE', 'ENVELOPE', 'WIRE'] as const)[ar.num('drawtype')] ?? 'OCTAHEDRAL';
    arm.active_bone = ar.ref('act_bone')?.str('name') ?? null;
    const af = ar.num('flag');
    arm.pose_position = af & 1 ? 'REST' : 'POSE';
    arm.show_axes = (af & 4) !== 0;
    arm.show_names = (af & 8) !== 0;
    return arm;
  }

  function convertPose(ob: BStruct): Record<string, PoseBone> | null {
    const pose = ob.ref('pose');
    if (!pose) return null;
    const out: Record<string, PoseBone> = {};
    for (const pc of pose.list('chanbase', 100_000)) {
      const name = pc.str('name');
      const pf = pc.num('protectflag');
      const ik = pc.num('ikflag');
      const pb: PoseBone = {
        location: vec3(pc, 'loc'),
        rotation_mode: ROT_MODES[pc.num('rotmode')] ?? 'QUATERNION',
        rotation_quaternion: pc.nums('quat', 4) as PoseBone['rotation_quaternion'],
        rotation_euler: vec3(pc, 'eul'),
        rotation_axis_angle: [pc.num('rotAngle'), ...vec3(pc, 'rotAxis', [0, 1, 0])],
        scale: vec3(pc, 'size', [1, 1, 1]),
        constraints: convertConstraints(pc.list('constraints', 1000), ctx, ctx.objectRef, true, `${ob.idName}:${name}`),
        lock_location: [!!(pf & 1), !!(pf & 2), !!(pf & 4)],
        lock_rotation: [!!(pf & 8), !!(pf & 16), !!(pf & 32)],
        lock_scale: [!!(pf & 64), !!(pf & 128), !!(pf & 256)],
        ik_stretch: pc.num('ikstretch'),
        lock_ik_x: !!(ik & 1),
        lock_ik_y: !!(ik & 2),
        lock_ik_z: !!(ik & 4),
      };
      const custom = pc.ref('custom');
      if (custom) pb.custom_shape = ctx.objectRef(custom);
      out[name] = pb;
    }
    return out;
  }

  // ---------------------------------------------------------------- object data
  const dataCache = new Map<number, ID>();
  function convertData(ob: BStruct, obType: number): { type: ObjectType; data: ID | null; anim: AnimData | null } {
    const d = ob.ref('data');
    let type: ObjectType = 'EMPTY';
    let id: ID | null = null;
    let anim: AnimData | null = null;
    switch (obType) {
      case 1:
        type = 'MESH';
        break;
      case 2:
        type = 'CURVE';
        break;
      case 4:
        type = 'FONT';
        break;
      case 10:
        type = 'LIGHT';
        break;
      case 11:
        type = 'CAMERA';
        break;
      case 22:
        type = 'LATTICE';
        break;
      case 25:
        type = 'ARMATURE';
        break;
      case 0:
        break;
      default:
        warn.add('Object types not supported (imported as empties)', `${ob.idName} (${OB_TYPE_NAMES[obType] ?? `type ${obType}`})`);
        return { type: 'EMPTY', data: null, anim: null };
    }
    if (type === 'EMPTY' || !d) return { type, data: null, anim: null };
    const cached = dataCache.get(d.offset);
    if (cached) id = cached;
    else {
      if (type === 'MESH' && d.type === 'Mesh') {
        const names = ob.list('defbase').map((g) => g.str('name'));
        const me = convertMesh(d, ctx, names);
        if (me) {
          doc.meshes[me.id] = me;
          id = me.id;
        }
      } else if ((type === 'CURVE' || type === 'FONT') && d.type === 'Curve') {
        const cu = convertCurve(d, type === 'FONT');
        doc.curves[cu.id] = cu;
        id = cu.id;
      } else if (type === 'LIGHT' && (d.type === 'Lamp' || d.type === 'Light')) {
        const la = convertLight(d);
        doc.lights[la.id] = la;
        id = la.id;
      } else if (type === 'CAMERA' && d.type === 'Camera') {
        const ca = convertCamera(d);
        doc.cameras[ca.id] = ca;
        id = ca.id;
      } else if (type === 'ARMATURE' && d.type === 'bArmature') {
        const ar = convertArmature(d);
        doc.armatures[ar.id] = ar;
        id = ar.id;
      } else if (type === 'LATTICE' && d.type === 'Lattice') {
        const lt = convertLattice(d);
        doc.lattices[lt.id] = lt;
        id = lt.id;
      }
      if (id) dataCache.set(d.offset, id);
    }
    if (!id) {
      warn.add('Object data that could not be read (imported as empties)', ob.idName);
      return { type: 'EMPTY', data: null, anim: null };
    }
    // data-level animation mapped onto object paths
    if (type === 'MESH') {
      const key = d.ref('key');
      if (key) anim = convertAnimData(key.ref('adt'), ctx, 'data.shape_keys.', actionCache);
    } else anim = convertAnimData(d.ref('adt'), ctx, 'data.', actionCache);
    return { type, data: id, anim };
  }

  // ---------------------------------------------------------------- objects
  function convertObject(ob: BStruct, obId: ID): ObjectData {
    const obType = ob.num('type');
    const { type, data, anim: dataAnim } = convertData(ob, obType);
    const o = newObject(ob.idName, type, data);
    o.id = obId;
    // transforms
    o.location = vec3(ob, 'loc');
    o.rotation_mode = ROT_MODES[ob.num('rotmode')] ?? 'XYZ';
    o.rotation_euler = vec3(ob, 'rot');
    const q = ob.nums('quat', 4);
    if (q.length === 4) o.rotation_quaternion = [q[0], q[1], q[2], q[3]];
    o.rotation_axis_angle = [finite(ob.num('rotAngle')), ...vec3(ob, 'rotAxis', [0, 1, 0])];
    o.scale = vec3(ob, 'size', [1, 1, 1]);
    o.delta_location = vec3(ob, 'dloc');
    o.delta_rotation_euler = vec3(ob, 'drot');
    o.delta_scale = vec3(ob, 'dscale', [1, 1, 1]);
    const dq = ob.nums('dquat', 4);
    if ((o.rotation_mode === 'QUATERNION' || o.rotation_mode === 'AXIS_ANGLE') && dq.length === 4 && (Math.abs(dq[0] - 1) > 1e-6 || dq[1] || dq[2] || dq[3])) warn.add('Delta quaternion rotations not supported', o.name);
    const pinv = mat4(ob, 'parentinv');
    if (pinv) o.matrix_parent_inverse = pinv;
    // parenting (resolved by the caller once all ids exist)
    const parent = ob.ref('parent');
    if (parent) {
      o.parent = ctx.objectRef(parent);
      const pt = ob.num('partype') & 15;
      if (pt === 7) {
        o.parent_type = 'BONE';
        o.parent_bone = ob.str('parsubstr');
      } else if (pt === 5 || pt === 6) {
        o.parent_type = 'VERTEX';
        warn.add('Vertex parenting imported as object parenting', o.name);
        o.parent_type = 'OBJECT';
      }
      if (!o.parent) warn.add('Parents outside the imported scene cleared', o.name);
    }
    // visibility / display
    const rf = ob.num('restrictflag');
    o.hide_viewport = (rf & 1) !== 0;
    o.hide_select = (rf & 2) !== 0;
    o.hide_render = (rf & 4) !== 0;
    const pf = ob.num('protectflag');
    o.lock_location = [!!(pf & 1), !!(pf & 2), !!(pf & 4)];
    o.lock_rotation = [!!(pf & 8), !!(pf & 16), !!(pf & 32)];
    o.lock_scale = [!!(pf & 64), !!(pf & 128), !!(pf & 256)];
    o.display_type = (({ 1: 'BOUNDS', 2: 'WIRE', 3: 'SOLID', 4: 'SOLID', 5: 'TEXTURED' }) as Record<number, ObjectData['display_type']>)[ob.num('dt')] ?? 'TEXTURED';
    const dtx = ob.num('dtx');
    o.show_axis = (dtx & 2) !== 0;
    o.show_name = (dtx & 8) !== 0;
    o.show_wire = (dtx & 32) !== 0;
    o.show_in_front = (dtx & 64) !== 0;
    const col = ob.nums('col', 4);
    if (col.length === 4) o.color = [col[0], col[1], col[2], col[3]];
    o.empty_display_type = EMPTY_DRAW[ob.num('empty_drawtype')] ?? 'PLAIN_AXES';
    o.empty_display_size = ob.num('empty_drawsize') || 1;
    if (o.empty_display_type === 'IMAGE') warn.add('Image empties shown as plain empties', o.name);
    o.active_material_index = Math.max(0, ob.num('actcol') - 1);
    o.vertex_group_active_index = Math.max(0, ob.num('actdef') - 1);
    // instancing
    const tf = ob.num('transflag');
    const dup = ob.ref('dup_group');
    if (dup && tf & 256) {
      o.instance_type = 'COLLECTION';
      o.instance_collection = ids.get(dup.offset) ?? null;
      warn.add('Collection instances are imported but not drawn in the viewport (use Make Instances Real)', o.name);
    } else if (tf & 16) o.instance_type = 'VERTS';
    else if (tf & 512) o.instance_type = 'FACES';
    if (o.instance_type === 'VERTS' || o.instance_type === 'FACES') warn.add('Vertex/face instancing setting imported (may not display)', o.name);
    // object-level material slots
    const totcol = Math.max(0, Math.min(32767, ob.num('totcol')));
    if (totcol) {
      const bits = f.bytesAt(ob.ptr('matbits'), totcol, ob.block);
      const mats = ob.ptrArray('mat', totcol);
      if (bits && bits.some((b) => b)) {
        o.material_slots_link = Array.from(bits, (b) => (b ? 'OBJECT' : 'DATA'));
        o.object_materials = mats.map((a, i) => (bits[i] && a !== 0 ? convertMaterial(ob.at(a)!) : null));
      }
    }
    // stack
    o.modifiers = convertModifiers(ob, ctx, ctx.objectRef);
    o.constraints = convertConstraints(ob.list('constraints', 1000), ctx, ctx.objectRef, false, o.name);
    if (type === 'ARMATURE') o.pose = convertPose(ob);
    // animation
    const obAnim = convertAnimData(ob.ref('adt'), ctx, '', actionCache);
    o.animation_data = mergeAnimData(ctx, obAnim, dataAnim, o.name);
    // unsupported extras
    if (ob.list('particlesystem').length) warn.add('Particle systems not imported', o.name);
    if (ob.ref('rigidbody_object')) warn.add('Rigid body settings not imported', o.name);
    if (ob.ref('soft')) warn.add('Soft body settings not imported', o.name);
    if (ob.sub('id')?.ptr('properties')) warn.add('Custom properties not imported', o.name);
    return o;
  }

  // ---------------------------------------------------------------- collection tree
  const master = sc.ref('master_collection');
  const objectsToConvert: BStruct[] = [];
  const objSeen = new Set<number>();
  const addObject = (ob: BStruct | null) => {
    if (!ob || ob.type !== 'Object' || objSeen.has(ob.offset)) return;
    objSeen.add(ob.offset);
    objectIds.set(ob.offset, uid('ob'));
    objectsToConvert.push(ob);
  };
  const collectionMembers = new Map<ID, BStruct[]>();
  const colStructs: BStruct[] = [];
  const convertCollection = (c: BStruct, isMaster: boolean, depth: number): ID => {
    const done = ids.get(c.offset);
    if (done) return done;
    let data: CollectionData;
    if (isMaster) data = doc.collections[doc.scene.collection];
    else {
      data = newCollection(c.idName);
      doc.collections[data.id] = data;
      const flag = c.num('flag');
      data.hide_viewport = (flag & 1) !== 0;
      data.hide_select = (flag & 2) !== 0;
      data.hide_render = (flag & 8) !== 0;
      const tag = c.num('color_tag');
      data.color_tag = tag >= 0 && tag < 8 ? COLOR_TAGS[tag] : 'NONE';
      data.instance_offset = vec3(c, 'dupli_ofs');
    }
    ids.set(c.offset, data.id);
    colStructs.push(c);
    const obs: BStruct[] = [];
    for (const co of c.list('gobject', 1_000_000)) {
      const ob = co.ref('ob');
      if (ob) {
        addObject(ob);
        obs.push(ob);
        // light linking state of the member (0 include, 1 exclude)
        if (co.sub('light_linking')?.num('link_state') === 1) (data.light_linking ??= {})[objectIds.get(ob.offset)!] = 'EXCLUDE';
      }
    }
    collectionMembers.set(data.id, obs);
    if (depth < 256)
      for (const ch of c.list('children', 100_000)) {
        const cc = ch.ref('collection');
        if (!cc) continue;
        const cid = convertCollection(cc, false, depth + 1);
        if (!data.children.includes(cid) && cid !== data.id) data.children.push(cid);
        if (ch.sub('light_linking')?.num('link_state') === 1) (data.light_linking ??= {})[cid] = 'EXCLUDE';
      }
    return data.id;
  };
  const masterId = doc.scene.collection;
  if (master) convertCollection(master, true, 0);
  else {
    // pre-2.80 files: objects listed by Scene.base
    warn.add('Pre-2.80 file: layers are not converted, all scene objects placed in one collection');
    const col = newCollection('Collection');
    doc.collections[col.id] = col;
    doc.collections[masterId].children.push(col.id);
    const obs: BStruct[] = [];
    for (const b of sc.list('base', 1_000_000)) {
      const ob = b.ref('object');
      if (ob) {
        addObject(ob);
        obs.push(ob);
      }
    }
    collectionMembers.set(col.id, obs);
  }
  // objects referenced from instanced collections not linked to the scene, and light / shadow
  // linking collections
  const lightLinks = new Map<string, { receiver: ID | null; blocker: ID | null }>();
  for (let i = 0; i < objectsToConvert.length; i++) {
    const dup = objectsToConvert[i].ref('dup_group');
    if (dup && dup.type === 'Collection' && !ids.has(dup.offset)) convertCollection(dup, false, 1);
    const ll = objectsToConvert[i].ref('light_linking');
    if (ll) {
      const rc = ll.ref('receiver_collection'),
        bc = ll.ref('blocker_collection');
      const receiver = rc ? convertCollection(rc, false, 1) : null;
      const blocker = bc ? convertCollection(bc, false, 1) : null;
      if (receiver || blocker) lightLinks.set(objectIds.get(objectsToConvert[i].offset)!, { receiver, blocker });
    }
  }
  // parents / targets referenced but not in the scene stay unresolved (reported per object)

  // ---------------------------------------------------------------- convert objects
  for (const ob of objectsToConvert) {
    const id = objectIds.get(ob.offset)!;
    try {
      const o = convertObject(ob, id);
      doc.objects[id] = o;
      doc.object_order.push(id);
    } catch (e) {
      objectIds.delete(ob.offset);
      warn.add('Objects that failed to import', `${ob.idName} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  for (const [cid, obs] of collectionMembers) {
    const c = doc.collections[cid];
    for (const ob of obs) {
      const id = objectIds.get(ob.offset);
      if (id && doc.objects[id] && !c.objects.includes(id)) c.objects.push(id);
    }
  }
  for (const [id, l] of lightLinks) if (doc.objects[id]) doc.objects[id].light_linking = { receiver_collection: l.receiver, blocker_collection: l.blocker };
  for (const ob of objectsToConvert) {
    const id = objectIds.get(ob.offset);
    const lg = ob.ref('lightgroup')?.str('name');
    if (id && lg && doc.objects[id]) doc.objects[id].lightgroup = lg;
  }
  // drop dangling parent links (object failed to import)
  for (const o of Object.values(doc.objects)) if (o.parent && !doc.objects[o.parent]) o.parent = null;
  // camera DOF focus objects
  for (const ob of objectsToConvert) {
    const d = ob.ref('data');
    if (d?.type === 'Camera') {
      const id = dataCache.get(d.offset);
      const fo = d.sub('dof')?.ref('focus_object');
      if (id && fo) doc.cameras[id].dof.focus_object = ctx.objectRef(fo);
    }
  }

  // ---------------------------------------------------------------- view layer
  const viewLayers = sc.list('view_layers', 1000);
  const curVl = glob?.ref('cur_view_layer');
  const vl = (curVl && viewLayers.find((v) => v.offset === curVl.offset)) ?? viewLayers[0];
  // every view layer: its name, Use for Rendering and per-collection flags (the active one is live)
  const layerFlagsOf = (layer: BStruct) => {
    const out: Record<string, { exclude?: boolean; hide?: boolean; holdout?: boolean; indirect_only?: boolean }> = {};
    const walk = (lc: BStruct, depth: number) => {
      const cs = lc.ref('collection');
      const cid = cs ? ids.get(cs.offset) : undefined;
      if (cid && cid !== masterId) {
        const fl = lc.num('flag');
        const f = { exclude: (fl & 16) !== 0, holdout: (fl & 32) !== 0, indirect_only: (fl & 64) !== 0, hide: (fl & 128) !== 0 };
        out[cid] = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
      }
      if (depth < 256) for (const c of lc.list('layer_collections', 100_000)) walk(c, depth + 1);
    };
    for (const lc of layer.list('layer_collections', 100_000)) walk(lc, 0);
    return out;
  };
  if (viewLayers.length) {
    doc.scene.view_layers = viewLayers.map((l) => {
      const groups = l.list('lightgroups', 1000).map((g) => ({ name: g.str('name') })).filter((g) => g.name);
      return groups.length ? { name: l.str('name') || 'ViewLayer', lightgroups: groups } : { name: l.str('name') || 'ViewLayer' };
    });
    doc.scene.active_view_layer = Math.max(0, viewLayers.indexOf(vl!));
    viewLayers.forEach((l, i) => {
      if (l === vl) return;
      const render: Partial<RenderSettings> = { use_view_layer: (l.num('flag') & 1) !== 0 };
      doc.scene.view_layers![i].stored = { render, collections: layerFlagsOf(l) };
    });
  }
  if (vl) {
    for (const [cid, f] of Object.entries(layerFlagsOf(vl))) {
      const c = doc.collections[cid];
      c.exclude = !!f.exclude;
      c.hide = !!f.hide;
      if (f.holdout) c.holdout = true;
      if (f.indirect_only) c.indirect_only = true;
    }
    doc.scene.render.use_view_layer = (vl.num('flag') & 1) !== 0;
    for (const b of vl.list('object_bases', 1_000_000)) {
      const id = ctx.objectRef(b.ref('object'));
      if (!id || !doc.objects[id]) continue;
      const fl = b.num('flag');
      doc.objects[id].hide = (fl & 256) !== 0;
      doc.objects[id].select = (fl & 1) !== 0;
    }
    const act = vl.ref('basact')?.ref('object');
    doc.scene.active_object = act ? ctx.objectRef(act) : null;
  }

  // ---------------------------------------------------------------- scene settings
  const s = doc.scene;
  s.name = sc.idName;
  const r = sc.sub('r');
  if (r) {
    s.frame_start = r.num('sfra');
    s.frame_end = r.num('efra');
    s.frame_step = r.num('frame_step') || 1;
    s.frame_current = r.num('cfra');
    s.render.fps = r.num('frs_sec') || 24;
    s.render.fps_base = r.num('frs_sec_base') || 1;
    s.render.resolution_x = r.num('xsch');
    s.render.resolution_y = r.num('ysch');
    s.render.resolution_percentage = r.num('size') || 100;
    s.render.pixel_aspect_x = r.num('xasp') || 1;
    s.render.pixel_aspect_y = r.num('yasp') || 1;
    s.render.film_transparent = r.num('alphamode') === 1;
    const engine = r.str('engine');
    s.render.engine = engine === 'CYCLES' ? 'PATHTRACE' : engine === 'BLENDER_WORKBENCH' ? 'SOLID' : 'RASTER';
    const ps = r.num('psfra'),
      pe = r.num('pefra');
    if (pe > ps) {
      s.frame_preview_start = ps;
      s.frame_preview_end = pe;
    }
  }
  const vs = sc.sub('view_settings');
  if (vs) {
    const vt = vs.str('view_transform');
    const map: Record<string, NonNullable<typeof s.render.view_transform>> = { AgX: 'AGX', Filmic: 'FILMIC', Standard: 'STANDARD', 'Khronos PBR Neutral': 'KHRONOS_PBR_NEUTRAL', Raw: 'RAW' };
    if (map[vt]) s.render.view_transform = map[vt];
    else if (vt) warn.add('View transform not supported', vt);
    s.render.exposure = vs.num('exposure');
    s.render.gamma = vs.num('gamma') || 1;
    const look = vs.str('look');
    if (look) s.render.look = look.replace(/^(AgX|Filmic) - /, '') || 'None';
  }
  const cursor = sc.sub('cursor');
  if (cursor) s.cursor = { location: vec3(cursor, 'location'), rotation_euler: vec3(cursor, 'rotation_euler') };
  const unit = sc.sub('unit');
  if (unit) {
    s.unit_settings.system = (['NONE', 'METRIC', 'IMPERIAL'] as const)[unit.num('system')] ?? 'METRIC';
    s.unit_settings.scale_length = unit.num('scale_length') || 1;
    s.unit_settings.system_rotation = unit.num('system_rotation') === 1 ? 'RADIANS' : 'DEGREES';
  }
  const phys = sc.sub('physics_settings');
  if (phys) {
    s.gravity = vec3(phys, 'gravity', [0, 0, -9.81]);
    s.use_gravity = (phys.num('flag') & 1) !== 0;
  }
  s.timeline_markers = sc.list('markers', 100_000).map((m) => ({ name: m.str('name'), frame: m.num('frame'), select: (m.num('flag') & 1) !== 0, camera: ctx.objectRef(m.ref('camera')) }));
  s.camera = ctx.objectRef(sc.ref('camera'));
  const wo = sc.ref('world');
  if (wo && wo.type === 'World') {
    s.world = convertWorld(wo);
    if (defaultWorld && s.world !== defaultWorld) delete doc.worlds[defaultWorld];
  } else s.world = defaultWorld;
  if (sc.ref('rigidbody_world')) warn.add('Rigid body world not imported');
  const ed = sc.ref('ed');
  if (ed && (ed.list('seqbase', 1).length || ed.list('strips', 1).length)) warn.add('Video sequencer strips not imported');
  if ((sc.num('use_nodes') && sc.ref('nodetree')) || sc.ref('compositing_node_group')) warn.add('Compositor node tree not imported');
  if (sc.ref('adt')) warn.add('Scene animation not imported');

  // ---------------------------------------------------------------- validate animation paths
  for (const o of Object.values(doc.objects)) {
    const ad = o.animation_data;
    if (!ad) continue;
    const actions = [ad.action, ...ad.nla_tracks.flatMap((t) => t.strips.map((x) => x.action))].filter((x): x is string => !!x);
    for (const aid of new Set(actions)) {
      for (const fc of doc.actions[aid]?.fcurves ?? []) {
        let ok = false;
        try {
          ok = !!resolve(doc, o, fc.data_path);
        } catch {
          ok = false;
        }
        if (!ok) warn.add('Animated properties not supported by this app (kept, not evaluated)', `${o.name}: ${fc.data_path}`);
      }
    }
  }

  readAssetMarks(f, ctx, convertWorld);
  const masterData = doc.collections[masterId];
  return {
    doc,
    warnings: warn.list(),
    version: `${Math.floor(version / 100)}.${version % 100}`,
    sceneName: sc.idName,
    compression: f.compression,
    topCollections: [...masterData.children],
    topObjects: [...masterData.objects],
    stats: { objects: Object.keys(doc.objects).length, meshes: Object.keys(doc.meshes).length, materials: Object.keys(doc.materials).length, actions: Object.keys(doc.actions).length },
  };
}
