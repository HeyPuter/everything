// Intersection lines: where the surfaces of two objects cut through each other (Line Art).
import { Box3, Line3, Matrix4, Vector3 } from 'three';
import { bvhFor, type OccluderInput } from './visibility';
import { F, type FeatureEdge } from './features';

// ids of intersection points (shared by touching segments so they chain); far below the cut ids
let nextId = -1.5e15;

/** Intersection segments (world space) between pairs of objects accepted by `pair`. */
export function intersectionEdges(objects: OccluderInput[], pair: (a: number, b: number) => boolean, limit = 200000): FeatureEdge[] {
  const out: FeatureEdge[] = [];
  const items = objects.map((o) => {
    const { bvh } = bvhFor(o);
    const world = new Matrix4().fromArray(Array.from(o.world));
    const box = new Box3();
    bvh.getBoundingBox(box);
    return { o, bvh, world, inv: world.clone().invert(), box: box.clone().applyMatrix4(world) };
  });
  const ids = new Map<string, number>();
  const idOf = (p: Vector3) => {
    const k = `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
    let i = ids.get(k);
    if (i === undefined) ids.set(k, (i = nextId--));
    return i;
  };
  const line = new Line3();
  for (let a = 0; a < items.length; a++)
    for (let b = a + 1; b < items.length; b++) {
      const A = items[a],
        B = items[b];
      if (!pair(A.o.object, B.o.object) || !A.box.intersectsBox(B.box)) continue;
      const toA = A.inv.clone().multiply(B.world);
      A.bvh.bvhcast(B.bvh, toA, {
        intersectsTriangles: (t1, t2) => {
          if (!t1.intersectsTriangle(t2, line)) return false;
          const pa = line.start.clone().applyMatrix4(A.world),
            pb = line.end.clone().applyMatrix4(A.world);
          if (pa.distanceToSquared(pb) < 1e-14) return false;
          out.push({ ia: idOf(pa), ib: idOf(pb), pa: [pa.x, pa.y, pa.z], pb: [pb.x, pb.y, pb.z], flags: F.INTERSECTION, object: A.o.object, f0: -1, f1: -1, angle: Math.PI, curvature: 0, m0: 0, m1: 0 });
          return out.length >= limit;
        },
      });
    }
  if (nextId < -8e15) nextId = -1.5e15;
  return out;
}
