// Editable polygon mesh used by Edit Mode operators. It converts from/to MeshData
// and carries per-vertex (weights, shape keys, point colors, selection, hidden) and
// per-face (smooth, material, corner UVs/seams/sharp/creases/colors) attributes through
// topology changes.
import type { MeshData, MeshAttribute } from '../../data/types';
import { attrWidth, attrDomainSize, isDiscreteAttr, makeAttrArray } from '../../mesh/attributes';
import { buildMesh, polyNormal } from '../../mesh/mesh';
import { exclusionsOf, setExclusions } from './selset';
import type { Vec3 } from '../../data/types';

/** Per-vertex float layers of MeshData that Edit Mode carries through topology changes. */
export const VERT_FLOAT_LAYERS = ['crease_vert', 'bevel_weight_vert'] as const;

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
  /** quad split along the other diagonal */
  flip?: boolean;
  /** marked for line rendering (Mark Freestyle Face) */
  fsFace?: boolean;
  /** face strength for weighted normals (0 weak, 1 medium, 2 strong) */
  strength?: number;
  /** generic FACE attribute values, per attribute index (see MeshEdit.gattrs) */
  fattr?: (number[] | undefined)[];
  /** generic CORNER attribute values (width per corner), per attribute index */
  cattr?: (number[] | undefined)[];
}

/** A generic attribute carried through Edit Mode. */
export interface GAttr {
  name: string;
  domain: MeshAttribute['domain'];
  data_type: MeshAttribute['data_type'];
  width: number;
  /** an inactive UV map (stored in MeshData.uv_layers_extra) */
  uvMap?: boolean;
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
  /** skin modifier data (4 per vertex: radius x/y, root, loose), when the mesh has it */
  skin: number[] | null = null;
  /** loose edges as vertex pairs (edges not belonging to any face) */
  looseEdges: [number, number][] = [];
  /** Edge/Face select mode: edges whose vertices are selected but which are not selected */
  edgeExcl = new Set<string>();
  /** edges marked for line rendering (vertex pair keys) */
  fsEdges = new Set<string>();
  /** vertices added on marked edges (the edge's ends), so the split parts stay marked */
  fsMid = new Map<number, [number, number]>();
  /** per-vertex float layers (VERT_FLOAT_LAYERS: vertex crease, vertex bevel weight) */
  vfloat: Record<string, number[]> = {};
  /** edge bevel weights by vertex pair key */
  ebw = new Map<string, number>();
  /** vertices added on weighted edges (the edge's ends), so the split parts keep the weight */
  ebwMid = new Map<number, [number, number]>();
  /** generic attributes: metadata, POINT values (by attribute index) and EDGE values by vertex pair key */
  gattrs: GAttr[] = [];
  vgen: number[][] = [];
  egen: Map<string, number[]>[] = [];

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
    m.skin = me.skin_vertices && me.skin_vertices.length === nv * 4 ? Array.from(me.skin_vertices) : null;
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
        flip: me.quad_flip?.[f] ? true : undefined,
        strength: me.face_strength && me.face_strength.length === me.offsets.length - 1 ? me.face_strength[f] : undefined,
        fsFace: me.freestyle_face?.[f] ? true : undefined,
      });
      if (me.freestyle_edge) for (let c = a; c < b; c++) if (me.freestyle_edge[c]) m.fsEdges.add(edgeKey(me.indices[c], me.indices[c + 1 < b ? c + 1 : a]));
    }
    const loose = me.loose_edges;
    if (loose) for (let i = 0; i < loose.length; i += 2) m.looseEdges.push([loose[i], loose[i + 1]]);
    const rec = me as unknown as Record<string, Float32Array | undefined>;
    for (const key of VERT_FLOAT_LAYERS) {
      const a = rec[key];
      if (a && a.length === nv) m.vfloat[key] = Array.from(a);
    }
    const bw = me.bevel_weight_edge;
    if (bw && bw.length === me.indices.length)
      for (let f = 0; f < me.offsets.length - 1; f++) {
        const a = me.offsets[f],
          b = me.offsets[f + 1];
        for (let c = a; c < b; c++) if (bw[c] > 0) m.ebw.set(edgeKey(me.indices[c], me.indices[c + 1 < b ? c + 1 : a]), Math.max(bw[c], m.ebw.get(edgeKey(me.indices[c], me.indices[c + 1 < b ? c + 1 : a])) ?? 0));
      }
    m.readGeneric(me);
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
    // corner layout unchanged: extra corner-domain color attributes can keep their data
    const sameCorners = built.indices.length === me.indices.length && built.offsets.length === me.offsets.length && built.indices.every((v, i) => v === me.indices[i]);
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
    me.skin_vertices = this.skin ? Float32Array.from(this.skin) : undefined;
    me.shape_keys = me.shape_keys.map((k, i) => ({ ...k, data: Float32Array.from(this.keys[i] ?? this.pos) }));
    let pi = 0;
    const firstCorner = me.color_attributes.findIndex((c) => c.domain === 'CORNER');
    me.color_attributes = me.color_attributes.map((c, ci) => {
      if (c.domain === 'POINT') return { ...c, data: Float32Array.from(this.pcolors[pi++] ?? []) };
      // only the first corner attribute travels through edits; others survive when the corners are unchanged
      if (ci !== firstCorner && sameCorners) return c;
      const data = new Float32Array(built.indices.length * 4).fill(1);
      if (ci !== firstCorner) return { ...c, data };
      let k = 0;
      for (const f of this.faces) {
        for (let i = 0; i < f.verts.length; i++, k++) for (let j = 0; j < 4; j++) data[k * 4 + j] = f.colors?.[i * 4 + j] ?? 1;
      }
      return { ...c, data };
    });
    me.loose_edges = this.looseEdges.length ? Uint32Array.from(this.looseEdges.flat()) : undefined;
    const rec = me as unknown as Record<string, Float32Array | undefined>;
    const nv = this.vcount;
    for (const key of VERT_FLOAT_LAYERS) {
      const l = this.vfloat[key];
      rec[key] = l && l.some((x) => x) ? Float32Array.from({ length: nv }, (_, i) => l[i] ?? 0) : undefined;
    }
    this.writeGeneric(me);
    me.bevel_weight_edge = this.ebw.size ? Float32Array.from(this.faces.flatMap((f) => f.verts.map((v, i) => this.edgeBevelWeight(v, f.verts[(i + 1) % f.verts.length])))) : undefined;
    if (me.bevel_weight_edge && !me.bevel_weight_edge.some(Boolean)) me.bevel_weight_edge = undefined;
    me.custom_normals = this.customNormals();
    me.face_strength = this.faces.some((f) => f.strength !== undefined && f.strength !== 1) ? Uint8Array.from(this.faces, (f) => f.strength ?? 1) : undefined;
    me.quad_flip = this.faces.some((f) => f.flip && f.verts.length === 4) ? Uint8Array.from(this.faces, (f) => (f.flip && f.verts.length === 4 ? 1 : 0)) : undefined;
    me.freestyle_face = this.faces.some((f) => f.fsFace) ? Uint8Array.from(this.faces, (f) => (f.fsFace ? 1 : 0)) : undefined;
    me.freestyle_edge = this.fsEdges.size ? Uint8Array.from(this.faces.flatMap((f) => f.verts.map((v, i) => (this.fsMarked(v, f.verts[(i + 1) % f.verts.length]) ? 1 : 0)))) : undefined;
    if (me.freestyle_edge && !me.freestyle_edge.some(Boolean)) me.freestyle_edge = undefined;
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
    c.skin = this.skin ? this.skin.slice() : null;
    c.looseEdges = this.looseEdges.map((e) => [e[0], e[1]] as [number, number]);
    c.edgeExcl = new Set(this.edgeExcl);
    c.fsEdges = new Set(this.fsEdges);
    c.fsMid = new Map(this.fsMid);
    c.vfloat = Object.fromEntries(Object.entries(this.vfloat).map(([k, v]) => [k, v.slice()]));
    c.gattrs = this.gattrs.map((g) => ({ ...g }));
    c.vgen = this.vgen.map((v) => v.slice());
    c.egen = this.egen.map((e) => new Map([...e].map(([k, v]) => [k, v.slice()])));
    c.ebw = new Map(this.ebw);
    c.ebwMid = new Map(this.ebwMid);
    c.faces = this.faces.map((f) => ({ ...f, verts: [...f.verts], uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined, cnormals: f.cnormals ? [...f.cnormals] : undefined, fattr: f.fattr?.map((a) => a?.slice()), cattr: f.cattr?.map((a) => a?.slice()) }));
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
    if (this.fsEdges.size && from.length === 2) {
      const ends = (v: number) => this.fsMid.get(v) ?? [v, v];
      const a = ends(from[0][0]),
        b = ends(from[1][0]);
      const pair = [...new Set([...a, ...b])];
      if (pair.length === 2 && this.fsEdges.has(edgeKey(pair[0], pair[1]))) this.fsMid.set(i, [pair[0], pair[1]]);
    }
    if (this.ebw.size && from.length === 2) {
      const ends = (v: number) => this.ebwMid.get(v) ?? [v, v];
      const pair = [...new Set([...ends(from[0][0]), ...ends(from[1][0])])];
      if (pair.length === 2 && this.ebw.has(edgeKey(pair[0], pair[1]))) this.ebwMid.set(i, [pair[0], pair[1]]);
    }
    for (const l of Object.values(this.vfloat)) {
      let v = 0;
      for (const [s, t] of from) v += (l[s] ?? 0) * t;
      l.push(v);
    }
    this.gattrs.forEach((g, k) => {
      if (g.domain !== 'POINT') return;
      const l = this.vgen[k];
      if (!from.length) {
        for (let j = 0; j < g.width; j++) l.push(0);
        return;
      }
      if (isDiscreteAttr(g.data_type)) {
        // integers / booleans come from the strongest source
        const [s] = from.reduce((a, b) => (b[1] > a[1] ? b : a));
        for (let j = 0; j < g.width; j++) l.push(l[s * g.width + j] ?? 0);
        return;
      }
      for (let j = 0; j < g.width; j++) {
        let v = 0;
        for (const [s, t] of from) v += (l[s * g.width + j] ?? 0) * t;
        l.push(v);
      }
    });
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
    if (this.skin) {
      // new vertices take the interpolated radius of their sources and are never roots
      let rx = 0,
        ry = 0;
      for (const [s, t] of from) {
        rx += (this.skin[s * 4] ?? 0.25) * t;
        ry += (this.skin[s * 4 + 1] ?? 0.25) * t;
      }
      this.skin.push(from.length ? rx : 0.25, from.length ? ry : 0.25, 0, 0);
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
      fsFace: template?.fsFace,
      // new faces take the face values of their template and its first corner's values on every corner
      fattr: template?.fattr?.map((a) => a?.slice()),
      cattr: template?.cattr?.map((a, k) => (a ? Array.from({ length: n }, () => a.slice(0, this.gattrs[k]?.width ?? 0)).flat() : undefined)),
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
    if (this.skin) this.skin = pick(this.skin, 4);
    for (const k in this.vfloat) this.vfloat[k] = pick(this.vfloat[k], 1);
    this.gattrs.forEach((g, k) => g.domain === 'POINT' && (this.vgen[k] = pick(this.vgen[k], g.width)));
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
      const cattr = f.cattr ? f.cattr.map(() => [] as number[]) : null;
      f.verts.forEach((v, i) => {
        const nv = map[v];
        if (verts.length && verts[verts.length - 1] === nv) return;
        verts.push(nv);
        uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
        seams.push(f.seams[i]);
        sharp.push(f.sharp[i]);
        creases.push(f.creases[i]);
        if (f.colors) colors.push(...f.colors.slice(i * 4, i * 4 + 4));
        if (cattr) f.cattr!.forEach((a, k) => a && cattr[k].push(...a.slice(i * this.gattrs[k].width, (i + 1) * this.gattrs[k].width)));
      });
      while (verts.length > 1 && verts[0] === verts[verts.length - 1]) {
        verts.pop();
        uvs.length -= 2;
        seams.pop();
        sharp.pop();
        creases.pop();
        if (f.colors) colors.length -= 4;
        if (cattr) cattr.forEach((a, k) => (a.length -= this.gattrs[k]?.width ?? 0));
      }
      f.verts = verts;
      f.uvs = uvs;
      f.seams = seams;
      f.sharp = sharp;
      f.creases = creases;
      if (f.colors) f.colors = colors;
      if (cattr) f.cattr = f.cattr!.map((a, k) => (a ? cattr[k] : undefined));
    }
    this.faces = this.faces.filter((f) => new Set(f.verts).size >= 3 && f.verts.length === new Set(f.verts).size);
    this.looseEdges = this.looseEdges.map(([a, b]) => [map[a], map[b]] as [number, number]).filter(([a, b]) => a !== b);
    this.remapEdgeExcl(map);
    this.compact();
  }

  /** Load the mesh's generic attributes (those whose size matches the mesh). */
  readGeneric(me: MeshData) {
    const nc = me.indices.length;
    const loose = me.loose_edges;
    const uvExtra: MeshAttribute[] = (me.uv_layers_extra ?? []).filter((u) => u.data.length === nc * 2).map((u) => ({ name: u.name, domain: 'CORNER', data_type: 'FLOAT2', data: u.data }));
    for (const a of [...(me.attributes ?? []), ...uvExtra]) {
      const width = attrWidth(a.data_type);
      if (a.data.length !== attrDomainSize(me, a.domain) * width) continue;
      const k = this.gattrs.length;
      this.gattrs.push({ name: a.name, domain: a.domain, data_type: a.data_type, width, uvMap: uvExtra.includes(a) || undefined });
      this.vgen.push(a.domain === 'POINT' ? Array.from(a.data) : []);
      const emap = new Map<string, number[]>();
      if (a.domain === 'EDGE') {
        for (let f = 0; f < me.offsets.length - 1; f++) {
          const s0 = me.offsets[f],
            e = me.offsets[f + 1];
          for (let c = s0; c < e; c++) emap.set(edgeKey(me.indices[c], me.indices[c + 1 < e ? c + 1 : s0]), Array.from(a.data.subarray(c * width, (c + 1) * width)));
        }
        if (loose) for (let i = 0; i + 1 < loose.length; i += 2) emap.set(edgeKey(loose[i], loose[i + 1]), Array.from(a.data.subarray((nc + i / 2) * width, (nc + i / 2 + 1) * width)));
      }
      this.egen.push(emap);
      if (a.domain === 'FACE' || a.domain === 'CORNER')
        this.faces.forEach((f, fi) => {
          const arr = (a.domain === 'FACE' ? (f.fattr ??= []) : (f.cattr ??= []));
          arr[k] = a.domain === 'FACE' ? Array.from(a.data.subarray(fi * width, (fi + 1) * width)) : Array.from(a.data.subarray(me.offsets[fi] * width, me.offsets[fi + 1] * width));
        });
    }
  }

  /** Store the generic attributes back (missing values become zero). */
  writeGeneric(me: MeshData) {
    if (!this.gattrs.length) {
      if (me.attributes?.length) me.attributes = me.attributes.filter((a) => a.data.length === attrDomainSize(me, a.domain) * attrWidth(a.data_type));
      if (me.uv_layers_extra?.length) me.uv_layers_extra = me.uv_layers_extra.filter((u) => u.data.length === me.indices.length * 2);
      return;
    }
    const nf = this.faces.length;
    const nc = this.faces.reduce((n, f) => n + f.verts.length, 0);
    const all = this.gattrs.map((g, k) => {
      const w = g.width;
      const size = g.domain === 'POINT' ? this.vcount : g.domain === 'FACE' ? nf : g.domain === 'CORNER' ? nc : nc + this.looseEdges.length;
      const data = makeAttrArray(g.data_type, size * w);
      if (g.domain === 'POINT') {
        const l = this.vgen[k];
        for (let i = 0; i < size * w; i++) data[i] = l[i] ?? 0;
      } else if (g.domain === 'FACE') this.faces.forEach((f, fi) => f.fattr?.[k]?.forEach((x, j) => j < w && (data[fi * w + j] = x)));
      else if (g.domain === 'CORNER') {
        let c = 0;
        for (const f of this.faces) {
          const a = f.cattr?.[k];
          if (a && a.length === f.verts.length * w) for (let j = 0; j < a.length; j++) data[c * w + j] = a[j];
          c += f.verts.length;
        }
      } else {
        const e = this.egen[k];
        let c = 0;
        for (const f of this.faces)
          for (let i = 0; i < f.verts.length; i++, c++) {
            const v = e.get(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]));
            if (v) for (let j = 0; j < w; j++) data[c * w + j] = v[j] ?? 0;
          }
        this.looseEdges.forEach(([a, b], i) => {
          const v = e.get(edgeKey(a, b));
          if (v) for (let j = 0; j < w; j++) data[(nc + i) * w + j] = v[j] ?? 0;
        });
      }
      return { name: g.name, domain: g.domain, data_type: g.data_type, data };
    });
    me.attributes = all.filter((_, k) => !this.gattrs[k].uvMap);
    const uvs = all.filter((_, k) => this.gattrs[k].uvMap).map((a) => ({ name: a.name, data: a.data as Float32Array }));
    if (uvs.length || me.uv_layers_extra) me.uv_layers_extra = uvs;
  }

  /** Bevel weight of the edge u–v (directly, or inherited from the weighted edge it was split from). */
  edgeBevelWeight(u: number, v: number): number {
    const w = this.ebw.get(edgeKey(u, v));
    if (w !== undefined) return w;
    if (!this.ebwMid.size || !(this.ebwMid.has(u) || this.ebwMid.has(v))) return 0;
    const a = this.ebwMid.get(u) ?? [u, u],
      b = this.ebwMid.get(v) ?? [v, v];
    const ends = [...new Set([...a, ...b])];
    return ends.length === 2 ? (this.ebw.get(edgeKey(ends[0], ends[1])) ?? 0) : 0;
  }

  /** Per-vertex float layer (created on demand, zero-filled). */
  vertLayer(key: (typeof VERT_FLOAT_LAYERS)[number]): number[] {
    const l = (this.vfloat[key] ??= []);
    while (l.length < this.vcount) l.push(0);
    return l;
  }

  /** Is the edge u–v marked for line rendering (directly, or as part of a split marked edge)? */
  fsMarked(u: number, v: number): boolean {
    if (this.fsEdges.has(edgeKey(u, v))) return true;
    const a = this.fsMid.get(u) ?? [u, u],
      b = this.fsMid.get(v) ?? [v, v];
    const ends = [...new Set([...a, ...b])];
    return ends.length === 2 && (this.fsMid.has(u) || this.fsMid.has(v)) && this.fsEdges.has(edgeKey(ends[0], ends[1]));
  }

  private remapEdgeExcl(map: number[]) {
    const remapSet = (set: Set<string>) => {
      const out = new Set<string>();
      for (const k of set) {
        const [a, b] = k.split(':').map(Number);
        const x = map[a],
          y = map[b];
        if (x >= 0 && y >= 0 && x !== y && x !== undefined && y !== undefined) out.add(edgeKey(x, y));
      }
      return out;
    };
    if (this.fsEdges.size) this.fsEdges = remapSet(this.fsEdges);
    if (this.fsMid.size) {
      const mid = new Map<number, [number, number]>();
      for (const [k, [a, b]] of this.fsMid) if (map[k] >= 0 && map[a] >= 0 && map[b] >= 0) mid.set(map[k], [map[a], map[b]]);
      this.fsMid = mid;
    }
    this.egen = this.egen.map((e) => {
      if (!e.size) return e;
      const out = new Map<string, number[]>();
      for (const [k, w] of e) {
        const [a, b] = k.split(':').map(Number);
        const x = map[a],
          y = map[b];
        if (x >= 0 && y >= 0 && x !== y && x !== undefined && y !== undefined) out.set(edgeKey(x, y), w);
      }
      return out;
    });
    if (this.ebw.size) {
      // resolve inherited weights before the indices change
      const out = new Map<string, number>();
      for (const [k, w] of this.ebw) {
        const [a, b] = k.split(':').map(Number);
        const x = map[a],
          y = map[b];
        if (x >= 0 && y >= 0 && x !== y && x !== undefined && y !== undefined) out.set(edgeKey(x, y), Math.max(w, out.get(edgeKey(x, y)) ?? 0));
      }
      const mid = new Map<number, [number, number]>();
      for (const [k, [a, b]] of this.ebwMid) if (map[k] >= 0 && map[a] >= 0 && map[b] >= 0) mid.set(map[k], [map[a], map[b]]);
      this.ebw = out;
      this.ebwMid = mid;
    }
    if (!this.edgeExcl.size) return;
    this.edgeExcl = remapSet(this.edgeExcl);
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
