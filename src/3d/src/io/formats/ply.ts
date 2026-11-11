// Stanford PLY (ASCII, binary little/big endian) reader and writer: n-gon faces, normals,
// UVs and vertex colors.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { emptyScene, type IRMesh, type IRScene } from './ir';
import { axisConversion, linearToSrgb, srgbToLinear, transpose3, type AxisId } from './common';
import type { ExportScene } from './scene-builder';
import { triangulatePoly } from '../../mesh/mesh';

export interface PlyReadOptions {
  forward?: AxisId;
  up?: AxisId;
  scale?: number;
  name?: string;
  /** how 8-bit/float colors in the file are interpreted */
  colorSpace?: 'SRGB' | 'LINEAR' | 'NONE';
  mergeVertices?: boolean;
}

type PlyType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';
const TYPE_ALIASES: Record<string, PlyType> = {
  int8: 'char',
  uint8: 'uchar',
  int16: 'short',
  uint16: 'ushort',
  int32: 'int',
  uint32: 'uint',
  float32: 'float',
  float64: 'double',
  char: 'char',
  uchar: 'uchar',
  short: 'short',
  ushort: 'ushort',
  int: 'int',
  uint: 'uint',
  float: 'float',
  double: 'double',
};
const TYPE_SIZE: Record<PlyType, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

interface PlyProp {
  name: string;
  type: PlyType;
  list?: PlyType;
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

function readValue(dv: DataView, o: number, t: PlyType, le: boolean): number {
  switch (t) {
    case 'char':
      return dv.getInt8(o);
    case 'uchar':
      return dv.getUint8(o);
    case 'short':
      return dv.getInt16(o, le);
    case 'ushort':
      return dv.getUint16(o, le);
    case 'int':
      return dv.getInt32(o, le);
    case 'uint':
      return dv.getUint32(o, le);
    case 'float':
      return dv.getFloat32(o, le);
    case 'double':
      return dv.getFloat64(o, le);
  }
}

export function readPly(bytes: Uint8Array, opts: PlyReadOptions = {}): IRScene {
  const ir = emptyScene();
  const axis = axisConversion(opts.forward ?? 'Y', opts.up ?? 'Z');
  if (!axis) throw new Error('Forward and Up axes must be different');
  ir.axis = axis;
  ir.unitScale = opts.scale ?? 1;
  // header
  const headText = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  if (!headText.startsWith('ply')) throw new Error('Not a PLY file');
  const endIdx = headText.search(/end_header\r?\n/);
  if (endIdx < 0) throw new Error('PLY header is incomplete');
  const headerEnd = endIdx + headText.slice(endIdx).indexOf('\n') + 1;
  const elements: PlyElement[] = [];
  let format = 'ascii';
  for (const raw of headText.slice(0, endIdx).split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ name: t[4], type: TYPE_ALIASES[t[3]] ?? 'int', list: TYPE_ALIASES[t[2]] ?? 'uchar' });
      else el.props.push({ name: t[2], type: TYPE_ALIASES[t[1]] ?? 'float' });
    }
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) throw new Error(`Unsupported PLY format "${format}"`);
  const data: Record<string, Record<string, number[] | number[][]>> = {};
  if (format === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd));
    const toks = body.split(/\s+/).filter(Boolean);
    let p = 0;
    for (const el of elements) {
      const cols: Record<string, number[] | number[][]> = {};
      for (const pr of el.props) cols[pr.name] = [];
      for (let i = 0; i < el.count && el.props.length; i++) {
        for (const pr of el.props) {
          if (pr.list) {
            const n = parseInt(toks[p++], 10);
            if (n > toks.length - p) throw new Error('The PLY file is truncated');
            const arr: number[] = [];
            for (let k = 0; k < n; k++) arr.push(Number(toks[p++]));
            (cols[pr.name] as number[][]).push(arr);
          } else (cols[pr.name] as number[]).push(Number(toks[p++]));
        }
        // a declared count larger than the data must not fill memory with empty values
        if (p > toks.length) throw new Error('The PLY file is truncated');
      }
      data[el.name] = cols;
    }
  } else {
    const le = format === 'binary_little_endian';
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = headerEnd;
    const fits = (n: number) => {
      if (o + n > bytes.length) throw new Error('The PLY file is truncated');
    };
    for (const el of elements) {
      const cols: Record<string, number[] | number[][]> = {};
      for (const pr of el.props) cols[pr.name] = [];
      for (let i = 0; i < el.count && el.props.length; i++)
        for (const pr of el.props) {
          if (pr.list) {
            fits(TYPE_SIZE[pr.list]);
            const n = readValue(dv, o, pr.list, le);
            o += TYPE_SIZE[pr.list];
            fits(n * TYPE_SIZE[pr.type]);
            const arr: number[] = new Array(n);
            for (let k = 0; k < n; k++) {
              arr[k] = readValue(dv, o, pr.type, le);
              o += TYPE_SIZE[pr.type];
            }
            (cols[pr.name] as number[][]).push(arr);
          } else {
            fits(TYPE_SIZE[pr.type]);
            (cols[pr.name] as number[]).push(readValue(dv, o, pr.type, le));
            o += TYPE_SIZE[pr.type];
          }
          if (o > bytes.length) throw new Error('The PLY file is truncated');
        }
      data[el.name] = cols;
    }
  }
  const vEl = elements.find((e) => e.name === 'vertex');
  const V = data.vertex as Record<string, number[]> | undefined;
  if (!vEl || !V?.x) throw new Error('The PLY file has no vertices');
  const nv = vEl.count;
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = V.x[i];
    positions[i * 3 + 1] = V.y?.[i] ?? 0;
    positions[i * 3 + 2] = V.z?.[i] ?? 0;
  }
  const fEl = elements.find((e) => e.name === 'face');
  const listName = fEl?.props.find((p) => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index'))?.name ?? fEl?.props.find((p) => p.list)?.name;
  const faces = (fEl && listName ? (data.face[listName] as number[][]) : []).filter((f) => f.length >= 3);
  const uName = ['s', 'u', 'texture_u', 'texture_s'].find((n) => V[n]);
  const vName = ['t', 'v', 'texture_v', 'texture_t'].find((n) => V[n]);
  const hasN = !!(V.nx && V.ny && V.nz);
  const colType = vEl.props.find((p) => p.name === 'red' || p.name === 'r')?.type;
  const cr = V.red ?? V.r,
    cg = V.green ?? V.g,
    cb = V.blue ?? V.b,
    ca = V.alpha ?? V.a;
  const faceSizes = Uint32Array.from(faces.map((f) => f.length));
  const indices = Uint32Array.from(faces.flat());
  for (const i of indices) if (i >= nv) throw new Error('A PLY face references a missing vertex');
  const perCorner = (get: (v: number) => number[], k: number) => {
    const out = new Float32Array(indices.length * k);
    for (let c = 0; c < indices.length; c++) out.set(get(indices[c]), c * k);
    return out;
  };
  const mesh: IRMesh = {
    name: opts.name ?? 'PLY',
    positions,
    faceSizes,
    indices,
    materials: [],
    uvs: uName && vName ? perCorner((v) => [V[uName][v], V[vName][v]], 2) : undefined,
    normals: hasN ? perCorner((v) => [V.nx[v], V.ny[v], V.nz[v]], 3) : undefined,
  };
  if (!hasN) mesh.smooth = new Uint8Array(faces.length);
  if (cr && cg && cb && opts.colorSpace !== 'NONE') {
    const scale = colType === 'float' || colType === 'double' ? 1 : colType === 'ushort' ? 65535 : 255;
    const conv = opts.colorSpace === 'LINEAR' ? (x: number) => x : srgbToLinear;
    const d = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      d[i * 4] = conv(cr[i] / scale);
      d[i * 4 + 1] = conv(cg[i] / scale);
      d[i * 4 + 2] = conv(cb[i] / scale);
      d[i * 4 + 3] = ca ? ca[i] / scale : 1;
    }
    mesh.colors = [{ name: 'Col', domain: 'POINT', data: d }];
  }
  const eEl = elements.find((e) => e.name === 'edge');
  if (eEl?.count) ir.warnings.push(`${eEl.count} edge element(s) were not imported`);
  if (!faces.length) ir.warnings.push('The PLY file contains points only; point clouds are not imported');
  else {
    ir.meshes.push(mesh);
    ir.nodes.push({ name: mesh.name, parent: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], mesh: 0 });
  }
  return ir;
}

export interface PlyWriteOptions {
  ascii?: boolean;
  forward?: AxisId;
  up?: AxisId;
  scale?: number;
  normals?: boolean;
  uvs?: boolean;
  colors?: 'SRGB' | 'LINEAR' | 'NONE';
  triangulate?: boolean;
}

export function writePly(scene: ExportScene, opts: PlyWriteOptions = {}): { bytes: Uint8Array | string; warnings: string[] } {
  const warnings = [...scene.warnings];
  const axis = axisConversion(opts.forward ?? 'Y', opts.up ?? 'Z');
  if (!axis) throw new Error('Forward and Up axes must be different');
  const A = transpose3(axis);
  const s = opts.scale ?? 1;
  const conv = new Matrix4().set(A[0] * s, A[1] * s, A[2] * s, 0, A[3] * s, A[4] * s, A[5] * s, 0, A[6] * s, A[7] * s, A[8] * s, 0, 0, 0, 0, 1);
  const P: number[] = [],
    N: number[] = [],
    T: number[] = [],
    C: number[] = [];
  const faces: number[][] = [];
  const wantN = opts.normals !== false,
    wantT = opts.uvs !== false,
    wantC = (opts.colors ?? 'SRGB') !== 'NONE';
  const anyUv = scene.objects.some((o) => o.mesh?.uvs);
  const anyCol = scene.objects.some((o) => o.mesh?.colors.length);
  const v = new Vector3();
  const tmp: number[] = [];
  for (const eo of scene.objects) {
    const m = eo.mesh;
    if (!m) continue;
    const M = conv.clone().multiply(eo.world);
    const NM = new Matrix3().getNormalMatrix(M);
    const flip = M.determinant() < 0;
    const map = new Map<string, number>();
    const vert = (c: number) => {
      const vi = m.indices[c];
      let key = `${vi}`;
      if (wantN) key += `|${m.normals[c * 3].toFixed(5)},${m.normals[c * 3 + 1].toFixed(5)},${m.normals[c * 3 + 2].toFixed(5)}`;
      if (wantT && m.uvs) key += `|${m.uvs[c * 2]},${m.uvs[c * 2 + 1]}`;
      if (wantC && m.colors[0]) key += `|${m.colors[0].data.subarray(c * 4, c * 4 + 4).join(',')}`;
      let id = map.get(key);
      if (id === undefined) {
        id = P.length / 3;
        map.set(key, id);
        v.set(m.positions[vi * 3], m.positions[vi * 3 + 1], m.positions[vi * 3 + 2]).applyMatrix4(M);
        P.push(v.x, v.y, v.z);
        v.set(m.normals[c * 3], m.normals[c * 3 + 1], m.normals[c * 3 + 2])
          .applyMatrix3(NM)
          .normalize();
        N.push(v.x, v.y, v.z);
        T.push(m.uvs ? m.uvs[c * 2] : 0, m.uvs ? m.uvs[c * 2 + 1] : 0);
        const col = m.colors[0]?.data;
        const cv = (x: number) => (opts.colors === 'LINEAR' ? x : linearToSrgb(Math.max(0, Math.min(1, x))));
        C.push(col ? cv(col[c * 4]) : 1, col ? cv(col[c * 4 + 1]) : 1, col ? cv(col[c * 4 + 2]) : 1, col ? col[c * 4 + 3] : 1);
      }
      return id;
    };
    for (let f = 0; f < m.offsets.length - 1; f++) {
      const a = m.offsets[f],
        b = m.offsets[f + 1];
      if (b - a < 3) continue;
      if (opts.triangulate && b - a > 3) {
        tmp.length = 0;
        triangulatePoly(m.positions, m.indices.subarray(a, b), tmp, a);
        for (let t = 0; t < tmp.length; t += 3) {
          const tri = [vert(tmp[t]), vert(tmp[t + 1]), vert(tmp[t + 2])];
          faces.push(flip ? tri.reverse() : tri);
        }
      } else {
        const f2: number[] = [];
        for (let c = a; c < b; c++) f2.push(vert(c));
        faces.push(flip ? f2.reverse() : f2);
      }
    }
  }
  const nv = P.length / 3;
  if (!faces.length) warnings.push('No mesh faces were exported');
  const withT = wantT && anyUv,
    withC = wantC && anyCol;
  const header = [
    'ply',
    `format ${opts.ascii ? 'ascii' : 'binary_little_endian'} 1.0`,
    'comment Created by Puter 3D',
    `element vertex ${nv}`,
    'property float x',
    'property float y',
    'property float z',
  ];
  if (wantN) header.push('property float nx', 'property float ny', 'property float nz');
  if (withT) header.push('property float s', 'property float t');
  if (withC) header.push('property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha');
  header.push(`element face ${faces.length}`, 'property list uchar uint vertex_indices', 'end_header');
  const b8 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  if (opts.ascii) {
    const out = [...header];
    for (let i = 0; i < nv; i++) {
      const row = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]].map((x) => +x.toFixed(6));
      if (wantN) row.push(...[N[i * 3], N[i * 3 + 1], N[i * 3 + 2]].map((x) => +x.toFixed(6)));
      if (withT) row.push(+T[i * 2].toFixed(6), +T[i * 2 + 1].toFixed(6));
      if (withC) row.push(b8(C[i * 4]), b8(C[i * 4 + 1]), b8(C[i * 4 + 2]), b8(C[i * 4 + 3]));
      out.push(row.join(' '));
    }
    for (const f of faces) out.push(`${f.length} ${f.join(' ')}`);
    return { bytes: out.join('\n') + '\n', warnings };
  }
  for (const f of faces) if (f.length > 255) throw new Error('Faces with more than 255 vertices cannot be written to binary PLY');
  const vsize = 12 + (wantN ? 12 : 0) + (withT ? 8 : 0) + (withC ? 4 : 0);
  let fsize = 0;
  for (const f of faces) fsize += 1 + f.length * 4;
  const head = new TextEncoder().encode(header.join('\n') + '\n');
  const out = new Uint8Array(head.length + nv * vsize + fsize);
  out.set(head, 0);
  const dv = new DataView(out.buffer);
  let o = head.length;
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++, o += 4) dv.setFloat32(o, P[i * 3 + k], true);
    if (wantN) for (let k = 0; k < 3; k++, o += 4) dv.setFloat32(o, N[i * 3 + k], true);
    if (withT) for (let k = 0; k < 2; k++, o += 4) dv.setFloat32(o, T[i * 2 + k], true);
    if (withC) for (let k = 0; k < 4; k++, o++) dv.setUint8(o, b8(C[i * 4 + k]));
  }
  for (const f of faces) {
    dv.setUint8(o++, f.length);
    for (const i of f) {
      dv.setUint32(o, i, true);
      o += 4;
    }
  }
  return { bytes: out, warnings };
}
