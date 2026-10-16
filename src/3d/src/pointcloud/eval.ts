// Depsgraph integration: a Point Cloud object evaluates to its points (positions + radius in
// EvalMesh.pointRadius) and registers a points component carrying every attribute as the geometry
// seen by geometry nodes.
import { dataEvaluators } from '../eval/depsgraph';
import type { EvalMesh } from '../eval/types';
import { GeometrySet, PointsComponent, isInternal, type AttrMap } from '../geonodes/geometry';
import { primeGeometry } from '../geonodes/convert';
import { dataComps } from '../geonodes/types';
import { pointCloudOf, pointCount, radii } from './data';
import type { PointCloudData } from './types';

const ids = new WeakMap<object, number>();
let next = 1;
function aid(a: object | undefined | null): number {
  if (!a) return 0;
  let i = ids.get(a);
  if (!i) ids.set(a, (i = next++));
  return i;
}

export function pointCloudSignature(pc: PointCloudData) {
  return `pc|${aid(pc.positions)}|${pc.attributes.map((a) => `${a.name}:${aid(a.data)}`).join(',')}|${pc.materials.join(',')}`;
}

/** Points component of point cloud data (shares the arrays). */
export function pointCloudToComponent(pc: PointCloudData): PointsComponent {
  const n = pointCount(pc);
  const attrs: AttrMap = new Map();
  for (const a of pc.attributes) {
    if (isInternal(a.name) || a.data.length !== n * dataComps(a.data_type)) continue;
    attrs.set(a.name, { domain: 'POINT', type: a.data_type, data: a.data });
  }
  if (!attrs.has('radius')) attrs.set('radius', { domain: 'POINT', type: 'FLOAT', data: radii(pc) });
  return new PointsComponent(pc.positions, attrs, [...pc.materials]);
}

export function pointCloudEvalMesh(pc: PointCloudData): EvalMesh {
  const mesh: EvalMesh = {
    positions: pc.positions,
    offsets: new Uint32Array([0]),
    indices: new Uint32Array(0),
    uvs: new Float32Array(0),
    normals: new Float32Array(0),
    pointRadius: radii(pc),
  };
  primeGeometry(mesh, new GeometrySet(undefined, pointCloudToComponent(pc)));
  return mesh;
}

dataEvaluators.POINTCLOUD = {
  signature(doc, ob) {
    const pc = pointCloudOf(doc, ob);
    return pc ? pointCloudSignature(pc) : null;
  },
  build(doc, ob) {
    return pointCloudEvalMesh(pointCloudOf(doc, ob)!);
  },
};
