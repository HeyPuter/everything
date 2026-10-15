// Mesh and element operations: Dual Mesh, Split Edges, Scale Elements, Duplicate Elements,
// Sort Elements, Merge Points, Points, and the face group field nodes.
import { geoNode, sock, geo, selection, enumProp } from './gndef';
import { evalOn, hasDomain } from './common';
import { prop } from './defs';
import { GeometrySet, PointsComponent, adaptDomain, type MeshComponent } from '../geometry';
import { InputField, makeContext, evalFull, evalSelection, ConstField, type FieldContext, type Evaluated } from '../field';
import { attributeField, positionField } from '../inputs';
import { dualMesh } from '../ops/dual';
import { splitEdges, scaleElements, duplicateElements, sortOrder, reorder, mergeMeshById, mergePointsById } from '../ops/elements';
import { joinGeometries } from '../ops/join';
import type { Domain } from '../types';
import type { Field } from '../field';

const full = (data: Float32Array | Int32Array | Uint8Array): Evaluated => ({ data, single: false });

// ---------------------------------------------------------------------------
// Dual Mesh

geoNode(
  {
    idname: 'GeometryNodeDualMesh',
    label: 'Dual Mesh',
    category: 'geometry',
    description: 'Turn faces into vertices and vertices into faces',
    inputs: [geo('Mesh'), sock('Keep Boundaries', 'BOOLEAN', { d: false })],
    outputs: [geo('Dual Mesh')],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      if (!g.mesh) return { 'Dual Mesh': g };
      return { 'Dual Mesh': g.with(dualMesh(g.mesh, ctx.bool('Keep Boundaries'))) };
    },
  },
);

// ---------------------------------------------------------------------------
// Split Edges

geoNode(
  {
    idname: 'GeometryNodeSplitEdges',
    label: 'Split Edges',
    category: 'geometry',
    description: 'Separate faces along the selected edges, giving each side its own vertices',
    inputs: [geo('Mesh'), selection()],
    outputs: [geo('Mesh')],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      if (!g.mesh) return { Mesh: g };
      const sel = evalOn(g.mesh, 'EDGE', ctx.field('Selection', 'BOOLEAN'), []).sel;
      return { Mesh: g.with(splitEdges(g.mesh, sel)) };
    },
  },
);

// ---------------------------------------------------------------------------
// Scale Elements

geoNode(
  {
    idname: 'GeometryNodeScaleElements',
    label: 'Scale Elements',
    category: 'geometry',
    description: 'Scale groups of connected faces or edges around their centre',
    inputs: [
      geo('Geometry'),
      selection(),
      sock('Scale', 'FLOAT', { d: 1, field: true }),
      sock('Center', 'VECTOR', { d: [0, 0, 0], hide_value: true, field: true, subtype: 'TRANSLATION' }),
      sock('Axis', 'VECTOR', { d: [1, 0, 0], field: true }),
    ],
    outputs: [geo('Geometry')],
    props: [
      enumProp('domain', 'Domain', [
        ['FACE', 'Face'],
        ['EDGE', 'Edge'],
      ]),
      enumProp('Scale Mode', 'Scale Mode', [
        ['Uniform', 'Uniform'],
        ['Single Axis', 'Single Axis'],
      ]),
    ],
    available: (n, s) => (s.identifier === 'Axis' ? prop(n, 'Scale Mode') === 'Single Axis' : true),
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const m = g.mesh;
      if (!m) return { Geometry: g };
      const domain = prop(ctx.node, 'domain') === 'EDGE' ? 'EDGE' : 'FACE';
      const axisMode = prop(ctx.node, 'Scale Mode') === 'Single Axis';
      const r = evalOn(m, domain, ctx.field('Selection', 'BOOLEAN'), [ctx.field('Scale', 'FLOAT'), ctx.field('Center', 'VECTOR'), ctx.field('Axis', 'VECTOR')]);
      return { Geometry: g.with(scaleElements(m, domain, { sel: r.sel, scale: r.values[0], center: r.values[1], axis: axisMode ? r.values[2] : null })) };
    },
    implicit: { Center: positionField },
  },
);

// ---------------------------------------------------------------------------
// Duplicate Elements

const DUP_DOMAINS: [string, string][] = [
  ['POINT', 'Point'],
  ['EDGE', 'Edge'],
  ['FACE', 'Face'],
  ['SPLINE', 'Spline'],
  ['INSTANCE', 'Instance'],
];

geoNode(
  {
    idname: 'GeometryNodeDuplicateElements',
    label: 'Duplicate Elements',
    category: 'geometry',
    description: 'Copy selected elements a number of times into separate geometry',
    inputs: [geo('Geometry'), selection(), sock('Amount', 'INT', { d: 1, min: 0, field: true })],
    outputs: [geo('Geometry'), sock('Duplicate Index', 'INT', { field: true })],
    props: [enumProp('domain', 'Domain', DUP_DOMAINS)],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const d = String(prop(ctx.node, 'domain'));
      const domain = (d === 'SPLINE' ? 'CURVE' : d) as Domain;
      const selF = ctx.field('Selection', 'BOOLEAN'),
        amountF = ctx.field('Amount', 'INT');
      const name = ctx.used('Duplicate Index') ? ctx.anon('Duplicate Index') : null;
      const parts: GeometrySet[] = [];
      for (const c of g.components()) {
        if (!hasDomain(c, domain)) continue;
        const r = evalOn(c, domain, selF, [amountF]);
        const res = duplicateElements(c, domain, r.sel, r.values[0]);
        if (!res) continue;
        if (name) res.geometry.attrs.set(name, { domain: res.domain, type: 'INT', data: res.index });
        const out = new GeometrySet();
        out.setComponent(res.geometry);
        parts.push(out);
      }
      return { Geometry: joinGeometries(parts), 'Duplicate Index': name ? attributeField(name, 'INT') : new ConstField('INT', 0) };
    },
  },
);

// ---------------------------------------------------------------------------
// Sort Elements

geoNode(
  {
    idname: 'GeometryNodeSortElements',
    label: 'Sort Elements',
    category: 'geometry',
    description: 'Reorder elements by a group and a weight; unselected elements keep their place',
    inputs: [geo('Geometry'), selection(), sock('Group ID', 'INT', { hide_value: true, field: true }), sock('Sort Weight', 'FLOAT', { hide_value: true, field: true })],
    outputs: [geo('Geometry')],
    props: [
      enumProp('domain', 'Domain', [
        ['POINT', 'Point'],
        ['EDGE', 'Edge'],
        ['FACE', 'Face'],
        ['CURVE', 'Spline'],
        ['INSTANCE', 'Instance'],
      ]),
    ],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const domain = String(prop(ctx.node, 'domain')) as Domain;
      const selF = ctx.field('Selection', 'BOOLEAN'),
        gid = ctx.field('Group ID', 'INT'),
        w = ctx.field('Sort Weight', 'FLOAT');
      return {
        Geometry: g.map((c) => {
          if (!hasDomain(c, domain)) return c;
          if (domain === 'EDGE' && c.kind === 'MESH' && c.faceCount) {
            ctx.warn('Edges of meshes with faces keep their order (it follows the faces)');
            return c;
          }
          const r = evalOn(c, domain, selF, [gid, w]);
          const order = sortOrder(r.ctx.size, r.sel, r.values[0], r.values[1]);
          let same = true;
          for (let i = 0; i < order.length; i++) if (order[i] !== i) same = false;
          return same ? c : reorder(c, domain, order);
        }),
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Merge Points

geoNode(
  {
    idname: 'GeometryNodeMergePoints',
    label: 'Merge Points',
    category: 'geometry',
    description: 'Merge selected points that share a merge id into one point at their average position',
    inputs: [geo('Geometry'), selection(), sock('Merge ID', 'INT', { hide_value: true, field: true })],
    outputs: [geo('Geometry')],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const selF = ctx.field('Selection', 'BOOLEAN'),
        idF = ctx.field('Merge ID', 'INT');
      return {
        Geometry: g.map((c) => {
          if (c.kind === 'MESH') {
            const r = evalOn(c, 'POINT', selF, [idF]);
            return mergeMeshById(c, r.sel, r.values[0]);
          }
          if (c.kind === 'POINTS') {
            const r = evalOn(c, 'POINT', selF, [idF]);
            return mergePointsById(c, r.sel, r.values[0]);
          }
          return c;
        }),
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Points

geoNode(
  {
    idname: 'GeometryNodePoints',
    label: 'Points',
    category: 'geometry',
    description: 'Create a point cloud with a number of points, positioned and sized by fields',
    inputs: [
      sock('Count', 'INT', { d: 1, min: 0 }),
      sock('Position', 'VECTOR', { d: [0, 0, 0], field: true, subtype: 'TRANSLATION' }),
      sock('Radius', 'FLOAT', { d: 0.1, min: 0, field: true, subtype: 'DISTANCE' }),
    ],
    outputs: [geo('Points', { id: 'Geometry' })],
  },
  {
    exec: (ctx) => {
      const n = Math.max(0, ctx.int('Count'));
      if (!n) return { Geometry: GeometrySet.empty() };
      const pc = new PointsComponent(new Float32Array(n * 3));
      const fc = makeContext(pc, 'POINT');
      const pos = evalFull(ctx.field('Position', 'VECTOR'), fc) as Float32Array;
      const rad = evalFull(ctx.field('Radius', 'FLOAT'), fc) as Float32Array;
      const out = new PointsComponent(new Float32Array(pos), new Map([['radius', { domain: 'POINT', type: 'FLOAT', data: new Float32Array(rad) }]]));
      return { Geometry: new GeometrySet(undefined, out) };
    },
  },
);

// ---------------------------------------------------------------------------
// Face groups (Mesh ▸ Read)

/** Face group ids: faces connected across edges that are not boundary edges, numbered by first face. */
export function faceGroups(m: MeshComponent, boundary: ArrayLike<number> | null): Int32Array {
  const topo = m.topology();
  const nf = m.faceCount;
  const parent = new Int32Array(nf);
  for (let f = 0; f < nf; f++) parent[f] = f;
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let e = 0; e < topo.edgeCount; e++) {
    if (boundary && boundary[e]) continue;
    const a = topo.edgeFaceOffsets[e],
      b = topo.edgeFaceOffsets[e + 1];
    for (let k = a + 1; k < b; k++) {
      const x = find(topo.edgeFaces[a]),
        y = find(topo.edgeFaces[k]);
      if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    }
  }
  const ids = new Int32Array(nf);
  const num = new Map<number, number>();
  for (let f = 0; f < nf; f++) {
    const r = find(f);
    let id = num.get(r);
    if (id === undefined) num.set(r, (id = num.size));
    ids[f] = id;
  }
  return ids;
}

function meshFieldOn(ctx: FieldContext, type: 'INT' | 'BOOLEAN', from: Domain, compute: (m: MeshComponent) => Int32Array | Uint8Array): Evaluated {
  const c = ctx.comp;
  if (c.kind !== 'MESH') return { data: type === 'INT' ? new Int32Array(1) : new Uint8Array(1), single: true };
  const data = compute(c);
  return full(adaptDomain(c, data, type === 'INT' ? 'INT' : 'BOOLEAN', from, ctx.domain) as Int32Array | Uint8Array);
}

geoNode(
  {
    idname: 'GeometryNodeEdgesToFaceGroups',
    label: 'Edges to Face Groups',
    category: 'input',
    width: 160,
    description: 'Group faces into regions bounded by the given edges',
    inputs: [sock('Boundary Edges', 'BOOLEAN', { d: true, hide_value: true, field: true })],
    outputs: [sock('Face Group ID', 'INT', { field: true })],
  },
  {
    exec: (ctx) => {
      const bf = ctx.field('Boundary Edges', 'BOOLEAN');
      return {
        'Face Group ID': new InputField('INT', `face_groups:${ctx.path}`, (fc) => meshFieldOn(fc, 'INT', 'FACE', (m) => faceGroups(m, evalSelection(bf, makeContext(m, 'EDGE')) ?? null))),
      };
    },
  },
);

/** Edges between faces of different groups. */
export function groupBoundaries(m: MeshComponent, ids: ArrayLike<number>): Uint8Array {
  const topo = m.topology();
  const out = new Uint8Array(topo.edgeCount);
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = topo.edgeFaceOffsets[e],
      b = topo.edgeFaceOffsets[e + 1];
    for (let k = a + 1; k < b; k++) if (ids[topo.edgeFaces[k]] !== ids[topo.edgeFaces[a]]) out[e] = 1;
  }
  return out;
}

geoNode(
  {
    idname: 'GeometryNodeMeshFaceSetBoundaries',
    label: 'Face Group Boundaries',
    category: 'input',
    width: 160,
    description: 'Find the edges that lie between faces of different groups',
    inputs: [sock('Face Group ID', 'INT', { id: 'Face Set', d: 0, hide_value: true, field: true })],
    outputs: [sock('Boundary Edges', 'BOOLEAN', { field: true })],
  },
  {
    exec: (ctx) => {
      const idF: Field = ctx.field('Face Set', 'INT');
      return {
        'Boundary Edges': new InputField('BOOLEAN', `face_group_bounds:${ctx.path}`, (fc) => meshFieldOn(fc, 'BOOLEAN', 'EDGE', (m) => groupBoundaries(m, evalFull(idF, makeContext(m, 'FACE'))))),
      };
    },
  },
);
