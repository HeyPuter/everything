/* eslint-disable @typescript-eslint/no-explicit-any */
// Section views of drawings: the body cut by a plane (the half between the viewer and
// the plane taken away) and the outline of the faces the cut makes, which the sheet hatches.

import { type Vec3, cross, dot, normalize, perpendicular } from '../math/vec';
import { type Sh, common, describeFace, getOc, projectShape, subShapes, transformShape, wrap, xyz } from './occ';

/**
 * The part of `body` on the side of the plane through p that n points to ((x - p) . n >= 0).
 * `size` is larger than the body (the half-space is a box of that half-width).
 */
export function halfOf(body: Sh, p: Vec3, n: Vec3, size: number): Sh {
  const oc = getOc();
  const z = normalize(n), x = perpendicular(z), y = cross(z, x);
  const a = new oc.gp_Pnt(-size, -size, 0), b = new oc.gp_Pnt(size, size, size);
  const mk = new oc.BRepPrimAPI_MakeBox(a, b);
  const tr = new oc.gp_Trsf();
  try {
    const box = wrap(mk.Shape());
    // Columns: the box's x, y and z axes in the model, then its origin.
    tr.SetValues(x[0], y[0], z[0], p[0], x[1], y[1], z[1], p[1], x[2], y[2], z[2], p[2]);
    return common(body, transformShape(box, tr));
  } finally {
    a.delete(); b.delete(); mk.delete(); tr.delete();
  }
}

/**
 * Outlines of the cut faces of `half` (made by halfOf with the same plane) as polylines in
 * a view's coordinates (paper x along `xAxis`, y down along -(dir x xAxis), model millimetres),
 * flat [x0, y0, x1, y1, ...]. Arcs and curves are drawn within `tol`.
 */
export function cutOutlines(half: Sh, p: Vec3, n: Vec3, dir: Vec3, xAxis: Vec3, tol: number): number[][] {
  const oc = getOc();
  const up = cross(dir, xAxis);
  const nn = normalize(n);
  const out: number[][] = [];
  const size = Math.max(tol * 1000, 1);
  for (const f of subShapes(half, 'face')) {
    const d = describeFace(f);
    // A cut face lies in the plane and faces the half taken away.
    if (d.type !== 'plane' || dot(d.d, nn) > -1 + 1e-7 || Math.abs(dot(d.center, nn) - dot(p, nn)) > 1e-6 * size) continue;
    for (const e of subShapes(f, 'edge')) {
      const ad = new oc.BRepAdaptor_Curve(e.wrapped);
      const pts: number[] = [];
      const push = (q: any) => {
        const v = xyz(q);
        pts.push(dot(v, xAxis), -dot(v, up));
      };
      try {
        const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
        if (!(u1 > u0)) continue;
        if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
          const a = ad.Value(u0), b = ad.Value(u1);
          push(a); push(b);
          a.delete(); b.delete();
        } else {
          const td = new oc.GCPnts_TangentialDeflection(ad, u0, u1, 0.1, tol, 2, 1e-9, 1e-7);
          try {
            for (let i = 1; i <= td.NbPoints(); i++) {
              const q = td.Value(i);
              push(q);
              q.delete();
            }
          } finally {
            td.delete();
          }
        }
      } finally {
        ad.delete();
      }
      if (pts.length >= 4) out.push(pts);
    }
  }
  return out;
}

/** A section view's projection: the half of the body behind the cutting plane, with the cut faces' outlines. */
export function projectSection(
  body: Sh,
  box: { min: Vec3; max: Vec3 },
  v: { dir: Vec3; x: Vec3; hidden?: boolean; smooth?: boolean; section?: { p: Vec3; n: Vec3 } },
  tol: number,
): { visible: string[]; hidden: string[]; bounds: [number, number, number, number] | null; cut: number[][] } {
  const { p, n } = v.section!;
  // Larger than the body wherever on it the plane passes.
  const size = 2 * (Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + Math.hypot(...p) + Math.hypot(...box.min) + 1);
  const half = halfOf(body, p, n, size);
  if (!subShapes(half, 'face').length) return { visible: [], hidden: [], bounds: null, cut: [] };
  return {
    ...projectShape(half, v.dir, v.x, tol, tol / 10, v.hidden !== false, v.smooth !== false),
    cut: cutOutlines(half, p, n, v.dir, v.x, tol),
  };
}
