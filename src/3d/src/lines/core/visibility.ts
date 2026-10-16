// Projection, frustum clipping and quantitative invisibility (QI: how many surfaces hide a point)
// of feature edges. Occlusion is found by casting rays against per-object BVHs built in object
// space (cached by the evaluated positions array, so moving objects reuse them).
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { triangulateMesh } from '../../mesh/mesh';
import { F, type FeatureEdge, type ViewInfo } from './features';

export interface LineCamera {
  /** projection × view, column-major */
  viewProj: ArrayLike<number>;
  width: number;
  height: number;
  view: ViewInfo;
}

/** Screen position (pixels, y down), clip w and distance to the camera. */
export function projectPoint(cam: LineCamera, x: number, y: number, z: number): [number, number, number, number] {
  const m = cam.viewProj;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  const w = Math.abs(cw) < 1e-12 ? 1e-12 : cw;
  const sx = (cx / w * 0.5 + 0.5) * cam.width;
  const sy = (1 - (cy / w * 0.5 + 0.5)) * cam.height;
  const v = cam.view;
  const dist = v.ortho ? (x - v.eye[0]) * v.dir[0] + (y - v.eye[1]) * v.dir[1] + (z - v.eye[2]) * v.dir[2] : Math.hypot(x - v.eye[0], y - v.eye[1], z - v.eye[2]);
  return [sx, sy, cw, dist];
}

function clipCoords(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number, number] {
  const [x, y, z] = [p[0], p[1], p[2]];
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
}

/**
 * Parameter range [t0, t1] of a 3D segment inside the view volume (frame grown by `margin`,
 * as a fraction of its half size), or null. Clip coordinates are affine along the segment,
 * so the parameters apply to the 3D segment directly.
 */
export function clipSegment(cam: LineCamera, a: ArrayLike<number>, b: ArrayLike<number>, margin = 0): [number, number] | null {
  const A = clipCoords(cam.viewProj, a),
    B = clipCoords(cam.viewProj, b);
  let t0 = 0,
    t1 = 1;
  const k = 1 + margin;
  // planes as dot products that must stay >= 0
  const planes: ((c: number[]) => number)[] = [(c) => c[3] - 1e-6, (c) => k * c[3] - c[0], (c) => k * c[3] + c[0], (c) => k * c[3] - c[1], (c) => k * c[3] + c[1], (c) => c[3] + c[2]];
  for (const pl of planes) {
    const da = pl(A),
      db = pl(B);
    if (da < 0 && db < 0) return null;
    if (da < 0) t0 = Math.max(t0, da / (da - db));
    else if (db < 0) t1 = Math.min(t1, da / (da - db));
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

// ---------------------------------------------------------------------------
// occluders

export interface OccluderInput {
  /** object-space mesh */
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  /** object → world, column-major */
  world: ArrayLike<number>;
  object: number;
  /** surfaces each face counts as when it hides a line (default 1; 0 hides nothing) */
  faceWeight?: Uint8Array;
}

interface Occluder {
  bvh: MeshBVH;
  triFace: Uint32Array;
  inv: Matrix4;
  world: Matrix4;
  object: number;
  center: Vector3;
  radius: number;
  faceWeight?: Uint8Array;
}

const bvhCache = new WeakMap<Float32Array, { indices: Uint32Array; bvh: MeshBVH; triFace: Uint32Array }>();

export function bvhFor(o: OccluderInput) {
  const hit = bvhCache.get(o.positions);
  if (hit && hit.indices === o.indices) return hit;
  const t = triangulateMesh(o);
  const tri = new Uint32Array(t.tris.length);
  for (let i = 0; i < tri.length; i++) tri[i] = o.indices[t.tris[i]];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(o.positions, 3));
  g.setIndex(new BufferAttribute(tri, 1));
  const bvh = new MeshBVH(g, { indirect: true });
  const entry = { indices: o.indices, bvh, triFace: t.triFace };
  bvhCache.set(o.positions, entry);
  return entry;
}

const _o = new Vector3(),
  _t = new Vector3(),
  _d = new Vector3(),
  _ray = new Ray(),
  _c = new Vector3();

export class Occlusion {
  private list: Occluder[] = [];
  /** world-space tolerance for hits at the target point */
  eps = 1e-5;
  rays = 0;
  /** surfaces facing away from the viewer hide nothing */
  cullBack = false;

  constructor(inputs: OccluderInput[]) {
    let extent = 0;
    for (const o of inputs) {
      if (!o.indices.length) continue;
      const { bvh, triFace } = bvhFor(o);
      const world = new Matrix4().fromArray(o.world as number[]);
      const box = bvh.geometry.boundingBox ?? (bvh.geometry.computeBoundingBox(), bvh.geometry.boundingBox!);
      const center = box.getCenter(new Vector3()).applyMatrix4(world);
      const scale = world.getMaxScaleOnAxis();
      const radius = box.getSize(new Vector3()).length() * 0.5 * scale;
      extent = Math.max(extent, center.length() + radius);
      this.list.push({ bvh, triFace, inv: world.clone().invert(), world, object: o.object, center, radius, faceWeight: o.faceWeight });
    }
    this.eps = Math.max(1e-6, extent * 2e-6);
  }

  get size() {
    return this.list.length;
  }

  /**
   * Number of surfaces between `from` and `to` (faces `f0`/`f1` of `object` are the line's own
   * faces and never hide it). Stops counting past `limit`.
   */
  count(from: ArrayLike<number>, to: ArrayLike<number>, object: number, f0: number, f1: number, limit = Infinity): number {
    let n = 0;
    _o.set(from[0], from[1], from[2]);
    _t.set(to[0], to[1], to[2]);
    const total = _o.distanceTo(_t);
    if (total <= this.eps) return 0;
    const far = total * (1 - 1e-5) - this.eps;
    for (const oc of this.list) {
      // the segment must pass near the occluder's bounding sphere
      if (segmentSphereDistance(_o, _t, oc.center) > oc.radius) continue;
      const lo = _c.copy(_o).applyMatrix4(oc.inv);
      const lt = _d.copy(_t).applyMatrix4(oc.inv);
      const len = lo.distanceTo(lt);
      if (len < 1e-12) continue;
      _ray.origin.copy(lo);
      _ray.direction.copy(lt).sub(lo).divideScalar(len);
      this.rays++;
      const hits = oc.bvh.raycast(_ray, DoubleSide, 0, (len * far) / total);
      for (const h of hits) {
        const face = oc.triFace[h.faceIndex ?? 0];
        if (oc.object === object && (face === f0 || face === f1)) continue;
        if (this.cullBack && h.face && h.face.normal.dot(_ray.direction) > 0) continue;
        n += oc.faceWeight ? oc.faceWeight[face] ?? 1 : 1;
        if (n > limit) return n;
      }
    }
    return n;
  }

  /** Object hit first by the ray from `from` through `through` (-1 for none). */
  first(from: ArrayLike<number>, through: ArrayLike<number>): number {
    _o.set(from[0], from[1], from[2]);
    _t.set(through[0], through[1], through[2]);
    let best = Infinity,
      obj = -1;
    const dirW = _t.clone().sub(_o).normalize();
    for (const oc of this.list) {
      const lo = _c.copy(_o).applyMatrix4(oc.inv);
      const lt = _d.copy(_o).add(dirW).applyMatrix4(oc.inv);
      const dl = lt.sub(lo);
      const scale = dl.length();
      if (scale < 1e-12) continue;
      _ray.origin.copy(lo);
      _ray.direction.copy(dl).divideScalar(scale);
      this.rays++;
      const h = oc.bvh.raycastFirst(_ray, DoubleSide);
      if (!h) continue;
      const d = h.distance / scale;
      if (d < best) {
        best = d;
        obj = oc.object;
      }
    }
    return obj;
  }
}

function segmentSphereDistance(a: Vector3, b: Vector3, c: Vector3): number {
  const abx = b.x - a.x,
    aby = b.y - a.y,
    abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + abx * t - c.x, a.y + aby * t - c.y, a.z + abz * t - c.z);
}

// ---------------------------------------------------------------------------
// visibility of feature edges

export interface Piece {
  edge: FeatureEdge;
  /** parameter range along the edge */
  t0: number;
  t1: number;
  qi: number;
  /** extra flags found in image space (contours) */
  flags: number;
  /** endpoint ids: edge vertex ids at the ends of the edge, fresh negative ids at cuts */
  ka: number;
  kb: number;
}

export const lerp3 = (a: ArrayLike<number>, b: ArrayLike<number>, t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Ray origin for a point: the camera, or the point moved back along the view axis (orthographic). */
export function rayOrigin(view: ViewInfo, p: ArrayLike<number>): [number, number, number] {
  if (!view.ortho) return view.eye;
  const d = (p[0] - view.eye[0]) * view.dir[0] + (p[1] - view.eye[1]) * view.dir[1] + (p[2] - view.eye[2]) * view.dir[2];
  return [p[0] - view.dir[0] * d, p[1] - view.dir[1] * d, p[2] - view.dir[2] * d];
}

export interface VisibilityOptions {
  /** sample spacing in pixels */
  step?: number;
  /** frame margin kept around the image (fraction of the half size) */
  margin?: number;
  /** QI above this is not told apart (saves rays) */
  maxQi?: number;
  /** classify silhouettes / borders as contours and external contours */
  contours?: boolean;
  /** cancellation / progress callback, called every few hundred edges */
  tick?: () => void;
}

// ids of points where edges are cut (unique across calls, so chunks of one frame never collide)
let fresh = -1;

/** Split feature edges into pieces of constant QI inside the view volume. */
export function visibilityPieces(edges: FeatureEdge[], cam: LineCamera, occ: Occlusion, o: VisibilityOptions = {}): Piece[] {
  const step = o.step ?? 4;
  const limit = o.maxQi ?? Infinity;
  const margin = o.margin ?? 0.05;
  const out: Piece[] = [];
  const keyOf = (e: FeatureEdge, t: number) => (t <= 0 ? e.ia : t >= 1 ? e.ib : fresh--);
  const qiAt = (e: FeatureEdge, t: number) => {
    const p = lerp3(e.pa, e.pb, t);
    return Math.min(limit + 1, occ.count(rayOrigin(cam.view, p), p, e.object, e.f0, e.f1, limit));
  };
  for (let i = 0; i < edges.length; i++) {
    if (o.tick && i % 256 === 255) o.tick();
    const e = edges[i];
    const r = clipSegment(cam, e.pa, e.pb, margin);
    if (!r) continue;
    const [ta, tb] = r;
    const A = projectPoint(cam, ...lerp3(e.pa, e.pb, ta)),
      B = projectPoint(cam, ...lerp3(e.pa, e.pb, tb));
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < 1e-3 && ta > 0 && tb < 1) continue;
    const n = Math.max(1, Math.min(64, Math.ceil(L / step)));
    const ts: number[] = [],
      qs: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = ta + ((tb - ta) * (k + 0.5)) / n;
      ts.push(t);
      qs.push(qiAt(e, t));
    }
    let start = ta;
    let startKey = keyOf(e, ta);
    for (let k = 0; k < n; k++) {
      if (k < n - 1 && qs[k + 1] === qs[k]) continue;
      let end = tb;
      if (k < n - 1) {
        // refine the change between two samples
        let lo = ts[k],
          hi = ts[k + 1];
        for (let it = 0; it < 6; it++) {
          const mid = (lo + hi) / 2;
          if (qiAt(e, mid) === qs[k]) lo = mid;
          else hi = mid;
        }
        end = (lo + hi) / 2;
      }
      const endKey = end >= 1 ? e.ib : fresh--;
      out.push({ edge: e, t0: start, t1: end, qi: qs[k], flags: e.flags, ka: startKey, kb: endKey });
      start = end;
      startKey = endKey;
    }
  }
  if (o.contours) classifyContours(out, cam, occ);
  if (fresh < -1e15) fresh = -1;
  return out;
}

/**
 * Visible silhouettes / borders that separate their object from other objects (contour) or from
 * the background (external contour): probe the image just outside the line.
 */
export function classifyContours(pieces: Piece[], cam: LineCamera, occ: Occlusion) {
  const inv = new Matrix4().fromArray(Array.from(cam.viewProj)).invert();
  const unproject = (sx: number, sy: number, z: number) => new Vector3((sx / cam.width) * 2 - 1, 1 - (sy / cam.height) * 2, z).applyMatrix4(inv);
  for (const p of pieces) {
    const e = p.edge;
    if (p.qi !== 0 || !(e.flags & (F.SILHOUETTE | F.BORDER))) continue;
    const a = projectPoint(cam, ...lerp3(e.pa, e.pb, p.t0)),
      b = projectPoint(cam, ...lerp3(e.pa, e.pb, p.t1));
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let nx = -(b[1] - a[1]),
      ny = b[0] - a[0];
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) continue;
    nx /= l;
    ny /= l;
    if (e.inner) {
      const c = projectPoint(cam, ...e.inner);
      if ((c[0] - mx) * nx + (c[1] - my) * ny > 0) {
        nx = -nx;
        ny = -ny;
      }
    }
    const qx = mx + nx * 2,
      qy = my + ny * 2;
    const near = unproject(qx, qy, -1),
      far = unproject(qx, qy, 1);
    const from: [number, number, number] = cam.view.ortho ? [near.x, near.y, near.z] : cam.view.eye;
    const hit = occ.first(from, [far.x, far.y, far.z]);
    if (hit < 0) p.flags |= F.CONTOUR | F.EXTERNAL_CONTOUR;
    else if (hit !== e.object) p.flags |= F.CONTOUR;
  }
}
