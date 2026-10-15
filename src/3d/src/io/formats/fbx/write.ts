// FBX 7.4 binary writer (independent implementation): meshes (n-gons, normals, UVs, colors,
// smoothing, materials), hierarchy, cameras, lights, armatures + skins, shape keys, textures
// (embedded) and baked animation.
import { Euler, Matrix4, Vector3 } from 'three';
import { N, P, writeFbxBinary, type WNode } from './binary';
import type { ExportMesh, ExportObject, ExportScene } from '../scene-builder';
import type { ExportMaterial, ExportTexRef } from '../material-nodes';
import { axisConversion, baseName, decompose, extOfMime, transpose3, type AxisId } from '../common';
import type { ImageData } from '../../../data/types';

export interface FbxWriteOptions {
  forward?: AxisId;
  up?: AxisId;
  /** global scale applied on top of the unit conversion */
  scale?: number;
  /** 'CM': UnitScaleFactor 1 with root objects scaled ×100 (default); 'M': UnitScaleFactor 100 */
  units?: 'CM' | 'M';
  embedTextures?: boolean;
  animation?: boolean;
  /** encoder for images without file bytes */
  encodeImage?: (img: ImageData) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  creator?: string;
}

const KTIME = 46186158000;
const R2D = 180 / Math.PI;

export async function writeFbx(scene: ExportScene, opts: FbxWriteOptions = {}): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings = [...scene.warnings];
  const axis = axisConversion(opts.forward ?? '-Z', opts.up ?? 'Y');
  if (!axis) throw new Error('Forward and Up axes must be different');
  const A = transpose3(axis); // doc → file
  const unitMode = opts.units ?? 'CM';
  const rootScale = (unitMode === 'CM' ? 100 : 1) * (opts.scale ?? 1);
  const G = new Matrix4().set(A[0], A[1], A[2], 0, A[3], A[4], A[5], 0, A[6], A[7], A[8], 0, 0, 0, 0, 1);
  const Gs = G.clone().multiply(new Matrix4().makeScale(rootScale, rootScale, rootScale));
  // global conversion applied to root objects: axis change and unit scale (uniform, so order is irrelevant)
  const K_CAMERA = new Matrix4().makeRotationY(Math.PI / 2);
  const K_LIGHT = new Matrix4().makeRotationX(Math.PI / 2);
  const K = (eo: ExportObject | null) => (eo?.type === 'CAMERA' ? K_CAMERA : eo?.type === 'LIGHT' ? K_LIGHT : new Matrix4());

  let nextId = 1000000;
  const id = () => P.i64(nextId++);
  const objects: WNode[] = [];
  const connections: WNode[] = [];
  const counts = new Map<string, number>();
  const count = (t: string) => counts.set(t, (counts.get(t) ?? 0) + 1);
  const oo = (child: P, parent: P | 0) => connections.push(N('C', [P.str('OO'), child, parent === 0 ? P.i64(0) : parent]));
  const op = (child: P, parent: P, prop: string) => connections.push(N('C', [P.str('OP'), child, parent, P.str(prop)]));
  const name = (n: string, cls: string) => P.str(`${n}\u0000\u0001${cls}`);
  const p70 = (...ps: WNode[]) => N('Properties70', [], ps);
  const pNum = (n: string, v: number, type = 'Number', label = '', flag = 'A') => N('P', [P.str(n), P.str(type), P.str(label), P.str(flag), P.f64(v)]);
  const pDouble = (n: string, v: number) => N('P', [P.str(n), P.str('double'), P.str('Number'), P.str(''), P.f64(v)]);
  const pInt = (n: string, v: number) => N('P', [P.str(n), P.str('int'), P.str('Integer'), P.str(''), P.i32(v)]);
  const pEnum = (n: string, v: number) => N('P', [P.str(n), P.str('enum'), P.str(''), P.str(''), P.i32(v)]);
  const pBool = (n: string, v: boolean) => N('P', [P.str(n), P.str('bool'), P.str(''), P.str(''), P.i32(v ? 1 : 0)]);
  const pStr = (n: string, v: string, type = 'KString', label = '') => N('P', [P.str(n), P.str(type), P.str(label), P.str(''), P.str(v)]);
  const pVec = (n: string, v: number[], type = 'Vector3D', label = 'Vector', flag = '') => N('P', [P.str(n), P.str(type), P.str(label), P.str(flag), P.f64(v[0]), P.f64(v[1]), P.f64(v[2])]);
  const pColor = (n: string, v: number[]) => N('P', [P.str(n), P.str('Color'), P.str(''), P.str('A'), P.f64(v[0]), P.f64(v[1]), P.f64(v[2])]);
  const pTime = (n: string, v: number) => N('P', [P.str(n), P.str('KTime'), P.str('Time'), P.str(''), P.i64(Math.round(v))]);

  // ------------------------------------------------------------ transforms
  const order: ExportObject[] = [];
  const visit = (eo: ExportObject) => {
    order.push(eo);
    eo.children.forEach(visit);
  };
  scene.roots.forEach(visit);
  /** FBX local matrix of an object given its document local (relative to its export parent frame) */
  const fbxLocal = (eo: ExportObject, local: Matrix4): Matrix4 => {
    if (!eo.parent) return Gs.clone().multiply(local).multiply(K(eo));
    if (eo.parentBone) {
      const b = eo.parent.armature!.bones.find((x) => x.name === eo.parentBone)!;
      return new Matrix4().makeTranslation(0, b.length, 0).multiply(local).multiply(K(eo));
    }
    return K(eo.parent).clone().invert().multiply(local).multiply(K(eo));
  };
  const trs = (m: Matrix4, prevEuler?: number[]) => {
    const { p, q, s } = decompose(m);
    const e = new Euler().setFromQuaternion(q, 'ZYX');
    let r = [e.x * R2D, e.y * R2D, e.z * R2D];
    if (prevEuler) r = r.map((v, i) => v + Math.round((prevEuler[i] - v) / 360) * 360);
    return { t: [p.x, p.y, p.z], r, s: [s.x, s.y, s.z] };
  };
  const modelProps = (m: Matrix4, extra: WNode[] = []) => {
    const { t, r, s } = trs(m);
    return p70(
      N('P', [P.str('Lcl Translation'), P.str('Lcl Translation'), P.str(''), P.str('A'), ...t.map(P.f64)]),
      N('P', [P.str('Lcl Rotation'), P.str('Lcl Rotation'), P.str(''), P.str('A'), ...r.map(P.f64)]),
      N('P', [P.str('Lcl Scaling'), P.str('Lcl Scaling'), P.str(''), P.str('A'), ...s.map(P.f64)]),
      pEnum('RotationOrder', 0),
      pInt('DefaultAttributeIndex', 0),
      pEnum('InheritType', 1),
      ...extra,
    );
  };

  // ------------------------------------------------------------ textures / materials
  const videoIds = new Map<string, P>();
  const textureNodes = new Map<string, P>();
  const encodeCache = new Map<string, { bytes: Uint8Array; mime: string } | null>();
  const imageData = async (imageId: string) => {
    if (encodeCache.has(imageId)) return encodeCache.get(imageId)!;
    const img = scene.doc.images[imageId];
    let r: { bytes: Uint8Array; mime: string } | null = img?.bytes ? { bytes: img.bytes, mime: img.mime } : null;
    if (!r && img && opts.encodeImage) r = await opts.encodeImage(img);
    encodeCache.set(imageId, r);
    return r;
  };
  const textureFor = async (ref: ExportTexRef | undefined, usage: string): Promise<P | null> => {
    if (!ref) return null;
    const img = scene.doc.images[ref.imageId];
    if (!img) return null;
    const key = `${ref.imageId}|${JSON.stringify([ref.offset, ref.scale, ref.rotation])}`;
    let tid = textureNodes.get(key);
    if (tid) return tid;
    const data = await imageData(ref.imageId);
    const fname = baseName(img.filepath || '') || `${img.name.replace(/\.(png|jpe?g|webp)$/i, '')}${data ? extOfMime(data.mime) : '.png'}`;
    let vid = videoIds.get(ref.imageId);
    if (!vid) {
      vid = id();
      videoIds.set(ref.imageId, vid);
      const vchildren: WNode[] = [
        N('Type', [P.str('Clip')]),
        p70(pStr('Path', fname, 'KString', 'Url')),
        N('UseMipMap', [P.i32(0)]),
        N('Filename', [P.str(fname)]),
        N('RelativeFilename', [P.str(fname)]),
      ];
      if (opts.embedTextures !== false && data) vchildren.push(N('Content', [P.raw(data.bytes)]));
      else if (opts.embedTextures !== false) warnings.push(`Image "${img.name}" has no pixel data to embed`);
      objects.push(N('Video', [vid, name(img.name, 'Video'), P.str('Clip')], vchildren));
      count('Video');
    }
    tid = id();
    textureNodes.set(key, tid);
    const tprops: WNode[] = [pBool('UseMaterial', true)];
    if (ref.offset) tprops.push(pVec('Translation', [ref.offset[0], ref.offset[1], 0]));
    if (ref.scale) tprops.push(pVec('Scaling', [ref.scale[0], ref.scale[1], 1]));
    if (ref.extension === 'EXTEND' || ref.extension === 'CLIP') tprops.push(pEnum('WrapModeU', 1), pEnum('WrapModeV', 1));
    objects.push(
      N(
        'Texture',
        [tid, name(`${usage}_texture`, 'Texture'), P.str('')],
        [
          N('Type', [P.str('TextureVideoClip')]),
          N('Version', [P.i32(202)]),
          N('TextureName', [name(`${usage}_texture`, 'Texture')]),
          p70(...tprops),
          N('Media', [name(img.name, 'Video')]),
          N('FileName', [P.str(fname)]),
          N('RelativeFilename', [P.str(fname)]),
          N('ModelUVTranslation', [P.f64(0), P.f64(0)]),
          N('ModelUVScaling', [P.f64(1), P.f64(1)]),
          N('Texture_Alpha_Source', [P.str('None')]),
          N('Cropping', [P.i32(0), P.i32(0), P.i32(0), P.i32(0)]),
        ],
      ),
    );
    count('Texture');
    oo(vid, tid);
    return tid;
  };
  const materialIds = new Map<string, P>();
  for (const [mid, m] of scene.materials) {
    const pid = id();
    materialIds.set(mid, pid);
    objects.push(N('Material', [pid, name(m.name, 'Material'), P.str('')], [N('Version', [P.i32(102)]), N('ShadingModel', [P.str('Phong')]), N('MultiLayer', [P.i32(0)]), materialProps(m)]));
    count('Material');
    const links: [ExportTexRef | undefined, string, string][] = [
      [m.baseColorTex, 'DiffuseColor', 'base_color'],
      [m.normalTex, 'NormalMap', 'normal'],
      [m.emissiveTex, 'EmissiveColor', 'emission'],
      [m.alphaTex, 'TransparentColor', 'alpha'],
      [m.metallicTex, 'ReflectionFactor', 'metallic'],
      [m.roughnessTex, 'ShininessExponent', 'roughness'],
    ];
    for (const [ref, prop, usage] of links) {
      const t = await textureFor(ref, usage);
      if (t) op(t, pid, prop);
    }
  }
  function materialProps(m: ExportMaterial) {
    const shin = (1 - m.roughness) ** 2 * 100;
    const e = m.emissive ?? [0, 0, 0];
    return p70(
      pColor('DiffuseColor', m.baseColor),
      pNum('DiffuseFactor', 1),
      pColor('EmissiveColor', e),
      pNum('EmissiveFactor', m.emissive ? (m.emissiveStrength ?? 1) : 0),
      pColor('AmbientColor', [0, 0, 0]),
      pNum('AmbientFactor', 0),
      pColor('SpecularColor', [1, 1, 1]),
      pNum('SpecularFactor', (m.specular ?? 0.5) / 2),
      pNum('Shininess', shin),
      pNum('ShininessExponent', shin),
      pColor('ReflectionColor', m.baseColor),
      pNum('ReflectionFactor', m.metallic),
      pColor('TransparentColor', [1, 1, 1]),
      pNum('TransparencyFactor', 1 - m.baseColor[3]),
      pNum('Opacity', m.baseColor[3]),
      ...(m.normalTex ? [pDouble('BumpFactor', m.normalTex.strength ?? 1)] : []),
    );
  }

  // ------------------------------------------------------------ models
  const modelIds = new Map<ExportObject, P>();
  const boneIds = new Map<ExportObject, Map<string, P>>();
  const geometryCache = new Map<string, { gid: P; shapes: { channel: P; name: string }[] }>();
  const res = scene.doc.scene.render;
  for (const eo of order) {
    const mid = id();
    modelIds.set(eo, mid);
    const local = fbxLocal(eo, eo.local);
    let kind = 'Null';
    const extra: WNode[] = [];
    if (eo.mesh) kind = 'Mesh';
    else if (eo.camera) kind = 'Camera';
    else if (eo.light) kind = 'Light';
    if (eo.camera) extra.push(pDouble('AspectW', res.resolution_x), pDouble('AspectH', res.resolution_y));
    objects.push(N('Model', [mid, name(eo.name, 'Model'), P.str(kind)], [N('Version', [P.i32(232)]), modelProps(local, extra), N('Shading', [P.bool(true)]), N('Culling', [P.str('CullingOff')])]));
    count('Model');
    oo(mid, eo.parent ? (eo.parentBone ? (boneIds.get(eo.parent)?.get(eo.parentBone) ?? modelIds.get(eo.parent)!) : modelIds.get(eo.parent)!) : 0);
    // node attributes
    if (eo.camera) {
      const c = eo.camera;
      const aid = id();
      const aspect = (res.resolution_x * res.pixel_aspect_x) / (res.resolution_y * res.pixel_aspect_y || 1);
      const sensorW = c.sensor_fit === 'VERTICAL' ? c.sensor_height * aspect : c.sensor_fit === 'AUTO' && aspect < 1 ? c.sensor_width * aspect : c.sensor_width;
      const sensorH = sensorW / aspect;
      const fovX = 2 * Math.atan(sensorW / 2 / c.lens) * R2D,
        fovY = 2 * Math.atan(sensorH / 2 / c.lens) * R2D;
      objects.push(
        N(
          'NodeAttribute',
          [aid, name(c.name, 'NodeAttribute'), P.str('Camera')],
          [
            p70(
              pNum('FocalLength', c.lens, 'double', 'Number'),
              pDouble('FilmWidth', sensorW / 25.4),
              pDouble('FilmHeight', sensorH / 25.4),
              pDouble('FilmAspectRatio', sensorW / sensorH),
              pEnum('AspectRatioMode', 2),
              pDouble('AspectWidth', res.resolution_x),
              pDouble('AspectHeight', res.resolution_y),
              pEnum('ApertureMode', 3),
              pEnum('GateFit', 2),
              N('P', [P.str('FieldOfView'), P.str('FieldOfView'), P.str(''), P.str('A'), P.f64(fovX)]),
              N('P', [P.str('FieldOfViewX'), P.str('FieldOfViewX'), P.str(''), P.str('A'), P.f64(fovX)]),
              N('P', [P.str('FieldOfViewY'), P.str('FieldOfViewY'), P.str(''), P.str('A'), P.f64(fovY)]),
              pDouble('FilmOffsetX', (c.shift_x * sensorW) / 25.4),
              pDouble('FilmOffsetY', (c.shift_y * sensorW) / 25.4),
              pEnum('CameraProjectionType', c.type === 'ORTHO' ? 1 : 0),
              pDouble('OrthoZoom', c.ortho_scale),
              pDouble('NearPlane', c.clip_start * rootScale),
              pDouble('FarPlane', c.clip_end * rootScale),
              pEnum('BackPlaneDistanceMode', 1),
              pDouble('BackPlaneDistance', c.clip_end * rootScale),
            ),
            N('TypeFlags', [P.str('Camera')]),
            N('GeometryVersion', [P.i32(124)]),
            N('Position', [P.f64(0), P.f64(0), P.f64(0)]),
            N('Up', [P.f64(0), P.f64(1), P.f64(0)]),
            N('LookAt', [P.f64(1), P.f64(0), P.f64(0)]),
            N('ShowInfoOnMoving', [P.i32(1)]),
            N('ShowAudio', [P.i32(0)]),
            N('AudioColor', [P.f64(0), P.f64(1), P.f64(0)]),
            N('CameraOrthoZoom', [P.f64(1)]),
          ],
        ),
      );
      count('NodeAttribute');
      oo(aid, mid);
      if (c.type === 'PANO') warnings.push(`Camera "${c.name}": panoramic cameras are exported as perspective`);
    } else if (eo.light) {
      const l = eo.light;
      const aid = id();
      const type = l.type === 'SUN' ? 1 : l.type === 'SPOT' ? 2 : l.type === 'AREA' ? 3 : 0;
      const ps: WNode[] = [pEnum('LightType', type), pColor('Color', l.color), pNum('Intensity', l.energy * 100), pBool('CastShadows', l.use_shadow), pDouble('DecayStart', 25 * rootScale)];
      if (l.type === 'SPOT') ps.push(pDouble('OuterAngle', l.spot_size * R2D), pDouble('InnerAngle', l.spot_size * (1 - l.spot_blend) * R2D));
      if (l.type === 'AREA') {
        ps.push(pEnum('AreaLightShape', l.shape === 'DISK' || l.shape === 'ELLIPSE' ? 1 : 0));
        warnings.push(`Light "${l.name}": area light size is not stored in FBX`);
      }
      objects.push(N('NodeAttribute', [aid, name(l.name, 'NodeAttribute'), P.str('Light')], [N('GeometryVersion', [P.i32(124)]), p70(...ps), N('TypeFlags', [P.str('Light')])]));
      count('NodeAttribute');
      oo(aid, mid);
    } else if (!eo.mesh) {
      const aid = id();
      objects.push(N('NodeAttribute', [aid, name(eo.name, 'NodeAttribute'), P.str('Null')], [N('TypeFlags', [P.str('Null')]), p70(pDouble('Size', 100))]));
      count('NodeAttribute');
      oo(aid, mid);
    }
    // bones
    if (eo.armature) {
      const map = new Map<string, P>();
      boneIds.set(eo, map);
      for (const b of eo.armature.bones) {
        const bid = id();
        map.set(b.name, bid);
        const pose = eo.armature.pose.get(b.name)!;
        const parentPose = b.parent ? eo.armature.pose.get(b.parent)! : null;
        const rel = parentPose ? parentPose.clone().invert().multiply(pose) : pose.clone();
        objects.push(N('Model', [bid, name(b.name, 'Model'), P.str('LimbNode')], [N('Version', [P.i32(232)]), modelProps(rel), N('Shading', [P.bool(true)]), N('Culling', [P.str('CullingOff')])]));
        count('Model');
        const aid = id();
        objects.push(N('NodeAttribute', [aid, name(b.name, 'NodeAttribute'), P.str('LimbNode')], [N('TypeFlags', [P.str('Skeleton')]), p70(pDouble('Size', b.length * rootScale))]));
        count('NodeAttribute');
        oo(aid, bid);
        oo(bid, b.parent ? map.get(b.parent)! : mid);
      }
    }
  }

  // ------------------------------------------------------------ geometry
  const globalOf = (eo: ExportObject): Matrix4 => Gs.clone().multiply(eo.world).multiply(K(eo));
  const bindPoses: { node: P; matrix: Matrix4 }[] = [];
  for (const eo of order) {
    if (!eo.mesh) continue;
    const mid = modelIds.get(eo)!;
    const key = eo.mesh.sourceId && !eo.mesh.modified && !eo.skin ? eo.mesh.sourceId : `obj:${eo.id}`;
    let geo = geometryCache.get(key);
    if (!geo) {
      const gid = id();
      objects.push(geometryNode(gid, eo.mesh));
      count('Geometry');
      geo = { gid, shapes: [] };
      geometryCache.set(key, geo);
      // shape keys
      if (eo.mesh.shapeKeys.length) {
        const bsid = id();
        objects.push(N('Deformer', [bsid, name(eo.mesh.name, 'Deformer'), P.str('BlendShape')], [N('Version', [P.i32(100)])]));
        count('Deformer');
        oo(bsid, gid);
        for (const k of eo.mesh.shapeKeys) {
          const idxs: number[] = [],
            deltas: number[] = [];
          for (let v = 0; v < eo.mesh.positions.length / 3; v++) {
            const dx = k.positions[v * 3] - eo.mesh.positions[v * 3],
              dy = k.positions[v * 3 + 1] - eo.mesh.positions[v * 3 + 1],
              dz = k.positions[v * 3 + 2] - eo.mesh.positions[v * 3 + 2];
            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-7) {
              idxs.push(v);
              deltas.push(dx, dy, dz);
            }
          }
          if (!idxs.length) {
            idxs.push(0);
            deltas.push(0, 0, 0);
          }
          const chid = id(),
            shid = id();
          objects.push(
            N('Deformer', [chid, name(k.name, 'SubDeformer'), P.str('BlendShapeChannel')], [N('Version', [P.i32(100)]), N('DeformPercent', [P.f64(k.value * 100)]), N('FullWeights', [P.f64s([100])])]),
          );
          objects.push(
            N(
              'Geometry',
              [shid, name(k.name, 'Geometry'), P.str('Shape')],
              [N('Version', [P.i32(100)]), N('Indexes', [P.i32s(idxs)]), N('Vertices', [P.f64s(deltas)]), N('Normals', [P.f64s(new Array(deltas.length).fill(0))])],
            ),
          );
          count('Deformer');
          count('Geometry');
          oo(chid, bsid);
          oo(shid, chid);
          geo.shapes.push({ channel: chid, name: k.name });
        }
      }
    }
    oo(geo.gid, mid);
    for (const matId of eo.mesh.materials) {
      const m = matId ? materialIds.get(matId) : undefined;
      if (m) oo(m, mid);
    }
    // skin
    if (eo.skin) {
      const arm = eo.skin;
      const bones = arm.armature!.bones;
      const groups = eo.mesh.groups;
      const skid = id();
      objects.push(N('Deformer', [skid, name(arm.name, 'Deformer'), P.str('Skin')], [N('Version', [P.i32(101)]), N('Link_DeformAcuracy', [P.f64(50)])]));
      count('Deformer');
      oo(skid, geo.gid);
      const meshGlobal = globalOf(eo);
      bindPoses.push({ node: mid, matrix: meshGlobal });
      for (const b of bones) {
        const gi = groups?.names.indexOf(b.name) ?? -1;
        const idxs: number[] = [],
          ws: number[] = [];
        if (gi >= 0) {
          const w = groups!.weights[gi];
          for (let v = 0; v < w.length; v++)
            if (w[v] > 0) {
              idxs.push(v);
              ws.push(w[v]);
            }
        }
        const cid = id();
        const link = Gs.clone().multiply(arm.world).multiply(b.rest);
        objects.push(
          N(
            'Deformer',
            [cid, name(b.name, 'SubDeformer'), P.str('Cluster')],
            [
              N('Version', [P.i32(100)]),
              N('UserData', [P.str(''), P.str('')]),
              N('Indexes', [P.i32s(idxs)]),
              N('Weights', [P.f64s(ws)]),
              N('Transform', [P.f64s(link.clone().invert().multiply(meshGlobal).elements)]),
              N('TransformLink', [P.f64s(link.elements)]),
              N('TransformAssociateModel', [P.f64s(Gs.clone().multiply(arm.world).elements)]),
            ],
          ),
        );
        count('Deformer');
        oo(cid, skid);
        oo(boneIds.get(arm)!.get(b.name)!, cid);
        bindPoses.push({ node: boneIds.get(arm)!.get(b.name)!, matrix: link });
      }
      const unused = (groups?.names ?? []).filter((n) => !bones.some((b) => b.name === n));
      if (unused.length) warnings.push(`"${eo.name}": vertex groups without matching bones were not exported as skin weights (${unused.slice(0, 5).join(', ')})`);
    }
  }
  if (bindPoses.length) {
    const pid = id();
    const seen = new Set<P>();
    const nodes = bindPoses.filter((b) => (seen.has(b.node) ? false : (seen.add(b.node), true)));
    objects.push(
      N(
        'Pose',
        [pid, name('BindPose', 'Pose'), P.str('BindPose')],
        [
          N('Type', [P.str('BindPose')]),
          N('Version', [P.i32(100)]),
          N('NbPoseNodes', [P.i32(nodes.length)]),
          ...nodes.map((b) => N('PoseNode', [], [N('Node', [b.node]), N('Matrix', [P.f64s(b.matrix.elements)])])),
        ],
      ),
    );
    count('Pose');
  }

  function geometryNode(gid: P, m: ExportMesh): WNode {
    const nf = m.offsets.length - 1;
    const pvi: number[] = [];
    for (let f = 0; f < nf; f++) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      if (e - s < 3) continue;
      for (let c = s; c < e; c++) pvi.push(c === e - 1 ? ~m.indices[c] : m.indices[c]);
    }
    const valid: number[] = [];
    for (let f = 0; f < nf; f++) if (m.offsets[f + 1] - m.offsets[f] >= 3) valid.push(f);
    const cornersOf = (f: number) => Array.from({ length: m.offsets[f + 1] - m.offsets[f] }, (_, k) => m.offsets[f] + k);
    const corners = valid.flatMap(cornersOf);
    const layers: WNode[] = [];
    const layerRefs: WNode[] = [];
    const normals: number[] = [];
    for (const c of corners) normals.push(m.normals[c * 3], m.normals[c * 3 + 1], m.normals[c * 3 + 2]);
    layers.push(
      N(
        'LayerElementNormal',
        [P.i32(0)],
        [
          N('Version', [P.i32(101)]),
          N('Name', [P.str('')]),
          N('MappingInformationType', [P.str('ByPolygonVertex')]),
          N('ReferenceInformationType', [P.str('Direct')]),
          N('Normals', [P.f64s(normals)]),
        ],
      ),
    );
    layerRefs.push(N('LayerElement', [], [N('Type', [P.str('LayerElementNormal')]), N('TypedIndex', [P.i32(0)])]));
    layers.push(
      N(
        'LayerElementSmoothing',
        [P.i32(0)],
        [
          N('Version', [P.i32(102)]),
          N('Name', [P.str('')]),
          N('MappingInformationType', [P.str('ByPolygon')]),
          N('ReferenceInformationType', [P.str('Direct')]),
          N('Smoothing', [P.i32s(valid.map((f) => (m.smooth[f] ? 1 : 0)))]),
        ],
      ),
    );
    layerRefs.push(N('LayerElement', [], [N('Type', [P.str('LayerElementSmoothing')]), N('TypedIndex', [P.i32(0)])]));
    if (m.uvs) {
      const map = new Map<string, number>();
      const uv: number[] = [],
        uvi: number[] = [];
      for (const c of corners) {
        const k = `${m.uvs[c * 2]},${m.uvs[c * 2 + 1]}`;
        let i = map.get(k);
        if (i === undefined) {
          i = map.size;
          map.set(k, i);
          uv.push(m.uvs[c * 2], m.uvs[c * 2 + 1]);
        }
        uvi.push(i);
      }
      layers.push(
        N(
          'LayerElementUV',
          [P.i32(0)],
          [
            N('Version', [P.i32(101)]),
            N('Name', [P.str(m.uvName || 'UVMap')]),
            N('MappingInformationType', [P.str('ByPolygonVertex')]),
            N('ReferenceInformationType', [P.str('IndexToDirect')]),
            N('UV', [P.f64s(uv)]),
            N('UVIndex', [P.i32s(uvi)]),
          ],
        ),
      );
      layerRefs.push(N('LayerElement', [], [N('Type', [P.str('LayerElementUV')]), N('TypedIndex', [P.i32(0)])]));
    }
    m.colors.forEach((cl, ci) => {
      const map = new Map<string, number>();
      const cols: number[] = [],
        idx: number[] = [];
      for (const c of corners) {
        const v = Array.from(cl.data.subarray(c * 4, c * 4 + 4));
        const k = v.join(',');
        let i = map.get(k);
        if (i === undefined) {
          i = map.size;
          map.set(k, i);
          cols.push(...v);
        }
        idx.push(i);
      }
      layers.push(
        N(
          'LayerElementColor',
          [P.i32(ci)],
          [
            N('Version', [P.i32(101)]),
            N('Name', [P.str(cl.name)]),
            N('MappingInformationType', [P.str('ByPolygonVertex')]),
            N('ReferenceInformationType', [P.str('IndexToDirect')]),
            N('Colors', [P.f64s(cols)]),
            N('ColorIndex', [P.i32s(idx)]),
          ],
        ),
      );
      if (ci === 0) layerRefs.push(N('LayerElement', [], [N('Type', [P.str('LayerElementColor')]), N('TypedIndex', [P.i32(0)])]));
    });
    if (m.materials.length) {
      layers.push(
        N(
          'LayerElementMaterial',
          [P.i32(0)],
          [
            N('Version', [P.i32(101)]),
            N('Name', [P.str('')]),
            N('MappingInformationType', [P.str('ByPolygon')]),
            N('ReferenceInformationType', [P.str('IndexToDirect')]),
            N('Materials', [P.i32s(valid.map((f) => Math.min(m.materialIndex[f] ?? 0, Math.max(0, m.materials.length - 1))))]),
          ],
        ),
      );
      layerRefs.push(N('LayerElement', [], [N('Type', [P.str('LayerElementMaterial')]), N('TypedIndex', [P.i32(0)])]));
    }
    return N(
      'Geometry',
      [gid, name(m.name, 'Geometry'), P.str('Mesh')],
      [
        p70(),
        N('GeometryVersion', [P.i32(124)]),
        N('Vertices', [P.f64s(m.positions)]),
        N('PolygonVertexIndex', [P.i32s(pvi)]),
        ...layers,
        N('Layer', [P.i32(0)], [N('Version', [P.i32(100)]), ...layerRefs]),
      ],
    );
  }

  // ------------------------------------------------------------ animation
  const fps = scene.fps;
  const frames = scene.frames;
  let stackStart = 0,
    stackStop = 0;
  if (opts.animation !== false && scene.tracks.length && frames.length > 1) {
    // FBX time 0 is frame 1 (the convention our importer reads back)
    const times = frames.map((f) => Math.round(((f - 1) / fps) * KTIME));
    stackStart = times[0];
    stackStop = times[times.length - 1];
    const stackName = scene.tracks.length === 1 ? scene.tracks[0].name : scene.doc.scene.name || 'Scene';
    const sid = id(),
      lid = id();
    objects.push(
      N(
        'AnimationStack',
        [sid, name(stackName, 'AnimStack'), P.str('')],
        [p70(pTime('LocalStart', stackStart), pTime('LocalStop', stackStop), pTime('ReferenceStart', stackStart), pTime('ReferenceStop', stackStop))],
      ),
    );
    objects.push(N('AnimationLayer', [lid, name('BaseLayer', 'AnimLayer'), P.str('')], []));
    count('AnimationStack');
    count('AnimationLayer');
    oo(lid, sid);
    const curve = (values: number[]): P => {
      const cid = id();
      objects.push(
        N(
          'AnimationCurve',
          [cid, name('', 'AnimCurve'), P.str('')],
          [
            N('Default', [P.f64(values[0])]),
            N('KeyVer', [P.i32(4008)]),
            N('KeyTime', [P.i64s(times)]),
            N('KeyValueFloat', [P.f32s(values)]),
            N('KeyAttrFlags', [P.i32s([24836])]),
            N('KeyAttrDataFloat', [P.f32s([0, 0, 0, 0])]),
            N('KeyAttrRefCount', [P.i32s([values.length])]),
          ],
        ),
      );
      count('AnimationCurve');
      return cid;
    };
    const curveNode = (target: P, prop: string, short: string, chans: number[][]) => {
      const cn = id();
      const labels = chans.length === 1 ? ['d|DeformPercent'] : ['d|X', 'd|Y', 'd|Z'];
      objects.push(
        N('AnimationCurveNode', [cn, name(short, 'AnimCurveNode'), P.str('')], [p70(...chans.map((c, i) => N('P', [P.str(labels[i]), P.str('Number'), P.str(''), P.str('A'), P.f64(c[0])])))]),
      );
      count('AnimationCurveNode');
      oo(cn, lid);
      op(cn, target, prop);
      chans.forEach((c, i) => op(curve(c), cn, labels[i]));
    };
    const varies = (ch: number[][]) => ch.some((c) => c.some((v) => Math.abs(v - c[0]) > 1e-6));
    const emitTRS = (target: P, mats: Matrix4[]) => {
      const T: number[][] = [[], [], []],
        R: number[][] = [[], [], []],
        S: number[][] = [[], [], []];
      let prev: number[] | undefined;
      for (const m of mats) {
        const x = trs(m, prev);
        prev = x.r;
        for (let k = 0; k < 3; k++) {
          T[k].push(x.t[k]);
          R[k].push(x.r[k]);
          S[k].push(x.s[k]);
        }
      }
      if (varies(T)) curveNode(target, 'Lcl Translation', 'T', T);
      if (varies(R)) curveNode(target, 'Lcl Rotation', 'R', R);
      if (varies(S)) curveNode(target, 'Lcl Scaling', 'S', S);
    };
    for (const tr of scene.tracks) {
      const eo = tr.object;
      const mid = modelIds.get(eo);
      if (!mid) continue;
      if (tr.locals)
        emitTRS(
          mid,
          tr.locals.map((l) => fbxLocal(eo, l)),
        );
      for (const [bone, mats] of tr.bones) {
        const bid = boneIds.get(eo)?.get(bone);
        if (bid) emitTRS(bid, mats);
      }
      if (tr.shapeKeys && eo.mesh) {
        const key = eo.mesh.sourceId && !eo.mesh.modified && !eo.skin ? eo.mesh.sourceId : `obj:${eo.id}`;
        const geo = geometryCache.get(key);
        geo?.shapes.forEach((sh, k) => curveNode(sh.channel, 'DeformPercent', 'DeformPercent', [tr.shapeKeys!.map((v) => v[k] * 100)]));
      }
    }
  }

  // ------------------------------------------------------------ document
  const timeMode = fpsMode(fps);
  const creator = opts.creator ?? 'Puter 3D FBX exporter';
  // FBX axis system: UpAxis/FrontAxis/CoordAxis in the file's coordinates (doc axes expressed in file space)
  const docUp = new Vector3(A[2], A[5], A[8]); // doc +Z in file coords
  const docFront = new Vector3(-A[1], -A[4], -A[7]); // FBX FrontAxis convention: −(doc +Y)
  const docRight = new Vector3(A[0], A[3], A[6]);
  const axisOf = (v: Vector3) => {
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
    const i = a.indexOf(Math.max(...a));
    return { i, s: Math.sign([v.x, v.y, v.z][i]) || 1 };
  };
  const up = axisOf(docUp),
    front = axisOf(docFront),
    coord = axisOf(docRight);
  const nodes: WNode[] = [
    N(
      'FBXHeaderExtension',
      [],
      [
        N('FBXHeaderVersion', [P.i32(1003)]),
        N('FBXVersion', [P.i32(7400)]),
        N('EncryptionType', [P.i32(0)]),
        N(
          'CreationTimeStamp',
          [],
          [
            N('Version', [P.i32(1000)]),
            N('Year', [P.i32(1970)]),
            N('Month', [P.i32(1)]),
            N('Day', [P.i32(1)]),
            N('Hour', [P.i32(10)]),
            N('Minute', [P.i32(0)]),
            N('Second', [P.i32(0)]),
            N('Millisecond', [P.i32(0)]),
          ],
        ),
        N('Creator', [P.str(creator)]),
      ],
    ),
    N('FileId', [P.raw(Uint8Array.from([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
    N('CreationTime', [P.str('1970-01-01 10:00:00:000')]),
    N('Creator', [P.str(creator)]),
    N(
      'GlobalSettings',
      [],
      [
        N('Version', [P.i32(1000)]),
        p70(
          pInt('UpAxis', up.i),
          pInt('UpAxisSign', up.s),
          pInt('FrontAxis', front.i),
          pInt('FrontAxisSign', front.s),
          pInt('CoordAxis', coord.i),
          pInt('CoordAxisSign', coord.s),
          pInt('OriginalUpAxis', 2),
          pInt('OriginalUpAxisSign', 1),
          pDouble('UnitScaleFactor', unitMode === 'CM' ? 1 : 100),
          pDouble('OriginalUnitScaleFactor', unitMode === 'CM' ? 1 : 100),
          N('P', [P.str('AmbientColor'), P.str('ColorRGB'), P.str('Color'), P.str(''), P.f64(0), P.f64(0), P.f64(0)]),
          pStr('DefaultCamera', 'Producer Perspective'),
          pEnum('TimeMode', timeMode),
          pTime('TimeSpanStart', stackStart),
          pTime('TimeSpanStop', stackStop || KTIME),
          pDouble('CustomFrameRate', fps),
        ),
      ],
    ),
    N(
      'Documents',
      [],
      [
        N('Count', [P.i32(1)]),
        N(
          'Document',
          [id(), P.str('Scene'), P.str('Scene')],
          [p70(N('P', [P.str('SourceObject'), P.str('object'), P.str(''), P.str('')]), pStr('ActiveAnimStackName', '')), N('RootNode', [P.i64(0)])],
        ),
      ],
    ),
    N('References', [], []),
    N(
      'Definitions',
      [],
      [
        N('Version', [P.i32(100)]),
        N('Count', [P.i32([...counts.values()].reduce((a, b) => a + b, 0) + 1)]),
        N('ObjectType', [P.str('GlobalSettings')], [N('Count', [P.i32(1)])]),
        ...[...counts].map(([t, c]) => N('ObjectType', [P.str(t)], [N('Count', [P.i32(c)])])),
      ],
    ),
    N('Objects', [], objects),
    N('Connections', [], connections),
    N('Takes', [], [N('Current', [P.str('')])]),
  ];
  return { bytes: writeFbxBinary(nodes, 7400), warnings: [...new Set(warnings)] };
}

function fpsMode(fps: number) {
  const table: [number, number][] = [
    [120, 1],
    [100, 2],
    [60, 3],
    [50, 4],
    [48, 5],
    [30, 6],
    [25, 10],
    [24, 11],
    [1000, 12],
    [96, 15],
    [72, 16],
  ];
  for (const [f, m] of table) if (Math.abs(fps - f) < 1e-6) return m;
  return 14;
}
