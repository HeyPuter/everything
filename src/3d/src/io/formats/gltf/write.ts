// glTF 2.0 writer (.glb / .gltf with embedded data URIs) from an ExportScene.
// Implemented from the Khronos glTF 2.0 specification. Z-up → Y-up.
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { ImageData } from '../../../data/types';
import { triangulatePoly } from '../../../mesh/mesh';
import type { ExportMaterial, ExportTexRef } from '../material-nodes';
import type { ExportMesh, ExportObject, ExportScene } from '../scene-builder';
import { bytesToBase64, decompose, pointWattsToCandela, WATTS_TO_LUMENS } from '../common';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type ImageEncoder = (img: ImageData) => Promise<{ bytes: Uint8Array; mime: string } | null>;

export interface GltfWriteOptions {
  format: 'GLB' | 'GLTF_EMBEDDED';
  /** convert to +Y up (default true) */
  yUp?: boolean;
  /** export custom properties as extras (default true) */
  extras?: boolean;
  /** encoder for generated/painted images and formats glTF cannot carry (browser canvas) */
  encodeImage?: ImageEncoder;
  /** generator string */
  generator?: string;
  /** 'ACTIONS': one glTF animation per action (default); 'SCENE': everything in one animation */
  animationMode?: 'ACTIONS' | 'SCENE';
  /**
   * Combine separate roughness / metallic images into one glTF metallicRoughness texture
   * (G = roughness, B = metallic). Browser-only (decodes through a canvas).
   */
  packMetallicRoughness?: (rough: { img: ImageData; channel: string } | null, metal: { img: ImageData; channel: string } | null) => Promise<Uint8Array | null>;
}

const D_YUP = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1); // doc (x,y,z) → glTF (x, z, -y)

class BinWriter {
  chunks: Uint8Array[] = [];
  length = 0;
  views: Json[] = [];
  add(data: ArrayBufferView, target?: number, stride?: number): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view: Json = { buffer: 0, byteOffset: this.length, byteLength: bytes.length };
    if (target) view.target = target;
    if (stride) view.byteStride = stride;
    this.chunks.push(bytes.slice());
    this.length += bytes.length;
    this.views.push(view);
    return this.views.length - 1;
  }
  concat(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

export async function writeGltf(scene: ExportScene, opts: GltfWriteOptions): Promise<{ bytes: Uint8Array | string; warnings: string[] }> {
  const warnings = [...scene.warnings];
  const D = opts.yUp === false ? new Matrix4() : D_YUP.clone();
  const Dinv = D.clone().invert();
  const bin = new BinWriter();
  const json: Json = {
    asset: { version: '2.0', generator: opts.generator ?? 'Puter 3D glTF exporter' },
    scene: 0,
    scenes: [{ name: scene.doc.scene.name, nodes: [] as number[] }],
    nodes: [] as Json[],
  };
  const used = new Set<string>();
  const accessors: Json[] = [];
  const addAccessor = (data: Float32Array | Uint16Array | Uint32Array | Uint8Array, type: string, componentType: number, target?: number, minmax = false, normalized = false): number => {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type as 'SCALAR']!;
    const view = bin.add(data, target);
    const acc: Json = { bufferView: view, componentType, count: data.length / comps, type };
    if (normalized) acc.normalized = true;
    if (minmax) {
      const min = new Array(comps).fill(Infinity),
        max = new Array(comps).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % comps;
        if (data[i] < min[c]) min[c] = data[i];
        if (data[i] > max[c]) max[c] = data[i];
      }
      acc.min = min.map((v) => (Number.isFinite(v) ? Math.fround(v) : 0));
      acc.max = max.map((v) => (Number.isFinite(v) ? Math.fround(v) : 0));
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // ------------------------------------------------------------ images, textures, materials
  const images: Json[] = [],
    textures: Json[] = [],
    samplers: Json[] = [],
    materials: Json[] = [];
  const imageIndex = new Map<string, number>();
  const samplerIndex = new Map<string, number>();
  const textureIndex = new Map<string, number>();
  const imageFor = async (id: string): Promise<number | null> => {
    if (imageIndex.has(id)) return imageIndex.get(id)!;
    const img = scene.doc.images[id];
    if (!img) return null;
    let bytes = img.bytes,
      mime = img.mime;
    if (!bytes || (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp')) {
      const enc = opts.encodeImage ? await opts.encodeImage(img) : null;
      if (!enc) {
        warnings.push(`Image "${img.name}" could not be encoded and was not exported`);
        imageIndex.set(id, -1);
        return null;
      }
      bytes = enc.bytes;
      mime = enc.mime;
    }
    const im: Json = { name: img.name, mimeType: mime };
    if (mime === 'image/webp') used.add('EXT_texture_webp');
    if (opts.format === 'GLB') im.bufferView = bin.add(bytes);
    else im.uri = `data:${mime};base64,${bytesToBase64(bytes)}`;
    images.push(im);
    imageIndex.set(id, images.length - 1);
    return images.length - 1;
  };
  const textureFor = async (ref: ExportTexRef | undefined): Promise<Json | undefined> => {
    if (!ref) return undefined;
    const im = await imageFor(ref.imageId);
    if (im === null || im < 0) return undefined;
    const wrap = ref.extension === 'EXTEND' || ref.extension === 'CLIP' ? 33071 : ref.extension === 'MIRROR' ? 33648 : 10497;
    const filt = ref.interpolation === 'Closest' ? 9728 : 9729;
    const skey = `${wrap}|${filt}`;
    if (!samplerIndex.has(skey)) {
      samplers.push({ magFilter: filt, minFilter: filt === 9728 ? 9728 : 9987, wrapS: wrap, wrapT: wrap });
      samplerIndex.set(skey, samplers.length - 1);
    }
    const isWebp = images[im].mimeType === 'image/webp';
    const tkey = `${im}|${samplerIndex.get(skey)}`;
    if (!textureIndex.has(tkey)) {
      const tex: Json = { sampler: samplerIndex.get(skey) };
      if (isWebp) tex.extensions = { EXT_texture_webp: { source: im } };
      else tex.source = im;
      textures.push(tex);
      textureIndex.set(tkey, textures.length - 1);
    }
    const info: Json = { index: textureIndex.get(tkey) };
    if (ref.offset || ref.rotation || ref.scale) {
      used.add('KHR_texture_transform');
      info.extensions = { KHR_texture_transform: { ...(ref.offset ? { offset: ref.offset } : {}), ...(ref.rotation ? { rotation: ref.rotation } : {}), ...(ref.scale ? { scale: ref.scale } : {}) } };
    }
    return info;
  };
  const materialIndex = new Map<string, number>();
  for (const [id, m] of scene.materials) {
    materialIndex.set(id, materials.length);
    materials.push(await materialJson(m));
  }
  async function materialJson(m: ExportMaterial): Promise<Json> {
    const pbr: Json = {};
    const bc = m.baseColor;
    if (bc.some((v, i) => v !== 1 || i > 3)) pbr.baseColorFactor = bc.map((v) => clamp01(v));
    const bct = await textureFor(m.baseColorTex);
    if (bct) pbr.baseColorTexture = bct;
    pbr.metallicFactor = clamp01(m.metallic);
    pbr.roughnessFactor = clamp01(m.roughness);
    if (m.metallicTex || m.roughnessTex) {
      const same = m.metallicTex && m.roughnessTex && m.metallicTex.imageId === m.roughnessTex.imageId && m.metallicTex.channel === 'B' && m.roughnessTex.channel === 'G';
      const single = !m.metallicTex ? m.roughnessTex!.channel === 'G' : !m.roughnessTex ? m.metallicTex.channel === 'B' : false;
      if (same || single) {
        const t = await textureFor((m.metallicTex ?? m.roughnessTex)!);
        if (t) pbr.metallicRoughnessTexture = t;
        if (!m.metallicTex) pbr.metallicFactor = clamp01(m.metallic);
        if (!m.roughnessTex) pbr.roughnessFactor = clamp01(m.roughness);
      } else {
        const pick = (r?: ExportTexRef) => (r && scene.doc.images[r.imageId] ? { img: scene.doc.images[r.imageId], channel: r.channel ?? 'R' } : null);
        const packed = opts.packMetallicRoughness ? await opts.packMetallicRoughness(pick(m.roughnessTex), pick(m.metallicTex)) : null;
        if (packed) {
          const im: Json = { name: `${m.name}_metallicRoughness`, mimeType: 'image/png' };
          if (opts.format === 'GLB') im.bufferView = bin.add(packed);
          else im.uri = `data:image/png;base64,${bytesToBase64(packed)}`;
          images.push(im);
          const filt = 9729;
          const skey = `10497|${filt}`;
          if (!samplerIndex.has(skey)) {
            samplers.push({ magFilter: filt, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
            samplerIndex.set(skey, samplers.length - 1);
          }
          textures.push({ sampler: samplerIndex.get(skey), source: images.length - 1 });
          pbr.metallicRoughnessTexture = { index: textures.length - 1 };
          pbr.metallicFactor = m.metallicTex ? 1 : clamp01(m.metallic);
          pbr.roughnessFactor = m.roughnessTex ? 1 : clamp01(m.roughness);
        } else warnings.push(`Material "${m.name}": separate metallic/roughness textures could not be packed into a glTF metallicRoughness texture`);
      }
    }
    const out: Json = { name: m.name, pbrMetallicRoughness: pbr };
    const nt = await textureFor(m.normalTex);
    if (nt) {
      if (m.normalTex!.strength !== undefined && m.normalTex!.strength !== 1) nt.scale = m.normalTex!.strength;
      out.normalTexture = nt;
    }
    if (m.emissive && (m.emissive[0] || m.emissive[1] || m.emissive[2])) {
      const s = m.emissiveStrength ?? 1;
      const peak = Math.max(...m.emissive) * s;
      if (peak > 1) {
        used.add('KHR_materials_emissive_strength');
        out.emissiveFactor = m.emissive.map((v) => (v * s) / peak);
        out.extensions = { ...(out.extensions ?? {}), KHR_materials_emissive_strength: { emissiveStrength: peak } };
      } else out.emissiveFactor = m.emissive.map((v) => clamp01(v * s));
      const et = await textureFor(m.emissiveTex);
      if (et) out.emissiveTexture = et;
    }
    if (m.alphaMode === 'BLEND') out.alphaMode = 'BLEND';
    else if (m.alphaMode === 'MASK') {
      out.alphaMode = 'MASK';
      out.alphaCutoff = m.alphaCutoff ?? 0.5;
    }
    if (m.alphaTex) warnings.push(`Material "${m.name}": a separate alpha texture is not supported by glTF (alpha must come from the base color texture)`);
    if (m.doubleSided) out.doubleSided = true;
    const ext: Json = out.extensions ?? {};
    if (m.transmission) {
      used.add('KHR_materials_transmission');
      ext.KHR_materials_transmission = { transmissionFactor: clamp01(m.transmission) };
      const tt = await textureFor(m.transmissionTex);
      if (tt) ext.KHR_materials_transmission.transmissionTexture = tt;
    }
    if (m.ior !== undefined && Math.abs(m.ior - 1.5) > 1e-6) {
      used.add('KHR_materials_ior');
      ext.KHR_materials_ior = { ior: m.ior };
    }
    if (m.clearcoat) {
      used.add('KHR_materials_clearcoat');
      ext.KHR_materials_clearcoat = { clearcoatFactor: clamp01(m.clearcoat), clearcoatRoughnessFactor: clamp01(m.clearcoatRoughness ?? 0.03) };
    }
    if (m.sheenColor) {
      used.add('KHR_materials_sheen');
      ext.KHR_materials_sheen = { sheenColorFactor: m.sheenColor.map(clamp01), sheenRoughnessFactor: clamp01(m.sheenRoughness ?? 0.5) };
    }
    if (Object.keys(ext).length) out.extensions = ext;
    return out;
  }

  // ------------------------------------------------------------ nodes
  const nodeOf = new Map<ExportObject, number>();
  const jointNodes = new Map<ExportObject, Map<string, number>>();
  const R = (eo: ExportObject | null): Matrix4 => (eo && (eo.type === 'CAMERA' || eo.type === 'LIGHT') ? new Matrix4() : Dinv.clone());
  const Rinv = (eo: ExportObject | null): Matrix4 => R(eo).invert();
  /** glTF local for an object given its document local relative to the parent frame. */
  const gltfLocal = (eo: ExportObject, local: Matrix4): Matrix4 => {
    const p = eo.parent && !eo.parentBone ? eo.parent : null;
    // parent frame: objects use R(parent); bones (joint nodes) are regular nodes; bone children are relative to the joint
    let pre: Matrix4;
    if (eo.parentBone) {
      const b = eo.parent!.armature!.bones.find((x) => x.name === eo.parentBone)!;
      pre = D.clone().multiply(new Matrix4().makeTranslation(0, b.length, 0));
    } else pre = p ? (p.skin ? D.clone().multiply(p.world) : Rinv(p)) : D.clone();
    return pre.multiply(local).multiply(R(eo));
  };
  const lightsExt: Json[] = [];
  const cameras: Json[] = [];
  const meshes: Json[] = [];
  const skins: Json[] = [];
  const meshCache = new Map<string, number>();
  let skinTruncated = 0;
  const res = scene.doc.scene.render;
  const aspect = (res.resolution_x * res.pixel_aspect_x) / (res.resolution_y * res.pixel_aspect_y || 1) || 1;

  const writeNode = (n: Json, m: Matrix4) => {
    const { p, q, s } = decompose(m);
    if (p.lengthSq() > 0) n.translation = [p.x, p.y, p.z].map(fround);
    if (Math.abs(q.w) < 1 - 1e-9) n.rotation = [q.x, q.y, q.z, q.w].map(fround);
    if (Math.abs(s.x - 1) > 1e-7 || Math.abs(s.y - 1) > 1e-7 || Math.abs(s.z - 1) > 1e-7) n.scale = [s.x, s.y, s.z].map(fround);
  };

  const order: ExportObject[] = [];
  const visit = (eo: ExportObject) => {
    order.push(eo);
    for (const c of eo.children) visit(c);
  };
  scene.roots.forEach(visit);

  for (const eo of order) {
    const node: Json = { name: eo.name };
    const idx = json.nodes.length;
    json.nodes.push(node);
    nodeOf.set(eo, idx);
    if (!eo.skin) writeNode(node, gltfLocal(eo, eo.local));
    if (opts.extras !== false && eo.ob.custom && Object.keys(eo.ob.custom).length) node.extras = { ...eo.ob.custom };
    if (eo.camera) {
      const c = eo.camera;
      const cam: Json = { name: c.name, type: c.type === 'ORTHO' ? 'orthographic' : 'perspective' };
      if (c.type === 'ORTHO') {
        const xmag = c.ortho_scale / 2;
        cam.orthographic = { xmag: aspect >= 1 ? xmag : xmag * aspect, ymag: aspect >= 1 ? xmag / aspect : xmag, znear: c.clip_start, zfar: c.clip_end };
      } else {
        let yfov: number;
        const fit = c.sensor_fit === 'AUTO' ? (aspect >= 1 ? 'HORIZONTAL' : 'VERTICAL') : c.sensor_fit;
        const sensor = c.sensor_fit === 'AUTO' ? c.sensor_width : fit === 'HORIZONTAL' ? c.sensor_width : c.sensor_height;
        if (fit === 'HORIZONTAL') yfov = 2 * Math.atan(Math.tan(Math.atan(sensor / 2 / c.lens)) / aspect);
        else yfov = 2 * Math.atan(sensor / 2 / c.lens);
        cam.perspective = { aspectRatio: aspect, yfov, znear: c.clip_start, zfar: c.clip_end };
        if (c.type === 'PANO') warnings.push(`Camera "${c.name}": panoramic cameras are exported as perspective`);
      }
      cameras.push(cam);
      node.camera = cameras.length - 1;
    }
    if (eo.light) {
      const l = eo.light;
      if (l.type === 'AREA') warnings.push(`Light "${l.name}": area lights are not supported by KHR_lights_punctual and were not exported`);
      else {
        const le: Json = { name: l.name, color: l.color.map(clamp01) };
        if (l.type === 'SUN') {
          le.type = 'directional';
          le.intensity = l.energy * WATTS_TO_LUMENS;
        } else {
          le.intensity = pointWattsToCandela(l.energy);
          le.type = l.type === 'SPOT' ? 'spot' : 'point';
          if (l.type === 'SPOT') {
            const outer = Math.min(Math.PI / 2, l.spot_size / 2);
            le.spot = { innerConeAngle: Math.max(0, outer - outer * l.spot_blend), outerConeAngle: outer };
            if (le.spot.innerConeAngle >= outer) le.spot.innerConeAngle = outer * 0.999;
          }
          if (l.use_custom_distance && l.cutoff_distance) le.range = l.cutoff_distance;
        }
        used.add('KHR_lights_punctual');
        lightsExt.push(le);
        node.extensions = { KHR_lights_punctual: { light: lightsExt.length - 1 } };
      }
    }
    if (eo.armature) {
      // joint nodes: one per bone, children of the armature node
      const map = new Map<string, number>();
      jointNodes.set(eo, map);
      for (const b of eo.armature.bones) {
        const jn: Json = { name: b.name };
        const ji = json.nodes.length;
        json.nodes.push(jn);
        map.set(b.name, ji);
        const pose = eo.armature.pose.get(b.name)!;
        const parentPose = b.parent ? eo.armature.pose.get(b.parent)! : null;
        const rel = parentPose ? parentPose.clone().invert().multiply(pose) : pose.clone();
        writeNode(jn, D.clone().multiply(rel).multiply(Dinv));
        const parentNode = b.parent ? json.nodes[map.get(b.parent)!] : node;
        (parentNode.children ??= []).push(ji);
      }
    }
  }
  // hierarchy
  for (const eo of order) {
    const idx = nodeOf.get(eo)!;
    if (eo.skin || !eo.parent) {
      json.scenes[0].nodes.push(idx);
      continue;
    }
    let parentIdx = nodeOf.get(eo.parent)!;
    if (eo.parentBone) parentIdx = jointNodes.get(eo.parent)?.get(eo.parentBone) ?? parentIdx;
    (json.nodes[parentIdx].children ??= []).push(idx);
  }

  // ------------------------------------------------------------ meshes
  for (const eo of order) {
    if (!eo.mesh) continue;
    const node = json.nodes[nodeOf.get(eo)!];
    let skinInfo: SkinInfo | null = null;
    if (eo.skin) {
      const arm = eo.skin;
      const bones = arm.armature!.bones;
      const joints = bones.map((b) => jointNodes.get(arm)!.get(b.name)!);
      const ibm = new Float32Array(bones.length * 16);
      bones.forEach((b, k) => {
        const bind = D.clone().multiply(arm.world).multiply(b.rest).multiply(Dinv).invert();
        ibm.set(bind.elements.map(fround), k * 16);
      });
      skins.push({ name: arm.name, joints, inverseBindMatrices: addAccessor(ibm, 'MAT4', 5126), skeleton: nodeOf.get(arm) });
      node.skin = skins.length - 1;
      skinInfo = { boneNames: bones.map((b) => b.name), meshWorld: eo.world };
    }
    const key = eo.mesh.sourceId && !eo.mesh.modified && !skinInfo ? eo.mesh.sourceId : `obj:${eo.id}`;
    let mi = meshCache.get(key);
    if (mi === undefined) {
      const mj = buildMesh(eo.mesh, skinInfo);
      if (!mj) continue;
      meshes.push(mj);
      mi = meshes.length - 1;
      meshCache.set(key, mi);
    }
    node.mesh = mi;
    if (eo.mesh.shapeKeys.length && eo.mesh.shapeKeys.some((k) => k.value)) node.weights = eo.mesh.shapeKeys.map((k) => k.value);
  }

  interface SkinInfo {
    boneNames: string[];
    meshWorld: Matrix4;
  }

  function buildMesh(m: ExportMesh, skin: SkinInfo | null): Json | null {
    const nf = m.offsets.length - 1;
    // triangulate per material
    const trisByMat = new Map<number, number[]>();
    const tmp: number[] = [];
    for (let f = 0; f < nf; f++) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      if (e - s < 3) continue;
      tmp.length = 0;
      triangulatePoly(m.positions, m.indices.subarray(s, e), tmp, s);
      const mat = m.materialIndex[f] ?? 0;
      if (!trisByMat.has(mat)) trisByMat.set(mat, []);
      const list = trisByMat.get(mat)!;
      for (const c of tmp) list.push(c);
    }
    if (!trisByMat.size) {
      warnings.push(`Mesh "${m.name}" has no faces and was not exported`);
      return null;
    }
    // vertex transform (skinned meshes are baked into world space)
    const posM = new Matrix4().copy(D);
    if (skin) posM.multiply(skin.meshWorld);
    const normalMat = new Matrix3().getNormalMatrix(posM);
    const prims: Json[] = [];
    const color = m.colors[0];
    // skin data per source vertex
    let jointsPerVertex: { j: number[]; w: number[] }[] | null = null;
    let unweighted = 0;
    if (skin) {
      const nv = m.positions.length / 3;
      jointsPerVertex = [];
      const groupToJoint = (m.groups?.names ?? []).map((n) => skin.boneNames.indexOf(n));
      for (let v = 0; v < nv; v++) {
        const list: { j: number; w: number }[] = [];
        m.groups?.weights.forEach((w, g) => {
          const j = groupToJoint[g];
          if (j >= 0 && (w[v] ?? 0) > 0) list.push({ j, w: w[v] });
        });
        list.sort((a, b) => b.w - a.w);
        const top = list.slice(0, 4);
        if (list.length > 4) skinTruncated++;
        let sum = top.reduce((acc, x) => acc + x.w, 0);
        if (!top.length || sum <= 0) {
          top.length = 0;
          top.push({ j: 0, w: 1 });
          sum = 1;
          unweighted++;
        }
        while (top.length < 4) top.push({ j: 0, w: 0 });
        jointsPerVertex.push({ j: top.map((x) => x.j), w: top.map((x) => x.w / sum) });
      }
      if (unweighted) warnings.push(`Mesh "${m.name}": ${unweighted} vertices without bone weights were bound to bone "${skin.boneNames[0]}"`);
    }
    const sortedMats = [...trisByMat.keys()].sort((a, b) => a - b);
    for (const mat of sortedMats) {
      const tris = trisByMat.get(mat)!;
      const map = new Map<string, number>();
      const srcVert: number[] = [],
        srcCorner: number[] = [];
      const indices = new Uint32Array(tris.length);
      for (let i = 0; i < tris.length; i++) {
        const c = tris[i],
          v = m.indices[c];
        let k = `${v}|${q(m.normals[c * 3])},${q(m.normals[c * 3 + 1])},${q(m.normals[c * 3 + 2])}`;
        if (m.uvs) k += `|${m.uvs[c * 2]},${m.uvs[c * 2 + 1]}`;
        if (color) k += `|${color.data[c * 4]},${color.data[c * 4 + 1]},${color.data[c * 4 + 2]},${color.data[c * 4 + 3]}`;
        let id = map.get(k);
        if (id === undefined) {
          id = srcVert.length;
          map.set(k, id);
          srcVert.push(v);
          srcCorner.push(c);
        }
        indices[i] = id;
      }
      const n = srcVert.length;
      const P = new Float32Array(n * 3),
        N = new Float32Array(n * 3);
      const tv = new Vector3();
      for (let i = 0; i < n; i++) {
        const v = srcVert[i],
          c = srcCorner[i];
        tv.set(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]).applyMatrix4(posM);
        P[i * 3] = tv.x;
        P[i * 3 + 1] = tv.y;
        P[i * 3 + 2] = tv.z;
        tv.set(m.normals[c * 3], m.normals[c * 3 + 1], m.normals[c * 3 + 2])
          .applyMatrix3(normalMat)
          .normalize();
        if (!Number.isFinite(tv.x) || tv.lengthSq() < 0.5) tv.set(0, 1, 0);
        N[i * 3] = tv.x;
        N[i * 3 + 1] = tv.y;
        N[i * 3 + 2] = tv.z;
      }
      const attributes: Json = { POSITION: addAccessor(P, 'VEC3', 5126, 34962, true), NORMAL: addAccessor(N, 'VEC3', 5126, 34962) };
      if (m.uvs) {
        const T = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          T[i * 2] = m.uvs[srcCorner[i] * 2];
          T[i * 2 + 1] = 1 - m.uvs[srcCorner[i] * 2 + 1];
        }
        attributes.TEXCOORD_0 = addAccessor(T, 'VEC2', 5126, 34962);
      }
      if (color) {
        const C = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) C[i * 4 + k] = clamp01(color.data[srcCorner[i] * 4 + k]);
        attributes.COLOR_0 = addAccessor(C, 'VEC4', 5126, 34962);
      }
      if (jointsPerVertex) {
        const big = skin!.boneNames.length > 255;
        const J = big ? new Uint16Array(n * 4) : new Uint8Array(n * 4);
        const Wt = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          const jw = jointsPerVertex[srcVert[i]];
          for (let k = 0; k < 4; k++) {
            J[i * 4 + k] = jw.j[k];
            Wt[i * 4 + k] = jw.w[k];
          }
        }
        attributes.JOINTS_0 = addAccessor(J, 'VEC4', big ? 5123 : 5121, 34962);
        attributes.WEIGHTS_0 = addAccessor(Wt, 'VEC4', 5126, 34962);
      }
      const prim: Json = { attributes, mode: 4 };
      const big = n > 65535;
      prim.indices = addAccessor(big ? indices : Uint16Array.from(indices), 'SCALAR', big ? 5125 : 5123, 34963);
      const matId = m.materials[mat];
      if (matId && materialIndex.has(matId)) prim.material = materialIndex.get(matId);
      if (m.shapeKeys.length) {
        prim.targets = m.shapeKeys.map((k) => {
          const d = new Float32Array(n * 3);
          const a = new Vector3(),
            b = new Vector3();
          for (let i = 0; i < n; i++) {
            const v = srcVert[i];
            a.set(k.positions[v * 3], k.positions[v * 3 + 1], k.positions[v * 3 + 2]).applyMatrix4(posM);
            b.set(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]).applyMatrix4(posM);
            d[i * 3] = a.x - b.x;
            d[i * 3 + 1] = a.y - b.y;
            d[i * 3 + 2] = a.z - b.z;
          }
          return { POSITION: addAccessor(d, 'VEC3', 5126, 34962, true) };
        });
      }
      prims.push(prim);
    }
    const mj: Json = { name: m.name, primitives: prims };
    if (m.shapeKeys.length) {
      mj.weights = m.shapeKeys.map((k) => k.value);
      mj.extras = { targetNames: m.shapeKeys.map((k) => k.name) };
    }
    return mj;
  }
  if (skinTruncated) warnings.push(`${skinTruncated} vertices had more than 4 bone influences; the 4 strongest were kept`);

  // ------------------------------------------------------------ animations
  const animations: Json[] = [];
  if (scene.tracks.length) {
    const times = new Float32Array(scene.frames.map((f) => f / scene.fps));
    const input = addAccessor(times, 'SCALAR', 5126, undefined, true);
    const groups = new Map<string, Json>();
    const anim = (name: string) => {
      let a = groups.get(name);
      if (!a) {
        a = { name, channels: [], samplers: [] };
        groups.set(name, a);
        animations.push(a);
      }
      return a;
    };
    const addChannels = (a: Json, node: number, mats: Matrix4[]) => {
      const T = new Float32Array(mats.length * 3),
        Q = new Float32Array(mats.length * 4),
        S = new Float32Array(mats.length * 3);
      let prev: Quaternion | null = null;
      mats.forEach((m, i) => {
        const { p, q: qq, s } = decompose(m);
        if (prev && prev.dot(qq) < 0) qq.set(-qq.x, -qq.y, -qq.z, -qq.w);
        prev = qq.clone();
        T.set([p.x, p.y, p.z], i * 3);
        Q.set([qq.x, qq.y, qq.z, qq.w], i * 4);
        S.set([s.x, s.y, s.z], i * 3);
      });
      const varies = (arr: Float32Array, k: number) => {
        for (let i = k; i < arr.length; i++) if (Math.abs(arr[i] - arr[i % k]) > 1e-6) return true;
        return false;
      };
      for (const [path, arr, k] of [
        ['translation', T, 3],
        ['rotation', Q, 4],
        ['scale', S, 3],
      ] as const) {
        if (!varies(arr, k)) continue;
        a.samplers.push({ input, output: addAccessor(arr, k === 4 ? 'VEC4' : 'VEC3', 5126), interpolation: 'LINEAR' });
        a.channels.push({ sampler: a.samplers.length - 1, target: { node, path } });
      }
    };
    for (const tr of scene.tracks) {
      const eo = tr.object;
      const a = anim(opts.animationMode === 'SCENE' ? scene.doc.scene.name || 'Scene' : tr.name);
      const node = nodeOf.get(eo);
      if (node === undefined) continue;
      if (tr.locals && !eo.skin)
        addChannels(
          a,
          node,
          tr.locals.map((l) => gltfLocal(eo, l)),
        );
      if (tr.locals && eo.skin) warnings.push(`"${eo.name}": object animation of skinned meshes is not exported (glTF ignores their transforms)`);
      for (const [bone, mats] of tr.bones) {
        const jn = jointNodes.get(eo)?.get(bone);
        if (jn !== undefined)
          addChannels(
            a,
            jn,
            mats.map((m) => D.clone().multiply(m).multiply(Dinv)),
          );
      }
      if (tr.shapeKeys && eo.mesh) {
        const w = new Float32Array(tr.shapeKeys.flat());
        a.samplers.push({ input, output: addAccessor(w, 'SCALAR', 5126), interpolation: 'LINEAR' });
        a.channels.push({ sampler: a.samplers.length - 1, target: { node, path: 'weights' } });
      }
    }
    for (const a of [...animations]) if (!a.channels.length) animations.splice(animations.indexOf(a), 1);
  }

  // ------------------------------------------------------------ assemble
  if (json.scenes[0].nodes.length === 0) warnings.push('Nothing was exported');
  if (materials.length) json.materials = materials;
  if (meshes.length) json.meshes = meshes;
  if (cameras.length) json.cameras = cameras;
  if (skins.length) json.skins = skins;
  if (animations.length) json.animations = animations;
  if (images.length) json.images = images;
  if (samplers.length) json.samplers = samplers;
  if (textures.length) json.textures = textures;
  if (lightsExt.length) json.extensions = { KHR_lights_punctual: { lights: lightsExt } };
  if (used.size) json.extensionsUsed = [...used];
  if (used.has('EXT_texture_webp')) json.extensionsRequired = ['EXT_texture_webp'];
  if (accessors.length) json.accessors = accessors;
  const binBytes = bin.concat();
  if (bin.views.length) {
    json.bufferViews = bin.views;
    json.buffers = [{ byteLength: binBytes.length }];
    if (opts.format === 'GLTF_EMBEDDED') json.buffers[0].uri = `data:application/octet-stream;base64,${bytesToBase64(binBytes)}`;
  }
  if (opts.format === 'GLTF_EMBEDDED') return { bytes: JSON.stringify(json, null, 1), warnings: [...new Set(warnings)] };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const hasBin = bin.views.length > 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (hasBin ? 8 + binBytes.length : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (hasBin) {
    const o = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(o, binBytes.length, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    out.set(binBytes, o + 8);
  }
  return { bytes: out, warnings: [...new Set(warnings)] };
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}
function fround(v: number) {
  const r = Math.fround(v);
  return Object.is(r, -0) ? 0 : r;
}
function q(v: number) {
  return Math.round(v * 1e5);
}
