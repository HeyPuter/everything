// glTF 2.0 reader (.glb / .gltf with embedded, data-URI or provided external resources) → IR.
// Implemented from the Khronos glTF 2.0 specification.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { emptyScene, Y_UP_TO_Z_UP, type IRChannel, type IRMaterial, type IRMesh, type IRNode, type IRScene, type IRTexRef } from '../ir';
import { baseName, candelaToPointWatts, decodeDataUri, sniffMime, stripExt, WATTS_TO_LUMENS } from '../common';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface GltfReadOptions {
  /** external resources by file name (as referenced by URIs, matched by base name) */
  resources?: Map<string, Uint8Array>;
  /** import shading / merge handled by commit */
}

export const SUPPORTED_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
  'KHR_materials_unlit',
  'KHR_materials_specular',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'EXT_texture_webp',
]);

export function isGlb(bytes: Uint8Array) {
  return bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

export function parseContainer(bytes: Uint8Array): { json: Json; bin: Uint8Array | null } {
  if (isGlb(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error(`Unsupported GLB version ${version} (only glTF 2.0 is supported)`);
    const length = Math.min(dv.getUint32(8, true), bytes.length);
    let off = 12;
    let json: Json = null,
      bin: Uint8Array | null = null;
    while (off + 8 <= length) {
      const len = dv.getUint32(off, true),
        type = dv.getUint32(off + 4, true);
      const data = bytes.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
      else if (type === 0x004e4942 && !bin) bin = data;
      off += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error('The GLB file has no JSON chunk');
    return { json, bin };
  }
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
  return { json: JSON.parse(text), bin: null };
}

/** URIs of external (non data-URI) resources referenced by a glTF JSON. */
export function externalUris(json: Json): string[] {
  const out: string[] = [];
  for (const b of json.buffers ?? []) if (b.uri && !b.uri.startsWith('data:')) out.push(decodeURIComponent(b.uri));
  for (const im of json.images ?? []) if (im.uri && !im.uri.startsWith('data:')) out.push(decodeURIComponent(im.uri));
  return out;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const CTYPES: Record<number, { size: number; read: (dv: DataView, o: number) => number; norm: (v: number) => number }> = {
  5120: { size: 1, read: (d, o) => d.getInt8(o), norm: (v) => Math.max(v / 127, -1) },
  5121: { size: 1, read: (d, o) => d.getUint8(o), norm: (v) => v / 255 },
  5122: { size: 2, read: (d, o) => d.getInt16(o, true), norm: (v) => Math.max(v / 32767, -1) },
  5123: { size: 2, read: (d, o) => d.getUint16(o, true), norm: (v) => v / 65535 },
  5125: { size: 4, read: (d, o) => d.getUint32(o, true), norm: (v) => v / 4294967295 },
  5126: { size: 4, read: (d, o) => d.getFloat32(o, true), norm: (v) => v },
};

export function readGltf(bytes: Uint8Array, opts: GltfReadOptions = {}): IRScene {
  const { json, bin } = parseContainer(bytes);
  const ir = emptyScene();
  ir.axis = Y_UP_TO_Z_UP;
  const W = ir.warnings;
  if (!json.asset || String(json.asset.version ?? '').split('.')[0] !== '2') throw new Error(`Only glTF 2.0 files are supported (asset version ${json.asset?.version ?? 'missing'})`);
  const required: string[] = json.extensionsRequired ?? [];
  const unsupportedRequired = required.filter((e) => !SUPPORTED_EXTENSIONS.has(e));
  if (unsupportedRequired.length) throw new Error(`Required extension(s) not supported: ${unsupportedRequired.join(', ')}`);
  for (const e of json.extensionsUsed ?? []) if (!SUPPORTED_EXTENSIONS.has(e)) W.push(`Extension ${e} is not supported and was ignored`);

  // ------------------------------------------------------------ buffers
  const resources = new Map<string, Uint8Array>();
  for (const [k, v] of opts.resources ?? []) resources.set(baseName(k).toLowerCase(), v);
  const findResource = (uri: string) => resources.get(baseName(decodeURIComponent(uri)).toLowerCase()) ?? null;
  const buffers: (Uint8Array | null)[] = (json.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin;
      W.push(`Buffer ${i} has no data`);
      return null;
    }
    if (b.uri.startsWith('data:')) return decodeDataUri(b.uri)?.bytes ?? null;
    const r = findResource(b.uri);
    if (!r) throw new Error(`External buffer "${b.uri}" is missing — select it together with the .gltf file`);
    return r;
  });
  const bufferView = (i: number): { bytes: Uint8Array; stride: number } | null => {
    const bv = json.bufferViews?.[i];
    if (!bv) return null;
    const buf = buffers[bv.buffer];
    if (!buf) return null;
    const off = bv.byteOffset ?? 0;
    if (off + bv.byteLength > buf.length) throw new Error(`bufferView ${i} is out of range`);
    return { bytes: buf.subarray(off, off + bv.byteLength), stride: bv.byteStride ?? 0 };
  };

  const accCache = new Map<string, Float32Array>();
  /** Read an accessor as floats (normalized ints are converted when `normalize` or accessor.normalized). */
  const readAccessor = (index: number, asFloat = true): Float32Array => {
    const key = `${index}|${asFloat}`;
    const hit = accCache.get(key);
    if (hit) return hit;
    const acc = json.accessors?.[index];
    if (!acc) throw new Error(`Accessor ${index} is missing`);
    const nc = COMPONENTS[acc.type];
    const ct = CTYPES[acc.componentType];
    if (!nc || !ct) throw new Error(`Accessor ${index} has an unsupported type`);
    const count = acc.count;
    const out = new Float32Array(count * nc);
    const norm = !!acc.normalized && asFloat;
    if (acc.bufferView !== undefined) {
      const bv = bufferView(acc.bufferView);
      if (bv) {
        const dv = new DataView(bv.bytes.buffer, bv.bytes.byteOffset, bv.bytes.byteLength);
        const elemSize = ct.size * nc;
        // matrices: columns are padded to 4-byte boundaries for 1/2-byte components
        const colPad = acc.type.startsWith('MAT') && ct.size < 4;
        const stride = bv.stride || (colPad ? paddedMatrixSize(acc.type, ct.size) : elemSize);
        const base = acc.byteOffset ?? 0;
        if (base + stride * (count - 1) + elemSize > bv.bytes.length && count > 0) throw new Error(`Accessor ${index} exceeds its buffer view`);
        for (let i = 0; i < count; i++) {
          const o = base + i * stride;
          for (let c = 0; c < nc; c++) {
            let co = o + c * ct.size;
            if (colPad) {
              const rows = Math.sqrt(nc),
                col = Math.floor(c / rows),
                row = c % rows;
              co = o + col * Math.ceil((rows * ct.size) / 4) * 4 + row * ct.size;
            }
            const v = ct.read(dv, co);
            out[i * nc + c] = norm ? ct.norm(v) : v;
          }
        }
      }
    }
    if (acc.sparse) {
      const sp = acc.sparse;
      const ib = bufferView(sp.indices.bufferView),
        vb = bufferView(sp.values.bufferView);
      if (ib && vb) {
        const it = CTYPES[sp.indices.componentType];
        const idv = new DataView(ib.bytes.buffer, ib.bytes.byteOffset + (sp.indices.byteOffset ?? 0));
        const vdv = new DataView(vb.bytes.buffer, vb.bytes.byteOffset + (sp.values.byteOffset ?? 0));
        for (let k = 0; k < sp.count; k++) {
          const target = it.read(idv, k * it.size);
          for (let c = 0; c < nc; c++) {
            const v = ct.read(vdv, (k * nc + c) * ct.size);
            out[target * nc + c] = norm ? ct.norm(v) : v;
          }
        }
      }
    }
    accCache.set(key, out);
    return out;
  };
  const readIndices = (index: number): Uint32Array => Uint32Array.from(readAccessor(index, false));

  // ------------------------------------------------------------ images / textures
  const images = (json.images ?? []) as Json[];
  ir.images = images.map((im: Json, i: number) => {
    const name = im.name || (im.uri && !im.uri.startsWith('data:') ? stripExt(baseName(decodeURIComponent(im.uri))) : `Image_${i}`);
    let bytes: Uint8Array | null = null;
    if (im.bufferView !== undefined) bytes = bufferView(im.bufferView)?.bytes.slice() ?? null;
    else if (im.uri?.startsWith('data:')) bytes = decodeDataUri(im.uri)?.bytes ?? null;
    else if (im.uri) bytes = findResource(im.uri);
    const mime = im.mimeType || (bytes ? sniffMime(bytes, im.uri ?? '') : 'image/png');
    return { name, mime, bytes, uri: im.uri && !im.uri.startsWith('data:') ? decodeURIComponent(im.uri) : undefined };
  });
  const imageColor = new Map<number, 'sRGB' | 'Non-Color'>();
  const texRef = (info: Json, nonColor: boolean, channel?: IRTexRef['channel']): IRTexRef | undefined => {
    if (!info) return undefined;
    const tex = json.textures?.[info.index];
    if (!tex) return undefined;
    const src = tex.extensions?.EXT_texture_webp?.source ?? tex.source ?? tex.extensions?.KHR_texture_basisu?.source;
    if (src === undefined || !ir.images[src]) return undefined;
    if (tex.extensions?.KHR_texture_basisu && tex.source === undefined) W.push('KTX2/Basis textures are not supported');
    if ((info.texCoord ?? 0) !== 0) W.push('Textures using a second UV map are mapped to the first UV map');
    const prev = imageColor.get(src);
    imageColor.set(src, prev === 'sRGB' ? 'sRGB' : nonColor ? 'Non-Color' : 'sRGB');
    const sampler = tex.sampler !== undefined ? json.samplers?.[tex.sampler] : undefined;
    const wrap = sampler?.wrapS ?? 10497;
    const ref: IRTexRef = {
      image: src,
      interpolation: sampler?.magFilter === 9728 ? 'Closest' : 'Linear',
      extension: wrap === 33071 ? 'EXTEND' : wrap === 33648 ? 'MIRROR' : 'REPEAT',
      channel,
    };
    if (sampler && (sampler.wrapT ?? 10497) !== wrap) W.push('Textures with different S/T wrap modes use the S mode');
    const xf = info.extensions?.KHR_texture_transform;
    if (xf) {
      if (xf.offset) ref.offset = [xf.offset[0], xf.offset[1]];
      if (xf.rotation) ref.rotation = xf.rotation;
      if (xf.scale) ref.scale = [xf.scale[0], xf.scale[1]];
      if (xf.texCoord !== undefined && xf.texCoord !== 0) W.push('KHR_texture_transform texCoord override is not supported');
    }
    return ref;
  };

  // ------------------------------------------------------------ materials
  ir.materials = (json.materials ?? []).map((m: Json, i: number): IRMaterial => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const ext = m.extensions ?? {};
    const bc = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const mat: IRMaterial = {
      name: m.name || `Material_${i}`,
      baseColor: [bc[0], bc[1], bc[2], bc[3]],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      baseColorTex: texRef(pbr.baseColorTexture, false),
      metallicRoughnessTex: texRef(pbr.metallicRoughnessTexture, true),
      emissive: m.emissiveFactor ? [m.emissiveFactor[0], m.emissiveFactor[1], m.emissiveFactor[2]] : undefined,
      emissiveTex: texRef(m.emissiveTexture, false),
      emissiveStrength: ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      alphaMode: m.alphaMode ?? 'OPAQUE',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: !!m.doubleSided,
    };
    if (m.normalTexture) {
      const r = texRef(m.normalTexture, true);
      if (r) mat.normalTex = { ...r, strength: m.normalTexture.scale ?? 1 };
    }
    if (m.occlusionTexture) mat.occlusionTex = texRef(m.occlusionTexture, true);
    if (ext.KHR_materials_transmission) {
      mat.transmission = ext.KHR_materials_transmission.transmissionFactor ?? 0;
      mat.transmissionTex = texRef(ext.KHR_materials_transmission.transmissionTexture, true, 'R');
    }
    if (ext.KHR_materials_ior) mat.ior = ext.KHR_materials_ior.ior ?? 1.5;
    if (ext.KHR_materials_clearcoat) {
      mat.clearcoat = ext.KHR_materials_clearcoat.clearcoatFactor ?? 0;
      mat.clearcoatRoughness = ext.KHR_materials_clearcoat.clearcoatRoughnessFactor ?? 0;
      if (ext.KHR_materials_clearcoat.clearcoatTexture || ext.KHR_materials_clearcoat.clearcoatRoughnessTexture || ext.KHR_materials_clearcoat.clearcoatNormalTexture)
        W.push(`Material "${mat.name}": clearcoat textures are not supported`);
    }
    if (ext.KHR_materials_sheen) {
      const s = ext.KHR_materials_sheen;
      mat.sheenColor = s.sheenColorFactor ?? [0, 0, 0];
      mat.sheenRoughness = s.sheenRoughnessFactor ?? 0;
      if (s.sheenColorTexture || s.sheenRoughnessTexture) W.push(`Material "${mat.name}": sheen textures are not supported`);
    }
    if (ext.KHR_materials_specular) {
      const s = ext.KHR_materials_specular;
      mat.specular = (s.specularFactor ?? 1) * 0.5;
      if (s.specularColorFactor) mat.specularTint = [s.specularColorFactor[0], s.specularColorFactor[1], s.specularColorFactor[2]];
    }
    if (ext.KHR_materials_unlit) mat.unlit = true;
    return mat;
  });
  for (const [i, cs] of imageColor) if (ir.images[i]) ir.images[i].colorspace = cs;

  // ------------------------------------------------------------ meshes
  const meshes = (json.meshes ?? []) as Json[];
  const vertexColorMats = new Map<number, boolean>();
  ir.meshes = meshes.map((m: Json, mi: number): IRMesh => {
    const pos: number[] = [],
      nrm: number[] = [],
      uv: number[] = [],
      col: number[] = [];
    const faceSizes: number[] = [],
      corners: number[] = [],
      matIndex: number[] = [];
    const slots: number[] = [];
    let anyNormals = false,
      anyUv = false,
      anyColor = false,
      loose = 0;
    const prims = (m.primitives ?? []) as Json[];
    const targetCount = Math.max(0, ...prims.map((p) => (p.targets ?? []).length));
    const targetDeltas: number[][] = Array.from({ length: targetCount }, () => []);
    const weightsPerVertex: { j: number; w: number }[][] = [];
    for (const p of prims) {
      const a = p.attributes ?? {};
      if (p.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed meshes are not supported');
      if (a.POSITION === undefined) continue;
      const P = readAccessor(a.POSITION);
      const nv = P.length / 3;
      const base = pos.length / 3;
      for (let i = 0; i < P.length; i++) pos.push(P[i]);
      const N = a.NORMAL !== undefined ? readAccessor(a.NORMAL) : null;
      const T = a.TEXCOORD_0 !== undefined ? readAccessor(a.TEXCOORD_0) : null;
      const C = a.COLOR_0 !== undefined ? readAccessor(a.COLOR_0) : null;
      const cComps = C ? COMPONENTS[json.accessors[a.COLOR_0].type] : 0;
      if (N) anyNormals = true;
      if (T) anyUv = true;
      if (C) anyColor = true;
      for (let v = 0; v < nv; v++) {
        nrm.push(N ? N[v * 3] : 0, N ? N[v * 3 + 1] : 0, N ? N[v * 3 + 2] : 0);
        uv.push(T ? T[v * 2] : 0, T ? 1 - T[v * 2 + 1] : 0);
        if (C) col.push(C[v * cComps], C[v * cComps + 1], C[v * cComps + 2], cComps === 4 ? C[v * cComps + 3] : 1);
        else col.push(1, 1, 1, 1);
      }
      // skin weights
      for (let set = 0; ; set++) {
        const J = a[`JOINTS_${set}`],
          Wt = a[`WEIGHTS_${set}`];
        if (J === undefined || Wt === undefined) break;
        const jj = readAccessor(J, false),
          ww = readAccessor(Wt);
        for (let v = 0; v < nv; v++) {
          const list = (weightsPerVertex[base + v] ??= []);
          for (let k = 0; k < 4; k++) if (ww[v * 4 + k] > 0) list.push({ j: jj[v * 4 + k], w: ww[v * 4 + k] });
        }
      }
      for (let v = 0; v < nv; v++) weightsPerVertex[base + v] ??= [];
      // morph targets
      (p.targets ?? []).forEach((t: Json, ti: number) => {
        const D = t.POSITION !== undefined ? readAccessor(t.POSITION) : null;
        for (let v = 0; v < nv; v++) targetDeltas[ti].push(D ? D[v * 3] : 0, D ? D[v * 3 + 1] : 0, D ? D[v * 3 + 2] : 0);
      });
      for (let ti = (p.targets ?? []).length; ti < targetCount; ti++) for (let v = 0; v < nv * 3; v++) targetDeltas[ti].push(0);
      // material slot
      const matIdx = p.material ?? -1;
      let slot = slots.indexOf(matIdx);
      if (slot < 0) {
        slot = slots.length;
        slots.push(matIdx);
      }
      if (matIdx >= 0) vertexColorMats.set(matIdx, (vertexColorMats.get(matIdx) ?? true) && !!C);
      // faces
      const mode = p.mode ?? 4;
      const idx = p.indices !== undefined ? readIndices(p.indices) : Uint32Array.from({ length: nv }, (_, i) => i);
      const tri = (x: number, y: number, z: number) => {
        faceSizes.push(3);
        corners.push(base + x, base + y, base + z);
        matIndex.push(slot);
      };
      if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) tri(idx[i], idx[i + 1], idx[i + 2]);
      else if (mode === 5) for (let i = 0; i + 2 < idx.length; i++) i % 2 ? tri(idx[i + 1], idx[i], idx[i + 2]) : tri(idx[i], idx[i + 1], idx[i + 2]);
      else if (mode === 6) for (let i = 1; i + 1 < idx.length; i++) tri(idx[0], idx[i], idx[i + 1]);
      else loose += idx.length;
    }
    const nvTotal = pos.length / 3;
    const cornerIdx = Uint32Array.from(corners);
    const percorner = (src: number[], k: number) => {
      const out = new Float32Array(cornerIdx.length * k);
      for (let c = 0; c < cornerIdx.length; c++) for (let j = 0; j < k; j++) out[c * k + j] = src[cornerIdx[c] * k + j];
      return out;
    };
    const mesh: IRMesh = {
      name: m.name || `Mesh_${mi}`,
      positions: Float32Array.from(pos),
      faceSizes: Uint32Array.from(faceSizes),
      indices: cornerIdx,
      uvs: anyUv ? percorner(uv, 2) : undefined,
      normals: anyNormals ? percorner(nrm, 3) : undefined,
      materialIndex: Uint16Array.from(matIndex),
      // primitives without a material leave the mesh without slots (not one empty slot)
      materials: slots.length === 1 && slots[0] < 0 ? [] : slots,
      colors: anyColor ? [{ name: 'Color', domain: 'POINT', data: Float32Array.from(col) }] : undefined,
      looseEdges: loose || undefined,
    };
    if (weightsPerVertex.some((l) => l && l.length)) {
      let maxJ = -1;
      for (const l of weightsPerVertex) for (const e of l ?? []) maxJ = Math.max(maxJ, e.j);
      const weights = Array.from({ length: maxJ + 1 }, () => new Float32Array(nvTotal));
      weightsPerVertex.forEach((l, v) => l?.forEach((e) => (weights[e.j][v] += e.w)));
      mesh.groups = { names: weights.map((_, j) => `joint_${j}`), weights };
    }
    if (targetCount) {
      const names: string[] = m.extras?.targetNames ?? [];
      mesh.shapeKeys = targetDeltas.map((d, ti) => {
        const p = new Float32Array(pos.length);
        for (let i = 0; i < p.length; i++) p[i] = pos[i] + (d[i] ?? 0);
        return { name: names[ti] ?? `Key ${ti + 1}`, positions: p };
      });
    }
    return mesh;
  });
  ir.materials.forEach((mat, i) => {
    if (vertexColorMats.get(i)) mat.useVertexColor = true;
  });

  // ------------------------------------------------------------ nodes
  const gnodes = (json.nodes ?? []) as Json[];
  const parentOf = new Int32Array(gnodes.length).fill(-1);
  gnodes.forEach((n: Json, i: number) => (n.children ?? []).forEach((c: number) => c >= 0 && c < gnodes.length && (parentOf[c] = i)));
  const lights = (json.extensions?.KHR_lights_punctual?.lights ?? []) as Json[];
  ir.nodes = gnodes.map((n: Json, i: number): IRNode => {
    let matrix: number[];
    if (n.matrix) matrix = [...n.matrix];
    else {
      const t = n.translation ?? [0, 0, 0],
        r = n.rotation ?? [0, 0, 0, 1],
        s = n.scale ?? [1, 1, 1];
      matrix = new Matrix4().compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]).normalize(), new Vector3(s[0], s[1], s[2])).toArray();
    }
    const node: IRNode = { name: n.name || `Node_${i}`, parent: parentOf[i], matrix };
    if (n.mesh !== undefined && ir.meshes[n.mesh]) node.mesh = n.mesh;
    if (n.skin !== undefined && json.skins?.[n.skin]) node.skin = n.skin;
    if (n.weights) node.morphWeights = n.weights;
    else if (n.mesh !== undefined && meshes[n.mesh]?.weights) node.morphWeights = meshes[n.mesh].weights;
    if (n.camera !== undefined) {
      const c = json.cameras?.[n.camera];
      if (c?.type === 'perspective') node.camera = { type: 'PERSP', yfov: c.perspective?.yfov ?? 0.8, clipStart: c.perspective?.znear, clipEnd: c.perspective?.zfar ?? 1000 };
      else if (c?.type === 'orthographic')
        node.camera = { type: 'ORTHO', orthoScale: 2 * Math.max(c.orthographic?.xmag ?? 1, c.orthographic?.ymag ?? 1), clipStart: c.orthographic?.znear, clipEnd: c.orthographic?.zfar };
    }
    const li = n.extensions?.KHR_lights_punctual?.light;
    if (li !== undefined && lights[li]) {
      const l = lights[li];
      const color = (l.color ?? [1, 1, 1]) as [number, number, number];
      const intensity = l.intensity ?? 1;
      if (l.type === 'directional') node.light = { type: 'SUN', color, energy: intensity / WATTS_TO_LUMENS };
      else if (l.type === 'spot') {
        const outer = l.spot?.outerConeAngle ?? Math.PI / 4,
          inner = l.spot?.innerConeAngle ?? 0;
        node.light = { type: 'SPOT', color, energy: candelaToPointWatts(intensity), spotSize: outer * 2, spotBlend: outer > 0 ? 1 - inner / outer : 0, range: l.range, radius: 0 };
      } else node.light = { type: 'POINT', color, energy: candelaToPointWatts(intensity), range: l.range, radius: 0 };
      if (!n.name && l.name) node.name = l.name;
    }
    if (n.extras && typeof n.extras === 'object') {
      const ex: Record<string, number | string | boolean> = {};
      for (const [k, v] of Object.entries(n.extras)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') ex[k] = v;
      if (Object.keys(ex).length) node.extras = ex;
    }
    return node;
  });
  // restrict to the active scene (other scenes' roots are dropped)
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  if (scene && json.scenes.length > 1) W.push(`The file has ${json.scenes.length} scenes; only "${scene.name ?? sceneIndex}" was imported`);
  if (scene) {
    const keep = new Set<number>();
    const walk = (i: number) => {
      if (keep.has(i) || !gnodes[i]) return;
      keep.add(i);
      for (const c of gnodes[i].children ?? []) walk(c);
    };
    for (const r of scene.nodes ?? []) walk(r);
    if (keep.size < gnodes.length) {
      // remove nodes outside the scene (keep indices stable by detaching them)
      ir.nodes.forEach((n, i) => {
        if (!keep.has(i)) {
          n.mesh = undefined;
          n.camera = undefined;
          n.light = undefined;
          n.skin = undefined;
          (n as IRNode & { _drop?: boolean })._drop = true;
        }
      });
    }
  }

  // ------------------------------------------------------------ skins
  ir.skins = (json.skins ?? []).map((s: Json, si: number) => {
    const joints: number[] = s.joints ?? [];
    let ibm: number[][] = joints.map(() => new Matrix4().toArray());
    if (s.inverseBindMatrices !== undefined) {
      const a = readAccessor(s.inverseBindMatrices);
      ibm = joints.map((_, k) => Array.from(a.subarray(k * 16, k * 16 + 16)));
    }
    return { name: s.name || `Armature${si ? `.${si}` : ''}`, joints, inverseBind: ibm };
  });

  // ------------------------------------------------------------ animations
  ir.animations = (json.animations ?? []).map((a: Json, ai: number) => {
    const channels: IRChannel[] = [];
    for (const ch of a.channels ?? []) {
      const s = a.samplers?.[ch.sampler];
      const node = ch.target?.node;
      if (!s || node === undefined || !ir.nodes[node]) continue;
      const path = ch.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale' && path !== 'weights') {
        W.push(`Animation channel path "${path}" is not supported`);
        continue;
      }
      const times = readAccessor(s.input);
      const values = readAccessor(s.output);
      channels.push({ node, path, times, values, interpolation: (s.interpolation ?? 'LINEAR') as IRChannel['interpolation'] });
    }
    return { name: a.name || `Animation_${ai}`, channels };
  });

  // drop detached nodes (outside the scene) while remapping indices
  const dropped = ir.nodes.map((n) => !!(n as IRNode & { _drop?: boolean })._drop);
  if (dropped.some(Boolean)) {
    const remap = new Int32Array(ir.nodes.length).fill(-1);
    const kept: IRNode[] = [];
    ir.nodes.forEach((n, i) => {
      if (!dropped[i]) {
        remap[i] = kept.length;
        kept.push(n);
      }
    });
    for (const n of kept) n.parent = n.parent >= 0 ? remap[n.parent] : -1;
    ir.nodes = kept;
    for (const s of ir.skins) {
      const keepIdx = s.joints.map((j) => remap[j]);
      s.joints = keepIdx;
    }
    for (const a of ir.animations) a.channels = a.channels.filter((c) => remap[c.node] >= 0).map((c) => ({ ...c, node: remap[c.node] }));
  }
  return ir;
}

function paddedMatrixSize(type: string, size: number) {
  const rows = type === 'MAT2' ? 2 : type === 'MAT3' ? 3 : 4;
  return rows * Math.ceil((rows * size) / 4) * 4;
}
