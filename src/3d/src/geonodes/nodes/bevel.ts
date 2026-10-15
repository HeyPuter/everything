// Mesh Bevel: bevel selected edges (or vertices) with the mesh editing bevel, by one offset.
import { geoNode, sock, geo, selection, enumProp } from './gndef';
import { evalOn } from './common';
import { prop } from './defs';
import { GeometrySet, MeshComponent, type MeshComponent as MC } from '../geometry';
import { ConstField } from '../field';
import { attributeField } from '../inputs';
import { MeshEdit, edgeKey, type EFace } from '../../modes/editmesh/meshedit';
import { bevelEdges, bevelVertices } from '../../modes/editmesh/bevel';

/** Edit mesh of a component with an exact edge (or vertex) selection. */
function toEdit(m: MC, edgeSel: Uint8Array | null, vertSel: Uint8Array | null): MeshEdit {
  const e = new MeshEdit();
  e.pos = Array.from(m.positions);
  const nv = m.vertCount;
  e.sel = new Array(nv).fill(0);
  e.hide = new Array(nv).fill(0);
  const smooth = m.attrs.get('sharp_face');
  const mat = m.attrs.get('material_index');
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      n = m.faceOffsets[f + 1] - s;
    e.faces.push({
      verts: Array.from(m.corners.subarray(s, s + n)),
      uvs: new Array(n * 2).fill(0),
      smooth: smooth && smooth.domain === 'FACE' ? !smooth.data[f] : false,
      material: mat && mat.domain === 'FACE' ? mat.data[f] : 0,
      seams: new Array(n).fill(0),
      sharp: new Array(n).fill(0),
      creases: new Array(n).fill(0),
    });
  }
  for (let i = 0; i < m.looseEdges.length; i += 2) e.looseEdges.push([m.looseEdges[i], m.looseEdges[i + 1]]);
  const topo = m.topology();
  if (vertSel) for (let v = 0; v < nv; v++) e.sel[v] = vertSel[v] ? 1 : 0;
  else {
    for (let k = 0; k < topo.edgeCount; k++) if (!edgeSel || edgeSel[k]) e.sel[topo.edges[k * 2]] = e.sel[topo.edges[k * 2 + 1]] = 1;
    // edges between selected vertices that are not selected themselves
    if (edgeSel)
      for (let k = 0; k < topo.edgeCount; k++) if (!edgeSel[k] && e.sel[topo.edges[k * 2]] && e.sel[topo.edges[k * 2 + 1]]) e.edgeExcl.add(edgeKey(topo.edges[k * 2], topo.edges[k * 2 + 1]));
  }
  return e;
}

function fromEdit(e: MeshEdit, materials: (string | null)[]): MeshComponent {
  const offsets = [0];
  const corners: number[] = [];
  for (const f of e.faces) {
    corners.push(...f.verts);
    offsets.push(corners.length);
  }
  const m = new MeshComponent(new Float32Array(e.pos), Uint32Array.from(offsets), Uint32Array.from(corners), Uint32Array.from(e.looseEdges.flat()), new Map(), [...materials]);
  if (e.faces.some((f) => !f.smooth)) m.attrs.set('sharp_face', { domain: 'FACE', type: 'BOOLEAN', data: Uint8Array.from(e.faces, (f) => (f.smooth ? 0 : 1)) });
  if (e.faces.some((f) => f.material)) m.attrs.set('material_index', { domain: 'FACE', type: 'INT', data: Int32Array.from(e.faces, (f) => f.material) });
  return m;
}

geoNode(
  {
    idname: 'GeometryNodeMeshBevel',
    label: 'Mesh Bevel',
    category: 'geometry',
    width: 180,
    description: 'Round off selected edges or vertices with new faces',
    inputs: [
      geo('Mesh'),
      selection(),
      sock('Offset', 'FLOAT', { d: 0.1, min: 0, subtype: 'DISTANCE' }),
      sock('Segments', 'INT', { d: 1, min: 1, max: 100 }),
      sock('Shape', 'FLOAT', { d: 0.5, min: 0, max: 1, subtype: 'FACTOR' }),
    ],
    outputs: [geo('Mesh'), sock('Vertex Face', 'BOOLEAN', { field: true }), sock('Edge Face', 'BOOLEAN', { field: true })],
    props: [
      enumProp(
        'Affect Kind',
        'Affect',
        [
          ['Vertices', 'Vertices'],
          ['Edges', 'Edges'],
        ],
        'Edges',
        { expand: true },
      ),
    ],
    available: (n, s, isOutput) => !(isOutput && s.identifier === 'Edge Face' && prop(n, 'Affect Kind') === 'Vertices'),
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      const m = g.mesh;
      const none = { Mesh: g, 'Vertex Face': new ConstField('BOOLEAN', false), 'Edge Face': new ConstField('BOOLEAN', false) };
      if (!m || !m.faceCount) return none;
      const verts = prop(ctx.node, 'Affect Kind') === 'Vertices';
      const sel = evalOn(m, verts ? 'POINT' : 'EDGE', ctx.field('Selection', 'BOOLEAN'), []).sel;
      const e = verts ? toEdit(m, null, sel ?? new Uint8Array(m.vertCount).fill(1)) : toEdit(m, sel, null);
      const before = new Set<EFace>(e.faces);
      const offset = Math.max(0, ctx.float('Offset')),
        segs = Math.max(1, Math.min(100, ctx.int('Segments'))),
        shape = Math.max(0, Math.min(1, ctx.float('Shape')));
      const ok = verts ? bevelVertices(e, offset, segs, shape) : bevelEdges(e, offset, segs, shape);
      if (!ok) return none;
      const out = fromEdit(e, m.materials);
      const result: Record<string, unknown> = { Mesh: g.with(out), 'Vertex Face': none['Vertex Face'], 'Edge Face': none['Edge Face'] };
      // new faces: strips along edges are quads joining two edge ends; the rest close the vertices
      const isNew = e.faces.map((f) => !before.has(f));
      const orig = new Set<string>();
      for (const o of e.faces) if (before.has(o)) for (let k = 0; k < o.verts.length; k++) orig.add(edgeKey(o.verts[k], o.verts[(k + 1) % o.verts.length]));
      // a new quad touching an original face along an edge is a strip along a beveled edge
      const strip = (i: number) => e.faces[i].verts.length === 4 && e.faces[i].verts.some((v, k, a) => orig.has(edgeKey(v, a[(k + 1) % a.length])));
      const kinds: [string, (i: number) => boolean][] = [
        ['Edge Face', (i) => isNew[i] && !verts && strip(i)],
        ['Vertex Face', (i) => isNew[i] && (verts || !strip(i))],
      ];
      for (const [k, test] of kinds) {
        if (!ctx.used(k)) continue;
        const name = ctx.anon(k);
        out.attrs.set(name, { domain: 'FACE', type: 'BOOLEAN', data: Uint8Array.from(e.faces, (_, i) => (test(i) ? 1 : 0)) });
        result[k] = attributeField(name, 'BOOLEAN');
      }
      return result as Record<string, never>;
    },
  },
);
