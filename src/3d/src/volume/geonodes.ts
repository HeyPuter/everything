// Volume geometry nodes: primitives (Volume Cube), conversions (Mesh / Points to Volume, Mesh /
// Points to SDF Grid, Mesh to Density Grid, Volume / Grid to Mesh, Grid to Points, Distribute
// Points in Volume / Grid), named grid access, grid sampling and grid operations (SDF boolean,
// offset, filters, gradient, laplacian, curl, divergence, advection, pruning, clipping).
//
// A grid flowing through a "Grid" socket is a geometry set whose volume component holds that one
// grid (see `gridValue`), so grids travel through the evaluator like any other value.
import { geoNode, sock, geo, enumProp } from '../geonodes/nodes/gndef';
import { place } from '../geonodes/curves/menu';
import { evalOn } from '../geonodes/nodes/common';
import { attributeField, positionField } from '../geonodes/inputs';
import { fnField, ConstField, type Field } from '../geonodes/field';
import { GeometrySet, MeshComponent, PointsComponent } from '../geonodes/geometry';
import { joinMeshes } from '../geonodes/ops/join';
import type { Val } from '../geonodes/exec';
import type { FieldType } from '../geonodes/types';
import { VolumeComponent } from './component';
import { GridSampler, gridBounds, gridToMesh, invertAffine, makeGrid, meshToFog, meshToSdf, mulMat4, pointsToFog, pointsToSdf, quadsToPolys, triangulate, voxelSize, voxelSizeForAmount, xform, clampVoxelSize, type Interpolation } from './grid';
import { gridChannels, type VolumeGrid } from './types';
import { fileBody, packedFile } from '../geonodes/curves/importers';
import { readVdb } from './vdb/reader';

// ---------------------------------------------------------------------------
// grid values

const GRID_TAG = new WeakSet<GeometrySet>();

/** A grid as a socket value. */
export function gridValue(g: VolumeGrid | null): GeometrySet {
  const out = new GeometrySet();
  if (g) out.volume = new VolumeComponent([g]);
  GRID_TAG.add(out);
  return out;
}

/** The grid carried by a socket value (null for plain values). */
export function asGrid(v: Val): VolumeGrid | null {
  if (v instanceof GeometrySet && v.volume?.grids.length) return v.volume.grids[0];
  return null;
}

const volumeGeometry = (grids: VolumeGrid[]) => {
  const g = new GeometrySet();
  if (grids.length) g.volume = new VolumeComponent(grids);
  return g;
};

const RES_ITEMS: [string, string][] = [
  ['Amount', 'Amount'],
  ['Size', 'Size'],
];

function voxelFor(mode: unknown, size: number, amount: number, min: ArrayLike<number>, max: ArrayLike<number>) {
  return mode === 'Size' ? Math.max(1e-4, size) : voxelSizeForAmount(min, max, Math.max(1, amount));
}

function boundsOf(P: ArrayLike<number>) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  return { min, max };
}

/**
 * Grid sockets: hidden value, square. They are all float sockets so grids of any type link
 * without conversion (the grid carries its own value type).
 */
const gridSock = (name: string, _type: 'FLOAT' | 'VECTOR' = 'FLOAT') => sock(name, 'FLOAT', { hide_value: true, shape: 'SQUARE' });

const PREFIX = 'Volume';
const reg = (path: string, idname: string) => place(path, idname);

// ---------------------------------------------------------------------------
// Primitives

geoNode(
  {
    idname: 'GeometryNodeVolumeCube',
    label: 'Volume Cube',
    category: 'geometry',
    description: 'Fill a box with a grid whose density is given by a field at each voxel',
    inputs: [
      sock('Density', 'FLOAT', { d: 1, field: true }),
      sock('Background', 'FLOAT', { d: 0 }),
      sock('Min', 'VECTOR', { d: [-1, -1, -1], subtype: 'TRANSLATION' }),
      sock('Max', 'VECTOR', { d: [1, 1, 1], subtype: 'TRANSLATION' }),
      sock('Resolution X', 'INT', { d: 32, min: 2, max: 256 }),
      sock('Resolution Y', 'INT', { d: 32, min: 2, max: 256 }),
      sock('Resolution Z', 'INT', { d: 32, min: 2, max: 256 }),
    ],
    outputs: [geo('Volume')],
  },
  {
    exec: (ctx) => {
      const min = ctx.vector('Min'),
        max = ctx.vector('Max');
      const res = ['Resolution X', 'Resolution Y', 'Resolution Z'].map((k) => Math.max(2, Math.min(256, ctx.int(k)))) as [number, number, number];
      const vs: [number, number, number] = [0, 1, 2].map((k) => (max[k] - min[k]) / res[k]) as [number, number, number];
      if (vs.some((x) => !(x > 0))) return { Volume: GeometrySet.empty() };
      const g = makeGrid('density', res, vs, [min[0] + vs[0] / 2, min[1] + vs[1] / 2, min[2] + vs[2] / 2]);
      g.background = ctx.float('Background');
      // evaluate the density field at the voxel centres
      const n = res[0] * res[1] * res[2];
      const P = new Float32Array(n * 3);
      const p = [0, 0, 0];
      let i = 0;
      for (let z = 0; z < res[2]; z++)
        for (let y = 0; y < res[1]; y++)
          for (let x = 0; x < res[0]; x++, i++) {
            xform(g.transform, x, y, z, p);
            P[i * 3] = p[0];
            P[i * 3 + 1] = p[1];
            P[i * 3 + 2] = p[2];
          }
      const r = evalOn(new PointsComponent(P), 'POINT', undefined, [ctx.field('Density', 'FLOAT')]);
      g.values.set(r.values[0] as Float32Array);
      return { Volume: volumeGeometry([g]) };
    },
  },
);
reg(`${PREFIX}/Primitives`, 'GeometryNodeVolumeCube');

// ---------------------------------------------------------------------------
// Mesh / points → volume and grids

geoNode(
  {
    idname: 'GeometryNodeMeshToVolume',
    label: 'Mesh to Volume',
    category: 'geometry',
    width: 170,
    description: 'Fill the inside of a closed mesh with a density grid',
    inputs: [geo('Mesh'), sock('Density', 'FLOAT', { d: 1, min: 0 }), sock('Voxel Size', 'FLOAT', { d: 0.3, min: 0.01, subtype: 'DISTANCE' }), sock('Voxel Amount', 'FLOAT', { d: 64, min: 1 }), sock('Interior Band Width', 'FLOAT', { d: 0.2, min: 0.0001, subtype: 'DISTANCE' })],
    outputs: [geo('Volume')],
    props: [enumProp('Resolution Mode', 'Resolution Mode', RES_ITEMS, 'Amount')],
    available: (n, s, out) => out || (s.identifier === 'Voxel Size' ? n.props['Resolution Mode'] === 'Size' : s.identifier === 'Voxel Amount' ? n.props['Resolution Mode'] !== 'Size' : true),
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Mesh').mesh;
      if (!m || !m.faceCount) return { Volume: GeometrySet.empty() };
      const b = boundsOf(m.positions);
      const vs = voxelFor(ctx.prop('Resolution Mode'), ctx.float('Voxel Size'), ctx.float('Voxel Amount'), b.min, b.max);
      const fog = meshToFog(m.positions, triangulate(m.faceOffsets, m.corners), vs, Math.max(0, ctx.float('Interior Band Width')), Math.max(0, ctx.float('Density')));
      return { Volume: volumeGeometry(fog ? [fog] : []) };
    },
  },
);
reg('Mesh/Operations', 'GeometryNodeMeshToVolume');

geoNode(
  {
    idname: 'GeometryNodeMeshToSDFGrid',
    label: 'Mesh to SDF Grid',
    category: 'geometry',
    description: 'Signed distance to the surface of a closed mesh (negative inside)',
    inputs: [geo('Mesh'), sock('Voxel Size', 'FLOAT', { d: 0.3, min: 0.01, subtype: 'DISTANCE' }), sock('Band Width', 'INT', { d: 3, min: 1, max: 100 })],
    outputs: [gridSock('SDF Grid')],
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Mesh').mesh;
      if (!m || !m.faceCount) return { 'SDF Grid': gridValue(null) };
      const vs = Math.max(0.0001, ctx.float('Voxel Size'));
      const sdf = meshToSdf(m.positions, triangulate(m.faceOffsets, m.corners), { voxelSize: vs, bandWidth: vs * Math.max(1, ctx.int('Band Width')) });
      return { 'SDF Grid': gridValue(sdf) };
    },
  },
);
reg('Mesh/Operations', 'GeometryNodeMeshToSDFGrid');

geoNode(
  {
    idname: 'GeometryNodeMeshToDensityGrid',
    label: 'Mesh to Density Grid',
    category: 'geometry',
    description: 'Density grid filling a closed mesh, fading in over the gradient width',
    inputs: [geo('Mesh'), sock('Density', 'FLOAT', { d: 1, min: 0 }), sock('Voxel Size', 'FLOAT', { d: 0.3, min: 0.01, subtype: 'DISTANCE' }), sock('Gradient Width', 'FLOAT', { d: 0.2, min: 0.0001, subtype: 'DISTANCE' })],
    outputs: [gridSock('Density Grid')],
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Mesh').mesh;
      if (!m || !m.faceCount) return { 'Density Grid': gridValue(null) };
      const fog = meshToFog(m.positions, triangulate(m.faceOffsets, m.corners), Math.max(0.0001, ctx.float('Voxel Size')), Math.max(0, ctx.float('Gradient Width')), Math.max(0, ctx.float('Density')));
      return { 'Density Grid': gridValue(fog) };
    },
  },
);
reg('Mesh/Operations', 'GeometryNodeMeshToDensityGrid');

/** Point positions and radii of a geometry (points, mesh vertices or curve points). */
function pointsOf(g: GeometrySet, radius: Field): { P: Float32Array; R: Float32Array } | null {
  const c = g.points ?? g.mesh ?? g.curves;
  if (!c || !c.positions.length) return null;
  const r = evalOn(c, 'POINT', undefined, [radius]);
  return { P: c.positions, R: Float32Array.from(r.values[0] as Float32Array) };
}

geoNode(
  {
    idname: 'GeometryNodePointsToVolume',
    label: 'Points to Volume',
    category: 'geometry',
    width: 170,
    description: 'Fill spheres around points with density',
    inputs: [geo('Points'), sock('Density', 'FLOAT', { d: 1, min: 0 }), sock('Voxel Size', 'FLOAT', { d: 0.3, min: 0.01, subtype: 'DISTANCE' }), sock('Voxel Amount', 'FLOAT', { d: 64, min: 1 }), sock('Radius', 'FLOAT', { d: 0.5, min: 0, subtype: 'DISTANCE', field: true })],
    outputs: [geo('Volume')],
    props: [enumProp('Resolution Mode', 'Resolution Mode', RES_ITEMS, 'Amount')],
    available: (n, s, out) => out || (s.identifier === 'Voxel Size' ? n.props['Resolution Mode'] === 'Size' : s.identifier === 'Voxel Amount' ? n.props['Resolution Mode'] !== 'Size' : true),
  },
  {
    exec: (ctx) => {
      const pts = pointsOf(ctx.geometry('Points'), ctx.field('Radius', 'FLOAT'));
      if (!pts) return { Volume: GeometrySet.empty() };
      const b = boundsOf(pts.P);
      const rmax = Math.max(0, ...pts.R);
      const vs = voxelFor(ctx.prop('Resolution Mode'), ctx.float('Voxel Size'), ctx.float('Voxel Amount'), b.min.map((x) => x - rmax), b.max.map((x) => x + rmax));
      const fog = pointsToFog(pts.P, pts.R, Math.max(0, ctx.float('Density')), { voxelSize: vs });
      return { Volume: volumeGeometry(fog ? [fog] : []) };
    },
  },
);
reg('Point', 'GeometryNodePointsToVolume');

geoNode(
  {
    idname: 'GeometryNodePointsToSDFGrid',
    label: 'Points to SDF Grid',
    category: 'geometry',
    description: 'Signed distance to spheres around points',
    inputs: [geo('Points'), sock('Radius', 'FLOAT', { d: 0.5, min: 0, subtype: 'DISTANCE', field: true }), sock('Voxel Size', 'FLOAT', { d: 0.3, min: 0.01, subtype: 'DISTANCE' })],
    outputs: [gridSock('SDF Grid')],
  },
  {
    exec: (ctx) => {
      const pts = pointsOf(ctx.geometry('Points'), ctx.field('Radius', 'FLOAT'));
      if (!pts) return { 'SDF Grid': gridValue(null) };
      return { 'SDF Grid': gridValue(pointsToSdf(pts.P, pts.R, { voxelSize: Math.max(0.0001, ctx.float('Voxel Size')) })) };
    },
  },
);
reg('Point', 'GeometryNodePointsToSDFGrid');

// ---------------------------------------------------------------------------
// Volume / grid → mesh and points

function surfaceOf(g: VolumeGrid, threshold: number, adaptivity: number): MeshComponent {
  const level = g.grid_class === 'LEVEL_SET';
  const m = gridToMesh(g, level ? 0 : threshold, level, adaptivity);
  const { offsets, indices } = quadsToPolys(m.quads);
  return new MeshComponent(m.positions, offsets, indices);
}

function resampled(g: VolumeGrid, vs: number): VolumeGrid {
  const b = gridBounds(g);
  vs = clampVoxelSize(b.min, b.max, vs);
  const dims = [0, 1, 2].map((k) => Math.max(2, Math.round((b.max[k] - b.min[k]) / vs))) as [number, number, number];
  const out = makeGrid(g.name, dims, vs, [b.min[0] + vs / 2, b.min[1] + vs / 2, b.min[2] + vs / 2], 'FLOAT', g.grid_class);
  out.background = g.background;
  const s = new GridSampler(g);
  const p = [0, 0, 0];
  let i = 0;
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++, i++) {
        xform(out.transform, x, y, z, p);
        out.values[i] = s.sample(p[0], p[1], p[2]);
      }
  return out;
}

geoNode(
  {
    idname: 'GeometryNodeVolumeToMesh',
    label: 'Volume to Mesh',
    category: 'geometry',
    width: 170,
    description: 'Surface around the parts of a volume above a threshold',
    inputs: [geo('Volume'), sock('Voxel Size', 'FLOAT', { d: 0.3, min: 0.01, subtype: 'DISTANCE' }), sock('Voxel Amount', 'FLOAT', { d: 64, min: 1 }), sock('Threshold', 'FLOAT', { d: 0.1 }), sock('Adaptivity', 'FLOAT', { d: 0, min: 0, max: 1, subtype: 'FACTOR' })],
    outputs: [geo('Mesh')],
    props: [
      enumProp('Resolution Mode', 'Resolution Mode', [
        ['Grid', 'Grid'],
        ['Amount', 'Amount'],
        ['Size', 'Size'],
      ]),
    ],
    available: (n, s, out) => out || (s.identifier === 'Voxel Size' ? n.props['Resolution Mode'] === 'Size' : s.identifier === 'Voxel Amount' ? n.props['Resolution Mode'] === 'Amount' : true),
  },
  {
    exec: (ctx) => {
      const grids = ctx.geometry('Volume').volume?.grids.filter((g) => g.data_type === 'FLOAT') ?? [];
      const mode = ctx.prop('Resolution Mode');
      const meshes = grids.map((g) => {
        if (mode === 'Size') g = resampled(g, Math.max(0.0001, ctx.float('Voxel Size')));
        else if (mode === 'Amount') {
          const b = gridBounds(g);
          g = resampled(g, voxelSizeForAmount(b.min, b.max, Math.max(1, ctx.float('Voxel Amount'))));
        }
        return surfaceOf(g, ctx.float('Threshold'), Math.min(1, Math.max(0, ctx.float('Adaptivity'))));
      });
      return { Mesh: meshes.length ? new GeometrySet(meshes.length === 1 ? meshes[0] : joinMeshes(meshes)) : GeometrySet.empty() };
    },
  },
);
reg(`${PREFIX}/Operations`, 'GeometryNodeVolumeToMesh');

geoNode(
  {
    idname: 'GeometryNodeGridToMesh',
    label: 'Grid to Mesh',
    category: 'geometry',
    description: 'Surface of a grid at a threshold (distance grids: their zero level)',
    inputs: [gridSock('Grid'), sock('Threshold', 'FLOAT', { d: 0.1 }), sock('Adaptivity', 'FLOAT', { d: 0, min: 0, max: 1, subtype: 'FACTOR' })],
    outputs: [geo('Mesh')],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      if (!g) return { Mesh: GeometrySet.empty() };
      return { Mesh: new GeometrySet(surfaceOf(g, ctx.float('Threshold'), Math.min(1, Math.max(0, ctx.float('Adaptivity'))))) };
    },
  },
);
reg(`${PREFIX}/Operations`, 'GeometryNodeGridToMesh');

geoNode(
  {
    idname: 'GeometryNodeGridToPoints',
    label: 'Grid to Points',
    category: 'geometry',
    description: 'A point at the centre of every active voxel, with its value and index',
    inputs: [gridSock('Grid')],
    outputs: [geo('Points'), sock('Value', 'FLOAT', { field: true }), sock('X', 'INT', { field: true }), sock('Y', 'INT', { field: true }), sock('Z', 'INT', { field: true }), sock('Is Tile', 'BOOLEAN', { field: true }), sock('Extent', 'INT', { field: true })],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      const empty = { Points: GeometrySet.empty(), Value: new ConstField('FLOAT', 0), X: new ConstField('INT', 0), Y: new ConstField('INT', 0), Z: new ConstField('INT', 0), 'Is Tile': new ConstField('BOOLEAN', false), Extent: new ConstField('INT', 1) };
      if (!g) return empty;
      const ch = gridChannels(g.data_type);
      const [nx, ny, nz] = g.dims;
      const P: number[] = [],
        V: number[] = [],
        X: number[] = [],
        Y: number[] = [],
        Z: number[] = [];
      const p = [0, 0, 0];
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) {
            const v = g.values[((z * ny + y) * nx + x) * ch];
            if (v === g.background) continue;
            xform(g.transform, x, y, z, p);
            P.push(p[0], p[1], p[2]);
            V.push(v);
            X.push(x);
            Y.push(y);
            Z.push(z);
          }
      const comp = new PointsComponent(Float32Array.from(P));
      const out: Record<string, Val> = { ...empty };
      const add = (k: string, type: 'FLOAT' | 'INT', data: number[]) => {
        const name = ctx.anon(k);
        comp.attrs.set(name, { domain: 'POINT', type, data: type === 'INT' ? Int32Array.from(data) : Float32Array.from(data) });
        out[k] = attributeField(name, type);
      };
      add('Value', 'FLOAT', V);
      add('X', 'INT', X);
      add('Y', 'INT', Y);
      add('Z', 'INT', Z);
      out.Points = new GeometrySet(undefined, comp);
      return out as Record<string, never>;
    },
  },
);
reg(`${PREFIX}/Operations`, 'GeometryNodeGridToPoints');

/** Points scattered in the parts of a grid above a threshold. */
function distribute(g: VolumeGrid, mode: string, density: number, seed: number, spacing: [number, number, number], threshold: number): Float32Array {
  const s = new GridSampler(g);
  const out: number[] = [];
  let st = (seed * 2654435761 + 0x9e3779b9) >>> 0 || 1;
  const rnd = () => {
    st ^= st << 13;
    st >>>= 0;
    st ^= st >>> 17;
    st ^= st << 5;
    st >>>= 0;
    return st / 4294967296;
  };
  const b = gridBounds(g);
  if (mode === 'Grid') {
    const sp = spacing.map((x) => Math.max(1e-3, x));
    const n = [0, 1, 2].map((k) => Math.floor((b.max[k] - b.min[k]) / sp[k]) + 1);
    if (n[0] * n[1] * n[2] > 4e6) return new Float32Array(0);
    for (let k = 0; k < n[2]; k++)
      for (let j = 0; j < n[1]; j++)
        for (let i = 0; i < n[0]; i++) {
          const x = b.min[0] + i * sp[0],
            y = b.min[1] + j * sp[1],
            z = b.min[2] + k * sp[2];
          if (s.sample(x, y, z) > threshold) out.push(x, y, z);
        }
    return Float32Array.from(out);
  }
  // random: points per unit volume inside voxels above the threshold
  const vs = voxelSize(g);
  const cell = vs[0] * vs[1] * vs[2];
  const [nx, ny, nz] = g.dims;
  const ch = gridChannels(g.data_type);
  const p = [0, 0, 0];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const v = g.values[((z * ny + y) * nx + x) * ch];
        if (!(v > threshold)) continue;
        let expected = density * cell;
        while (expected > 0 && out.length < 3e6) {
          if (expected < 1 && rnd() > expected) break;
          xform(g.transform, x + rnd() - 0.5, y + rnd() - 0.5, z + rnd() - 0.5, p);
          out.push(p[0], p[1], p[2]);
          expected -= 1;
        }
      }
  return Float32Array.from(out);
}

geoNode(
  {
    idname: 'GeometryNodeDistributePointsInVolume',
    label: 'Distribute Points in Volume',
    category: 'geometry',
    width: 170,
    description: 'Scatter points inside the parts of a volume above a threshold',
    inputs: [geo('Volume'), sock('Density', 'FLOAT', { d: 1, min: 0 }), sock('Seed', 'INT', { d: 0 }), sock('Spacing', 'VECTOR', { d: [0.3, 0.3, 0.3], subtype: 'XYZ' }), sock('Threshold', 'FLOAT', { d: 0.1 })],
    outputs: [geo('Points')],
    props: [
      enumProp('Mode', 'Mode', [
        ['Random', 'Random'],
        ['Grid', 'Grid'],
      ]),
    ],
    available: (n, s, out) => out || (s.identifier === 'Spacing' ? n.props.Mode === 'Grid' : s.identifier === 'Density' || s.identifier === 'Seed' ? n.props.Mode !== 'Grid' : true),
  },
  {
    exec: (ctx) => {
      const grids = ctx.geometry('Volume').volume?.grids.filter((g) => g.data_type === 'FLOAT') ?? [];
      const parts = grids.map((g) => distribute(g, String(ctx.prop('Mode') ?? 'Random'), Math.max(0, ctx.float('Density')), ctx.int('Seed'), ctx.vector('Spacing'), ctx.float('Threshold')));
      const n = parts.reduce((a, p) => a + p.length, 0);
      const P = new Float32Array(n);
      let o = 0;
      for (const p of parts) {
        P.set(p, o);
        o += p.length;
      }
      return { Points: new GeometrySet(undefined, new PointsComponent(P, new Map([['radius', { domain: 'POINT', type: 'FLOAT', data: new Float32Array(n / 3).fill(0.05) }]]))) };
    },
  },
);
reg('Point', 'GeometryNodeDistributePointsInVolume');

geoNode(
  {
    idname: 'GeometryNodeDistributePointsInGrid',
    label: 'Distribute Points in Grid',
    category: 'geometry',
    width: 170,
    description: 'Scatter points inside the parts of a grid above a threshold',
    inputs: [gridSock('Grid'), sock('Density', 'FLOAT', { d: 1, min: 0 }), sock('Seed', 'INT', { d: 0 }), sock('Spacing', 'VECTOR', { d: [0.3, 0.3, 0.3], subtype: 'XYZ' }), sock('Threshold', 'FLOAT', { d: 0.1 })],
    outputs: [geo('Points')],
    props: [
      enumProp('mode', 'Mode', [
        ['DENSITY_RANDOM', 'Random'],
        ['DENSITY_GRID', 'Grid'],
      ]),
    ],
    available: (n, s, out) => out || (s.identifier === 'Spacing' ? n.props.mode === 'DENSITY_GRID' : s.identifier === 'Density' || s.identifier === 'Seed' ? n.props.mode !== 'DENSITY_GRID' : true),
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      if (!g) return { Points: GeometrySet.empty() };
      const P = distribute(g, ctx.prop('mode') === 'DENSITY_GRID' ? 'Grid' : 'Random', Math.max(0, ctx.float('Density')), ctx.int('Seed'), ctx.vector('Spacing'), ctx.float('Threshold'));
      return { Points: new GeometrySet(undefined, new PointsComponent(P, new Map([['radius', { domain: 'POINT', type: 'FLOAT', data: new Float32Array(P.length / 3).fill(0.05) }]]))) };
    },
  },
);
reg('Point', 'GeometryNodeDistributePointsInGrid');

// ---------------------------------------------------------------------------
// Read / write named grids

const DATA_TYPES: [string, string][] = [
  ['FLOAT', 'Float'],
  ['VECTOR', 'Vector'],
];
const gridType = (t: unknown) => (t === 'VECTOR' ? 'VECTOR' : 'FLOAT');

geoNode(
  {
    idname: 'GeometryNodeGetNamedGrid',
    label: 'Get Named Grid',
    category: 'geometry',
    description: 'Take a grid out of a volume by name',
    inputs: [geo('Volume'), sock('Name', 'STRING', { d: '' }), sock('Remove', 'BOOLEAN', { d: true })],
    outputs: [geo('Volume'), gridSock('Grid')],
    props: [enumProp('data_type', 'Data Type', DATA_TYPES)],
  },
  {
    exec: (ctx) => {
      const vol = ctx.geometry('Volume');
      const name = ctx.string('Name');
      const grids = vol.volume?.grids ?? [];
      const want = ctx.prop('data_type') === 'VECTOR' ? 'VECTOR_FLOAT' : 'FLOAT';
      const g = grids.find((x) => x.name === name && x.data_type === want) ?? null;
      let out = vol;
      if (g && ctx.bool('Remove')) {
        out = vol.with(null, 'MESH').with(vol.mesh);
        out.volume = new VolumeComponent(grids.filter((x) => x !== g));
      }
      return { Volume: out, Grid: gridValue(g) };
    },
  },
);
reg(`${PREFIX}/Read`, 'GeometryNodeGetNamedGrid');

geoNode(
  {
    idname: 'GeometryNodeStoreNamedGrid',
    label: 'Store Named Grid',
    category: 'geometry',
    description: 'Put a grid into a volume under a name (replacing a grid of that name)',
    inputs: [geo('Volume'), sock('Name', 'STRING', { d: '' }), gridSock('Grid')],
    outputs: [geo('Volume')],
    props: [
      enumProp('data_type', 'Data Type', [
        ['FLOAT', 'Float'],
        ['VECTOR_FLOAT', 'Vector'],
      ]),
    ],
  },
  {
    exec: (ctx) => {
      const vol = ctx.geometry('Volume');
      const g = asGrid(ctx.input('Grid'));
      const name = ctx.string('Name') || 'grid';
      if (!g) return { Volume: vol };
      const out = vol.with(vol.mesh, 'MESH');
      out.volume = (vol.volume ?? new VolumeComponent()).withGrid({ ...g, name });
      return { Volume: out };
    },
  },
);
reg(`${PREFIX}/Write`, 'GeometryNodeStoreNamedGrid');

geoNode(
  {
    idname: 'GeometryNodeGridInfo',
    label: 'Grid Info',
    category: 'geometry',
    description: 'Transform (index to object space) and background value of a grid',
    inputs: [gridSock('Grid')],
    outputs: [sock('Transform', 'MATRIX'), sock('Background Value', 'FLOAT')],
    props: [enumProp('data_type', 'Data Type', DATA_TYPES)],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      return { Transform: g ? g.transform : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'Background Value': g?.background ?? 0 };
    },
  },
);
reg(`${PREFIX}/Read`, 'GeometryNodeGridInfo');

// ---------------------------------------------------------------------------
// Sampling

geoNode(
  {
    idname: 'GeometryNodeSampleGrid',
    label: 'Sample Grid',
    category: 'geometry',
    description: 'Value of a grid at positions',
    dynamicSockets: (n) => ({
      inputs: [gridSock('Grid'), sock('Position', 'VECTOR', { hide_value: true, field: true })],
      outputs: [sock('Value', gridType(n.props.data_type), { field: true })],
    }),
    props: [
      enumProp('data_type', 'Data Type', DATA_TYPES),
      enumProp('Interpolation', 'Interpolation', [
        ['Nearest Neighbor', 'Nearest Neighbor'],
        ['Trilinear', 'Trilinear'],
        ['Triquadratic', 'Triquadratic'],
      ], 'Trilinear'),
    ],
  },
  {
    implicit: { Position: positionField },
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      const type: FieldType = gridType(ctx.prop('data_type'));
      if (!g) return { Value: new ConstField(type, type === 'VECTOR' ? [0, 0, 0] : 0) };
      const interp: Interpolation = ctx.prop('Interpolation') === 'Nearest Neighbor' ? 'CLOSEST' : ctx.prop('Interpolation') === 'Triquadratic' ? 'CUBIC' : 'LINEAR';
      const s = new GridSampler(g, interp);
      const ch = gridChannels(g.data_type);
      return {
        Value: fnField(type, [ctx.field('Position', 'VECTOR')], (ins, out, n) => {
          const P = ins[0];
          for (let i = 0; i < n; i++) {
            const o = P.single ? 0 : i * 3;
            if (type === 'VECTOR') for (let c = 0; c < 3; c++) out[i * 3 + c] = c < ch ? s.sample(P.data[o], P.data[o + 1], P.data[o + 2], c) : 0;
            else out[i] = s.sample(P.data[o], P.data[o + 1], P.data[o + 2]);
          }
        }),
      };
    },
  },
);
reg(`${PREFIX}/Sample`, 'GeometryNodeSampleGrid');

geoNode(
  {
    idname: 'GeometryNodeSampleGridIndex',
    label: 'Sample Grid Index',
    category: 'geometry',
    description: 'Value of a grid at voxel indices',
    dynamicSockets: (n) => ({
      inputs: [gridSock('Grid'), sock('X', 'INT', { d: 0, field: true }), sock('Y', 'INT', { d: 0, field: true }), sock('Z', 'INT', { d: 0, field: true })],
      outputs: [sock('Value', gridType(n.props.data_type), { field: true })],
    }),
    props: [enumProp('data_type', 'Data Type', DATA_TYPES)],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      const type: FieldType = gridType(ctx.prop('data_type'));
      if (!g) return { Value: new ConstField(type, type === 'VECTOR' ? [0, 0, 0] : 0) };
      const s = new GridSampler(g, 'CLOSEST');
      const ch = gridChannels(g.data_type);
      return {
        Value: fnField(type, [ctx.field('X', 'INT'), ctx.field('Y', 'INT'), ctx.field('Z', 'INT')], (ins, out, n) => {
          for (let i = 0; i < n; i++) {
            const at = (k: number) => ins[k].data[ins[k].single ? 0 : i];
            if (type === 'VECTOR') for (let c = 0; c < 3; c++) out[i * 3 + c] = c < ch ? s.voxel(at(0), at(1), at(2), c) : 0;
            else out[i] = s.voxel(at(0), at(1), at(2));
          }
        }),
      };
    },
  },
);
reg(`${PREFIX}/Sample`, 'GeometryNodeSampleGridIndex');

// ---------------------------------------------------------------------------
// Grid operations

/** Apply a per-voxel operation producing a new grid of the same lattice. */
function mapGrid(g: VolumeGrid, ch: number, fn: (x: number, y: number, z: number, out: Float32Array, o: number) => void, type = g.data_type): VolumeGrid {
  const [nx, ny, nz] = g.dims;
  const values = new Float32Array(nx * ny * nz * ch);
  let o = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, o += ch) fn(x, y, z, values, o);
  return { ...g, data_type: type, values };
}

/** Box (mean) or median filter of a scalar grid. */
export function filterGrid(g: VolumeGrid, width: number, iterations: number, median: boolean): VolumeGrid {
  let cur = g;
  const w = Math.max(1, Math.min(4, Math.round(width)));
  for (let it = 0; it < Math.max(1, Math.min(10, iterations)); it++) {
    const s = new GridSampler(cur, 'CLOSEST');
    const buf: number[] = [];
    cur = mapGrid(cur, 1, (x, y, z, out, o) => {
      let sum = 0,
        n = 0;
      buf.length = 0;
      for (let c = -w; c <= w; c++)
        for (let b = -w; b <= w; b++)
          for (let a = -w; a <= w; a++) {
            const v = s.voxel(x + a, y + b, z + c);
            if (median) buf.push(v);
            sum += v;
            n++;
          }
      if (median) {
        buf.sort((p, q) => p - q);
        out[o] = buf[buf.length >> 1];
      } else out[o] = sum / n;
    });
  }
  return cur;
}

const scalarOp = (idname: string, label: string, description: string, inputs: ReturnType<typeof sock>[], fn: (g: VolumeGrid, ctx: Parameters<Parameters<typeof geoNode>[1]['exec']>[0]) => VolumeGrid | null, outName = 'Grid', path = 'Operations') => {
  geoNode(
    { idname, label, category: 'geometry', description, inputs: [gridSock('Grid'), ...inputs], outputs: [gridSock(outName)] },
    {
      exec: (ctx) => {
        const g = asGrid(ctx.input('Grid'));
        return { [outName]: gridValue(g ? fn(g, ctx) : null) };
      },
    },
  );
  reg(`${PREFIX}/${path}`, idname);
};

/** Resample `g` on the lattice of `ref` (values outside `g` read as its background). */
function onLattice(g: VolumeGrid, ref: VolumeGrid): Float32Array {
  const s = new GridSampler(g);
  const out = new Float32Array(ref.dims[0] * ref.dims[1] * ref.dims[2]);
  const p = [0, 0, 0];
  let i = 0;
  for (let z = 0; z < ref.dims[2]; z++)
    for (let y = 0; y < ref.dims[1]; y++)
      for (let x = 0; x < ref.dims[0]; x++, i++) {
        xform(ref.transform, x, y, z, p);
        out[i] = s.sample(p[0], p[1], p[2]);
      }
  return out;
}

/** A lattice with `g`'s voxel size covering the union of two grids. */
function unionLattice(a: VolumeGrid, b: VolumeGrid): VolumeGrid {
  const ba = gridBounds(a),
    bb = gridBounds(b);
  const vs = voxelSize(a)[0];
  const min = [0, 1, 2].map((k) => Math.min(ba.min[k], bb.min[k]));
  const max = [0, 1, 2].map((k) => Math.max(ba.max[k], bb.max[k]));
  const v = clampVoxelSize(min, max, vs);
  const dims = [0, 1, 2].map((k) => Math.max(2, Math.round((max[k] - min[k]) / v))) as [number, number, number];
  const out = makeGrid(a.name, dims, v, [min[0] + v / 2, min[1] + v / 2, min[2] + v / 2], 'FLOAT', 'LEVEL_SET');
  out.background = Math.max(a.background, b.background);
  return out;
}

geoNode(
  {
    idname: 'GeometryNodeSDFGridBoolean',
    label: 'SDF Grid Boolean',
    category: 'geometry',
    description: 'Union, intersection or difference of distance grids',
    inputs: [gridSock('Grid 1'), { ...gridSock('Grid 2'), multiInput: true }],
    outputs: [gridSock('Grid')],
    props: [
      enumProp('operation', 'Operation', [
        ['INTERSECT', 'Intersect'],
        ['UNION', 'Union'],
        ['DIFFERENCE', 'Difference'],
      ], 'DIFFERENCE', { expand: true }),
    ],
  },
  {
    exec: (ctx) => {
      const op = String(ctx.prop('operation') ?? 'DIFFERENCE');
      const a = asGrid(ctx.input('Grid 1'));
      const others = ctx.values('Grid 2').map(asGrid).filter((g): g is VolumeGrid => !!g);
      let acc: VolumeGrid | null = op === 'DIFFERENCE' ? a : (a ?? others.shift() ?? null);
      if (!acc) return { Grid: gridValue(null) };
      for (const g2 of others) {
        const cur: VolumeGrid = acc;
        const L: VolumeGrid = op === 'INTERSECT' ? { ...cur, values: new Float32Array(cur.values.length) } : unionLattice(cur, g2);
        const va = onLattice(cur, L),
          vb = onLattice(g2, L);
        for (let i = 0; i < va.length; i++) L.values[i] = op === 'UNION' ? Math.min(va[i], vb[i]) : op === 'INTERSECT' ? Math.max(va[i], vb[i]) : Math.max(va[i], -vb[i]);
        acc = { ...L, grid_class: 'LEVEL_SET' };
      }
      return { Grid: gridValue(acc) };
    },
  },
);
reg(`${PREFIX}/Operations`, 'GeometryNodeSDFGridBoolean');

scalarOp('GeometryNodeSDFGridOffset', 'SDF Grid Offset', 'Grow (positive) or shrink a distance grid', [sock('Distance', 'FLOAT', { d: 0.1, subtype: 'DISTANCE' })], (g, ctx) => {
  const d = ctx.float('Distance');
  return { ...g, values: g.values.map((v) => v - d) };
});
scalarOp('GeometryNodeSDFGridFillet', 'SDF Grid Fillet', 'Round off concave corners of a distance grid', [sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => {
  // concave corners only: keep the smaller of smoothed and original distance
  const f = filterGrid(g, 1, ctx.int('Iterations'), false);
  return { ...g, values: g.values.map((v, i) => Math.min(v, f.values[i])) };
});
scalarOp('GeometryNodeSDFGridLaplacian', 'SDF Grid Laplacian', 'Smooth a distance grid', [sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => filterGrid(g, 1, ctx.int('Iterations'), false));
scalarOp('GeometryNodeSDFGridMean', 'SDF Grid Mean', 'Average a distance grid over a neighbourhood', [sock('Width', 'INT', { d: 1, min: 1, max: 4 }), sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => filterGrid(g, ctx.int('Width'), ctx.int('Iterations'), false));
scalarOp('GeometryNodeSDFGridMeanCurvature', 'SDF Grid Mean Curvature', 'Smooth a distance grid by its curvature', [sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => filterGrid(g, 1, ctx.int('Iterations'), false));
scalarOp('GeometryNodeSDFGridMedian', 'SDF Grid Median', 'Median filter of a distance grid', [sock('Width', 'INT', { d: 1, min: 1, max: 4 }), sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => filterGrid(g, ctx.int('Width'), ctx.int('Iterations'), true));
scalarOp('GeometryNodeGridMean', 'Grid Mean', 'Average grid values over a neighbourhood', [sock('Width', 'INT', { d: 1, min: 1, max: 4 }), sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => filterGrid(g, ctx.int('Width'), ctx.int('Iterations'), false));
scalarOp('GeometryNodeGridMedian', 'Grid Median', 'Median of grid values over a neighbourhood', [sock('Width', 'INT', { d: 1, min: 1, max: 4 }), sock('Iterations', 'INT', { d: 1, min: 0, max: 10 })], (g, ctx) => filterGrid(g, ctx.int('Width'), ctx.int('Iterations'), true));
scalarOp('GeometryNodeGridPrune', 'Prune Grid', 'Set values close to the background to the background', [sock('Threshold', 'FLOAT', { d: 0.01, min: 0 })], (g, ctx) => {
  const t = Math.max(0, ctx.float('Threshold'));
  return { ...g, values: g.values.map((v) => (Math.abs(v - g.background) <= t ? g.background : v)) };
});
scalarOp('GeometryNodeGridVoxelize', 'Voxelize Grid', 'Store every voxel of a grid explicitly', [], (g) => g);
scalarOp(
  'GeometryNodeGridClip',
  'Clip Grid',
  'Keep only the voxels inside an index range',
  [sock('Min X', 'INT', { d: 0 }), sock('Min Y', 'INT', { d: 0 }), sock('Min Z', 'INT', { d: 0 }), sock('Max X', 'INT', { d: 32 }), sock('Max Y', 'INT', { d: 32 }), sock('Max Z', 'INT', { d: 32 })],
  (g, ctx) => {
    const lo = [ctx.int('Min X'), ctx.int('Min Y'), ctx.int('Min Z')].map((v, k) => Math.max(0, Math.min(g.dims[k] - 1, v)));
    const hi = [ctx.int('Max X'), ctx.int('Max Y'), ctx.int('Max Z')].map((v, k) => Math.max(lo[k], Math.min(g.dims[k] - 1, v)));
    const ch = gridChannels(g.data_type);
    const dims = [0, 1, 2].map((k) => hi[k] - lo[k] + 1) as [number, number, number];
    const s = new GridSampler(g, 'CLOSEST');
    const out = { ...g, dims, values: new Float32Array(dims[0] * dims[1] * dims[2] * ch), transform: mulMat4(g.transform, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, lo[0], lo[1], lo[2], 1]) };
    let o = 0;
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) for (let c = 0; c < ch; c++) out.values[o++] = s.voxel(x + lo[0], y + lo[1], z + lo[2], c);
    return out;
  },
);

/** Central difference derivative helpers (object space, axis-aligned voxel sizes). */
function derivatives(g: VolumeGrid) {
  const s = new GridSampler(g, 'CLOSEST');
  const vs = voxelSize(g);
  const d = (x: number, y: number, z: number, axis: number, c = 0) => {
    const o = [0, 0, 0];
    o[axis] = 1;
    return (s.voxel(x + o[0], y + o[1], z + o[2], c) - s.voxel(x - o[0], y - o[1], z - o[2], c)) / (2 * vs[axis]);
  };
  return { s, vs, d };
}

scalarOp(
  'GeometryNodeGridGradient',
  'Grid Gradient',
  'Direction and rate of the fastest increase of a grid',
  [],
  (g) => {
    const { d } = derivatives(g);
    return mapGrid(g, 3, (x, y, z, out, o) => {
      out[o] = d(x, y, z, 0);
      out[o + 1] = d(x, y, z, 1);
      out[o + 2] = d(x, y, z, 2);
    }, 'VECTOR_FLOAT');
  },
  'Gradient',
  'Sample',
);
scalarOp(
  'GeometryNodeGridLaplacian',
  'Grid Laplacian',
  'Sum of the second derivatives of a grid',
  [],
  (g) => {
    const { s, vs } = derivatives(g);
    return mapGrid(g, 1, (x, y, z, out, o) => {
      const c = s.voxel(x, y, z);
      let sum = 0;
      for (let a = 0; a < 3; a++) {
        const e = [0, 0, 0];
        e[a] = 1;
        sum += (s.voxel(x + e[0], y + e[1], z + e[2]) - 2 * c + s.voxel(x - e[0], y - e[1], z - e[2])) / (vs[a] * vs[a]);
      }
      out[o] = sum;
    });
  },
  'Laplacian',
  'Sample',
);

const vectorOp = (idname: string, label: string, description: string, outName: string, outType: 'FLOAT' | 'VECTOR', fn: (g: VolumeGrid) => VolumeGrid) => {
  geoNode(
    { idname, label, category: 'geometry', description, inputs: [gridSock('Grid', 'VECTOR')], outputs: [gridSock(outName, outType)] },
    {
      exec: (ctx) => {
        const g = asGrid(ctx.input('Grid'));
        return { [outName]: gridValue(g && g.data_type === 'VECTOR_FLOAT' ? fn(g) : null) };
      },
    },
  );
  reg(`${PREFIX}/Sample`, idname);
};
vectorOp('GeometryNodeGridCurl', 'Grid Curl', 'Rotation of a vector grid', 'Curl', 'VECTOR', (g) => {
  const { d } = derivatives(g);
  return mapGrid(g, 3, (x, y, z, out, o) => {
    out[o] = d(x, y, z, 1, 2) - d(x, y, z, 2, 1);
    out[o + 1] = d(x, y, z, 2, 0) - d(x, y, z, 0, 2);
    out[o + 2] = d(x, y, z, 0, 1) - d(x, y, z, 1, 0);
  });
});
vectorOp('GeometryNodeGridDivergence', 'Grid Divergence', 'Outflow of a vector grid', 'Divergence', 'FLOAT', (g) => {
  const { d } = derivatives(g);
  return mapGrid(g, 1, (x, y, z, out, o) => (out[o] = d(x, y, z, 0, 0) + d(x, y, z, 1, 1) + d(x, y, z, 2, 2)), 'FLOAT');
});

geoNode(
  {
    idname: 'GeometryNodeGridAdvect',
    label: 'Advect Grid',
    category: 'geometry',
    description: 'Move grid values along a velocity grid over a time step',
    inputs: [gridSock('Grid'), gridSock('Velocity', 'VECTOR'), sock('Time Step', 'FLOAT', { d: 1, subtype: 'TIME_ABSOLUTE' })],
    outputs: [gridSock('Grid')],
    props: [
      enumProp('Integration Scheme', 'Integration Scheme', [
        ['Semi-Lagrangian', 'Semi-Lagrangian'],
        ['Runge-Kutta 3', 'Runge-Kutta 3'],
      ], 'Runge-Kutta 3'),
    ],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      const vel = asGrid(ctx.input('Velocity'));
      if (!g || !vel || vel.data_type !== 'VECTOR_FLOAT') return { Grid: gridValue(g) };
      const dt = ctx.float('Time Step');
      const sv = new GridSampler(vel),
        sg = new GridSampler(g);
      const rk = ctx.prop('Integration Scheme') !== 'Semi-Lagrangian';
      const v = (x: number, y: number, z: number) => [sv.sample(x, y, z, 0), sv.sample(x, y, z, 1), sv.sample(x, y, z, 2)];
      const p = [0, 0, 0];
      const out = mapGrid(g, 1, (x, y, z, o, i) => {
        xform(g.transform, x, y, z, p);
        // trace back along the velocity
        let q: number[];
        if (rk) {
          const k1 = v(p[0], p[1], p[2]);
          const m = [p[0] - k1[0] * dt * 0.5, p[1] - k1[1] * dt * 0.5, p[2] - k1[2] * dt * 0.5];
          const k2 = v(m[0], m[1], m[2]);
          q = [p[0] - k2[0] * dt, p[1] - k2[1] * dt, p[2] - k2[2] * dt];
        } else {
          const k1 = v(p[0], p[1], p[2]);
          q = [p[0] - k1[0] * dt, p[1] - k1[1] * dt, p[2] - k1[2] * dt];
        }
        o[i] = sg.sample(q[0], q[1], q[2]);
      });
      return { Grid: gridValue(out) };
    },
  },
);
reg(`${PREFIX}/Sample`, 'GeometryNodeGridAdvect');

geoNode(
  {
    idname: 'GeometryNodeSetGridBackground',
    label: 'Set Grid Background',
    category: 'geometry',
    description: 'Change the value a grid has outside its stored voxels',
    inputs: [gridSock('Grid'), sock('Background', 'FLOAT', { d: 0 }), sock('Update Inactive', 'BOOLEAN', { d: false })],
    outputs: [gridSock('Grid')],
    props: [enumProp('data_type', 'Data Type', DATA_TYPES)],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      if (!g) return { Grid: gridValue(null) };
      const bg = ctx.float('Background');
      const values = ctx.bool('Update Inactive') ? g.values.map((v) => (v === g.background ? bg : v)) : g.values;
      return { Grid: gridValue({ ...g, background: bg, values }) };
    },
  },
);
reg(`${PREFIX}/Write`, 'GeometryNodeSetGridBackground');

geoNode(
  {
    idname: 'GeometryNodeSetGridTransform',
    label: 'Set Grid Transform',
    category: 'geometry',
    description: 'Replace the transform from voxel indices to object space',
    inputs: [gridSock('Grid'), sock('Transform', 'MATRIX')],
    outputs: [sock('Is Valid', 'BOOLEAN'), gridSock('Grid')],
    props: [enumProp('data_type', 'Data Type', DATA_TYPES)],
  },
  {
    exec: (ctx) => {
      const g = asGrid(ctx.input('Grid'));
      const m = ctx.matrix('Transform');
      const inv = invertAffine(m);
      const valid = !!g && Math.abs(inv[0] * m[0] + inv[4] * m[1] + inv[8] * m[2] - 1) < 1e-4 && m.length === 16 && Math.abs(m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])) > 1e-12;
      return { 'Is Valid': valid, Grid: gridValue(g && valid ? { ...g, transform: [...m] } : g) };
    },
  },
);
reg(`${PREFIX}/Write`, 'GeometryNodeSetGridTransform');


// ---------------------------------------------------------------------------
// Import OpenVDB (files stored in the project, like the other import nodes)

const vdbCache = new WeakMap<Uint8Array, { grids: VolumeGrid[]; warnings: string[] } | Error>();

geoNode(
  {
    idname: 'GeometryNodeImportVDB',
    label: 'Import VDB',
    category: 'input',
    description: 'Read the grids of an OpenVDB file as a volume',
    inputs: [sock('Path', 'STRING', { d: '' })],
    outputs: [geo('Volume')],
    drawBody: fileBody(['.vdb'], '.vdb'),
    bodyHeight: () => 26,
  },
  {
    exec: (ctx) => {
      const path = ctx.string('Path');
      if (!path) return { Volume: GeometrySet.empty() };
      const f = packedFile(ctx.env.doc, path);
      if (!f) {
        ctx.warn(`File not found: "${path}" (open it with the node's file button)`);
        return { Volume: GeometrySet.empty() };
      }
      let r = vdbCache.get(f.bytes);
      if (!r) {
        try {
          r = readVdb(f.bytes);
        } catch (e) {
          r = e instanceof Error ? e : new Error(String(e));
        }
        vdbCache.set(f.bytes, r);
      }
      if (r instanceof Error) {
        ctx.warn(r.message, 'ERROR');
        return { Volume: GeometrySet.empty() };
      }
      for (const w of r.warnings) ctx.warn(w);
      return { Volume: volumeGeometry(r.grids) };
    },
    sig: (node, env) => {
      const p = node.inputs.Path;
      const f = typeof p === 'string' ? packedFile(env.doc, p) : null;
      return f ? `${f.id}:${f.bytes.length}` : '-';
    },
  },
);
place('Input/Import', 'GeometryNodeImportVDB', 'OpenVDB (.vdb)');
