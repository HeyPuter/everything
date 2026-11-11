// STL (binary and ASCII) reader and writer.
import { Matrix4, Vector3 } from 'three';
import { emptyScene, type IRScene } from './ir';
import { axisConversion, transpose3, type AxisId } from './common';
import type { ExportScene } from './scene-builder';
import { triangulatePoly } from '../../mesh/mesh';

export interface StlReadOptions {
  forward?: AxisId;
  up?: AxisId;
  scale?: number;
  name?: string;
  /** weld identical positions into connected geometry (default true) */
  mergeVertices?: boolean;
}

export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  if (84 + n * 50 === bytes.length) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length))).trimStart();
  return !(head.startsWith('solid') && /facet|endsolid/.test(new TextDecoder().decode(bytes.subarray(0, Math.min(4096, bytes.length)))));
}

export function readStl(bytes: Uint8Array, opts: StlReadOptions = {}): IRScene {
  const ir = emptyScene();
  const axis = axisConversion(opts.forward ?? 'Y', opts.up ?? 'Z');
  if (!axis) throw new Error('Forward and Up axes must be different');
  ir.axis = axis;
  ir.unitScale = opts.scale ?? 1;
  const tri: number[] = [];
  let colored = false;
  const colors: number[] = [];
  if (isBinaryStl(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 > bytes.length) throw new Error('The STL file is truncated');
    // Materialise Magics: "COLOR=" + RGBA bytes in the header is the object color; a facet whose
    // attribute bit 15 is clear has its own 5-bit color (red in the low bits)
    const header = new TextDecoder('latin1').decode(bytes.subarray(0, 80));
    const at = header.indexOf('COLOR=');
    const colorHeader = at >= 0 && at + 9 < 80;
    const base = colorHeader ? [bytes[at + 6] / 255, bytes[at + 7] / 255, bytes[at + 8] / 255] : [1, 1, 1];
    colored = colorHeader;
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50;
      for (let k = 0; k < 9; k++) tri.push(dv.getFloat32(o + 12 + k * 4, true));
      const attr = dv.getUint16(o + 48, true);
      if (colorHeader && !(attr & 0x8000)) colors.push((attr & 31) / 31, ((attr >> 5) & 31) / 31, ((attr >> 10) & 31) / 31);
      else colors.push(base[0], base[1], base[2]);
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) tri.push(+m[1], +m[2], +m[3]);
    tri.length -= tri.length % 9;
  }
  const nt = tri.length / 9;
  if (!nt) throw new Error('The STL file contains no triangles');
  const positions: number[] = [];
  const indices = new Uint32Array(nt * 3);
  const map = new Map<string, number>();
  for (let i = 0; i < nt * 3; i++) {
    const x = tri[i * 3],
      y = tri[i * 3 + 1],
      z = tri[i * 3 + 2];
    let id: number | undefined;
    if (opts.mergeVertices !== false) {
      const key = `${x},${y},${z}`;
      id = map.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        map.set(key, id);
        positions.push(x, y, z);
      }
    } else {
      id = positions.length / 3;
      positions.push(x, y, z);
    }
    indices[i] = id;
  }
  const mesh = {
    name: opts.name ?? 'STL',
    positions: Float32Array.from(positions),
    faceSizes: new Uint32Array(nt).fill(3),
    indices,
    smooth: new Uint8Array(nt),
    materials: [],
    colors: colored
      ? [
          {
            name: 'Color',
            domain: 'CORNER' as const,
            data: Float32Array.from({ length: nt * 12 }, (_, i) => {
              const t = Math.floor(i / 12),
                k = i % 4;
              return k === 3 ? 1 : colors[t * 3 + k];
            }),
          },
        ]
      : undefined,
  };
  ir.meshes.push(mesh);
  ir.nodes.push({ name: mesh.name, parent: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], mesh: 0 });
  return ir;
}

export interface StlWriteOptions {
  ascii?: boolean;
  forward?: AxisId;
  up?: AxisId;
  scale?: number;
  name?: string;
}

/** Triangles of all exported meshes in world space (file axes). */
export function worldTriangles(scene: ExportScene, forward: AxisId, up: AxisId, scale: number): Float32Array {
  const axis = axisConversion(forward, up);
  if (!axis) throw new Error('Forward and Up axes must be different');
  const A = transpose3(axis);
  const conv = new Matrix4().set(A[0] * scale, A[1] * scale, A[2] * scale, 0, A[3] * scale, A[4] * scale, A[5] * scale, 0, A[6] * scale, A[7] * scale, A[8] * scale, 0, 0, 0, 0, 1);
  const out: number[] = [];
  const v = new Vector3();
  const tmp: number[] = [];
  for (const eo of scene.objects) {
    const m = eo.mesh;
    if (!m) continue;
    const M = conv.clone().multiply(eo.world);
    const flip = M.determinant() < 0;
    for (let f = 0; f < m.offsets.length - 1; f++) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      if (e - s < 3) continue;
      tmp.length = 0;
      triangulatePoly(m.positions, m.indices.subarray(s, e), tmp, s);
      for (let t = 0; t < tmp.length; t += 3) {
        const cs = flip ? [tmp[t], tmp[t + 2], tmp[t + 1]] : [tmp[t], tmp[t + 1], tmp[t + 2]];
        for (const c of cs) {
          const vi = m.indices[c];
          v.set(m.positions[vi * 3], m.positions[vi * 3 + 1], m.positions[vi * 3 + 2]).applyMatrix4(M);
          out.push(v.x, v.y, v.z);
        }
      }
    }
  }
  return Float32Array.from(out);
}

export function writeStl(scene: ExportScene, opts: StlWriteOptions = {}): { bytes: Uint8Array | string; warnings: string[] } {
  const tris = worldTriangles(scene, opts.forward ?? 'Y', opts.up ?? 'Z', opts.scale ?? 1);
  const n = tris.length / 9;
  const warnings = [...scene.warnings];
  if (!n) warnings.push('No mesh faces were exported');
  const normal = (i: number) => {
    const a = new Vector3(tris[i * 9], tris[i * 9 + 1], tris[i * 9 + 2]),
      b = new Vector3(tris[i * 9 + 3], tris[i * 9 + 4], tris[i * 9 + 5]),
      c = new Vector3(tris[i * 9 + 6], tris[i * 9 + 7], tris[i * 9 + 8]);
    const nn = b.sub(a).cross(c.sub(a));
    const l = nn.length();
    return l > 0 ? nn.multiplyScalar(1 / l) : nn.set(0, 0, 0);
  };
  const name = (opts.name ?? 'Puter3D').replace(/\s+/g, '_');
  if (opts.ascii) {
    const f = (x: number) => x.toExponential(6);
    const out: string[] = [`solid ${name}`];
    for (let i = 0; i < n; i++) {
      const nn = normal(i);
      out.push(` facet normal ${f(nn.x)} ${f(nn.y)} ${f(nn.z)}`, '  outer loop');
      for (let k = 0; k < 3; k++) out.push(`   vertex ${f(tris[i * 9 + k * 3])} ${f(tris[i * 9 + k * 3 + 1])} ${f(tris[i * 9 + k * 3 + 2])}`);
      out.push('  endloop', ' endfacet');
    }
    out.push(`endsolid ${name}`);
    return { bytes: out.join('\n') + '\n', warnings };
  }
  const bytes = new Uint8Array(84 + n * 50);
  const dv = new DataView(bytes.buffer);
  const header = new TextEncoder().encode(`Binary STL exported by Puter 3D`.slice(0, 79));
  bytes.set(header, 0);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const nn = normal(i);
    dv.setFloat32(o, nn.x, true);
    dv.setFloat32(o + 4, nn.y, true);
    dv.setFloat32(o + 8, nn.z, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tris[i * 9 + k], true);
  }
  return { bytes, warnings };
}
