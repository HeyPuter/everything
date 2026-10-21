// USD writer: USDA text layer (+ USDZ package). Independent implementation of the public USD
// schemas: Xform/Mesh/GeomSubset, UsdPreviewSurface materials, Camera, UsdLux lights, UsdSkel
// (armatures, skin weights, blend shapes) and time-sampled transforms.
import { Euler, Matrix4 } from 'three';
import type { ExportMesh, ExportObject, ExportScene } from '../scene-builder';
import type { ExportMaterial, ExportTexRef } from '../material-nodes';
import { decompose, extOfMime } from '../common';
import type { ImageData } from '../../../data/types';
import { writeStoredZip } from './zip';

export interface UsdWriteOptions {
  /** 'Z' (default) or 'Y' (root rotated −90° about X) */
  upAxis?: 'Z' | 'Y';
  /** metersPerUnit written to the stage (positions are scaled by 1/metersPerUnit) */
  metersPerUnit?: number;
  animation?: boolean;
  /** texture path prefix inside the package / next to the layer */
  textureDir?: string;
  encodeImage?: (img: ImageData) => { bytes: Uint8Array; mime: string } | null;
}

export interface UsdOutput {
  usda: string;
  textures: { path: string; bytes: Uint8Array }[];
  warnings: string[];
}

const R2D = 180 / Math.PI;

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(8);
  return Object.is(r, -0) ? '0' : String(r);
}
const tup = (a: ArrayLike<number>) => `(${Array.from(a, fmt).join(', ')})`;
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const matrix = (m: Matrix4) => {
  const e = m.elements;
  return `( ${[0, 4, 8, 12].map((i) => tup([e[i], e[i + 1], e[i + 2], e[i + 3]])).join(', ')} )`;
};

export function usdIdentifier(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!s || /^[0-9]/.test(s)) s = `_${s}`;
  return s;
}

class Names {
  private used = new Set<string>();
  get(name: string) {
    const base = usdIdentifier(name);
    let n = base,
      i = 1;
    while (this.used.has(n)) n = `${base}_${i++}`;
    this.used.add(n);
    return n;
  }
}

class Writer {
  lines: string[] = [];
  depth = 0;
  line(s: string) {
    this.lines.push('    '.repeat(this.depth) + s);
  }
  open(head: string, meta?: string[]) {
    if (meta?.length) {
      this.line(`${head} (`);
      this.depth++;
      for (const m of meta) this.line(m);
      this.depth--;
      this.line(')');
    } else this.line(head);
    this.line('{');
    this.depth++;
  }
  close() {
    this.depth--;
    this.line('}');
  }
}

export function writeUsda(scene: ExportScene, opts: UsdWriteOptions = {}): UsdOutput {
  const warnings = [...scene.warnings];
  const w = new Writer();
  const mpu = opts.metersPerUnit ?? 1;
  const unit = 1 / mpu;
  const texDir = opts.textureDir ?? 'textures';
  const anim = opts.animation !== false && scene.tracks.length > 0 && scene.frames.length > 1;
  const frames = anim ? scene.frames : [];
  const res = scene.doc.scene.render;
  const aspect = (res.resolution_x * res.pixel_aspect_x) / (res.resolution_y * res.pixel_aspect_y || 1) || 1;
  w.lines.push('#usda 1.0', '(');
  w.lines.push('    defaultPrim = "root"');
  w.lines.push('    doc = "Puter 3D USD exporter"');
  w.lines.push(`    metersPerUnit = ${fmt(mpu)}`);
  w.lines.push(`    upAxis = "${opts.upAxis === 'Y' ? 'Y' : 'Z'}"`);
  if (anim) {
    w.lines.push(`    startTimeCode = ${frames[0]}`, `    endTimeCode = ${frames[frames.length - 1]}`, `    timeCodesPerSecond = ${fmt(scene.fps)}`, `    framesPerSecond = ${fmt(scene.fps)}`);
  }
  w.lines.push(')', '');

  const trackOf = new Map(scene.tracks.map((t) => [t.object, t]));
  const textures: UsdOutput['textures'] = [];
  const texPath = new Map<string, string>();
  const textureFile = (imageId: string): string | null => {
    if (texPath.has(imageId)) return texPath.get(imageId)!;
    const img = scene.doc.images[imageId];
    if (!img) return null;
    let bytes = img.bytes,
      mime = img.mime;
    if (!bytes || (mime !== 'image/png' && mime !== 'image/jpeg')) {
      const enc = opts.encodeImage ? opts.encodeImage(img) : null;
      if (!enc) {
        warnings.push(`Image "${img.name}" could not be written (USD supports PNG/JPEG textures)`);
        return null;
      }
      bytes = enc.bytes;
      mime = enc.mime;
    }
    let name = `${usdIdentifier(img.name.replace(/\.(png|jpe?g|webp|bmp)$/i, ''))}${extOfMime(mime)}`;
    while (textures.some((t) => t.path === `${texDir}/${name}`)) name = `_${name}`;
    const path = `${texDir}/${name}`;
    textures.push({ path, bytes });
    texPath.set(imageId, path);
    return path;
  };

  // material prim names
  const matNames = new Names();
  const matPath = new Map<string, string>();
  for (const [id, m] of scene.materials) matPath.set(id, `/root/_materials/${matNames.get(m.name)}`);

  // transform ops
  const xformOps = (m: Matrix4, samples?: Matrix4[]) => {
    const { p, q, s } = decompose(m);
    const e = new Euler().setFromQuaternion(q, 'ZYX');
    const r = [e.x * R2D, e.y * R2D, e.z * R2D];
    w.line(`double3 xformOp:translate = ${tup([p.x * unit, p.y * unit, p.z * unit])}`);
    if (samples)
      timeSampled(
        'double3 xformOp:translate',
        samples.map((x) =>
          decompose(x)
            .p.toArray()
            .map((v) => v * unit),
        ),
        1e-7,
      );
    w.line(`float3 xformOp:rotateXYZ = ${tup(r)}`);
    if (samples) {
      let prev = r;
      const rs = samples.map((x) => {
        const ee = new Euler().setFromQuaternion(decompose(x).q, 'ZYX');
        const v = [ee.x * R2D, ee.y * R2D, ee.z * R2D].map((a, i) => a + Math.round((prev[i] - a) / 360) * 360);
        prev = v;
        return v;
      });
      timeSampled('float3 xformOp:rotateXYZ', rs, 1e-5);
    }
    w.line(`float3 xformOp:scale = ${tup([s.x, s.y, s.z])}`);
    if (samples)
      timeSampled(
        'float3 xformOp:scale',
        samples.map((x) => decompose(x).s.toArray()),
        1e-7,
      );
    w.line('uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"]');
  };
  const timeSampled = (decl: string, values: number[][], eps: number) => {
    if (!values.length || values.every((v) => v.every((x, i) => Math.abs(x - values[0][i]) <= eps))) return;
    w.line(`${decl}.timeSamples = {`);
    w.depth++;
    values.forEach((v, i) => w.line(`${frames[i]}: ${tup(v)},`));
    w.depth--;
    w.line('}');
  };

  // ------------------------------------------------------------ hierarchy
  const rootNames = new Names();
  w.open('def Xform "root"', ['customData = {', '    dictionary puter3d = {', '        bool generated = 1', '    }', '}']);
  if (opts.upAxis === 'Y') {
    w.line('float3 xformOp:rotateXYZ = (-90, 0, 0)');
    w.line('uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]');
  }
  const descendantOf = (eo: ExportObject, anc: ExportObject) => {
    for (let p = eo.parent; p; p = p.parent) if (p === anc) return true;
    return false;
  };
  /** Data name of the object's shape prim (null without one). */
  const shapeDataName = (eo: ExportObject): string | null =>
    eo.mesh ? eo.mesh.name || eo.name : eo.camera ? eo.camera.name || eo.name : eo.light ? eo.light.name || eo.name : eo.armature ? eo.armature.data.name || eo.name : null;
  const writeObject = (eo: ExportObject, names: Names) => {
    const prim = names.get(eo.name);
    const track = trackOf.get(eo);
    const local = eo.parentBone ? eo.parent!.world.clone().invert().multiply(eo.world) : eo.local;
    if (eo.parentBone) warnings.push(`"${eo.name}": bone parenting is exported as a static child of the armature`);
    const isSkelRoot = !!eo.armature || (!!eo.mesh?.shapeKeys.length && !eo.skin);
    w.open(`def ${isSkelRoot ? 'SkelRoot' : 'Xform'} ${quote(prim)}`);
    w.line(`custom string userProperties:name = ${quote(eo.name)}`);
    xformOps(local, anim && track?.locals && !eo.parentBone ? track.locals : undefined);
    // the shape prim is named after its data (mesh, camera, light), like other DCC exporters
    const childNames = new Names();
    const shape = shapeDataName(eo);
    const shapePrim = shape !== null ? childNames.get(shape) : prim;
    if (eo.mesh) writeMesh(eo, eo.mesh, shapePrim);
    if (eo.camera) writeCamera(eo, shapePrim);
    if (eo.light) writeLight(eo, shapePrim);
    if (eo.armature) writeSkeleton(eo, shapePrim);
    for (const c of eo.children) writeObject(c, childNames);
    w.close();
  };

  const writeCamera = (eo: ExportObject, prim: string) => {
    const c = eo.camera!;
    w.open(`def Camera ${quote(prim)}`);
    const fit = c.sensor_fit === 'AUTO' ? (aspect >= 1 ? 'HORIZONTAL' : 'VERTICAL') : c.sensor_fit;
    if (c.type === 'ORTHO') {
      w.line('token projection = "orthographic"');
      const hor = aspect >= 1 ? c.ortho_scale : c.ortho_scale * aspect;
      w.line(`float horizontalAperture = ${fmt(hor)}`);
      w.line(`float verticalAperture = ${fmt(hor / aspect)}`);
    } else {
      w.line('token projection = "perspective"');
      const sensorH = fit === 'VERTICAL' ? (c.sensor_fit === 'AUTO' ? c.sensor_width : c.sensor_height) * aspect : c.sensor_width;
      // focal length and apertures are in tenths of a scene unit
      const k = 1 / (100 * mpu);
      w.line(`float focalLength = ${fmt(c.lens * k)}`);
      w.line(`float horizontalAperture = ${fmt(sensorH * k)}`);
      w.line(`float verticalAperture = ${fmt((sensorH / aspect) * k)}`);
      if (c.shift_x) w.line(`float horizontalApertureOffset = ${fmt(c.shift_x * sensorH * k)}`);
      if (c.shift_y) w.line(`float verticalApertureOffset = ${fmt(c.shift_y * sensorH * k)}`);
      if (c.dof.use_dof) {
        w.line(`float focusDistance = ${fmt(c.dof.focus_distance * unit)}`);
        w.line(`float fStop = ${fmt(c.dof.aperture_fstop)}`);
      }
    }
    w.line(`float2 clippingRange = ${tup([c.clip_start * unit, c.clip_end * unit])}`);
    w.close();
  };

  const writeLight = (eo: ExportObject, prim: string) => {
    const l = eo.light!;
    const color = `color3f inputs:color = ${tup(l.color)}`;
    if (l.type === 'SUN') {
      w.open(`def DistantLight ${quote(prim)}`);
      w.line(color);
      w.line(`float inputs:intensity = ${fmt(l.energy / 4)}`);
      w.line(`float inputs:angle = ${fmt((l.angle * R2D) / 2)}`);
      w.line('bool inputs:normalize = 1');
    } else if (l.type === 'AREA') {
      const disk = l.shape === 'DISK' || l.shape === 'ELLIPSE';
      w.open(`def ${disk ? 'DiskLight' : 'RectLight'} ${quote(prim)}`);
      w.line(color);
      w.line(`float inputs:intensity = ${fmt(l.energy / Math.PI)}`);
      if (disk) w.line(`float inputs:radius = ${fmt((l.size / 2) * unit)}`);
      else {
        w.line(`float inputs:width = ${fmt(l.size * unit)}`);
        w.line(`float inputs:height = ${fmt((l.shape === 'RECTANGLE' ? l.size_y : l.size) * unit)}`);
      }
      w.line('bool inputs:normalize = 1');
    } else {
      w.open(`def SphereLight ${quote(prim)}`, l.type === 'SPOT' ? ['prepend apiSchemas = ["ShapingAPI"]'] : undefined);
      w.line(color);
      w.line(`float inputs:intensity = ${fmt(l.energy / Math.PI)}`);
      w.line(`float inputs:radius = ${fmt(l.shadow_soft_size * unit)}`);
      w.line('bool inputs:normalize = 1');
      if (!l.shadow_soft_size) w.line('bool treatAsPoint = 1');
      if (l.type === 'SPOT') {
        w.line(`float inputs:shaping:cone:angle = ${fmt((l.spot_size * R2D) / 2)}`);
        w.line(`float inputs:shaping:cone:softness = ${fmt(l.spot_blend)}`);
      }
    }
    if (!l.use_shadow) w.line('bool inputs:shadow:enable = 0');
    w.close();
  };

  const writeSkeleton = (eo: ExportObject, prim: string) => {
    const arm = eo.armature!;
    const skelName = prim; // the armature data's name (reserved among the SkelRoot's children)
    const path = new Map<string, string>();
    for (const b of arm.bones) path.set(b.name, b.parent && path.has(b.parent) ? `${path.get(b.parent)}/${usdIdentifier(b.name)}` : usdIdentifier(b.name));
    (eo as ExportObject & { _skelPath?: string })._skelPath = skelName;
    const restLocal = arm.bones.map((b) => {
      const parent = b.parent ? arm.bones.find((x) => x.name === b.parent) : undefined;
      return parent ? parent.rest.clone().invert().multiply(b.rest) : b.rest.clone();
    });
    const scaled = (m: Matrix4) => {
      const c = m.clone();
      c.elements[12] *= unit;
      c.elements[13] *= unit;
      c.elements[14] *= unit;
      return c;
    };
    w.open(`def Skeleton ${quote(skelName)}`, ['prepend apiSchemas = ["SkelBindingAPI"]']);
    w.line(`uniform token[] joints = [${arm.bones.map((b) => quote(path.get(b.name)!)).join(', ')}]`);
    w.line(`uniform matrix4d[] bindTransforms = [${arm.bones.map((b) => matrix(scaled(b.rest))).join(', ')}]`);
    w.line(`uniform matrix4d[] restTransforms = [${restLocal.map((m) => matrix(scaled(m))).join(', ')}]`);
    // bone lengths (USD skeletons have none); importers that know this primvar read it
    w.line(`float[] primvars:blender:bone_lengths = [${arm.bones.map((b) => fmt(b.length * unit)).join(', ')}] (`);
    w.line('    interpolation = "uniform"');
    w.line(')');
    // animation: current pose as defaults, sampled frames as time samples (named after the action)
    const track = trackOf.get(eo);
    const animName = usdIdentifier(track?.name ?? 'Anim');
    w.line(`prepend rel skel:animationSource = </root/${skelPathOf(eo)}/${skelName}/${animName}>`);
    const poseLocal = arm.bones.map((b) => {
      const pose = arm.pose.get(b.name)!;
      const pp = b.parent ? arm.pose.get(b.parent) : undefined;
      return pp ? pp.clone().invert().multiply(pose) : pose.clone();
    });
    w.open(`def SkelAnimation ${quote(animName)}`);
    w.line(`uniform token[] joints = [${arm.bones.map((b) => quote(path.get(b.name)!)).join(', ')}]`);
    const trsOf = (ms: Matrix4[]) => ms.map((m) => decompose(m));
    const writeTRS = (ms: Matrix4[]) => {
      const d = trsOf(ms);
      return {
        t: `[${d.map((x) => tup([x.p.x * unit, x.p.y * unit, x.p.z * unit])).join(', ')}]`,
        r: `[${d.map((x) => tup([x.q.w, x.q.x, x.q.y, x.q.z])).join(', ')}]`,
        s: `[${d.map((x) => tup([x.s.x, x.s.y, x.s.z])).join(', ')}]`,
      };
    };
    const def = writeTRS(poseLocal);
    w.line(`float3[] translations = ${def.t}`);
    w.line(`quatf[] rotations = ${def.r}`);
    w.line(`half3[] scales = ${def.s}`);
    if (anim && track?.bones.size) {
      const per = frames.map((_, fi) => arm.bones.map((b, bi) => track.bones.get(b.name)?.[fi] ?? poseLocal[bi]));
      for (const [key, decl] of [
        ['t', 'float3[] translations'],
        ['r', 'quatf[] rotations'],
        ['s', 'half3[] scales'],
      ] as const) {
        w.line(`${decl}.timeSamples = {`);
        w.depth++;
        per.forEach((ms, fi) => w.line(`${frames[fi]}: ${writeTRS(ms)[key]},`));
        w.depth--;
        w.line('}');
      }
    }
    w.close();
    w.close();
  };
  const skelRootPath = new Map<ExportObject, string>();
  function skelPathOf(eo: ExportObject) {
    return skelRootPath.get(eo) ?? usdIdentifier(eo.name);
  }

  const writeMesh = (eo: ExportObject, m: ExportMesh, prim: string) => {
    const nf = m.offsets.length - 1;
    const counts: number[] = [],
      idx: number[] = [];
    const faces: number[] = [];
    for (let f = 0; f < nf; f++) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      if (e - s < 3) continue;
      faces.push(f);
      counts.push(e - s);
      for (let c = s; c < e; c++) idx.push(m.indices[c]);
    }
    const corners = faces.flatMap((f) => Array.from({ length: m.offsets[f + 1] - m.offsets[f] }, (_, k) => m.offsets[f] + k));
    const skinArm = eo.skin && descendantOf(eo, eo.skin) ? eo.skin : null;
    if (eo.skin && !skinArm) warnings.push(`"${eo.name}": skinned meshes must be inside their armature for USD skinning; exported in rest pose`);
    const schemas = ['MaterialBindingAPI'];
    if (skinArm || m.shapeKeys.length) schemas.push('SkelBindingAPI');
    w.open(`def Mesh ${quote(prim)}`, [`prepend apiSchemas = [${schemas.map(quote).join(', ')}]`]);
    const mats = m.materials.map((id) => (id ? scene.materials.get(id) : undefined));
    w.line(`uniform bool doubleSided = ${mats.some((x) => x && !x.doubleSided) ? 0 : 1}`);
    let min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    const pts: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      const p = [m.positions[i] * unit, m.positions[i + 1] * unit, m.positions[i + 2] * unit];
      pts.push(...p);
      min = min.map((v, k) => Math.min(v, p[k]));
      max = max.map((v, k) => Math.max(v, p[k]));
    }
    if (!Number.isFinite(min[0])) min = max = [0, 0, 0];
    w.line(`float3[] extent = [${tup(min)}, ${tup(max)}]`);
    w.line(`int[] faceVertexCounts = [${counts.join(', ')}]`);
    w.line(`int[] faceVertexIndices = [${idx.join(', ')}]`);
    const usedMats = [...new Set(faces.map((f) => m.materialIndex[f] ?? 0))].filter((s) => m.materials[s] && matPath.has(m.materials[s]!));
    if (usedMats.length === 1) w.line(`rel material:binding = <${matPath.get(m.materials[usedMats[0]]!)}>`);
    w.line(`normal3f[] normals = [${corners.map((c) => tup([m.normals[c * 3], m.normals[c * 3 + 1], m.normals[c * 3 + 2]])).join(', ')}] (`);
    w.line('    interpolation = "faceVarying"');
    w.line(')');
    w.line(`point3f[] points = [${chunk3(pts)}]`);
    if (m.uvs) {
      const map = new Map<string, number>();
      const vals: string[] = [],
        ind: number[] = [];
      for (const c of corners) {
        const k = tup([m.uvs[c * 2], m.uvs[c * 2 + 1]]);
        let i = map.get(k);
        if (i === undefined) {
          i = vals.length;
          map.set(k, i);
          vals.push(k);
        }
        ind.push(i);
      }
      w.line(`texCoord2f[] primvars:st = [${vals.join(', ')}] (`);
      w.line('    interpolation = "faceVarying"');
      w.line(')');
      w.line(`int[] primvars:st:indices = [${ind.join(', ')}]`);
    }
    for (const cl of m.colors) {
      const name = usdIdentifier(cl.name || 'Col');
      w.line(`color3f[] primvars:${name} = [${corners.map((c) => tup([cl.data[c * 4], cl.data[c * 4 + 1], cl.data[c * 4 + 2]])).join(', ')}] (`);
      w.line('    interpolation = "faceVarying"');
      w.line(')');
    }
    // skinning
    if (skinArm) {
      const bones = skinArm.armature!.bones;
      const nv = m.positions.length / 3;
      const groupJoint = (m.groups?.names ?? []).map((n) => bones.findIndex((b) => b.name === n));
      const lists: { j: number; w: number }[][] = [];
      let maxN = 1;
      for (let v = 0; v < nv; v++) {
        const l: { j: number; w: number }[] = [];
        m.groups?.weights.forEach((wt, g) => {
          if (groupJoint[g] >= 0 && wt[v] > 0) l.push({ j: groupJoint[g], w: wt[v] });
        });
        l.sort((a, b) => b.w - a.w);
        lists.push(l.slice(0, 8));
        maxN = Math.max(maxN, Math.min(8, l.length));
      }
      const ji: number[] = [],
        jw: number[] = [];
      for (const l of lists) {
        const sum = l.reduce((a, b) => a + b.w, 0) || 1;
        for (let k = 0; k < maxN; k++) {
          ji.push(l[k]?.j ?? 0);
          jw.push(l[k] ? l[k].w / sum : 0);
        }
      }
      w.line(`matrix4d primvars:skel:geomBindTransform = ${matrix(scaleT(skinArm.world.clone().invert().multiply(eo.world), unit))}`);
      w.line(`int[] primvars:skel:jointIndices = [${ji.join(', ')}] (`);
      w.line(`    elementSize = ${maxN}`);
      w.line('    interpolation = "vertex"');
      w.line(')');
      w.line(`float[] primvars:skel:jointWeights = [${jw.map(fmt).join(', ')}] (`);
      w.line(`    elementSize = ${maxN}`);
      w.line('    interpolation = "vertex"');
      w.line(')');
      const skelPrim = (skinArm as ExportObject & { _skelPath?: string })._skelPath ?? usdIdentifier(skinArm.name);
      w.line(`rel skel:skeleton = <${primPathOf(skinArm)}/${skelPrim}>`);
      if (m.shapeKeys.length) warnings.push(`"${eo.name}": shape keys on skinned meshes are exported without weight animation`);
    } else if (m.shapeKeys.length) {
      const nv = m.positions.length / 3;
      w.line(`int[] primvars:skel:jointIndices = [${new Array(nv).fill(0).join(', ')}] (`);
      w.line('    elementSize = 1');
      w.line('    interpolation = "vertex"');
      w.line(')');
      w.line(`float[] primvars:skel:jointWeights = [${new Array(nv).fill(1).join(', ')}] (`);
      w.line('    elementSize = 1');
      w.line('    interpolation = "vertex"');
      w.line(')');
    }
    const keyNames = new Names();
    const keyPrims = m.shapeKeys.map((k) => keyNames.get(k.name));
    if (m.shapeKeys.length) {
      w.line(`uniform token[] skel:blendShapes = [${keyPrims.map(quote).join(', ')}]`);
      w.line(`rel skel:blendShapeTargets = [${keyPrims.map((k) => `<${primPathOf(eo)}/${prim}/${k}>`).join(', ')}]`);
      if (!skinArm) w.line(`rel skel:skeleton = <${primPathOf(eo)}/Skel>`);
    }
    w.line('uniform token subdivisionScheme = "none"');
    if (usedMats.length > 1) {
      w.line('uniform token subsetFamily:materialBind:familyType = "nonOverlapping"');
      const subNames = new Names();
      for (const slot of usedMats) {
        const mat = scene.materials.get(m.materials[slot]!)!;
        w.open(`def GeomSubset ${quote(subNames.get(mat.name))}`, ['prepend apiSchemas = ["MaterialBindingAPI"]']);
        w.line('uniform token elementType = "face"');
        w.line('uniform token familyName = "materialBind"');
        w.line(
          `int[] indices = [${faces
            .map((f, i) => ((m.materialIndex[f] ?? 0) === slot ? i : -1))
            .filter((i) => i >= 0)
            .join(', ')}]`,
        );
        w.line(`rel material:binding = <${matPath.get(m.materials[slot]!)}>`);
        w.close();
      }
    }
    m.shapeKeys.forEach((k, ki) => {
      w.open(`def BlendShape ${quote(keyPrims[ki])}`);
      const off: number[] = [],
        pi: number[] = [];
      for (let v = 0; v < m.positions.length / 3; v++) {
        const d = [0, 1, 2].map((a) => (k.positions[v * 3 + a] - m.positions[v * 3 + a]) * unit);
        if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-9) {
          off.push(...d);
          pi.push(v);
        }
      }
      w.line(`uniform vector3f[] offsets = [${chunk3(off)}]`);
      w.line(`uniform int[] pointIndices = [${pi.join(', ')}]`);
      w.close();
    });
    w.close();
    // a skeleton carrying blend shape weights for non-skinned meshes
    if (m.shapeKeys.length && !skinArm) {
      w.open('def Skeleton "Skel"', ['prepend apiSchemas = ["SkelBindingAPI"]']);
      w.line('uniform token[] joints = ["joint1"]');
      w.line(`uniform matrix4d[] bindTransforms = [${matrix(new Matrix4())}]`);
      w.line(`uniform matrix4d[] restTransforms = [${matrix(new Matrix4())}]`);
      w.line(`prepend rel skel:animationSource = <${primPathOf(eo)}/Skel/Anim>`);
      w.open('def SkelAnimation "Anim"');
      w.line(`uniform token[] blendShapes = [${keyPrims.map(quote).join(', ')}]`);
      w.line(`float[] blendShapeWeights = [${m.shapeKeys.map((k) => fmt(k.value)).join(', ')}]`);
      const track = trackOf.get(eo);
      if (anim && track?.shapeKeys) {
        w.line('float[] blendShapeWeights.timeSamples = {');
        w.depth++;
        track.shapeKeys.forEach((v, fi) => w.line(`${frames[fi]}: [${v.map(fmt).join(', ')}],`));
        w.depth--;
        w.line('}');
      }
      w.close();
      w.close();
    }
  };

  // prim paths of objects (computed before writing so relationships can reference them)
  const pathOf = new Map<ExportObject, string>();
  const assign = (eo: ExportObject, parentPath: string, names: Names) => {
    const prim = names.get(eo.name);
    const p = `${parentPath}/${prim}`;
    pathOf.set(eo, p);
    skelRootPath.set(eo, p.replace(/^\/root\//, ''));
    const child = new Names();
    const shape = shapeDataName(eo);
    if (shape !== null) child.get(shape);
    for (const c of eo.children) assign(c, p, child);
  };
  const preNames = new Names();
  for (const r of scene.roots) assign(r, '/root', preNames);
  function primPathOf(eo: ExportObject) {
    return pathOf.get(eo) ?? `/root/${usdIdentifier(eo.name)}`;
  }

  for (const r of scene.roots) writeObject(r, rootNames);

  // ------------------------------------------------------------ materials
  if (scene.materials.size) {
    w.line('');
    w.open('def Scope "_materials"');
    for (const [id, m] of scene.materials) writeMaterial(matPath.get(id)!, m);
    w.close();
  }
  w.close();

  function writeMaterial(path: string, m: ExportMaterial) {
    const name = path.split('/').pop()!;
    w.open(`def Material ${quote(name)}`);
    w.line(`token outputs:surface.connect = <${path}/Principled_BSDF.outputs:surface>`);
    w.line(`custom string userProperties:name = ${quote(m.name)}`);
    const tex: { prim: string; ref: ExportTexRef; file: string; raw: boolean }[] = [];
    const texNames = new Names();
    texNames.get('Principled_BSDF');
    texNames.get('uvmap');
    const connectTex = (ref: ExportTexRef | undefined, raw: boolean): string | null => {
      if (!ref) return null;
      const file = textureFile(ref.imageId);
      if (!file) return null;
      const existing = tex.find(
        (t) => t.ref.imageId === ref.imageId && t.raw === raw && JSON.stringify([t.ref.offset, t.ref.scale, t.ref.rotation]) === JSON.stringify([ref.offset, ref.scale, ref.rotation]),
      );
      if (existing) return existing.prim;
      const prim = texNames.get(`${scene.doc.images[ref.imageId]?.name ?? 'Image'}_Texture`);
      tex.push({ prim, ref, file, raw });
      return prim;
    };
    const lines: string[] = [];
    const ch = (r: ExportTexRef) => (r.channel === 'R' ? 'r' : r.channel === 'G' ? 'g' : r.channel === 'B' ? 'b' : r.channel === 'A' ? 'a' : 'rgb');
    const base = connectTex(m.baseColorTex, false);
    if (base) lines.push(`color3f inputs:diffuseColor.connect = <${path}/${base}.outputs:rgb>`);
    else lines.push(`color3f inputs:diffuseColor = ${tup(m.baseColor.slice(0, 3))}`);
    const metal = connectTex(m.metallicTex, true);
    lines.push(metal ? `float inputs:metallic.connect = <${path}/${metal}.outputs:${ch(m.metallicTex!)}>` : `float inputs:metallic = ${fmt(m.metallic)}`);
    const rough = connectTex(m.roughnessTex, true);
    lines.push(rough ? `float inputs:roughness.connect = <${path}/${rough}.outputs:${ch(m.roughnessTex!)}>` : `float inputs:roughness = ${fmt(m.roughness)}`);
    const alphaTex = m.alphaTex ?? (m.alphaMode !== 'OPAQUE' && m.baseColorTex ? { ...m.baseColorTex, channel: 'A' as const } : undefined);
    const op = alphaTex ? connectTex(alphaTex, m.alphaTex ? true : false) : null;
    lines.push(op ? `float inputs:opacity.connect = <${path}/${op}.outputs:${ch(alphaTex!)}>` : `float inputs:opacity = ${fmt(m.baseColor[3])}`);
    if (m.alphaMode === 'MASK') lines.push(`float inputs:opacityThreshold = ${fmt(m.alphaCutoff ?? 0.5)}`);
    lines.push(`float inputs:ior = ${fmt(m.ior ?? 1.5)}`);
    if (m.clearcoat) lines.push(`float inputs:clearcoat = ${fmt(m.clearcoat)}`, `float inputs:clearcoatRoughness = ${fmt(m.clearcoatRoughness ?? 0.03)}`);
    const em = connectTex(m.emissiveTex, false);
    if (em) lines.push(`color3f inputs:emissiveColor.connect = <${path}/${em}.outputs:rgb>`);
    else if (m.emissive) lines.push(`color3f inputs:emissiveColor = ${tup(m.emissive.map((v) => v * (m.emissiveStrength ?? 1)))}`);
    const nrm = connectTex(m.normalTex, true);
    if (nrm) lines.push(`normal3f inputs:normal.connect = <${path}/${nrm}.outputs:rgb>`);
    if (m.normalTex && (m.normalTex.strength ?? 1) !== 1) warnings.push(`Material "${m.name}": normal map strength is not supported by UsdPreviewSurface`);
    if (m.transmission) warnings.push(`Material "${m.name}": transmission is not supported by UsdPreviewSurface`);
    w.open('def Shader "Principled_BSDF"');
    w.line('uniform token info:id = "UsdPreviewSurface"');
    lines.sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]));
    for (const l of lines) w.line(l);
    w.line('token outputs:surface');
    w.close();
    for (const t of tex) {
      w.open(`def Shader ${quote(t.prim)}`);
      w.line('uniform token info:id = "UsdUVTexture"');
      w.line(`asset inputs:file = @./${t.file}@`);
      w.line(`token inputs:sourceColorSpace = "${t.raw ? 'raw' : 'sRGB'}"`);
      const xf = t.ref.offset || t.ref.scale || t.ref.rotation;
      w.line(`float2 inputs:st.connect = <${path}/${xf ? `${t.prim}_transform` : 'uvmap'}.outputs:result>`);
      const wrap = t.ref.extension === 'EXTEND' || t.ref.extension === 'CLIP' ? 'clamp' : t.ref.extension === 'MIRROR' ? 'mirror' : 'repeat';
      w.line(`token inputs:wrapS = "${wrap}"`);
      w.line(`token inputs:wrapT = "${wrap}"`);
      if (t.ref === m.normalTex || (m.normalTex && t.ref.imageId === m.normalTex.imageId && t.raw)) {
        w.line('float4 inputs:scale = (2, 2, 2, 1)');
        w.line('float4 inputs:bias = (-1, -1, -1, 0)');
      }
      w.line('float3 outputs:rgb');
      w.line('float outputs:r');
      w.line('float outputs:g');
      w.line('float outputs:b');
      w.line('float outputs:a');
      w.close();
      if (xf) {
        // UsdTransform2d works on bottom-left UVs like the document
        w.open(`def Shader ${quote(`${t.prim}_transform`)}`);
        w.line('uniform token info:id = "UsdTransform2d"');
        w.line(`float2 inputs:in.connect = <${path}/uvmap.outputs:result>`);
        const off = t.ref.offset ?? [0, 0],
          sc = t.ref.scale ?? [1, 1];
        w.line(`float inputs:rotation = ${fmt(-(t.ref.rotation ?? 0) * R2D)}`);
        w.line(`float2 inputs:scale = ${tup(sc)}`);
        w.line(`float2 inputs:translation = ${tup([off[0], 1 - sc[1] - off[1]])}`);
        w.line('float2 outputs:result');
        w.close();
      }
    }
    if (tex.length) {
      w.open('def Shader "uvmap"');
      w.line('uniform token info:id = "UsdPrimvarReader_float2"');
      w.line('string inputs:varname = "st"');
      w.line('float2 outputs:result');
      w.close();
    }
    w.close();
  }

  return { usda: w.lines.join('\n') + '\n', textures, warnings: [...new Set(warnings)] };
}

function chunk3(a: number[]) {
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 3) out.push(tup([a[i], a[i + 1], a[i + 2]]));
  return out.join(', ');
}

function scaleT(m: Matrix4, unit: number) {
  const c = m.clone();
  c.elements[12] *= unit;
  c.elements[13] *= unit;
  c.elements[14] *= unit;
  return c;
}

/** USDZ package: the root layer first, then textures (stored, 64-byte aligned). */
export function packUsdz(out: UsdOutput, layerName = 'scene.usda'): Uint8Array {
  return writeStoredZip([{ name: layerName, data: new TextEncoder().encode(out.usda) }, ...out.textures.map((t) => ({ name: t.path, data: t.bytes }))]);
}
