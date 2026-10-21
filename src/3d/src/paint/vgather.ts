// Brush footprint for vertex-based paint modes (vertex colors, weights): projected (screen space
// circle, the default) or spherical (3D distance around the surface hit),
// with optional front-face test and normal falloff, plus symmetry passes.
import { Matrix3, Matrix4, Vector3 } from 'three';
import type { View3D } from '../editors/view3d/view3d';
import { app } from '../app/app';
import type { PaintBrush } from './brushes';
import { cachedCurveTable, falloff, mirror, symmetryPasses } from './math';
import type { Hit, MeshSession } from './session';

/** Screen positions of all vertices (x, y, ndc z) for the current view. */
export function projectVertices(s: MeshSession, v: View3D, out?: Float32Array, sign: ArrayLike<number> = [1, 1, 1]): Float32Array {
  const P = s.positions;
  const res = out && out.length === s.nv * 3 ? out : new Float32Array(s.nv * 3);
  const cam = v.camera;
  cam.updateMatrixWorld();
  const m = new Matrix4()
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    .multiply(s.world())
    .multiply(new Matrix4().makeScale(sign[0], sign[1], sign[2]));
  const e = m.elements;
  const W = v.width,
    H = v.height;
  for (let i = 0; i < s.nv; i++) {
    const x = P[i * 3],
      y = P[i * 3 + 1],
      z = P[i * 3 + 2];
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = cw > 1e-9 ? 1 / cw : 0;
    res[i * 3] = (cx * iw * 0.5 + 0.5) * W;
    res[i * 3 + 1] = (-cy * iw * 0.5 + 0.5) * H;
    res[i * 3 + 2] = cw > 1e-9 ? cz * iw : 2;
  }
  return res;
}

export interface GatherOptions {
  brush: PaintBrush;
  x: number;
  y: number;
  hit: Hit | null;
  strength: number;
  /** cosine falloff of the normal against the view (paint modes); 0 disables */
  normalAngle?: number;
  /** pen pressure factor for the radius */
  sizeFactor?: number;
  /** brush texture factor per vertex */
  tex?: ((vi: number) => number) | null;
}

/**
 * Brush radius in pixels at a world point: the pixel radius, or the scene-unit radius projected
 * at that depth when the size is locked to the scene.
 */
export function brushRadiusPx(b: PaintBrush, s: MeshSession, v: View3D, world: Vector3 | null | undefined): number {
  if (b.use_locked_size !== 'SCENE' || !world) return b.radius;
  const perPx = s.pixelsToLocal(v, world, 1) * s.scale();
  return Math.max(1, (b.unprojected_radius ?? 0.1) / Math.max(1e-9, perPx));
}

/**
 * Collect affected vertices into s.gv / s.gf (factor = falloff × strength × normal factor),
 * merging symmetry passes (maximum factor per vertex). Returns the count.
 */
export function gatherPaint(s: MeshSession, v: View3D, o: GatherOptions, scratch: { proj?: Float32Array; best?: Float32Array }): number {
  const b = o.brush;
  const ts = app.doc.scene.tool_settings.sculpt;
  const passes = symmetryPasses(ts.use_symmetry_x, ts.use_symmetry_y, ts.use_symmetry_z);
  const nv = s.nv;
  if (!scratch.best || scratch.best.length !== nv) scratch.best = new Float32Array(nv);
  const best = scratch.best;
  const list: number[] = [];
  const vn = s.vn;
  const world = s.world();
  const cam = v.camera;
  const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
  const camDir = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  const ortho = (cam as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
  const inv = world.clone().invert();
  const camLocal0 = camPos.clone().applyMatrix4(inv);
  const dirLocal0 = camDir.clone().applyMatrix3(new Matrix3().setFromMatrix4(inv)).normalize();
  const cosA = o.normalAngle && o.normalAngle > 0 ? Math.cos(o.normalAngle) : -2;
  const ff = !!b.use_frontface;
  const P = s.positions;
  const hard = b.hardness ?? 0;
  const fc = b.falloff === 'CUSTOM' ? cachedCurveTable(b.falloff_curve) : null;
  const rpx = brushRadiusPx(b, s, v, o.hit?.world) * (o.sizeFactor ?? 1);
  const R = b.falloff_shape === 'SPHERE' && o.hit ? s.pixelsToLocal(v, o.hit.world, rpx) : 0;
  if (b.falloff_shape === 'SPHERE' && !o.hit) return 0;
  // Symmetry passes work like a mirrored viewpoint: the mesh is mirrored (object space) and painted
  // from the same view, so mirrored strokes reach the far side of the object too.
  for (const sg of passes) {
    const camLocal = new Vector3(camLocal0.x * sg[0], camLocal0.y * sg[1], camLocal0.z * sg[2]);
    const dirLocal = new Vector3(dirLocal0.x * sg[0], dirLocal0.y * sg[1], dirLocal0.z * sg[2]);
    const normalFactor = (vi: number) => {
      if (cosA < -1 && !ff) return 1;
      let tx: number, ty: number, tz: number;
      if (ortho) {
        tx = -dirLocal.x;
        ty = -dirLocal.y;
        tz = -dirLocal.z;
      } else {
        tx = camLocal.x - P[vi * 3];
        ty = camLocal.y - P[vi * 3 + 1];
        tz = camLocal.z - P[vi * 3 + 2];
        const l = Math.hypot(tx, ty, tz) || 1;
        tx /= l;
        ty /= l;
        tz /= l;
      }
      const d = vn[vi * 3] * tx + vn[vi * 3 + 1] * ty + vn[vi * 3 + 2] * tz;
      if (ff && d <= 0) return 0;
      if (cosA < -1) return 1;
      if (d <= cosA) return 0;
      // smooth ramp from the cutoff angle to facing the viewer
      return Math.min(1, ((d - cosA) / Math.max(1e-6, 1 - cosA)) * 2);
    };
    if (b.falloff_shape === 'SPHERE') {
      const c = mirror(o.hit!.point.toArray(), sg);
      const r2 = R * R;
      for (let vi = 0; vi < nv; vi++) {
        const dx = P[vi * 3] - c[0],
          dy = P[vi * 3 + 1] - c[1],
          dz = P[vi * 3 + 2] - c[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const f = falloff(b.falloff, Math.sqrt(d2) / R, hard, fc) * o.strength * normalFactor(vi);
        if (f <= 0) continue;
        if (best[vi] === 0) list.push(vi);
        if (f > best[vi]) best[vi] = f;
      }
    } else {
      scratch.proj = projectVertices(s, v, scratch.proj, sg);
      const proj = scratch.proj;
      const r = rpx,
        cx = o.x,
        cy = o.y;
      for (let vi = 0; vi < nv; vi++) {
        const dx = proj[vi * 3] - cx;
        if (dx > r || dx < -r) continue;
        const dy = proj[vi * 3 + 1] - cy;
        if (dy > r || dy < -r) continue;
        if (proj[vi * 3 + 2] > 1 || proj[vi * 3 + 2] < -1) continue;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const f = falloff(b.falloff, d / r, hard, fc) * o.strength * normalFactor(vi);
        if (f <= 0) continue;
        if (best[vi] === 0) list.push(vi);
        if (f > best[vi]) best[vi] = f;
      }
    }
  }
  const allowed = s.paintVerts;
  let n = 0;
  for (let k = 0; k < list.length; k++) {
    const vi = list[k];
    const f = best[vi];
    best[vi] = 0;
    if (allowed && !allowed[vi]) continue;
    s.gv[n] = vi;
    s.gf[n] = o.tex ? f * o.tex(vi) : f;
    n++;
  }
  return n;
}

/** For smear: the neighbor of each vertex lying most against the stroke direction (object space). */
export function smearSource(s: MeshSession, vi: number, dir: Vector3): number {
  const nb = s.neighbors;
  const P = s.positions;
  let bestU = -1,
    bestD = 0.3;
  for (let j = nb.offsets[vi]; j < nb.offsets[vi + 1]; j++) {
    const u = nb.neighbors[j];
    let dx = P[u * 3] - P[vi * 3],
      dy = P[u * 3 + 1] - P[vi * 3 + 1],
      dz = P[u * 3 + 2] - P[vi * 3 + 2];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const d = -(dx * dir.x + dy * dir.y + dz * dir.z);
    if (d > bestD) {
      bestD = d;
      bestU = u;
    }
  }
  return bestU;
}

/** Default normal falloff angle of the paint modes (80°). */
export const NORMAL_ANGLE = (80 * Math.PI) / 180;

/** Normal falloff settings of a paint mode (tool_settings.vertex_paint / weight_paint / image_paint). */
export interface NormalFalloff {
  use_normal_falloff?: boolean;
  normal_angle?: number;
}

/** The normal falloff angle a paint mode uses (0: off). */
export function normalAngleOf(settings: NormalFalloff | undefined | null): number {
  if (settings?.use_normal_falloff === false) return 0;
  return settings?.normal_angle ?? NORMAL_ANGLE;
}
