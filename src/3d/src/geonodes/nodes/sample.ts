// Sampling nodes: Raycast, Geometry Proximity, Sample Nearest, Sample Nearest Surface,
// Sample UV Surface and Index of Nearest. Their outputs are fields evaluated where they are
// used (the source); the target geometry is searched through bounding volume hierarchies.
import { geoNode, sock, geo, enumProp, ATTRIBUTE_TYPE_ITEMS } from './gndef';
import { prop } from './defs';
import { valueSocket } from './geometry';
import type { MeshComponent } from '../geometry';
import { InputField, makeContext, evalFull, allocField, type Field, type FieldContext, type Evaluated } from '../field';
import { positionField } from '../inputs';
import { faceNormals } from '../meshutil';
import { BVH, meshTriangles, triangleBVH, pointBVH, segmentBVH, closestOnTriangle, closestOnSegment, rayTriangle } from '../ops/spatial';
import { fieldComps, fieldTypeOfEnum, type FieldType } from '../types';
import type { NodeData } from '../../data/types';

const full = (data: Float32Array | Int32Array | Uint8Array): Evaluated => ({ data, single: false });

/** Fields sharing one computation per evaluation context. */
function sharedFields<R>(compute: (fc: FieldContext) => R, outputs: Record<string, [FieldType, (r: R) => Float32Array | Int32Array | Uint8Array]>): Record<string, Field> {
  const memo = new WeakMap<FieldContext, R>();
  const get = (fc: FieldContext) => {
    let r = memo.get(fc);
    if (!r) memo.set(fc, (r = compute(fc)));
    return r;
  };
  const out: Record<string, Field> = {};
  for (const [name, [t, pick]] of Object.entries(outputs)) out[name] = new InputField(t, `sample:${name}`, (fc) => full(pick(get(fc))));
  return out;
}

const valueType = (n: NodeData): FieldType => fieldTypeOfEnum(prop(n, 'data_type'));
const dataTypeProp = () => enumProp('data_type', 'Data Type', ATTRIBUTE_TYPE_ITEMS);

/** Interpolate corner values of a triangle with barycentric weights. */
function interpCorners(vals: ArrayLike<number>, comps: number, tris: Uint32Array, t: number, w: ArrayLike<number>, out: Float32Array | Int32Array | Uint8Array, i: number, type: FieldType) {
  for (let k = 0; k < comps; k++) {
    let s = 0;
    for (let j = 0; j < 3; j++) s += vals[tris[t * 3 + j] * comps + k] * w[j];
    out[i * comps + k] = type === 'BOOLEAN' ? (s >= 0.5 ? 1 : 0) : type === 'INT' ? Math.round(s) : s;
  }
}

// ---------------------------------------------------------------------------
// Raycast

geoNode(
  {
    idname: 'GeometryNodeRaycast',
    label: 'Raycast',
    category: 'geometry',
    width: 160,
    description: 'Cast rays from the evaluated positions onto a mesh and read where they hit',
    props: [
      dataTypeProp(),
      enumProp('Interpolation', 'Interpolation', [
        ['Interpolated', 'Interpolated'],
        ['Nearest', 'Nearest'],
      ]),
    ],
    dynamicSockets: (node) => {
      const t = valueType(node);
      return {
        inputs: [
          geo('Target Geometry'),
          { ...valueSocket('Attribute', t), hide_value: true },
          sock('Source Position', 'VECTOR', { d: [0, 0, 0], hide_value: true }),
          sock('Ray Direction', 'VECTOR', { d: [0, 0, -1] }),
          sock('Ray Length', 'FLOAT', { d: 100, min: 0, subtype: 'DISTANCE' }),
        ],
        outputs: [sock('Is Hit', 'BOOLEAN'), sock('Hit Position', 'VECTOR'), sock('Hit Normal', 'VECTOR'), sock('Hit Distance', 'FLOAT'), { ...valueSocket('Attribute', t), shape: 'CIRCLE' }],
      };
    },
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Target Geometry').mesh;
      const t = valueType(ctx.node);
      const comps = fieldComps(t);
      const attrF = ctx.field('Attribute', t);
      const nearest = prop(ctx.node, 'Interpolation') === 'Nearest';
      const srcF = ctx.field('Source Position', 'VECTOR'),
        dirF = ctx.field('Ray Direction', 'VECTOR'),
        lenF = ctx.field('Ray Length', 'FLOAT');
      let target: { bvh: BVH; tris: Uint32Array; triFace: Uint32Array; normals: Float32Array; attr: ArrayLike<number> } | null = null;
      const tgt = (mesh: MeshComponent) => {
        if (target) return target;
        const tr = meshTriangles(mesh);
        target = { bvh: triangleBVH(mesh.positions, mesh.corners, tr.tris), tris: tr.tris, triFace: tr.triFace, normals: faceNormals(mesh), attr: evalFull(attrF, makeContext(mesh, 'CORNER')) };
        return target;
      };
      const fields = sharedFields(
        (fc) => {
          const n = fc.size;
          const r = { hit: new Uint8Array(n), pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), dist: new Float32Array(n), attr: allocField(t, n) };
          const src = evalFull(srcF, fc),
            dir = evalFull(dirF, fc),
            len = evalFull(lenF, fc);
          const bary = new Float64Array(3);
          const best = new Float64Array(3);
          const o = [0, 0, 0],
            d = [0, 0, 0];
          for (let i = 0; i < n; i++) {
            r.dist[i] = len[i];
            if (!m) continue;
            const T = tgt(m);
            for (let k = 0; k < 3; k++) {
              o[k] = src[i * 3 + k];
              d[k] = dir[i * 3 + k];
            }
            const l = Math.hypot(d[0], d[1], d[2]);
            if (!l) continue;
            for (let k = 0; k < 3; k++) d[k] /= l;
            const P = m.positions;
            let bestT = Infinity;
            const h = T.bvh.raycast(o, d, Math.max(0, len[i]), (tri) => {
              const tt = rayTriangle(P, m.corners[T.tris[tri * 3]], m.corners[T.tris[tri * 3 + 1]], m.corners[T.tris[tri * 3 + 2]], o, d, bary);
              if (tt >= 0 && tt < bestT) {
                bestT = tt;
                best.set(bary);
              }
              return tt;
            });
            if (h.prim < 0) continue;
            r.hit[i] = 1;
            r.dist[i] = h.t;
            for (let k = 0; k < 3; k++) r.pos[i * 3 + k] = o[k] + d[k] * h.t;
            const f = T.triFace[h.prim];
            for (let k = 0; k < 3; k++) r.nrm[i * 3 + k] = T.normals[f * 3 + k];
            if (nearest) {
              const j = best[0] >= best[1] && best[0] >= best[2] ? 0 : best[1] >= best[2] ? 1 : 2;
              const c = T.tris[h.prim * 3 + j];
              for (let k = 0; k < comps; k++) r.attr[i * comps + k] = T.attr[c * comps + k];
            } else interpCorners(T.attr, comps, T.tris, h.prim, best, r.attr, i, t);
          }
          return r;
        },
        {
          'Is Hit': ['BOOLEAN', (r) => r.hit],
          'Hit Position': ['VECTOR', (r) => r.pos],
          'Hit Normal': ['VECTOR', (r) => r.nrm],
          'Hit Distance': ['FLOAT', (r) => r.dist],
          Attribute: [t, (r) => r.attr],
        },
      );
      return fields;
    },
    implicit: { 'Source Position': positionField },
  },
);

// ---------------------------------------------------------------------------
// Geometry Proximity

interface GroupIndex {
  bvh: BVH;
  /** primitive index → element */
  ids: number[];
}

/** One BVH per group id (built lazily). */
function groupedIndex(groups: ArrayLike<number> | null, count: number, build: (ids: number[]) => BVH): (g: number) => GroupIndex | null {
  const members = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const g = groups ? groups[i] : 0;
    const l = members.get(g);
    if (l) l.push(i);
    else members.set(g, [i]);
  }
  const built = new Map<number, GroupIndex>();
  return (g) => {
    const ids = members.get(g);
    if (!ids) return null;
    let b = built.get(g);
    if (!b) built.set(g, (b = { bvh: build(ids), ids }));
    return b;
  };
}

geoNode(
  {
    idname: 'GeometryNodeProximity',
    label: 'Geometry Proximity',
    category: 'geometry',
    description: 'Find the closest point on the target geometry (its points, edges or faces)',
    inputs: [
      geo('Geometry', { id: 'Target' }),
      sock('Group ID', 'INT', { hide_value: true, field: true }),
      sock('Sample Position', 'VECTOR', { id: 'Source Position', d: [0, 0, 0], hide_value: true }),
      sock('Sample Group ID', 'INT', { hide_value: true }),
    ],
    outputs: [sock('Position', 'VECTOR'), sock('Distance', 'FLOAT'), sock('Is Valid', 'BOOLEAN')],
    props: [
      enumProp(
        'target_element',
        'Target Geometry',
        [
          ['POINTS', 'Points'],
          ['EDGES', 'Edges'],
          ['FACES', 'Faces'],
        ],
        'FACES',
      ),
    ],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Target');
      const mode = String(prop(ctx.node, 'target_element'));
      const gidF = ctx.field('Group ID', 'INT');
      const srcF = ctx.field('Source Position', 'VECTOR'),
        sgF = ctx.field('Sample Group ID', 'INT');
      // target primitives
      let index: ((grp: number) => GroupIndex | null) | null = null;
      let closest: ((prim: number, x: number, y: number, z: number, out: number[]) => number) | null = null;
      const setup = () => {
        if (index) return;
        if (mode === 'POINTS') {
          const parts: Float32Array[] = [];
          const groups: number[] = [];
          for (const c of [g.mesh, g.points]) {
            if (!c || !c.positions.length) continue;
            parts.push(c.positions);
            groups.push(...Array.from(evalFull(gidF, makeContext(c, 'POINT'))));
          }
          const P = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
          let o = 0;
          for (const p of parts) (P.set(p, o), (o += p.length));
          index = groupedIndex(groups, P.length / 3, (ids) => pointBVH(P, ids));
          closest = (prim, x, y, z, out) => {
            out[0] = P[prim * 3];
            out[1] = P[prim * 3 + 1];
            out[2] = P[prim * 3 + 2];
            return (out[0] - x) ** 2 + (out[1] - y) ** 2 + (out[2] - z) ** 2;
          };
        } else if (g.mesh) {
          const m = g.mesh;
          const P = m.positions;
          if (mode === 'EDGES') {
            const topo = m.topology();
            const E = topo.edges;
            index = groupedIndex(evalFull(gidF, makeContext(m, 'EDGE')), topo.edgeCount, (ids) => segmentBVH(P, E, ids));
            closest = (e, x, y, z, out) => {
              const a = E[e * 2],
                b = E[e * 2 + 1];
              const s = closestOnSegment(P, a, b, x, y, z);
              for (let k = 0; k < 3; k++) out[k] = P[a * 3 + k] + (P[b * 3 + k] - P[a * 3 + k]) * s;
              return (out[0] - x) ** 2 + (out[1] - y) ** 2 + (out[2] - z) ** 2;
            };
          } else {
            const tr = meshTriangles(m);
            const fg = evalFull(gidF, makeContext(m, 'FACE'));
            const triGroups = Array.from(tr.triFace, (f) => fg[f]);
            index = groupedIndex(triGroups, tr.triFace.length, (ids) => triangleBVH(P, m.corners, tr.tris, ids));
            const w = new Float64Array(3);
            closest = (t, x, y, z, out) => {
              const a = m.corners[tr.tris[t * 3]],
                b = m.corners[tr.tris[t * 3 + 1]],
                c = m.corners[tr.tris[t * 3 + 2]];
              closestOnTriangle(P, a, b, c, x, y, z, w);
              for (let k = 0; k < 3; k++) out[k] = P[a * 3 + k] * w[0] + P[b * 3 + k] * w[1] + P[c * 3 + k] * w[2];
              return (out[0] - x) ** 2 + (out[1] - y) ** 2 + (out[2] - z) ** 2;
            };
          }
        }
      };
      return sharedFields(
        (fc) => {
          const n = fc.size;
          const r = { pos: new Float32Array(n * 3), dist: new Float32Array(n), valid: new Uint8Array(n) };
          setup();
          const src = evalFull(srcF, fc),
            sg = evalFull(sgF, fc);
          const tmp = [0, 0, 0];
          for (let i = 0; i < n; i++) {
            const gi = index?.(sg[i]);
            if (!gi || !closest) continue;
            const x = src[i * 3],
              y = src[i * 3 + 1],
              z = src[i * 3 + 2];
            const h = gi.bvh.nearest(x, y, z, (p) => closest!(gi.ids[p], x, y, z, tmp));
            if (h.prim < 0) continue;
            closest(gi.ids[h.prim], x, y, z, tmp);
            r.pos.set(tmp, i * 3);
            r.dist[i] = Math.sqrt(h.dist2);
            r.valid[i] = 1;
          }
          return r;
        },
        {
          Position: ['VECTOR', (r) => r.pos],
          Distance: ['FLOAT', (r) => r.dist],
          'Is Valid': ['BOOLEAN', (r) => r.valid],
        },
      );
    },
    implicit: { 'Source Position': positionField },
  },
);

// ---------------------------------------------------------------------------
// Sample Nearest

geoNode(
  {
    idname: 'GeometryNodeSampleNearest',
    label: 'Sample Nearest',
    category: 'geometry',
    description: 'Find the index of the element of the geometry closest to each sample position',
    inputs: [geo('Geometry'), sock('Sample Position', 'VECTOR', { d: [0, 0, 0], hide_value: true })],
    outputs: [sock('Index', 'INT')],
    props: [
      enumProp('domain', 'Domain', [
        ['POINT', 'Point'],
        ['EDGE', 'Edge'],
        ['FACE', 'Face'],
        ['CORNER', 'Face Corner'],
      ]),
    ],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const domain = String(prop(ctx.node, 'domain'));
      const srcF = ctx.field('Sample Position', 'VECTOR');
      let query: ((x: number, y: number, z: number) => number) | null = null;
      const setup = () => {
        if (query) return;
        query = () => -1;
        if (domain === 'POINT') {
          const c = g.mesh?.vertCount ? g.mesh : g.points?.count ? g.points : null;
          if (!c) return;
          const P = c.positions;
          const bvh = pointBVH(P);
          query = (x, y, z) => bvh.nearest(x, y, z, (p) => (P[p * 3] - x) ** 2 + (P[p * 3 + 1] - y) ** 2 + (P[p * 3 + 2] - z) ** 2).prim;
          return;
        }
        const m = g.mesh;
        if (!m) return;
        const P = m.positions;
        if (domain === 'EDGE') {
          const E = m.topology().edges;
          const bvh = segmentBVH(P, E);
          query = (x, y, z) =>
            bvh.nearest(x, y, z, (e) => {
              const a = E[e * 2],
                b = E[e * 2 + 1];
              const s = closestOnSegment(P, a, b, x, y, z);
              let d = 0;
              for (let k = 0; k < 3; k++) d += (P[a * 3 + k] + (P[b * 3 + k] - P[a * 3 + k]) * s - [x, y, z][k]) ** 2;
              return d;
            }).prim;
          return;
        }
        const tr = meshTriangles(m);
        const bvh = triangleBVH(P, m.corners, tr.tris);
        const w = new Float64Array(3);
        const triDist = (t: number, x: number, y: number, z: number) => {
          const a = m.corners[tr.tris[t * 3]],
            b = m.corners[tr.tris[t * 3 + 1]],
            c = m.corners[tr.tris[t * 3 + 2]];
          closestOnTriangle(P, a, b, c, x, y, z, w);
          let d = 0;
          for (let k = 0; k < 3; k++) d += (P[a * 3 + k] * w[0] + P[b * 3 + k] * w[1] + P[c * 3 + k] * w[2] - [x, y, z][k]) ** 2;
          return d;
        };
        query = (x, y, z) => {
          const t = bvh.nearest(x, y, z, (tt) => triDist(tt, x, y, z)).prim;
          if (t < 0) return -1;
          const f = tr.triFace[t];
          if (domain === 'FACE') return f;
          // nearest corner of that face
          let best = -1,
            bd = Infinity;
          for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
            const v = m.corners[c];
            const d = (P[v * 3] - x) ** 2 + (P[v * 3 + 1] - y) ** 2 + (P[v * 3 + 2] - z) ** 2;
            if (d < bd) ((bd = d), (best = c));
          }
          return best;
        };
      };
      return {
        Index: new InputField('INT', 'sample_nearest', (fc) => {
          setup();
          const src = evalFull(srcF, fc);
          const out = new Int32Array(fc.size);
          for (let i = 0; i < fc.size; i++) out[i] = query!(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
          return full(out);
        }),
      };
    },
    implicit: { 'Sample Position': positionField },
  },
);

// ---------------------------------------------------------------------------
// Sample Nearest Surface

geoNode(
  {
    idname: 'GeometryNodeSampleNearestSurface',
    label: 'Sample Nearest Surface',
    category: 'geometry',
    width: 160,
    description: 'Interpolate a value of the mesh at the closest point on its surface',
    props: [dataTypeProp()],
    dynamicSockets: (node) => {
      const t = valueType(node);
      return {
        inputs: [
          geo('Mesh'),
          { ...valueSocket('Value', t), hide_value: true },
          sock('Group ID', 'INT', { hide_value: true, field: true }),
          sock('Sample Position', 'VECTOR', { d: [0, 0, 0], hide_value: true }),
          sock('Sample Group ID', 'INT', { hide_value: true }),
        ],
        outputs: [{ ...valueSocket('Value', t), shape: 'CIRCLE' }, sock('Is Valid', 'BOOLEAN')],
      };
    },
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Mesh').mesh;
      const t = valueType(ctx.node);
      const comps = fieldComps(t);
      const valF = ctx.field('Value', t),
        gidF = ctx.field('Group ID', 'INT');
      const srcF = ctx.field('Sample Position', 'VECTOR'),
        sgF = ctx.field('Sample Group ID', 'INT');
      let st: { index: (g: number) => GroupIndex | null; tris: Uint32Array; vals: ArrayLike<number> } | null = null;
      const setup = (mesh: MeshComponent) => {
        if (st) return st;
        const tr = meshTriangles(mesh);
        const fg = evalFull(gidF, makeContext(mesh, 'FACE'));
        st = {
          index: groupedIndex(
            Array.from(tr.triFace, (f) => fg[f]),
            tr.triFace.length,
            (ids) => triangleBVH(mesh.positions, mesh.corners, tr.tris, ids),
          ),
          tris: tr.tris,
          vals: evalFull(valF, makeContext(mesh, 'CORNER')),
        };
        return st;
      };
      return sharedFields(
        (fc) => {
          const n = fc.size;
          const r = { val: allocField(t, n), valid: new Uint8Array(n) };
          if (!m || !m.faceCount) return r;
          const S = setup(m);
          const P = m.positions;
          const src = evalFull(srcF, fc),
            sg = evalFull(sgF, fc);
          const w = new Float64Array(3),
            bw = new Float64Array(3);
          for (let i = 0; i < n; i++) {
            const gi = S.index(sg[i]);
            if (!gi) continue;
            const x = src[i * 3],
              y = src[i * 3 + 1],
              z = src[i * 3 + 2];
            let bd = Infinity;
            const h = gi.bvh.nearest(x, y, z, (p) => {
              const tt = gi.ids[p];
              const a = m.corners[S.tris[tt * 3]],
                b = m.corners[S.tris[tt * 3 + 1]],
                c = m.corners[S.tris[tt * 3 + 2]];
              closestOnTriangle(P, a, b, c, x, y, z, w);
              let d = 0;
              for (let k = 0; k < 3; k++) d += (P[a * 3 + k] * w[0] + P[b * 3 + k] * w[1] + P[c * 3 + k] * w[2] - [x, y, z][k]) ** 2;
              if (d < bd) ((bd = d), bw.set(w));
              return d;
            });
            if (h.prim < 0) continue;
            interpCorners(S.vals, comps, S.tris, gi.ids[h.prim], bw, r.val, i, t);
            r.valid[i] = 1;
          }
          return r;
        },
        {
          Value: [t, (r) => r.val],
          'Is Valid': ['BOOLEAN', (r) => r.valid],
        },
      );
    },
    implicit: { 'Sample Position': positionField },
  },
);

// ---------------------------------------------------------------------------
// Sample UV Surface

geoNode(
  {
    idname: 'GeometryNodeSampleUVSurface',
    label: 'Sample UV Surface',
    category: 'geometry',
    description: 'Interpolate a value of the mesh at the place of a UV coordinate',
    props: [dataTypeProp()],
    dynamicSockets: (node) => {
      const t = valueType(node);
      return {
        inputs: [
          geo('Mesh'),
          { ...valueSocket('Value', t), hide_value: true },
          sock('UV Map', 'VECTOR', { id: 'Source UV Map', d: [0, 0, 0], hide_value: true, field: true }),
          sock('Sample UV', 'VECTOR', { d: [0, 0, 0] }),
        ],
        outputs: [{ ...valueSocket('Value', t), shape: 'CIRCLE' }, sock('Is Valid', 'BOOLEAN')],
      };
    },
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Mesh').mesh;
      const t = valueType(ctx.node);
      const comps = fieldComps(t);
      const valF = ctx.field('Value', t),
        uvF = ctx.field('Source UV Map', 'VECTOR');
      const sampleF = ctx.field('Sample UV', 'VECTOR');
      let st: { bvh: BVH; tris: Uint32Array; uv: Float32Array; vals: ArrayLike<number> } | null = null;
      const setup = (mesh: MeshComponent) => {
        if (st) return st;
        const tr = meshTriangles(mesh);
        const uv3 = evalFull(uvF, makeContext(mesh, 'CORNER')) as Float32Array;
        // a flat copy of the UVs (z = 0), indexed by corner
        const uv = new Float32Array(mesh.cornerCount * 3);
        for (let c = 0; c < mesh.cornerCount; c++) {
          uv[c * 3] = uv3[c * 3];
          uv[c * 3 + 1] = uv3[c * 3 + 1];
        }
        const ident = Uint32Array.from({ length: mesh.cornerCount }, (_, i) => i);
        st = { bvh: triangleBVH(uv, ident, tr.tris), tris: tr.tris, uv, vals: evalFull(valF, makeContext(mesh, 'CORNER')) };
        return st;
      };
      return sharedFields(
        (fc) => {
          const n = fc.size;
          const r = { val: allocField(t, n), valid: new Uint8Array(n) };
          if (!m || !m.faceCount) return r;
          const S = setup(m);
          const sample = evalFull(sampleF, fc);
          const w = new Float64Array(3),
            bw = new Float64Array(3);
          for (let i = 0; i < n; i++) {
            const x = sample[i * 3],
              y = sample[i * 3 + 1];
            let bd = Infinity;
            const h = S.bvh.nearest(
              x,
              y,
              0,
              (tt) => {
                const a = S.tris[tt * 3],
                  b = S.tris[tt * 3 + 1],
                  c = S.tris[tt * 3 + 2];
                closestOnTriangle(S.uv, a, b, c, x, y, 0, w);
                const px = S.uv[a * 3] * w[0] + S.uv[b * 3] * w[1] + S.uv[c * 3] * w[2],
                  py = S.uv[a * 3 + 1] * w[0] + S.uv[b * 3 + 1] * w[1] + S.uv[c * 3 + 1] * w[2];
                const d = (px - x) ** 2 + (py - y) ** 2;
                if (d < bd) ((bd = d), bw.set(w));
                return d;
              },
              1e-10,
            );
            if (h.prim < 0) continue;
            interpCorners(S.vals, comps, S.tris, h.prim, bw, r.val, i, t);
            r.valid[i] = 1;
          }
          return r;
        },
        {
          Value: [t, (r) => r.val],
          'Is Valid': ['BOOLEAN', (r) => r.valid],
        },
      );
    },
  },
);

// ---------------------------------------------------------------------------
// Index of Nearest

geoNode(
  {
    idname: 'GeometryNodeIndexOfNearest',
    label: 'Index of Nearest',
    category: 'converter',
    description: 'Find the closest other element with the same group id',
    inputs: [sock('Position', 'VECTOR', { d: [0, 0, 0], hide_value: true, field: true }), sock('Group ID', 'INT', { hide_value: true, field: true })],
    outputs: [sock('Index', 'INT', { field: true }), sock('Has Neighbor', 'BOOLEAN', { field: true })],
  },
  {
    exec: (ctx) => {
      const posF = ctx.field('Position', 'VECTOR'),
        gidF = ctx.field('Group ID', 'INT');
      return sharedFields(
        (fc) => {
          const n = fc.size;
          const P = evalFull(posF, fc),
            G = evalFull(gidF, fc);
          const r = { idx: new Int32Array(n).fill(-1), has: new Uint8Array(n) };
          const index = groupedIndex(G, n, (ids) => pointBVH(P, ids));
          for (let i = 0; i < n; i++) {
            const gi = index(G[i]);
            if (!gi || gi.ids.length < 2) continue;
            const x = P[i * 3],
              y = P[i * 3 + 1],
              z = P[i * 3 + 2];
            const h = gi.bvh.nearest(x, y, z, (p) => {
              const j = gi.ids[p];
              return j === i ? Infinity : (P[j * 3] - x) ** 2 + (P[j * 3 + 1] - y) ** 2 + (P[j * 3 + 2] - z) ** 2;
            });
            if (h.prim < 0) continue;
            r.idx[i] = gi.ids[h.prim];
            r.has[i] = 1;
          }
          return r;
        },
        {
          Index: ['INT', (r) => r.idx],
          'Has Neighbor': ['BOOLEAN', (r) => r.has],
        },
      );
    },
    implicit: { Position: positionField },
  },
);
