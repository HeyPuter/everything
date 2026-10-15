// Wavefront OBJ + MTL reader and writer (independent implementation of the public format).
import { Matrix3, Matrix4, Vector3 } from 'three';
import { emptyScene, type IRMaterial, type IRMesh, type IRScene, type IRTexRef } from './ir';
import { axisConversion, baseName, extOfMime, round, transpose3, type AxisId } from './common';
import type { ExportScene } from './scene-builder';
import type { ExportMaterial, ExportTexRef } from './material-nodes';
import { triangulatePoly } from '../../mesh/mesh';

export interface ObjReadOptions {
  forward?: AxisId;
  up?: AxisId;
  scale?: number;
  splitByObject?: boolean;
  splitByGroup?: boolean;
  /** MTL and texture files by base name (lower case) */
  resources?: Map<string, Uint8Array>;
}

const num = (s: string | undefined, d = 0) => {
  const v = s === undefined ? NaN : parseFloat(s);
  return Number.isFinite(v) ? v : d;
};

/** Names of the material libraries an OBJ references. */
export function objMaterialLibraries(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)) out.push(m[1]);
  return out;
}

/** Texture files referenced by an MTL. */
export function mtlTextureFiles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(map_\w+|bump|disp|decal|refl|norm)\s+(.+?)\s*$/gim)) out.push(parseMapArgs(m[2]).file);
  return out;
}

function parseMapArgs(rest: string): { file: string; bm?: number; o?: number[]; s?: number[] } {
  const toks = rest.trim().split(/\s+/);
  const res: { file: string; bm?: number; o?: number[]; s?: number[] } = { file: '' };
  const counts: Record<string, number> = { '-bm': 1, '-o': 3, '-s': 3, '-t': 3, '-mm': 2, '-blendu': 1, '-blendv': 1, '-boost': 1, '-clamp': 1, '-cc': 1, '-imfchan': 1, '-texres': 1, '-type': 1 };
  let i = 0;
  while (i < toks.length && toks[i].startsWith('-') && counts[toks[i]] !== undefined) {
    const k = toks[i],
      n = counts[k];
    const vals = toks.slice(i + 1, i + 1 + n);
    // -o / -s / -t accept 1..3 numbers
    let used = n;
    if (k === '-o' || k === '-s' || k === '-t') {
      used = 0;
      while (used < 3 && i + 1 + used < toks.length - 1 && /^[-+]?[\d.]/.test(toks[i + 1 + used])) used++;
    }
    const v = toks.slice(i + 1, i + 1 + used).map(Number);
    if (k === '-bm') res.bm = Number(vals[0]);
    if (k === '-o') res.o = v;
    if (k === '-s') res.s = v;
    i += 1 + used;
  }
  res.file = toks.slice(i).join(' ');
  return res;
}

interface MtlDef {
  name: string;
  Kd?: number[];
  Ks?: number[];
  Ka?: number[];
  Ke?: number[];
  Ns?: number;
  Ni?: number;
  d?: number;
  illum?: number;
  Pr?: number;
  Pm?: number;
  maps: Record<string, { file: string; bm?: number; o?: number[]; s?: number[] }>;
}

export function parseMtl(text: string): MtlDef[] {
  const out: MtlDef[] = [];
  let cur: MtlDef | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    const nums = rest.split(/\s+/).map(Number);
    if (key === 'newmtl') {
      cur = { name: rest || 'Material', maps: {} };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const col = () => (nums.length >= 3 ? [nums[0], nums[1], nums[2]] : [nums[0], nums[0], nums[0]]);
    switch (key) {
      case 'kd':
        cur.Kd = col();
        break;
      case 'ks':
        cur.Ks = col();
        break;
      case 'ka':
        cur.Ka = col();
        break;
      case 'ke':
        cur.Ke = col();
        break;
      case 'ns':
        cur.Ns = nums[0];
        break;
      case 'ni':
        cur.Ni = nums[0];
        break;
      case 'd':
        cur.d = nums[0];
        break;
      case 'tr':
        cur.d = 1 - nums[0];
        break;
      case 'illum':
        cur.illum = nums[0];
        break;
      case 'pr':
        cur.Pr = nums[0];
        break;
      case 'pm':
        cur.Pm = nums[0];
        break;
      default:
        if (key.startsWith('map_') || key === 'bump' || key === 'norm' || key === 'disp' || key === 'refl') cur.maps[key === 'bump' ? 'map_bump' : key] = parseMapArgs(rest);
    }
  }
  return out;
}

function mtlToIR(m: MtlDef, image: (file: string, nonColor: boolean) => number): IRMaterial {
  const tex = (key: string, nonColor = false, channel?: IRTexRef['channel']): IRTexRef | undefined => {
    const mp = m.maps[key];
    if (!mp?.file) return undefined;
    const ref: IRTexRef = { image: image(mp.file, nonColor), channel };
    if (mp.o && (mp.o[0] || mp.o[1])) ref.offset = [mp.o[0] ?? 0, -(mp.o[1] ?? 0)];
    if (mp.s && (mp.s[0] !== 1 || (mp.s[1] ?? mp.s[0]) !== 1)) ref.scale = [mp.s[0], mp.s[1] ?? mp.s[0]];
    return ref;
  };
  const kd = m.Kd ?? [0.8, 0.8, 0.8];
  const metallic = m.Pm ?? (m.illum === 3 && m.Ka ? (m.Ka[0] + m.Ka[1] + m.Ka[2]) / 3 : 0);
  const roughness = m.Pr ?? (m.Ns !== undefined ? 1 - Math.sqrt(Math.max(0, Math.min(1000, m.Ns)) / 1000) : 0.5);
  const mat: IRMaterial = {
    name: m.name,
    baseColor: [kd[0], kd[1], kd[2], m.d ?? 1],
    metallic,
    roughness,
    ior: m.Ni && m.Ni >= 1 ? m.Ni : undefined,
    specular: m.Ks ? (m.Ks[0] + m.Ks[1] + m.Ks[2]) / 3 : undefined,
    baseColorTex: tex('map_kd'),
    roughnessTex: tex('map_pr', true, 'R') ?? tex('map_ns', true, 'R'),
    metallicTex: tex('map_pm', true, 'R'),
    emissiveTex: tex('map_ke'),
    alphaTex: tex('map_d', true, 'R'),
  };
  if (mat.baseColorTex) mat.baseColor = [1, 1, 1, mat.baseColor[3]];
  if (m.Ke && (m.Ke[0] || m.Ke[1] || m.Ke[2])) {
    mat.emissive = [m.Ke[0], m.Ke[1], m.Ke[2]];
    mat.emissiveStrength = 1;
  } else if (mat.emissiveTex) mat.emissive = [1, 1, 1];
  const bump = m.maps['map_bump'] ?? m.maps['norm'];
  if (bump?.file) {
    const r = tex(m.maps['map_bump'] ? 'map_bump' : 'norm', true)!;
    mat.normalTex = { ...r, strength: bump.bm ?? 1 };
  }
  if ((m.d ?? 1) < 1 || mat.alphaTex) mat.alphaMode = 'BLEND';
  return mat;
}

/** Parse OBJ text into IR (one node per object/group). */
export function readObj(text: string, opts: ObjReadOptions = {}): IRScene {
  const ir = emptyScene();
  const axis = axisConversion(opts.forward ?? '-Z', opts.up ?? 'Y');
  if (!axis) throw new Error('Forward and Up axes must be different');
  ir.axis = axis;
  ir.unitScale = opts.scale ?? 1;
  const W = ir.warnings;
  const pos: number[] = [],
    col: number[] = [],
    tex: number[] = [],
    nrm: number[] = [];
  let anyVertexColor = false;
  // materials
  const resources = new Map<string, Uint8Array>();
  for (const [k, v] of opts.resources ?? []) resources.set(baseName(k).toLowerCase(), v);
  const matIndex = new Map<string, number>();
  const imageIndex = new Map<string, number>();
  const image = (file: string, nonColor: boolean) => {
    const key = baseName(file).toLowerCase();
    let i = imageIndex.get(key);
    if (i === undefined) {
      const bytes = resources.get(key) ?? null;
      i = ir.images.length;
      ir.images.push({ name: baseName(file), mime: '', bytes, uri: file, colorspace: nonColor ? 'Non-Color' : 'sRGB' });
      imageIndex.set(key, i);
    }
    return i;
  };
  const libs: MtlDef[] = [];
  const materialFor = (name: string): number => {
    let i = matIndex.get(name);
    if (i !== undefined) return i;
    const def = libs.find((m) => m.name === name);
    i = ir.materials.length;
    ir.materials.push(def ? mtlToIR(def, image) : { name, baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 });
    if (!def) W.push(`Material "${name}" was not found in the material libraries`);
    matIndex.set(name, i);
    return i;
  };

  interface Builder {
    name: string;
    faces: number[][]; // [v, vt, vn] triples flattened per face
    faceMat: number[];
    faceSmooth: number[];
    slots: number[];
    loose: number;
  }
  const builders: Builder[] = [];
  let cur: Builder | null = null;
  let objName = '';
  let groupName = '';
  let currentMat = -1;
  let smooth = 0;
  let anySmoothStatement = false;
  const newBuilder = (name: string) => {
    cur = { name, faces: [], faceMat: [], faceSmooth: [], slots: [], loose: 0 };
    builders.push(cur);
    return cur;
  };
  const ensure = () => cur ?? newBuilder(objName || groupName || 'Object');
  const idx = (s: string, n: number) => {
    const v = parseInt(s, 10);
    if (!Number.isFinite(v) || v === 0) return -1;
    return v < 0 ? n + v : v - 1;
  };
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    while (line.endsWith('\\') && li + 1 < lines.length) line = line.slice(0, -1) + ' ' + lines[++li];
    line = line.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.search(/\s/);
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (key) {
      case 'v': {
        const t = rest.split(/\s+/);
        pos.push(num(t[0]), num(t[1]), num(t[2]));
        if (t.length >= 6) {
          anyVertexColor = true;
          col.push(num(t[3], 1), num(t[4], 1), num(t[5], 1), 1);
        } else col.push(1, 1, 1, 1);
        break;
      }
      case 'vt': {
        const t = rest.split(/\s+/);
        tex.push(num(t[0]), num(t[1]));
        break;
      }
      case 'vn': {
        const t = rest.split(/\s+/);
        nrm.push(num(t[0]), num(t[1]), num(t[2]));
        break;
      }
      case 'f': {
        const b = ensure();
        const corners: number[] = [];
        for (const tok of rest.split(/\s+/)) {
          if (!tok) continue;
          const [a, t, n] = tok.split('/');
          const v = idx(a, pos.length / 3);
          if (v < 0 || v >= pos.length / 3) continue;
          corners.push(v, t ? idx(t, tex.length / 2) : -1, n ? idx(n, nrm.length / 3) : -1);
        }
        if (corners.length < 9) {
          b.loose++;
          break;
        }
        let slot = -1;
        if (currentMat >= 0) {
          slot = b.slots.indexOf(currentMat);
          if (slot < 0) {
            slot = b.slots.length;
            b.slots.push(currentMat);
          }
        }
        b.faces.push(corners);
        b.faceMat.push(Math.max(0, slot));
        b.faceSmooth.push(smooth);
        break;
      }
      case 'l':
      case 'p':
        ensure().loose++;
        break;
      case 'o':
        objName = rest || 'Object';
        if (opts.splitByObject !== false) newBuilder(objName);
        break;
      case 'g':
        groupName = rest || 'Group';
        if (opts.splitByGroup) newBuilder(opts.splitByObject !== false && objName ? `${objName}_${groupName}` : groupName);
        break;
      case 's':
        anySmoothStatement = true;
        smooth = rest === 'off' || rest === '0' ? 0 : 1;
        break;
      case 'usemtl':
        currentMat = materialFor(rest || 'Material');
        break;
      case 'mtllib': {
        for (const file of [rest, ...rest.split(/\s+/)]) {
          const bytes = resources.get(baseName(file).toLowerCase());
          if (bytes) {
            libs.push(...parseMtl(new TextDecoder().decode(bytes)));
            break;
          }
        }
        if (!libs.length) W.push(`Material library "${rest}" was not provided; materials use default settings`);
        break;
      }
      default:
        break;
    }
  }
  // build meshes (compact vertices per object)
  for (const b of builders) {
    if (!b.faces.length) {
      if (b.loose) W.push(`"${b.name}": ${b.loose} line/point element(s) were not imported`);
      continue;
    }
    const remap = new Map<number, number>();
    const P: number[] = [],
      C: number[] = [];
    const faceSizes: number[] = [],
      indices: number[] = [],
      uvs: number[] = [],
      normals: number[] = [];
    let hasUv = false,
      hasN = false;
    for (const f of b.faces) {
      faceSizes.push(f.length / 3);
      for (let k = 0; k < f.length; k += 3) {
        const v = f[k];
        let id = remap.get(v);
        if (id === undefined) {
          id = P.length / 3;
          remap.set(v, id);
          P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
          C.push(col[v * 4], col[v * 4 + 1], col[v * 4 + 2], col[v * 4 + 3]);
        }
        indices.push(id);
        const t = f[k + 1],
          n = f[k + 2];
        if (t >= 0 && t * 2 + 1 < tex.length) {
          hasUv = true;
          uvs.push(tex[t * 2], tex[t * 2 + 1]);
        } else uvs.push(0, 0);
        if (n >= 0 && n * 3 + 2 < nrm.length) {
          hasN = true;
          normals.push(nrm[n * 3], nrm[n * 3 + 1], nrm[n * 3 + 2]);
        } else normals.push(0, 0, 0);
      }
    }
    const mesh: IRMesh = {
      name: b.name,
      positions: Float32Array.from(P),
      faceSizes: Uint32Array.from(faceSizes),
      indices: Uint32Array.from(indices),
      uvs: hasUv ? Float32Array.from(uvs) : undefined,
      normals: hasN && !anySmoothStatement ? Float32Array.from(normals) : undefined,
      smooth: anySmoothStatement || !hasN ? Uint8Array.from(b.faceSmooth) : undefined,
      materialIndex: Uint16Array.from(b.faceMat),
      materials: b.slots,
      colors: anyVertexColor ? [{ name: 'Color', domain: 'POINT', data: Float32Array.from(C) }] : undefined,
      looseEdges: b.loose || undefined,
    };
    ir.meshes.push(mesh);
    ir.nodes.push({ name: b.name, parent: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], mesh: ir.meshes.length - 1 });
  }
  return ir;
}

// ---------------------------------------------------------------------------
// Writer

export interface ObjWriteOptions {
  forward?: AxisId;
  up?: AxisId;
  scale?: number;
  uvs?: boolean;
  normals?: boolean;
  colors?: boolean;
  materials?: boolean;
  triangulate?: boolean;
  smoothGroups?: boolean;
  /** 'o' (default) or 'g' for objects */
  groups?: boolean;
  /** MTL file name referenced by `mtllib` */
  mtlName?: string;
}

export interface ObjOutput {
  obj: string;
  mtl: string | null;
  /** texture files referenced by the MTL */
  textures: { name: string; bytes: Uint8Array | null; imageId: string }[];
  warnings: string[];
}

const fmt = (v: number) => {
  const r = round(v, 6);
  return r.toFixed(6);
};
const safeName = (s: string) => s.replace(/\s+/g, '_');

export function writeObj(scene: ExportScene, opts: ObjWriteOptions = {}): ObjOutput {
  const warnings = [...scene.warnings];
  const axis = axisConversion(opts.forward ?? '-Z', opts.up ?? 'Y');
  if (!axis) throw new Error('Forward and Up axes must be different');
  // document → file: inverse (transpose) of the file → document conversion
  const A = transpose3(axis);
  const scale = opts.scale ?? 1;
  const conv = new Matrix4().set(A[0] * scale, A[1] * scale, A[2] * scale, 0, A[3] * scale, A[4] * scale, A[5] * scale, 0, A[6] * scale, A[7] * scale, A[8] * scale, 0, 0, 0, 0, 1);
  const out: string[] = ['# Puter 3D OBJ File', '# https://puter.com'];
  const useMats = opts.materials !== false;
  const mtlName = opts.mtlName ?? 'materials.mtl';
  if (useMats && scene.materials.size) out.push(`mtllib ${mtlName}`);
  let vBase = 0,
    tBase = 0,
    nBase = 0;
  const usedMats = new Set<string>();
  let lastMat: string | null = null;
  for (const eo of scene.objects) {
    const m = eo.mesh;
    if (!m) continue;
    const nf = m.offsets.length - 1;
    if (!nf) continue;
    const M = conv.clone().multiply(eo.world);
    const N = new Matrix3().getNormalMatrix(M);
    const flip = M.determinant() < 0;
    out.push(`${opts.groups ? 'g' : 'o'} ${safeName(eo.name)}`);
    const nv = m.positions.length / 3;
    const v = new Vector3();
    // vertex colors (averaged per vertex from corners)
    let vcol: Float32Array | null = null;
    if (opts.colors && m.colors[0]) {
      vcol = new Float32Array(nv * 4);
      const cnt = new Float32Array(nv);
      for (let c = 0; c < m.indices.length; c++) {
        const vi = m.indices[c];
        for (let k = 0; k < 4; k++) vcol[vi * 4 + k] += m.colors[0].data[c * 4 + k];
        cnt[vi]++;
      }
      for (let i = 0; i < nv; i++) for (let k = 0; k < 4; k++) vcol[i * 4 + k] /= cnt[i] || 1;
    }
    for (let i = 0; i < nv; i++) {
      v.set(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]).applyMatrix4(M);
      out.push(`v ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}${vcol ? ` ${fmt(vcol[i * 4])} ${fmt(vcol[i * 4 + 1])} ${fmt(vcol[i * 4 + 2])}` : ''}`);
    }
    // uvs (deduplicated)
    const uvIndex = new Int32Array(m.indices.length).fill(-1);
    const tStart = tBase,
      nStart = nBase;
    if (opts.uvs !== false && m.uvs) {
      const map = new Map<string, number>();
      for (let c = 0; c < m.indices.length; c++) {
        const k = `${fmt(m.uvs[c * 2])} ${fmt(m.uvs[c * 2 + 1])}`;
        let id = map.get(k);
        if (id === undefined) {
          id = map.size;
          map.set(k, id);
          out.push(`vt ${k}`);
        }
        uvIndex[c] = id;
      }
      tBase += map.size;
    }
    const nIndex = new Int32Array(m.indices.length).fill(-1);
    if (opts.normals !== false) {
      const map = new Map<string, number>();
      for (let c = 0; c < m.indices.length; c++) {
        v.set(m.normals[c * 3], m.normals[c * 3 + 1], m.normals[c * 3 + 2])
          .applyMatrix3(N)
          .normalize();
        const k = `${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}`.replace(/-0\.0000/g, '0.0000');
        let id = map.get(k);
        if (id === undefined) {
          id = map.size;
          map.set(k, id);
          out.push(`vn ${k}`);
        }
        nIndex[c] = id;
      }
      nBase += map.size;
    }
    let lastSmooth = -1;
    const corner = (c: number) => {
      const vi = vBase + m.indices[c] + 1;
      const ti = uvIndex[c] >= 0 ? tStart + uvIndex[c] + 1 : 0;
      const ni = nIndex[c] >= 0 ? nStart + nIndex[c] + 1 : 0;
      return ni ? `${vi}/${ti || ''}/${ni}` : ti ? `${vi}/${ti}` : `${vi}`;
    };
    // faces sorted by material for fewer usemtl switches
    const order = Array.from({ length: nf }, (_, f) => f).sort((a, b) => (m.materialIndex[a] ?? 0) - (m.materialIndex[b] ?? 0));
    const tmp: number[] = [];
    for (const f of order) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      if (e - s < 3) continue;
      if (opts.smoothGroups !== false) {
        const sm = m.smooth[f] ? 1 : 0;
        if (sm !== lastSmooth) {
          out.push(`s ${sm}`);
          lastSmooth = sm;
        }
      }
      if (useMats) {
        const id = m.materials[m.materialIndex[f] ?? 0] ?? null;
        const mat = id ? scene.materials.get(id) : undefined;
        const name = mat ? safeName(mat.name) : null;
        if (name && name !== lastMat) {
          out.push(`usemtl ${name}`);
          usedMats.add(id!);
          lastMat = name;
        }
      }
      if (opts.triangulate && e - s > 3) {
        tmp.length = 0;
        triangulatePoly(m.positions, m.indices.subarray(s, e), tmp, s);
        for (let t = 0; t < tmp.length; t += 3) {
          const tri = flip ? [tmp[t], tmp[t + 2], tmp[t + 1]] : [tmp[t], tmp[t + 1], tmp[t + 2]];
          out.push(`f ${tri.map(corner).join(' ')}`);
        }
      } else {
        const cs: number[] = [];
        for (let c = s; c < e; c++) cs.push(c);
        if (flip) cs.reverse();
        out.push(`f ${cs.map(corner).join(' ')}`);
      }
    }
    vBase += nv;
  }
  // MTL
  let mtl: string | null = null;
  const textures: ObjOutput['textures'] = [];
  if (useMats && usedMats.size) {
    const texName = new Map<string, string>();
    const texFile = (ref: ExportTexRef | undefined): string | null => {
      if (!ref) return null;
      let n = texName.get(ref.imageId);
      if (!n) {
        const img = scene.doc.images[ref.imageId];
        if (!img) return null;
        const ext = img.bytes ? extOfMime(img.mime) : '.png';
        let base = safeName(img.name.replace(/\.(png|jpe?g|webp|bmp|gif|tga|tiff?)$/i, '')) + ext;
        while (textures.some((t) => t.name === base)) base = `_${base}`;
        n = base;
        texName.set(ref.imageId, n);
        textures.push({ name: n, bytes: img.bytes, imageId: ref.imageId });
      }
      return n;
    };
    const lines = ['# Puter 3D MTL File', `# Material Count: ${usedMats.size}`];
    for (const id of usedMats) {
      const m = scene.materials.get(id)!;
      lines.push('', ...mtlLines(m, texFile));
    }
    mtl = lines.join('\n') + '\n';
  }
  return { obj: out.join('\n') + '\n', mtl, textures, warnings };
}

function mtlLines(m: ExportMaterial, texFile: (r: ExportTexRef | undefined) => string | null): string[] {
  const c3 = (c: number[]) => `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`;
  const out = [`newmtl ${safeName(m.name)}`];
  out.push(`Ns ${fmt((1 - m.roughness) ** 2 * 1000)}`);
  out.push(`Ka ${m.metallic > 0 ? c3([m.metallic, m.metallic, m.metallic]) : c3([1, 1, 1])}`);
  if (!m.baseColorTex) out.push(`Kd ${c3(m.baseColor)}`);
  const sp = m.specular ?? 0.5;
  out.push(`Ks ${c3([sp, sp, sp])}`);
  const e = m.emissive ?? [0, 0, 0],
    es = m.emissiveStrength ?? 1;
  out.push(`Ke ${c3(e.map((x) => x * es))}`);
  out.push(`Ni ${fmt(m.ior ?? 1.5)}`);
  out.push(`d ${fmt(m.baseColor[3])}`);
  out.push(`illum ${m.metallic > 0 ? 3 : 2}`);
  const mapArgs = (r: ExportTexRef) => {
    let s = '';
    if (r.offset) s += ` -o ${fmt(r.offset[0])} ${fmt(-r.offset[1])} 0`;
    if (r.scale) s += ` -s ${fmt(r.scale[0])} ${fmt(r.scale[1])} 1`;
    return s;
  };
  const add = (key: string, r: ExportTexRef | undefined, extra = '') => {
    const f = texFile(r);
    if (f && r) out.push(`${key}${extra}${mapArgs(r)} ${f}`);
  };
  add('map_Kd', m.baseColorTex);
  add('map_Pr', m.roughnessTex);
  add('map_Pm', m.metallicTex);
  add('map_Ke', m.emissiveTex);
  add('map_d', m.alphaTex);
  if (m.normalTex) add('map_Bump', m.normalTex, m.normalTex.strength !== undefined && m.normalTex.strength !== 1 ? ` -bm ${fmt(m.normalTex.strength)}` : '');
  return out;
}
