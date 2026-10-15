// Editable polygon mesh used by Edit Mode operators. It converts from/to MeshData
// and carries per-vertex (weights, shape keys, point colors, selection, hidden) and
// per-face (smooth, material, corner UVs/seams/sharp/creases/colors) attributes through
// topology changes.
import type { MeshData } from '../../data/types';
import { buildMesh, polyNormal } from '../../mesh/mesh';
import { exclusionsOf, setExclusions } from './selset';
import type { Vec3 } from '../../data/types';

export interface EFace {
  verts: number[];
  uvs: number[]; // 2 per corner
  smooth: boolean;
  material: number;
  seams: number[]; // per corner: edge corner→next
  sharp: number[];
  creases: number[];
  colors?: number[]; // 4 per corner (corner-domain color attribute)
  /** custom split normals, 3 per corner (dropped when the corner count no longer matches) */
  cnormals?: number[];
  /** selection flag kept for face-mode bookkeeping (derived from verts when synced) */
  hidden?: boolean;
  /** Edge/Face select mode: all vertices are selected but the face itself is not */
  selX?: boolean;
}

export class MeshEdit {
  pos: number[] = [];
  faces: EFace[] = [];
  sel: number[] = [];
  hide: number[] = [];
  /** per group per vertex */
  weights: number[][] = [];
  /** shape key absolute positions (excluding the evaluated mix), per key */
  keys: number[][] = [];
  /** POINT-domain color attributes (4 per vertex) */
  pcolors: number[][] = [];
  /** loose edges as vertex pairs (edges not belonging to any face) */
  looseEdges: [number, number][] = [];
  /** Edge/Face select mode: edges whose vertices are selected but which are not selected */
  edgeExcl = new Set<string>();

  get vcount() {
    return this.pos.length / 3;
  }

  static from(me: MeshData): MeshEdit {
    const m = new MeshEdit();
    m.pos = Array.from(me.positions);
    const nv = me.positions.length / 3;
    m.sel = me.select_vert ? Array.from(me.select_vert) : new Array(nv).fill(0);
    m.hide = me.hide_vert ? Array.from(me.hide_vert) : new Array(nv).fill(0);
    m.weights = me.weights.map((w) => Array.from(w));
    m.keys = me.shape_keys.map((k) => Array.from(k.data));
    const cornerColor = me.color_attributes.findIndex((c) => c.domain === 'CORNER');
    const cn = me.custom_normals && me.custom_normals.length === me.indices.length * 3 ? me.custom_normals : null;
    m.pcolors = me.color_attributes.filter((c) => c.domain === 'POINT').map((c) => Array.from(c.data));
    for (let f = 0; f < me.offsets.length - 1; f++) {
      const a = me.offsets[f],
        b = me.offsets[f + 1];
      m.faces.push({
        verts: Array.from(me.indices.subarray(a, b)),
        uvs: Array.from(me.uvs.subarray(a * 2, b * 2)),
        smooth: !!me.smooth?.[f],
        material: me.material_index?.[f] ?? 0,
        seams: me.seams ? Array.from(me.seams.subarray(a, b)) : new Array(b - a).fill(0),
        sharp: me.sharp ? Array.from(me.sharp.subarray(a, b)) : new Array(b - a).fill(0),
        creases: me.creases ? Array.from(me.creases.subarray(a, b)) : new Array(b - a).fill(0),
        colors: cornerColor >= 0 ? Array.from(me.color_attributes[cornerColor].data.subarray(a * 4, b * 4)) : undefined,
        cnormals: cn ? Array.from(cn.subarray(a * 3, b * 3)) : undefined,
      });
    }
    const loose = me.loose_edges;
    if (loose) for (let i = 0; i < loose.length; i += 2) m.looseEdges.push([loose[i], loose[i + 1]]);
    const ex = exclusionsOf(me);
    if (ex) {
      for (const f of ex.faces) if (m.faces[f]) m.faces[f].selX = true;
      m.edgeExcl = new Set(ex.edges);
    }
    return m;
  }

  /** Write back into the mesh data-block (replacing arrays). */
  write(me: MeshData) {
    const built = buildMesh(this.pos, this.faces.map((f) => ({ verts: f.verts, uvs: f.uvs, smooth: f.smooth, material: f.material, seams: f.seams, sharp: f.sharp, creases: f.creases })));
    me.positions = built.positions;
    me.offsets = built.offsets;
    me.indices = built.indices;
    me.uvs = built.uvs;
    me.normals = built.normals;
    me.smooth = built.smooth;
    me.material_index = built.material_index;
    me.seams = this.faces.some((f) => f.seams.some(Boolean)) ? built.seams ?? new Uint32Array(built.indices.length) : undefined;
    me.sharp = this.faces.some((f) => f.sharp.some(Boolean)) ? built.sharp : undefined;
    me.creases = this.faces.some((f) => f.creases.some(Boolean)) ? built.creases : undefined;
    me.select_vert = Uint8Array.from(this.sel);
    me.hide_vert = this.hide.some(Boolean) ? Uint8Array.from(this.hide) : undefined;
    me.weights = this.weights.map((w) => Float32Array.from(w));
    me.shape_keys = me.shape_keys.map((k, i) => ({ ...k, data: Float32Array.from(this.keys[i] ?? this.pos) }));
    let pi = 0;
    me.color_attributes = me.color_attributes.map((c) => {
      if (c.domain === 'POINT') return { ...c, data: Float32Array.from(this.pcolors[pi++] ?? []) };
      const data = new Float32Array(built.indices.length * 4).fill(1);
      let k = 0;
      for (const f of this.faces) {
        for (let i = 0; i < f.verts.length; i++, k++) for (let j = 0; j < 4; j++) data[k * 4 + j] = f.colors?.[i * 4 + j] ?? 1;
      }
      return { ...c, data };
    });
    me.loose_edges = this.looseEdges.length ? Uint32Array.from(this.looseEdges.flat()) : undefined;
    me.custom_normals = this.customNormals();
    // keep the exact edge/face selection with the new selection array
    const sel = this.sel;
    const faces = new Set<number>();
    this.faces.forEach((f, i) => {
      if (f.selX && f.verts.every((v) => sel[v])) faces.add(i);
    });
    const edges = new Set<string>();
    if (this.edgeExcl.size) {
      const all = new Set(this.edges().map(([a, b]) => edgeKey(a, b)));
      for (const k of this.edgeExcl) {
        const [a, b] = k.split(':').map(Number);
        if (sel[a] && sel[b] && all.has(k)) edges.add(k);
      }
    }
    setExclusions(me.select_vert, { faces, edges });
  }

  /** Per-corner custom normals, or undefined when no face carries any (missing ones get the automatic normal). */
  customNormals(): Float32Array | undefined {
    if (!this.faces.some((f) => f.cnormals && f.cnormals.length === f.verts.length * 3)) return undefined;
    return this.cornerNormalsWith(true);
  }

  /** The automatic shading normal of every corner (flat faces: face normal; smooth: vertex normal). */
  customNormalsAuto(): Float32Array {
    return this.cornerNormalsWith(false);
  }

  private cornerNormalsWith(useCustom: boolean): Float32Array {
    const vn = new Float32Array(this.pos.length);
    for (const f of this.faces) {
      const n = this.faceNormal(f);
      for (const v of f.verts) for (let k = 0; k < 3; k++) vn[v * 3 + k] += n[k];
    }
    const out: number[] = [];
    for (const f of this.faces) {
      if (useCustom && f.cnormals && f.cnormals.length === f.verts.length * 3) {
        out.push(...f.cnormals);
        continue;
      }
      const fn = this.faceNormal(f);
      for (const v of f.verts) {
        if (!f.smooth) out.push(...fn);
        else {
          const x = vn[v * 3],
            y = vn[v * 3 + 1],
            z = vn[v * 3 + 2];
          const l = Math.hypot(x, y, z) || 1;
          out.push(x / l, y / l, z / l);
        }
      }
    }
    return Float32Array.from(out);
  }

  /** Deep copy (used by modal tools that recompute from a snapshot). */
  clone(): MeshEdit {
    const c = new MeshEdit();
    c.pos = this.pos.slice();
    c.sel = this.sel.slice();
    c.hide = this.hide.slice();
    c.weights = this.weights.map((w) => w.slice());
    c.keys = this.keys.map((k) => k.slice());
    c.pcolors = this.pcolors.map((k) => k.slice());
    c.looseEdges = this.looseEdges.map((e) => [e[0], e[1]] as [number, number]);
    c.edgeExcl = new Set(this.edgeExcl);
    c.faces = this.faces.map((f) => ({ ...f, verts: [...f.verts], uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined, cnormals: f.cnormals ? [...f.cnormals] : undefined }));
    return c;
  }

  p(i: number): Vec3 {
    return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
  }

  setP(i: number, v: ArrayLike<number>) {
    this.pos[i * 3] = v[0];
    this.pos[i * 3 + 1] = v[1];
    this.pos[i * 3 + 2] = v[2];
  }

  /** Append a vertex interpolated from sources (weights sum to 1). */
  addVert(p: ArrayLike<number>, from: [number, number][] = [], select = 1): number {
    const i = this.vcount;
    this.pos.push(p[0], p[1], p[2]);
    this.sel.push(select);
    this.hide.push(0);
    for (const w of this.weights) {
      let v = 0;
      for (const [s, t] of from) v += (w[s] ?? 0) * t;
      w.push(v);
    }
    for (const k of this.keys) {
      if (!from.length) {
        k.push(p[0], p[1], p[2]);
        continue;
      }
      // keep the shape-key offset of the sources
      let ox = 0,
        oy = 0,
        oz = 0;
      for (const [s, t] of from) {
        ox += (k[s * 3] - this.pos[s * 3]) * t;
        oy += (k[s * 3 + 1] - this.pos[s * 3 + 1]) * t;
        oz += (k[s * 3 + 2] - this.pos[s * 3 + 2]) * t;
      }
      k.push(p[0] + ox, p[1] + oy, p[2] + oz);
    }
    for (const c of this.pcolors) {
      const v = [0, 0, 0, 0];
      if (!from.length) v.fill(1);
      for (const [s, t] of from) for (let j = 0; j < 4; j++) v[j] += (c[s * 4 + j] ?? 1) * t;
      c.push(...v);
    }
    return i;
  }

  /** Create a face copying attributes from a template face. */
  makeFace(verts: number[], template?: EFace, uvs?: number[]): EFace {
    const n = verts.length;
    return {
      verts,
      uvs: uvs ?? new Array(n * 2).fill(0),
      smooth: template?.smooth ?? false,
      material: template?.material ?? 0,
      seams: new Array(n).fill(0),
      sharp: new Array(n).fill(0),
      creases: new Array(n).fill(0),
      colors: template?.colors ? new Array(n * 4).fill(1) : undefined,
    };
  }

  /** Remove unused vertices (not referenced by faces or loose edges), remapping attributes. */
  compact(keepLoose = true): number[] {
    const used = new Uint8Array(this.vcount);
    for (const f of this.faces) for (const v of f.verts) used[v] = 1;
    if (keepLoose) for (const [a, b] of this.looseEdges) used[a] = used[b] = 1;
    return this.keepVerts(used);
  }

  /** Keep only flagged vertices; returns old→new map (-1 removed). */
  keepVerts(keep: ArrayLike<number>): number[] {
    const map: number[] = new Array(this.vcount).fill(-1);
    let n = 0;
    for (let i = 0; i < this.vcount; i++) if (keep[i]) map[i] = n++;
    const pick = <T>(arr: T[], stride: number) => {
      const out: T[] = [];
      for (let i = 0; i < map.length; i++) if (map[i] >= 0) for (let k = 0; k < stride; k++) out.push(arr[i * stride + k]);
      return out;
    };
    this.pos = pick(this.pos, 3);
    this.sel = pick(this.sel, 1);
    this.hide = pick(this.hide, 1);
    this.weights = this.weights.map((w) => pick(w, 1));
    this.keys = this.keys.map((k) => pick(k, 3));
    this.pcolors = this.pcolors.map((c) => pick(c, 4));
    for (const f of this.faces) f.verts = f.verts.map((v) => map[v]);
    this.faces = this.faces.filter((f) => f.verts.every((v) => v >= 0));
    this.looseEdges = this.looseEdges.map(([a, b]) => [map[a], map[b]] as [number, number]).filter(([a, b]) => a >= 0 && b >= 0);
    this.remapEdgeExcl(map);
    return map;
  }

  /** Remap vertices (e.g. after merging) and drop degenerate faces. */
  remap(map: number[]) {
    for (const f of this.faces) {
      const verts: number[] = [],
        uvs: number[] = [],
        seams: number[] = [],
        sharp: number[] = [],
        creases: number[] = [],
        colors: number[] = [];
      f.verts.forEach((v, i) => {
        const nv = map[v];
        if (verts.length && verts[verts.length - 1] === nv) return;
        verts.push(nv);
        uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
        seams.push(f.seams[i]);
        sharp.push(f.sharp[i]);
        creases.push(f.creases[i]);
        if (f.colors) colors.push(...f.colors.slice(i * 4, i * 4 + 4));
      });
      while (verts.length > 1 && verts[0] === verts[verts.length - 1]) {
        verts.pop();
        uvs.length -= 2;
        seams.pop();
        sharp.pop();
        creases.pop();
        if (f.colors) colors.length -= 4;
      }
      f.verts = verts;
      f.uvs = uvs;
      f.seams = seams;
      f.sharp = sharp;
      f.creases = creases;
      if (f.colors) f.colors = colors;
    }
    this.faces = this.faces.filter((f) => new Set(f.verts).size >= 3 && f.verts.length === new Set(f.verts).size);
    this.looseEdges = this.looseEdges.map(([a, b]) => [map[a], map[b]] as [number, number]).filter(([a, b]) => a !== b);
    this.remapEdgeExcl(map);
    this.compact();
  }

  private remapEdgeExcl(map: number[]) {
    if (!this.edgeExcl.size) return;
    const out = new Set<string>();
    for (const k of this.edgeExcl) {
      const [a, b] = k.split(':').map(Number);
      const x = map[a],
        y = map[b];
      if (x >= 0 && y >= 0 && x !== y && x !== undefined && y !== undefined) out.add(edgeKey(x, y));
    }
    this.edgeExcl = out;
  }

  // -------------------------------------------------------------------------
  // queries

  faceNormal(f: EFace): Vec3 {
    return polyNormal(this.pos, f.verts);
  }

  faceCenter(f: EFace): Vec3 {
    const c: Vec3 = [0, 0, 0];
    for (const v of f.verts) {
      c[0] += this.pos[v * 3];
      c[1] += this.pos[v * 3 + 1];
      c[2] += this.pos[v * 3 + 2];
    }
    return [c[0] / f.verts.length, c[1] / f.verts.length, c[2] / f.verts.length];
  }

  isFaceSelected(f: EFace) {
    return f.verts.every((v) => this.sel[v]);
  }

  /** Map "a:b" (a<b) → list of [faceIndex, cornerIndex] using that edge. */
  edgeFaces(): Map<string, [number, number][]> {
    const m = new Map<string, [number, number][]>();
    this.faces.forEach((f, fi) => {
      const n = f.verts.length;
      for (let i = 0; i < n; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % n];
        const k = a < b ? `${a}:${b}` : `${b}:${a}`;
        let l = m.get(k);
        if (!l) m.set(k, (l = []));
        l.push([fi, i]);
      }
    });
    return m;
  }

  /** All edges (face edges + loose edges) as unique pairs. */
  edges(): [number, number][] {
    const seen = new Set<string>(),
      out: [number, number][] = [];
    const add = (a: number, b: number) => {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(a < b ? [a, b] : [b, a]);
    };
    for (const f of this.faces) for (let i = 0; i < f.verts.length; i++) add(f.verts[i], f.verts[(i + 1) % f.verts.length]);
    for (const [a, b] of this.looseEdges) add(a, b);
    return out;
  }

  vertexFaces(): number[][] {
    const out: number[][] = Array.from({ length: this.vcount }, () => []);
    this.faces.forEach((f, fi) => f.verts.forEach((v) => out[v].push(fi)));
    return out;
  }

  neighbors(): number[][] {
    const out: number[][] = Array.from({ length: this.vcount }, () => []);
    for (const [a, b] of this.edges()) {
      out[a].push(b);
      out[b].push(a);
    }
    return out;
  }

  selectedVerts(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.sel.length; i++) if (this.sel[i] && !this.hide[i]) out.push(i);
    return out;
  }

  selectedFaces(): number[] {
    const out: number[] = [];
    this.faces.forEach((f, i) => {
      if (!f.selX && f.verts.every((v) => this.sel[v] && !this.hide[v])) out.push(i);
    });
    return out;
  }

  selectedEdges(): [number, number][] {
    return this.edges().filter(([a, b]) => this.sel[a] && this.sel[b] && !this.hide[a] && !this.hide[b] && !this.edgeExcl.has(edgeKey(a, b)));
  }
}

export const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
