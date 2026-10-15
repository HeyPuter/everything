// FBX (binary 7.x / ASCII) → IR. Independent implementation following the publicly documented
// FBX object model: Objects + Connections, Model transform stack (pivots, pre/post rotation,
// rotation order, geometric transform), layer elements, skin clusters, blend shapes, animation stacks.
import { Euler, Matrix4, Vector3 } from 'three';
import { child, childrenNamed, idOf, numArray, parseFbx, props70, toNum, type FbxNode, type FbxValue } from './binary';
import { emptyScene, type IRChannel, type IRMaterial, type IRMesh, type IRScene, type IRTexRef } from '../ir';
import { baseName, sniffMime, stripExt } from '../common';

const KTIME = 46186158000;
const D2R = Math.PI / 180;

export interface FbxReadOptions {
  /** external texture files by base name */
  resources?: Map<string, Uint8Array>;
  /** frames per second for sampling animation (default: from the file) */
  fps?: number;
}

interface Obj {
  id: string;
  node: FbxNode;
  type: string; // node name: Model, Geometry, Material, ...
  name: string;
  sub: string; // class: Mesh, LimbNode, Null, Skin, Cluster, ...
}

const ROT_ORDERS: Euler['order'][] = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ']; // FBX eEulerXYZ.. mapped to three's (reversed) order strings

export function fbxExternalTextures(bytes: Uint8Array): string[] {
  const { nodes } = parseFbx(bytes);
  const objs = nodes.find((n) => n.name === 'Objects');
  const out: string[] = [];
  const embedded = new Set<string>();
  for (const v of childrenNamed(objs, 'Video')) {
    const content = child(v, 'Content')?.props[0];
    const f = baseName(String(child(v, 'RelativeFilename')?.props[0] ?? child(v, 'Filename')?.props[0] ?? ''));
    if ((content instanceof Uint8Array && content.length) || (typeof content === 'string' && content.length)) {
      embedded.add(f.toLowerCase());
      continue;
    }
    if (f) out.push(f);
  }
  for (const t of childrenNamed(objs, 'Texture')) {
    const f = baseName(String(child(t, 'RelativeFilename')?.props[0] ?? child(t, 'FileName')?.props[0] ?? ''));
    if (f && !embedded.has(f.toLowerCase()) && !out.includes(f)) out.push(f);
  }
  return out;
}

export function readFbx(bytes: Uint8Array, opts: FbxReadOptions = {}): IRScene {
  const { version, nodes } = parseFbx(bytes);
  const ir = emptyScene();
  const W = ir.warnings;
  const top = (n: string) => nodes.find((x) => x.name === n);
  const objectsNode = top('Objects');
  if (!objectsNode) throw new Error('The FBX file has no Objects section');
  if (version < 7100) W.push(`FBX version ${version} is old; some data may be missing`);

  // ------------------------------------------------------------ global settings
  const gs = props70(top('GlobalSettings'));
  const gnum = (k: string, d: number) => toNum(gs.get(k)?.[0], d);
  const upAxis = gnum('UpAxis', 1),
    upSign = gnum('UpAxisSign', 1),
    frontAxis = gnum('FrontAxis', 2),
    frontSign = gnum('FrontAxisSign', 1),
    coordAxis = gnum('CoordAxis', 0),
    coordSign = gnum('CoordAxisSign', 1);
  const vec = (i: number, s: number) => [i === 0 ? s : 0, i === 1 ? s : 0, i === 2 ? s : 0];
  const up = vec(upAxis, upSign),
    front = vec(frontAxis, frontSign),
    coord = vec(coordAxis, coordSign);
  // rows: doc X = coord, doc Y = −front, doc Z = up
  let axis = [...coord, ...front.map((v) => -v), ...up];
  const det = axis[0] * (axis[4] * axis[8] - axis[5] * axis[7]) - axis[1] * (axis[3] * axis[8] - axis[5] * axis[6]) + axis[2] * (axis[3] * axis[7] - axis[4] * axis[6]);
  if (Math.abs(det) < 0.5) axis = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  else if (det < 0) {
    W.push('The FBX axis system is left-handed; the X axis was mirrored');
    axis = [-axis[0], -axis[1], -axis[2], ...axis.slice(3)];
  }
  ir.axis = axis;
  ir.unitScale = gnum('UnitScaleFactor', 1) / 100;
  ir.unitScaleMode = 'ROOT';
  const timeMode = gnum('TimeMode', 0);
  const fps = opts.fps ?? (timeMode === 14 ? gnum('CustomFrameRate', 24) : (FPS[timeMode] ?? 24));
  ir.fps = fps;

  // ------------------------------------------------------------ objects + connections
  const objs = new Map<string, Obj>();
  for (const n of objectsNode.children) {
    const id = idOf(n.props[0]);
    const full = String(n.props[1] ?? '');
    const nm = full.includes('\u0000\u0001') ? full.split('\u0000\u0001')[0] : full.replace(/^\w+::/, '');
    objs.set(id, { id, node: n, type: n.name, name: nm, sub: String(n.props[2] ?? '') });
  }
  // children: parent id → list of {child, prop}
  const kids = new Map<string, { id: string; prop: string }[]>();
  const parents = new Map<string, { id: string; prop: string }[]>();
  for (const c of top('Connections')?.children ?? []) {
    if (c.name !== 'C' && c.name !== 'Connect') continue;
    const kind = String(c.props[0]);
    const a = idOf(c.props[1]),
      b = idOf(c.props[2]);
    const prop = kind === 'OP' || kind === 'PO' ? String(c.props[3] ?? '') : '';
    if (!kids.has(b)) kids.set(b, []);
    kids.get(b)!.push({ id: a, prop });
    if (!parents.has(a)) parents.set(a, []);
    parents.get(a)!.push({ id: b, prop });
  }
  const childObjs = (id: string, type?: string, sub?: string) =>
    (kids.get(id) ?? []).map((k) => ({ o: objs.get(k.id), prop: k.prop })).filter((x): x is { o: Obj; prop: string } => !!x.o && (!type || x.o.type === type) && (!sub || x.o.sub === sub));
  const parentObjs = (id: string, type?: string) => (parents.get(id) ?? []).map((k) => ({ o: objs.get(k.id), prop: k.prop, id: k.id })).filter((x) => (type ? x.o?.type === type : true));

  // ------------------------------------------------------------ images / textures
  const resources = new Map<string, Uint8Array>();
  for (const [k, v] of opts.resources ?? []) resources.set(baseName(k).toLowerCase(), v);
  const imageOfVideo = new Map<string, number>();
  const imageForFile = new Map<string, number>();
  const imageFor = (tex: Obj): number | null => {
    const video = childObjs(tex.id, 'Video')[0]?.o;
    if (video && imageOfVideo.has(video.id)) return imageOfVideo.get(video.id)!;
    let bytes: Uint8Array | null = null;
    const file = String(
      child(video?.node, 'RelativeFilename')?.props[0] ?? child(video?.node, 'Filename')?.props[0] ?? child(tex.node, 'RelativeFilename')?.props[0] ?? child(tex.node, 'FileName')?.props[0] ?? '',
    );
    const content = child(video?.node, 'Content')?.props[0];
    if (content instanceof Uint8Array && content.length) bytes = content;
    else if (typeof content === 'string' && content.length) bytes = base64(content);
    if (!bytes && file) bytes = resources.get(baseName(file).toLowerCase()) ?? null;
    const key = file ? baseName(file).toLowerCase() : `video:${video?.id ?? tex.id}`;
    if (!video && imageForFile.has(key)) return imageForFile.get(key)!;
    const idx = ir.images.length;
    ir.images.push({ name: file ? stripExt(baseName(file)) : video?.name || tex.name || 'Texture', mime: bytes ? sniffMime(bytes, file) : '', bytes, uri: file || undefined });
    if (video) imageOfVideo.set(video.id, idx);
    imageForFile.set(key, idx);
    return idx;
  };
  const texRef = (tex: Obj, channel?: IRTexRef['channel']): IRTexRef | undefined => {
    const img = imageFor(tex);
    if (img === null) return undefined;
    const p = props70(tex.node);
    const t = numArray(p.get('Translation') as FbxValue).length ? (p.get('Translation') as number[]) : [0, 0, 0];
    const s = p.get('Scaling') ? (p.get('Scaling') as number[]) : [1, 1, 1];
    const ref: IRTexRef = { image: img, channel };
    if (toNum(t[0]) || toNum(t[1])) ref.offset = [toNum(t[0]), toNum(t[1])];
    if (toNum(s[0], 1) !== 1 || toNum(s[1], 1) !== 1) ref.scale = [toNum(s[0], 1), toNum(s[1], 1)];
    const wrapU = toNum(p.get('WrapModeU')?.[0], 0);
    if (wrapU === 1) ref.extension = 'EXTEND';
    return ref;
  };

  // ------------------------------------------------------------ materials
  const materialIndex = new Map<string, number>();
  const materialFor = (mo: Obj): number => {
    if (materialIndex.has(mo.id)) return materialIndex.get(mo.id)!;
    const p = props70(mo.node);
    const col = (k: string, d: number[]) => {
      const v = p.get(k);
      return v && v.length >= 3 ? [toNum(v[0]), toNum(v[1]), toNum(v[2])] : d;
    };
    const num = (k: string, d: number) => toNum(p.get(k)?.[0], d);
    const diffuse = col('DiffuseColor', col('Diffuse', [0.8, 0.8, 0.8]));
    const df = num('DiffuseFactor', 1);
    let alpha = p.has('Opacity') ? num('Opacity', 1) : 1 - num('TransparencyFactor', 0) * (p.has('TransparentColor') ? Math.max(...col('TransparentColor', [1, 1, 1])) : 1);
    if (!(alpha >= 0 && alpha <= 1)) alpha = 1;
    const shin = num('ShininessExponent', num('Shininess', 20));
    const mat: IRMaterial = {
      name: mo.name || 'Material',
      baseColor: [diffuse[0] * df, diffuse[1] * df, diffuse[2] * df, alpha],
      metallic: Math.min(1, Math.max(0, num('ReflectionFactor', 0))),
      roughness: Math.min(1, Math.max(0, 1 - Math.sqrt(Math.max(0, shin) / 100))),
    };
    const ef = num('EmissiveFactor', 1);
    const ec = col('EmissiveColor', col('Emissive', [0, 0, 0]));
    if (ef > 0 && (ec[0] || ec[1] || ec[2])) {
      mat.emissive = [ec[0], ec[1], ec[2]];
      mat.emissiveStrength = ef;
    }
    for (const { o, prop } of childObjs(mo.id, 'Texture')) {
      const pr = prop.toLowerCase();
      if (pr === 'diffusecolor' || pr === 'diffuse' || pr === 'maya|basecolor' || pr === '3dsmax|parameters|base_color_map') {
        mat.baseColorTex = texRef(o);
        mat.baseColor = [df, df, df, alpha];
      } else if (pr === 'normalmap' || pr === 'maya|normalcamera') {
        const r = texRef(o);
        if (r) mat.normalTex = { ...r, strength: num('BumpFactor', 1) || 1 };
      } else if (pr === 'bump') {
        const r = texRef(o);
        if (r) mat.bumpTex = { ...r, strength: num('BumpFactor', 1) || 1 };
      } else if (pr === 'emissivecolor' || pr === 'emissive') {
        mat.emissiveTex = texRef(o);
        mat.emissive ??= [1, 1, 1];
        mat.emissiveStrength ??= ef || 1;
      } else if (pr === 'transparentcolor' || pr === 'transparencyfactor') mat.alphaTex = texRef(o, 'R');
      else if (pr === 'reflectionfactor') mat.metallicTex = texRef(o, 'R');
      else if (pr === 'shininessexponent') W.push(`Material "${mat.name}": a shininess texture was ignored (it is not a roughness map)`);
      else W.push(`Material "${mat.name}": texture on "${prop}" is not supported`);
    }
    if (alpha < 1 || mat.alphaTex) mat.alphaMode = 'BLEND';
    const idx = ir.materials.length;
    ir.materials.push(mat);
    materialIndex.set(mo.id, idx);
    return idx;
  };

  // ------------------------------------------------------------ models → nodes
  const models = [...objs.values()].filter((o) => o.type === 'Model');
  const nodeIndex = new Map<string, number>();
  models.forEach((m) => {
    nodeIndex.set(m.id, ir.nodes.length);
    ir.nodes.push({ name: m.name || 'Node', parent: -1, matrix: [] });
  });
  const modelParent = (m: Obj) => parentObjs(m.id, 'Model').find((p) => p.o)?.o;
  // transform stack per model
  interface Xf {
    T: number[];
    R: number[];
    S: number[];
    order: Euler['order'];
    pre: Matrix4;
    postInv: Matrix4;
    Roff: number[];
    Rp: number[];
    Soff: number[];
    Sp: number[];
    inherit: number;
    geo: Matrix4 | null;
  }
  const xf = new Map<string, Xf>();
  const v3 = (p: Map<string, FbxValue[]>, k: string, d: number[]) => {
    const v = p.get(k);
    return v && v.length >= 3 ? [toNum(v[0]), toNum(v[1]), toNum(v[2])] : d;
  };
  const eulerMat = (deg: number[], order: Euler['order'] = 'ZYX') => new Matrix4().makeRotationFromEuler(new Euler(deg[0] * D2R, deg[1] * D2R, deg[2] * D2R, order));
  const localOf = (x: Xf, T = x.T, R = x.R, S = x.S): Matrix4 => {
    // L = T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹
    const tr = (v: number[]) => new Matrix4().makeTranslation(v[0], v[1], v[2]);
    const m = tr(T)
      .multiply(tr(x.Roff))
      .multiply(tr(x.Rp))
      .multiply(x.pre)
      .multiply(eulerMat(R, x.order))
      .multiply(x.postInv)
      .multiply(tr(x.Rp.map((v) => -v)));
    m.multiply(tr(x.Soff))
      .multiply(tr(x.Sp))
      .multiply(new Matrix4().makeScale(S[0], S[1], S[2]))
      .multiply(tr(x.Sp.map((v) => -v)));
    return m;
  };
  let warnedInherit = false;
  for (const m of models) {
    const p = props70(m.node);
    const order = ROT_ORDERS[toNum(p.get('RotationOrder')?.[0], 0)] ?? 'ZYX';
    const x: Xf = {
      T: v3(p, 'Lcl Translation', [0, 0, 0]),
      R: v3(p, 'Lcl Rotation', [0, 0, 0]),
      S: v3(p, 'Lcl Scaling', [1, 1, 1]),
      order,
      pre: eulerMat(v3(p, 'PreRotation', [0, 0, 0])),
      postInv: eulerMat(v3(p, 'PostRotation', [0, 0, 0])).invert(),
      Roff: v3(p, 'RotationOffset', [0, 0, 0]),
      Rp: v3(p, 'RotationPivot', [0, 0, 0]),
      Soff: v3(p, 'ScalingOffset', [0, 0, 0]),
      Sp: v3(p, 'ScalingPivot', [0, 0, 0]),
      inherit: toNum(p.get('InheritType')?.[0], 1),
      geo: null,
    };
    const gt = v3(p, 'GeometricTranslation', [0, 0, 0]),
      gr = v3(p, 'GeometricRotation', [0, 0, 0]),
      gsc = v3(p, 'GeometricScaling', [1, 1, 1]);
    if (gt.some((v) => v) || gr.some((v) => v) || gsc.some((v) => v !== 1))
      x.geo = new Matrix4()
        .makeTranslation(gt[0], gt[1], gt[2])
        .multiply(eulerMat(gr))
        .multiply(new Matrix4().makeScale(gsc[0], gsc[1], gsc[2]));
    if (x.inherit !== 1 && !warnedInherit) {
      warnedInherit = true;
      if (x.inherit === 0 || x.inherit === 2) W.push('Some FBX nodes use a non-standard scale inheritance; scaling may differ');
    }
    xf.set(m.id, x);
    const n = ir.nodes[nodeIndex.get(m.id)!];
    n.matrix = localOf(x).toArray();
    const par = modelParent(m);
    n.parent = par ? (nodeIndex.get(par.id) ?? -1) : -1;
    if (m.sub === 'LimbNode' || m.sub === 'Limb' || m.sub === 'Root' || childObjs(m.id, 'NodeAttribute').some((a) => a.o.sub === 'LimbNode' || a.o.sub === 'Root')) n.isBone = true;
    if (toNum(p.get('Visibility')?.[0], 1) === 0) n.hidden = true;
    // cameras / lights
    const attr = childObjs(m.id, 'NodeAttribute')[0]?.o;
    if (attr?.sub === 'Camera' || m.sub === 'Camera') {
      const ap = props70(attr?.node);
      const n2 = (k: string, d: number) => toNum(ap.get(k)?.[0], d);
      const fw = n2('FilmWidth', 1.417) * 25.4,
        fh = n2('FilmHeight', 0.945) * 25.4;
      const ortho = n2('CameraProjectionType', 0) === 1;
      n.camera = {
        type: ortho ? 'ORTHO' : 'PERSP',
        lens: n2('FocalLength', 35),
        sensorWidth: fw,
        sensorHeight: fh,
        sensorFit: 'AUTO',
        orthoScale: ortho ? n2('OrthoZoom', 1) * (n2('OrthoZoom', 1) < 0.01 ? 100 : 1) : undefined,
        clipStart: n2('NearPlane', 10),
        clipEnd: n2('FarPlane', 100000),
        scaleClip: true,
      };
      n.attachCorrection = new Matrix4().makeRotationY(-Math.PI / 2).toArray();
    } else if (attr?.sub === 'Light' || m.sub === 'Light') {
      const ap = props70(attr?.node);
      const n2 = (k: string, d: number) => toNum(ap.get(k)?.[0], d);
      const type = n2('LightType', 0);
      const c = ap.get('Color');
      const color: [number, number, number] = c && c.length >= 3 ? [toNum(c[0], 1), toNum(c[1], 1), toNum(c[2], 1)] : [1, 1, 1];
      const outer = n2('OuterAngle', n2('Cone angle', 45)) * D2R,
        inner = n2('InnerAngle', n2('HotSpot', outer / D2R)) * D2R;
      n.light = {
        type: type === 1 ? 'SUN' : type === 2 ? 'SPOT' : type === 3 ? 'AREA' : 'POINT',
        color,
        energy: n2('Intensity', 100) / 100,
        spotSize: outer,
        spotBlend: outer > 0 ? Math.max(0, 1 - inner / outer) : 0,
        castShadow: n2('CastShadows', 1) !== 0,
      };
      n.attachCorrection = new Matrix4().makeRotationX(-Math.PI / 2).toArray();
    }
  }

  // ------------------------------------------------------------ geometry
  const meshFor = new Map<string, number>(); // geometry id + model geo key → IR mesh
  for (const m of models) {
    const geoObj = childObjs(m.id, 'Geometry').find((g) => g.o.sub === 'Mesh')?.o;
    if (!geoObj) {
      if (childObjs(m.id, 'Geometry').length) W.push(`"${m.name}": NURBS/patch geometry is not supported`);
      continue;
    }
    const x = xf.get(m.id)!;
    const key = `${geoObj.id}|${x.geo ? x.geo.elements.join(',') : ''}`;
    let mi = meshFor.get(key);
    if (mi === undefined) {
      const mesh = readGeometry(geoObj, x.geo);
      if (!mesh) continue;
      mi = ir.meshes.length;
      ir.meshes.push(mesh);
      meshFor.set(key, mi);
      // blend shapes
      const shapes: { name: string; positions: Float32Array; weight: number; channel: string }[] = [];
      for (const { o: bs } of childObjs(geoObj.id, 'Deformer', 'BlendShape'))
        for (const { o: ch } of childObjs(bs.id, 'Deformer', 'BlendShapeChannel')) {
          const shape = childObjs(ch.id, 'Geometry', 'Shape')[0]?.o;
          if (!shape) continue;
          const idx = numArray(child(shape.node, 'Indexes')?.props[0]);
          const d = numArray(child(shape.node, 'Vertices')?.props[0]);
          const pos = new Float32Array(mesh.positions);
          const nv = pos.length / 3;
          const g = x.geo;
          const tmp = new Vector3();
          idx.forEach((vi, k) => {
            if (vi >= nv) return;
            tmp.set(d[k * 3], d[k * 3 + 1], d[k * 3 + 2]);
            if (g) tmp.transformDirection(g).multiplyScalar(new Vector3().setFromMatrixScale(g).x);
            pos[vi * 3] += tmp.x;
            pos[vi * 3 + 1] += tmp.y;
            pos[vi * 3 + 2] += tmp.z;
          });
          shapes.push({ name: ch.name || shape.name, positions: pos, weight: toNum(child(ch.node, 'DeformPercent')?.props[0], 0) / 100, channel: ch.id });
        }
      if (shapes.length) {
        mesh.shapeKeys = shapes.map((s) => ({ name: s.name, positions: s.positions }));
        (mesh as IRMesh & { _channels?: string[]; _weights?: number[] })._channels = shapes.map((s) => s.channel);
        (mesh as IRMesh & { _channels?: string[]; _weights?: number[] })._weights = shapes.map((s) => s.weight);
      }
    }
    const node = ir.nodes[nodeIndex.get(m.id)!];
    node.mesh = mi;
    const mesh = ir.meshes[mi];
    const w = (mesh as IRMesh & { _weights?: number[] })._weights;
    if (w) node.morphWeights = w;
    // material slots from the model's connected materials (in connection order)
    const mats = childObjs(m.id, 'Material').map((x) => materialFor(x.o));
    if (mats.length && !mesh.materials.length) mesh.materials = mats;
    else if (mats.length && mesh.materials.join() !== mats.join()) {
      // same geometry with different materials on another model: duplicate the mesh
      const copy = { ...mesh, materials: mats };
      ir.meshes.push(copy);
      node.mesh = ir.meshes.length - 1;
    }
    const meshObj = ir.meshes[node.mesh!];
    const maxSlot = meshObj.materialIndex ? Math.max(0, ...meshObj.materialIndex) : 0;
    while (meshObj.materials.length && meshObj.materials.length <= maxSlot) meshObj.materials.push(-1);
    // skin
    const skin = childObjs(geoObj.id, 'Deformer', 'Skin')[0]?.o;
    if (skin) {
      const clusters = childObjs(skin.id, 'Deformer', 'Cluster').map((c) => c.o);
      const mat16 = (n: FbxNode | undefined) => {
        const a = numArray(child(n, 'Transform')?.props[0]);
        return a.length === 16 ? new Matrix4().fromArray(a) : null;
      };
      const linkOf = (n: FbxNode | undefined) => {
        const a = numArray(child(n, 'TransformLink')?.props[0]);
        return a.length === 16 ? new Matrix4().fromArray(a) : new Matrix4();
      };
      // Cluster "Transform" maps the mesh node into the bone (TransformLink⁻¹ · MeshGlobal);
      // the mesh's global bind matrix is therefore TransformLink · Transform.
      const first = clusters.find((c) => mat16(c.node));
      const T0 = first ? linkOf(first.node).multiply(mat16(first.node)!) : new Matrix4();
      const T0inv = T0.clone().invert();
      const joints: number[] = [],
        ibm: number[][] = [];
      // skinned vertices are stored in bind (world) space: v_world = Transform · v_local
      const bound = bakeMatrix(meshObj, T0);
      ir.meshes.push(bound);
      node.mesh = ir.meshes.length - 1;
      const nv = bound.positions.length / 3;
      const weights: Float32Array[] = [];
      const names: string[] = [];
      for (const cl of clusters) {
        const bone = childObjs(cl.id, 'Model')[0]?.o;
        if (!bone) continue;
        const ni = nodeIndex.get(bone.id);
        if (ni === undefined) continue;
        const TL = linkOf(cl.node);
        const meshToBone = mat16(cl.node) ?? TL.clone().invert().multiply(T0);
        // IBM maps bind-space (world) vertices into the joint: meshToBone · T0⁻¹
        joints.push(ni);
        ibm.push(meshToBone.clone().multiply(T0inv).toArray());
        const w = new Float32Array(nv);
        const idx = numArray(child(cl.node, 'Indexes')?.props[0]);
        const ws = numArray(child(cl.node, 'Weights')?.props[0]);
        idx.forEach((vi, k) => {
          if (vi < nv) w[vi] += ws[k] ?? 0;
        });
        weights.push(w);
        names.push(bone.name);
        ir.nodes[ni].isBone = true;
      }
      if (joints.length) {
        bound.groups = { names, weights };
        node.skin = ir.skins.length;
        ir.skins.push({ name: modelParentChainName(joints[0]) || skin.name || 'Armature', joints, inverseBind: ibm });
      }
    }
  }
  function bakeMatrix(mesh: IRMesh, m: Matrix4): IRMesh {
    const v = new Vector3();
    const tr = (src: Float32Array) => {
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
        out[i] = v.x;
        out[i + 1] = v.y;
        out[i + 2] = v.z;
      }
      return out;
    };
    const nm = new Matrix4().copy(m).invert().transpose();
    let normals: Float32Array | undefined;
    if (mesh.normals) {
      normals = new Float32Array(mesh.normals.length);
      for (let i = 0; i < normals.length; i += 3) {
        v.set(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]).transformDirection(nm);
        normals[i] = v.x;
        normals[i + 1] = v.y;
        normals[i + 2] = v.z;
      }
    }
    return { ...mesh, positions: tr(mesh.positions), normals, shapeKeys: mesh.shapeKeys?.map((k) => ({ name: k.name, positions: tr(k.positions) })) };
  }
  function modelParentChainName(ni: number) {
    let p = ir.nodes[ni].parent;
    while (p >= 0 && ir.nodes[p].isBone) p = ir.nodes[p].parent;
    return p >= 0 ? ir.nodes[p].name : '';
  }
  // skeletons without skins: give them a pseudo skin so they become armatures
  const skinned = new Set(ir.skins.flatMap((s) => s.joints));
  const worldOf = (i: number): Matrix4 => {
    const m = new Matrix4().fromArray(ir.nodes[i].matrix);
    return ir.nodes[i].parent >= 0 ? worldOf(ir.nodes[i].parent).multiply(m) : m;
  };
  const boneRoots = ir.nodes.map((_, i) => i).filter((i) => ir.nodes[i].isBone && !(ir.nodes[i].parent >= 0 && ir.nodes[ir.nodes[i].parent].isBone));
  for (const r of boneRoots) {
    const chain: number[] = [];
    const walk = (i: number) => {
      chain.push(i);
      ir.nodes.forEach((n, k) => n.parent === i && n.isBone && walk(k));
    };
    walk(r);
    if (chain.some((c) => skinned.has(c))) continue;
    ir.skins.push({ name: modelParentChainName(r) || 'Armature', joints: chain, inverseBind: chain.map((c) => worldOf(c).invert().toArray()) });
  }

  function readGeometry(g: Obj, geo: Matrix4 | null): IRMesh | null {
    const n = g.node;
    const pos = numArray(child(n, 'Vertices')?.props[0]);
    const pvi = numArray(child(n, 'PolygonVertexIndex')?.props[0]);
    if (!pos.length || !pvi.length) return null;
    const faceSizes: number[] = [],
      indices: number[] = [];
    let size = 0;
    for (const raw of pvi) {
      const v = raw < 0 ? ~raw : raw;
      indices.push(v);
      size++;
      if (raw < 0) {
        faceSizes.push(size);
        size = 0;
      }
    }
    if (size) faceSizes.push(size);
    const nc = indices.length,
      nf = faceSizes.length,
      nv = pos.length / 3;
    const cornerFace = new Int32Array(nc);
    for (let f = 0, c = 0; f < nf; f++) for (let k = 0; k < faceSizes[f]; k++) cornerFace[c++] = f;
    // edges array for ByEdge mappings
    const edges = numArray(child(n, 'Edges')?.props[0]);
    const layerData = (le: FbxNode | undefined, dataName: string, indexName: string, comps: number): Float32Array | null => {
      if (!le) return null;
      const mapping = String(child(le, 'MappingInformationType')?.props[0] ?? 'ByPolygonVertex');
      const ref = String(child(le, 'ReferenceInformationType')?.props[0] ?? 'Direct');
      const data = numArray(child(le, dataName)?.props[0]);
      const idx = ref === 'IndexToDirect' || ref === 'Index' ? numArray(child(le, indexName)?.props[0]) : null;
      const out = new Float32Array(nc * comps);
      for (let c = 0; c < nc; c++) {
        let e: number;
        if (mapping === 'ByPolygonVertex') e = c;
        else if (mapping === 'ByVertice' || mapping === 'ByVertex') e = indices[c];
        else if (mapping === 'ByPolygon') e = cornerFace[c];
        else if (mapping === 'AllSame') e = 0;
        else if (mapping === 'ByEdge') e = c;
        else e = c;
        if (idx) e = idx[e] ?? 0;
        for (let k = 0; k < comps; k++) out[c * comps + k] = data[e * comps + k] ?? 0;
      }
      return out;
    };
    const positions = Float32Array.from(pos);
    let normals = layerData(child(n, 'LayerElementNormal'), 'Normals', 'NormalsIndex', 3);
    if (geo) {
      const v = new Vector3();
      for (let i = 0; i < nv; i++) {
        v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(geo);
        positions[i * 3] = v.x;
        positions[i * 3 + 1] = v.y;
        positions[i * 3 + 2] = v.z;
      }
      if (normals) {
        const nm = new Matrix4().copy(geo).invert().transpose();
        for (let i = 0; i < nc; i++) {
          v.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).transformDirection(nm);
          normals[i * 3] = v.x;
          normals[i * 3 + 1] = v.y;
          normals[i * 3 + 2] = v.z;
        }
      }
    }
    const uvLayer = child(n, 'LayerElementUV');
    const uvs = layerData(uvLayer, 'UV', 'UVIndex', 2);
    if (childrenNamed(n, 'LayerElementUV').length > 1) W.push(`"${g.name}": only the first UV map was imported`);
    const colLayer = child(n, 'LayerElementColor');
    const cols = layerData(colLayer, 'Colors', 'ColorIndex', 4);
    // materials per polygon
    const matLe = child(n, 'LayerElementMaterial');
    let materialIndex: Uint16Array | undefined;
    if (matLe) {
      const mapping = String(child(matLe, 'MappingInformationType')?.props[0] ?? 'AllSame');
      const m = numArray(child(matLe, 'Materials')?.props[0]);
      materialIndex = new Uint16Array(nf);
      for (let f = 0; f < nf; f++) materialIndex[f] = Math.max(0, mapping === 'AllSame' ? (m[0] ?? 0) : (m[f] ?? 0));
    }
    // smoothing
    let smooth: Uint8Array | undefined;
    const sm = child(n, 'LayerElementSmoothing');
    if (sm) {
      const mapping = String(child(sm, 'MappingInformationType')?.props[0] ?? '');
      const data = numArray(child(sm, 'Smoothing')?.props[0]);
      if (mapping === 'ByPolygon' && data.length >= nf) smooth = Uint8Array.from(data.slice(0, nf), (v) => (v ? 1 : 0));
      else if (mapping === 'ByEdge' && edges.length && !normals) {
        // a face is smooth when any of its edges is smooth
        smooth = new Uint8Array(nf);
        edges.forEach((c, e) => {
          if (data[e] && c < nc) smooth![cornerFace[c]] = 1;
        });
      }
    }
    if (geo && geo.determinant() < 0) W.push(`"${g.name}": mirrored geometric transform`);
    return {
      name: g.name || 'Mesh',
      positions,
      faceSizes: Uint32Array.from(faceSizes),
      indices: Uint32Array.from(indices),
      uvs: uvs ?? undefined,
      uvName: uvLayer ? String(child(uvLayer, 'Name')?.props[0] || 'UVMap') : undefined,
      normals: normals ?? undefined,
      smooth: smooth && !normals ? smooth : smooth && normals ? smooth : undefined,
      materialIndex,
      materials: [],
      colors: cols ? [{ name: String(child(colLayer, 'Name')?.props[0] || 'Color'), domain: 'CORNER', data: cols }] : undefined,
    };
  }

  // ------------------------------------------------------------ animation
  const stacks = [...objs.values()].filter((o) => o.type === 'AnimationStack');
  const curveOf = (o: Obj) => {
    const n = o.node;
    const times = numArray(child(n, 'KeyTime')?.props[0]).map((t) => t / KTIME);
    const values = numArray(child(n, 'KeyValueFloat')?.props[0] ?? child(n, 'KeyValueDouble')?.props[0]);
    const flags = numArray(child(n, 'KeyAttrFlags')?.props[0]);
    const data = numArray(child(n, 'KeyAttrDataFloat')?.props[0]);
    const refs = numArray(child(n, 'KeyAttrRefCount')?.props[0]);
    // expand per-key attribute (flags and slope data are run-length encoded)
    const keyFlag: number[] = [],
      keySlope: [number, number][] = [];
    let k = 0;
    refs.forEach((count, a) => {
      for (let j = 0; j < count; j++, k++) {
        keyFlag[k] = flags[a] ?? 4;
        keySlope[k] = [data[a * 4] ?? 0, data[a * 4 + 1] ?? 0];
      }
    });
    return { times, values, keyFlag, keySlope };
  };
  type Curve = ReturnType<typeof curveOf>;
  const evalCurve = (c: Curve, t: number, def: number) => {
    const n = c.times.length;
    if (!n) return def;
    if (t <= c.times[0]) return c.values[0];
    if (t >= c.times[n - 1]) return c.values[n - 1];
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c.times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const t0 = c.times[lo],
      t1 = c.times[lo + 1],
      v0 = c.values[lo],
      v1 = c.values[lo + 1];
    const u = (t - t0) / (t1 - t0 || 1);
    const flag = c.keyFlag[lo] ?? 4;
    if (flag & 0x02) return v0; // constant
    if (flag & 0x08) {
      // cubic: Hermite with stored slopes (per second)
      const dt = t1 - t0;
      const m0 = (c.keySlope[lo]?.[0] ?? 0) * dt,
        m1 = (c.keySlope[lo]?.[1] ?? 0) * dt;
      const u2 = u * u,
        u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1;
    }
    return v0 + (v1 - v0) * u;
  };
  for (const st of stacks) {
    const layers = childObjs(st.id, 'AnimationLayer').map((l) => l.o);
    if (layers.length > 1) W.push(`Animation "${st.name}": only the first of ${layers.length} animation layers was imported`);
    const layer = layers[0];
    if (!layer) continue;
    // node id → property → axis curves
    const props = new Map<string, Map<string, Map<string, Curve>>>();
    for (const { o: cn } of childObjs(layer.id, 'AnimationCurveNode')) {
      for (const tgt of parentObjs(cn.id)) {
        if (!tgt.o || !tgt.prop) continue;
        if (!props.has(tgt.id)) props.set(tgt.id, new Map());
        const pm = props.get(tgt.id)!;
        if (!pm.has(tgt.prop)) pm.set(tgt.prop, new Map());
        for (const { o: cv, prop } of childObjs(cn.id, 'AnimationCurve')) pm.get(tgt.prop)!.set(prop, curveOf(cv));
      }
    }
    const channels: IRChannel[] = [];
    let tmin = Infinity,
      tmax = -Infinity;
    for (const pm of props.values())
      for (const axes of pm.values())
        for (const c of axes.values())
          if (c.times.length) {
            tmin = Math.min(tmin, c.times[0]);
            tmax = Math.max(tmax, c.times[c.times.length - 1]);
          }
    if (!Number.isFinite(tmin)) continue;
    const sampleTimes: number[] = [];
    for (let t = tmin; t <= tmax + 1e-9; t += 1 / fps) sampleTimes.push(Math.min(t, tmax));
    if (sampleTimes.length < 2) sampleTimes.push(tmax);
    // FBX time 0 is frame 1 (exporters write the first frame at t = 0)
    const shift = 1 / fps;
    for (const [id, pm] of props) {
      const o = objs.get(id);
      if (!o) continue;
      if (o.type === 'Model') {
        const ni = nodeIndex.get(id);
        const x = xf.get(id);
        if (ni === undefined || !x) continue;
        const get = (prop: string, base: number[]) => {
          const axes = pm.get(prop);
          return (t: number) => (axes ? ['d|X', 'd|Y', 'd|Z'].map((a, k) => (axes.get(a) ? evalCurve(axes.get(a)!, t, base[k]) : base[k])) : base);
        };
        const T = get('Lcl Translation', x.T),
          R = get('Lcl Rotation', x.R),
          S = get('Lcl Scaling', x.S);
        if (!pm.has('Lcl Translation') && !pm.has('Lcl Rotation') && !pm.has('Lcl Scaling')) continue;
        const values: number[] = [];
        for (const t of sampleTimes) values.push(...localOf(x, T(t), R(t), S(t)).elements);
        channels.push({ node: ni, path: 'matrix', times: sampleTimes.map((t) => t + shift), values, interpolation: 'LINEAR' });
      } else if (o.type === 'Deformer' && o.sub === 'BlendShapeChannel') {
        const c = pm.get('DeformPercent')?.get('d|DeformPercent') ?? [...(pm.get('DeformPercent')?.values() ?? [])][0];
        if (!c) continue;
        // find the mesh node(s) using this channel
        ir.meshes.forEach((mesh, mi) => {
          const chans = (mesh as IRMesh & { _channels?: string[] })._channels;
          const k = chans?.indexOf(id) ?? -1;
          if (k < 0) return;
          ir.nodes.forEach((n, ni) => {
            if (n.mesh !== mi) return;
            let ch = channels.find((x) => x.node === ni && x.path === 'weights');
            if (!ch) {
              const nk = chans!.length;
              const base = (mesh as IRMesh & { _weights?: number[] })._weights ?? new Array(nk).fill(0);
              ch = { node: ni, path: 'weights', times: sampleTimes.map((t) => t + shift), values: sampleTimes.flatMap(() => base), interpolation: 'LINEAR' };
              channels.push(ch);
            }
            const nk = chans!.length;
            sampleTimes.forEach((t, si) => ((ch!.values as number[])[si * nk + k] = evalCurve(c, t, 0) / 100));
          });
        });
      }
    }
    if (channels.length) ir.animations.push({ name: st.name || 'Take', channels });
  }
  for (const mesh of ir.meshes) {
    delete (mesh as IRMesh & { _channels?: string[] })._channels;
    delete (mesh as IRMesh & { _weights?: number[] })._weights;
  }
  return ir;
}

const FPS: Record<number, number> = { 0: 24, 1: 120, 2: 100, 3: 60, 4: 50, 5: 48, 6: 30, 7: 30, 8: 29.97, 9: 29.97, 10: 25, 11: 24, 12: 1000, 13: 23.976, 15: 96, 16: 72, 17: 59.94 };

function base64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
