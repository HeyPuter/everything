// Mesh and mesh primitive nodes.
import { gn, prop, sprop } from './defs';
import { evalOn } from './common';
import { GeometrySet, MeshComponent, setAttr } from '../geometry';
import { attributeField, normalField, positionField } from '../inputs';
import { ConstField } from '../field';
import { cubeMesh, gridMesh, uvSphereMesh, icoSphereMesh, coneMesh, circleMesh, lineMesh, type FillType } from '../ops/primitives';
import { extrudeEdges, extrudeFaces, extrudeVertices } from '../ops/extrude';
import { subdivide } from '../ops/subdiv';
import { flipFaces, meshEdgesToCurves, meshFacesToCurves, meshToPoints, triangulate } from '../ops/meshops';
import { UV_DEFAULT } from '../convert';
import type { ExecContext } from '../exec';

/** UV map output as an anonymous corner attribute (only when linked). */
function uvOut(ctx: ExecContext, mesh: MeshComponent): { mesh: MeshComponent; uv: ReturnType<typeof attributeField> | ConstField } {
  const uv = mesh.attrs.get(UV_DEFAULT);
  if (!uv) return { mesh, uv: new ConstField('VECTOR', [0, 0, 0]) };
  const m = mesh.copy();
  m.attrs.delete(UV_DEFAULT);
  if (!ctx.used('UV Map')) return { mesh: m, uv: new ConstField('VECTOR', [0, 0, 0]) };
  const name = ctx.anon('UV Map');
  m.attrs.set(name, uv);
  return { mesh: m, uv: attributeField(name, 'VECTOR') };
}

function prim(ctx: ExecContext, mesh: MeshComponent) {
  const r = uvOut(ctx, mesh);
  return { Mesh: new GeometrySet(r.mesh), 'UV Map': r.uv };
}

gn('GeometryNodeMeshCube', 'geometry', {
  exec: (ctx) => {
    const vx = ctx.int('Vertices X'),
      vy = ctx.int('Vertices Y'),
      vz = ctx.int('Vertices Z');
    // as in Blender: nothing (with a note) rather than a clamped cube
    if (!(vx >= 1 && vy >= 1 && vz >= 1)) {
      ctx.warn('Vertices must be at least 1', 'INFO');
      return { Mesh: GeometrySet.empty(), 'UV Map': new ConstField('VECTOR', [0, 0, 0]) };
    }
    return prim(ctx, cubeMesh(ctx.vector('Size'), vx, vy, vz, UV_DEFAULT));
  },
});

gn('GeometryNodeMeshGrid', 'geometry', {
  exec: (ctx) => {
    const vx = ctx.int('Vertices X'),
      vy = ctx.int('Vertices Y');
    if (vx < 1 || vy < 1)
      return {
        Mesh: GeometrySet.empty(),
        'UV Map': new ConstField('VECTOR', [0, 0, 0]),
      };
    return prim(ctx, gridMesh(ctx.float('Size X'), ctx.float('Size Y'), vx, vy, UV_DEFAULT));
  },
});

gn('GeometryNodeMeshUVSphere', 'geometry', {
  exec: (ctx) => {
    const s = ctx.int('Segments'),
      r = ctx.int('Rings');
    if (s < 3 || r < 2) {
      ctx.warn(s < 3 ? 'Segments must be at least 3' : 'Rings must be at least 2');
      return {
        Mesh: GeometrySet.empty(),
        'UV Map': new ConstField('VECTOR', [0, 0, 0]),
      };
    }
    return prim(ctx, uvSphereMesh(s, r, ctx.float('Radius'), UV_DEFAULT));
  },
});

gn('GeometryNodeMeshIcoSphere', 'geometry', {
  exec: (ctx) => prim(ctx, icoSphereMesh(ctx.float('Radius'), ctx.int('Subdivisions'), UV_DEFAULT)),
});

function coneLike(ctx: ExecContext, rTop: number, rBottom: number, zTop: number, zBottom: number) {
  const verts = ctx.int('Vertices');
  const fill = sprop(ctx.node, 'fill_type') as FillType;
  // as in Blender: nothing (with a note) for counts out of range rather than clamped counts
  const problem = !(verts >= 3)
    ? 'Vertices must be at least 3'
    : !(ctx.int('Side Segments') >= 1)
      ? 'Side Segments must be at least 1'
      : fill !== 'NONE' && !(ctx.int('Fill Segments') >= 1)
        ? 'Fill Segments must be at least 1'
        : null;
  if (problem) {
    ctx.warn(problem, 'INFO');
    return {
      Mesh: GeometrySet.empty(),
      Top: false,
      Side: false,
      Bottom: false,
      'UV Map': new ConstField('VECTOR', [0, 0, 0]),
    };
  }
  const r = coneMesh(verts, ctx.int('Side Segments'), ctx.int('Fill Segments'), rTop, rBottom, zTop, zBottom, fill, UV_DEFAULT);
  const u = uvOut(ctx, r.mesh);
  const out: Record<string, unknown> = { 'UV Map': u.uv };
  for (const [k, data] of [
    ['Top', r.top],
    ['Side', r.side],
    ['Bottom', r.bottom],
  ] as const) {
    if (!ctx.used(k)) {
      out[k] = false;
      continue;
    }
    const name = ctx.anon(k);
    setAttr(u.mesh.attrs, name, 'FACE', 'BOOLEAN', data);
    out[k] = attributeField(name, 'BOOLEAN');
  }
  out.Mesh = new GeometrySet(u.mesh);
  return out as Record<string, never>;
}

gn('GeometryNodeMeshCylinder', 'geometry', {
  exec: (ctx) => {
    const r = ctx.float('Radius'),
      d = ctx.float('Depth');
    return coneLike(ctx, r, r, d / 2, -d / 2);
  },
});

gn('GeometryNodeMeshCone', 'geometry', {
  exec: (ctx) => coneLike(ctx, ctx.float('Radius Top'), ctx.float('Radius Bottom'), ctx.float('Depth'), 0),
});

gn('GeometryNodeMeshCircle', 'geometry', {
  exec: (ctx) => {
    const v = ctx.int('Vertices');
    if (v < 3) {
      ctx.warn('Vertices must be at least 3');
      return { Mesh: GeometrySet.empty() };
    }
    const m = circleMesh(v, ctx.float('Radius'), sprop(ctx.node, 'fill_type') as FillType, null);
    return { Mesh: new GeometrySet(m) };
  },
});

gn(
  'GeometryNodeMeshLine',
  'geometry',
  {
    exec: (ctx) => {
      const start = ctx.vector('Start Location'),
        off = ctx.vector('Offset');
      const endPoints = prop(ctx.node, 'mode') === 'END_POINTS';
      let count = ctx.int('Count');
      let delta = off;
      if (endPoints && prop(ctx.node, 'count_mode') === 'RESOLUTION') {
        // edges of exactly the resolution's length towards the end point (the last one may stop short of it)
        const len = Math.hypot(off[0] - start[0], off[1] - start[1], off[2] - start[2]);
        const res = Math.max(1e-4, ctx.float('Resolution'));
        count = Math.floor(len / res) + 1;
        delta = len > 0 ? (off.map((x, i) => ((x - start[i]) / len) * res) as [number, number, number]) : [0, 0, 0];
      } else if (endPoints) delta = count > 1 ? (off.map((x, i) => (x - start[i]) / (count - 1)) as [number, number, number]) : [0, 0, 0];
      if (count < 1) return { Mesh: GeometrySet.empty() };
      return {
        Mesh: new GeometrySet(lineMesh(Math.min(count, 1e7), start, delta)),
      };
    },
  },
  {
    propPatch: {
      count_mode: { visible: (n) => prop(n, 'mode') === 'END_POINTS' },
    },
    available: (n, s) => {
      const end = prop(n, 'mode') === 'END_POINTS';
      const res = end && prop(n, 'count_mode') === 'RESOLUTION';
      if (s.identifier === 'Resolution') return res;
      if (s.identifier === 'Count') return !res;
      return true;
    },
    socketLabel: (n, s) => (s.identifier === 'Offset' && prop(n, 'mode') === 'END_POINTS' ? 'End Location' : undefined),
  },
);

// ---------------------------------------------------------------------------
// Operations

gn(
  'GeometryNodeExtrudeMesh',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      const m = g.mesh;
      const mode = sprop(ctx.node, 'mode');
      if (!m) return { Mesh: g, Top: false, Side: false };
      const offF = ctx.field('Offset', 'VECTOR'),
        scaleF = ctx.field('Offset Scale', 'FLOAT'),
        selF = ctx.field('Selection', 'BOOLEAN');
      const domain = mode === 'VERTICES' ? 'POINT' : mode === 'EDGES' ? 'EDGE' : 'FACE';
      const r = evalOn(m, domain, selF, [offF, scaleF]);
      const off = r.values[0] as Float32Array,
        sc = r.values[1] as Float32Array;
      const scaled = new Float32Array(off.length);
      for (let i = 0; i < r.ctx.size; i++) for (let k = 0; k < 3; k++) scaled[i * 3 + k] = off[i * 3 + k] * sc[i];
      const res = mode === 'VERTICES' ? extrudeVertices(m, r.sel, scaled) : mode === 'EDGES' ? extrudeEdges(m, r.sel, scaled) : extrudeFaces(m, r.sel, scaled, ctx.bool('Individual'));
      const mesh = res.mesh;
      const out: Record<string, unknown> = {};
      for (const [k, f] of [
        ['Top', res.top],
        ['Side', res.side],
      ] as const) {
        if (!ctx.used(k)) {
          out[k] = false;
          continue;
        }
        const name = ctx.anon(k);
        setAttr(mesh.attrs, name, f.domain, 'BOOLEAN', f.data);
        out[k] = attributeField(name, 'BOOLEAN');
      }
      out.Mesh = g.with(mesh);
      return out as Record<string, never>;
    },
    implicit: { Offset: () => normalField(false) },
  },
  {
    available: (n, s) => (s.identifier === 'Individual' ? sprop(n, 'mode') === 'FACES' : !s.disabled),
  },
);

gn('GeometryNodeSubdivideMesh', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Mesh');
    if (!g.mesh) return { Mesh: g };
    return {
      Mesh: g.with(
        subdivide(g.mesh, ctx.int('Level'), {
          smooth: false,
          boundary: 'ALL',
          limit: false,
        }),
      ),
    };
  },
});

gn(
  'GeometryNodeSubdivisionSurface',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      const m = g.mesh;
      if (!m) return { Mesh: g };
      const er = evalOn(m, 'EDGE', undefined, [ctx.field('Edge Crease', 'FLOAT')]);
      const vr = evalOn(m, 'POINT', undefined, [ctx.field('Vertex Crease', 'FLOAT')]);
      const out = subdivide(m, ctx.int('Level'), {
        smooth: true,
        edgeCrease: er.values[0] as Float32Array,
        vertexCrease: vr.values[0] as Float32Array,
        boundary: prop(ctx.node, 'Boundary Smooth') === 'Keep Corners' ? 'KEEP_CORNERS' : 'ALL',
        limit: ctx.bool('Limit Surface'),
      });
      return { Mesh: g.with(out) };
    },
  },
  {
    drop: ['Quality', 'UV Smooth'],
    menus: {
      'Boundary Smooth': [
        ['Keep Corners', 'Keep Corners'],
        ['All', 'All'],
      ],
    },
  },
);

gn(
  'GeometryNodeTriangulate',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      if (!g.mesh) return { Mesh: g };
      const sel = evalOn(g.mesh, 'FACE', ctx.field('Selection', 'BOOLEAN'), []).sel;
      return {
        Mesh: g.with(triangulate(g.mesh, sel, String(prop(ctx.node, 'Quad Method')), String(prop(ctx.node, 'N-gon Method')))),
      };
    },
  },
  {
    menus: {
      'Quad Method': [
        ['Beauty', 'Beauty'],
        ['Fixed', 'Fixed'],
        ['Fixed Alternate', 'Fixed Alternate'],
        ['Shortest Diagonal', 'Shortest Diagonal'],
        ['Longest Diagonal', 'Longest Diagonal'],
      ],
      'N-gon Method': [
        ['Beauty', 'Beauty'],
        ['Clip', 'Clip'],
      ],
    },
    propPatch: {
      'Quad Method': { noLabel: false },
      'N-gon Method': { noLabel: false },
    },
  },
);

gn('GeometryNodeFlipFaces', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Mesh');
    if (!g.mesh) return { Mesh: g };
    return {
      Mesh: g.with(flipFaces(g.mesh, evalOn(g.mesh, 'FACE', ctx.field('Selection', 'BOOLEAN'), []).sel)),
    };
  },
});

gn('GeometryNodeSetShadeSmooth', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const m = g.mesh;
    if (!m) return { Geometry: g };
    const domain = sprop(ctx.node, 'domain') === 'EDGE' ? 'EDGE' : 'FACE';
    const r = evalOn(m, domain, ctx.field('Selection', 'BOOLEAN'), [ctx.field('Shade Smooth', 'BOOLEAN')]);
    const name = domain === 'FACE' ? 'sharp_face' : 'sharp_edge';
    const prev = m.attrs.get(name);
    const n = r.ctx.size;
    const data = new Uint8Array(n);
    if (prev && prev.domain === domain) data.set(prev.data.subarray(0, n) as Uint8Array);
    for (let i = 0; i < n; i++) if (!r.sel || r.sel[i]) data[i] = r.values[0][i] ? 0 : 1;
    const out = m.copy();
    out.attrs.set(name, { domain, type: 'BOOLEAN', data });
    return { Geometry: g.with(out) };
  },
});

gn('GeometryNodeMeshToPoints', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Mesh');
    const m = g.mesh;
    if (!m) return { Points: GeometrySet.empty() };
    const mode = sprop(ctx.node, 'mode') as 'VERTICES' | 'EDGES' | 'FACES' | 'CORNERS';
    const domain = mode === 'VERTICES' ? 'POINT' : mode === 'EDGES' ? 'EDGE' : mode === 'FACES' ? 'FACE' : 'CORNER';
    const r = evalOn(m, domain, ctx.field('Selection', 'BOOLEAN'), [ctx.field('Position', 'VECTOR'), ctx.field('Radius', 'FLOAT')]);
    return {
      Points: new GeometrySet(undefined, meshToPoints(m, mode, r.sel, r.values[0] as Float32Array, r.values[1] as Float32Array)),
    };
  },
  implicit: { Position: positionField },
});

gn('GeometryNodeMeshToCurve', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Mesh');
    const m = g.mesh;
    if (!m) return { Curve: GeometrySet.empty() };
    const faces = sprop(ctx.node, 'mode') === 'FACES';
    const sel = evalOn(m, faces ? 'FACE' : 'EDGE', ctx.field('Selection', 'BOOLEAN'), []).sel;
    const c = faces ? meshFacesToCurves(m, sel) : meshEdgesToCurves(m, sel);
    return {
      Curve: c.curveCount ? new GeometrySet(undefined, undefined, c) : GeometrySet.empty(),
    };
  },
});

// ---------------------------------------------------------------------------
// Materials

gn('GeometryNodeSetMaterial', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const mat = ctx.idRef('Material');
    const selF = ctx.field('Selection', 'BOOLEAN');
    return {
      Geometry: g.map((c) => {
        if (c.kind === 'INSTANCES') return c;
        if (c.kind !== 'MESH') {
          const out = c.copy();
          out.materials = [mat];
          return out;
        }
        const r = evalOn(c, 'FACE', selF, []);
        const out = c.copy();
        if (!r.sel) {
          out.materials = [mat];
          out.attrs.delete('material_index');
          return out;
        }
        let idx = out.materials.indexOf(mat);
        if (idx < 0) {
          if (!out.materials.length) out.materials.push(null);
          idx = out.materials.length;
          out.materials.push(mat);
        }
        const prev = c.attrs.get('material_index');
        const data = new Int32Array(c.faceCount);
        if (prev && prev.domain === 'FACE') data.set(prev.data as Int32Array);
        for (let f = 0; f < c.faceCount; f++) if (r.sel[f]) data[f] = idx;
        out.attrs.set('material_index', { domain: 'FACE', type: 'INT', data });
        return out;
      }),
    };
  },
});

gn('GeometryNodeSetMaterialIndex', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const m = g.mesh;
    if (!m) return { Geometry: g };
    const r = evalOn(m, 'FACE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Material Index', 'INT')]);
    const prev = m.attrs.get('material_index');
    const data = new Int32Array(m.faceCount);
    if (prev && prev.domain === 'FACE') data.set(prev.data as Int32Array);
    for (let f = 0; f < m.faceCount; f++) if (!r.sel || r.sel[f]) data[f] = Math.max(0, r.values[0][f]);
    const out = m.copy();
    out.attrs.set('material_index', { domain: 'FACE', type: 'INT', data });
    return { Geometry: g.with(out) };
  },
});
