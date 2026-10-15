// Mesh Boolean node.
import { geoNode, sock, geo, enumProp } from './gndef';
import { prop } from './defs';
import { EdgeHash, GeometrySet, type MeshComponent } from '../geometry';
import { ConstField } from '../field';
import { attributeField } from '../inputs';
import { realizeInstances } from '../ops/join';
import { meshBoolean, type BooleanOp } from '../ops/boolean';

const meshOf = (g: GeometrySet): MeshComponent | null => (g.instances ? realizeInstances(g).mesh : g.mesh) ?? null;

geoNode(
  {
    idname: 'GeometryNodeMeshBoolean',
    label: 'Mesh Boolean',
    category: 'geometry',
    description: 'Cut, subtract or join meshes based on their volumes',
    inputs: [geo('Mesh 1'), geo('Mesh 2', { multiInput: true }), sock('Self Intersection', 'BOOLEAN', { d: false }), sock('Hole Tolerant', 'BOOLEAN', { d: false })],
    outputs: [geo('Mesh'), sock('Intersecting Edges', 'BOOLEAN', { field: true })],
    props: [
      enumProp(
        'operation',
        'Operation',
        [
          ['INTERSECT', 'Intersect'],
          ['UNION', 'Union'],
          ['DIFFERENCE', 'Difference'],
        ],
        'DIFFERENCE',
        { expand: true },
      ),
      enumProp(
        'solver',
        'Solver',
        [
          ['EXACT', 'Exact'],
          ['FLOAT', 'Float'],
          ['MANIFOLD', 'Manifold'],
        ],
        'FLOAT',
      ),
    ],
    available: (n, s, isOutput) => {
      if (isOutput) return s.identifier !== 'Intersecting Edges' || prop(n, 'solver') !== 'FLOAT';
      if (s.identifier === 'Mesh 1') return prop(n, 'operation') === 'DIFFERENCE';
      if (s.identifier === 'Self Intersection' || s.identifier === 'Hole Tolerant') return prop(n, 'solver') === 'EXACT';
      return true;
    },
    socketLabel: (n, s) => (s.identifier === 'Mesh 2' && prop(n, 'operation') !== 'DIFFERENCE' ? 'Mesh' : undefined),
  },
  {
    exec: (ctx) => {
      const op = String(prop(ctx.node, 'operation')) as BooleanOp;
      const first = op === 'DIFFERENCE' ? meshOf(ctx.geometry('Mesh 1')) : null;
      const others = ctx
        .geometries('Mesh 2')
        .map(meshOf)
        .filter((m): m is MeshComponent => !!m);
      const none = { Mesh: GeometrySet.empty(), 'Intersecting Edges': new ConstField('BOOLEAN', false) };
      if (op === 'DIFFERENCE' && !first) return none;
      if (op === 'DIFFERENCE' && !others.length) return { ...none, Mesh: new GeometrySet(first!) };
      let res;
      try {
        res = meshBoolean(op, first, others);
      } catch (e) {
        ctx.warn(`Boolean failed: ${e instanceof Error ? e.message : String(e)}`);
        return none;
      }
      if (!res) return none;
      const out: Record<string, unknown> = { Mesh: new GeometrySet(res.mesh), 'Intersecting Edges': new ConstField('BOOLEAN', false) };
      if (ctx.used('Intersecting Edges') && prop(ctx.node, 'solver') !== 'FLOAT') {
        const topo = res.mesh.topology();
        const h = new EdgeHash(topo.edgeCount);
        for (let e = 0; e < topo.edgeCount; e++) h.getOrAdd(topo.edges[e * 2], topo.edges[e * 2 + 1], e);
        const data = new Uint8Array(topo.edgeCount);
        for (const [a, b] of res.intersecting) {
          const e = h.get(a, b);
          if (e >= 0) data[e] = 1;
        }
        const name = ctx.anon('Intersecting Edges');
        res.mesh.attrs.set(name, { domain: 'EDGE', type: 'BOOLEAN', data });
        out['Intersecting Edges'] = attributeField(name, 'BOOLEAN');
      }
      return out as Record<string, never>;
    },
  },
);
