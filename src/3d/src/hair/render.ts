// Strands as geometry for the render engines (path tracer, realtime raster) and conversions:
// each evaluated curve becomes a thin tube with smooth normals.
import { Mesh, type Material } from 'three';
import type { EvalMesh } from '../eval/types';
import { renderSceneHooks, renderVisibleObjects, type RenderScene } from '../render/final/renderscene';
import { meshGeometry } from '../render/geometry';
import { viewportMaterial } from '../render/pbr';
import { pathTracerMaterial } from '../render/final/ptmaterial';
import { materialSlots } from '../geonodes/convert';
import { hairDisplay } from './eval';
import { DEFAULT_RADIUS } from './data';

/**
 * Tube mesh around polylines (`sides` ≥ 2; 2 makes a flat ribbon facing the frame normal).
 * Radii are per point in the order of the polylines.
 */
export function strandTubes(curves: { points: ArrayLike<number>; cyclic?: boolean }[], radius: ArrayLike<number> | number, sides = 3, materialIndex?: ArrayLike<number>): EvalMesh {
  sides = Math.max(2, Math.round(sides));
  let nv = 0,
    nf = 0;
  for (const c of curves) {
    const k = c.points.length / 3;
    if (k < 2) continue;
    nv += k * sides;
    nf += (k - 1) * (sides === 2 ? 1 : sides);
  }
  const pos = new Float32Array(nv * 3);
  const offsets = new Uint32Array(nf + 1);
  const indices = new Uint32Array(nf * 4);
  const uvs = new Float32Array(nf * 8);
  const mat = materialIndex ? new Uint16Array(nf) : undefined;
  let v = 0,
    f = 0,
    pi = 0;
  const t = [0, 0, 0],
    n = [0, 0, 0],
    b = [0, 0, 0];
  curves.forEach((c, ci) => {
    const k = c.points.length / 3;
    const P = c.points;
    if (k < 2) {
      pi += k;
      return;
    }
    const base = v;
    for (let i = 0; i < k; i++) {
      const a = Math.max(0, i - 1),
        z = Math.min(k - 1, i + 1);
      t[0] = P[z * 3] - P[a * 3];
      t[1] = P[z * 3 + 1] - P[a * 3 + 1];
      t[2] = P[z * 3 + 2] - P[a * 3 + 2];
      norm(t);
      if (i === 0) {
        // any vector perpendicular to the first tangent
        if (Math.abs(t[2]) < 0.9) cross(t, [0, 0, 1], n);
        else cross(t, [1, 0, 0], n);
        norm(n);
      } else {
        // parallel transport: remove the tangent component of the previous normal
        const d = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
        n[0] -= t[0] * d;
        n[1] -= t[1] * d;
        n[2] -= t[2] * d;
        norm(n);
      }
      cross(t, n, b);
      const r = typeof radius === 'number' ? radius : (radius[pi + i] ?? DEFAULT_RADIUS);
      for (let s = 0; s < sides; s++) {
        const ang = sides === 2 ? (s ? Math.PI : 0) : (s / sides) * Math.PI * 2;
        const ca = Math.cos(ang) * r,
          sa = Math.sin(ang) * r;
        const o = (v + s) * 3;
        pos[o] = P[i * 3] + n[0] * ca + b[0] * sa;
        pos[o + 1] = P[i * 3 + 1] + n[1] * ca + b[1] * sa;
        pos[o + 2] = P[i * 3 + 2] + n[2] * ca + b[2] * sa;
      }
      v += sides;
    }
    for (let i = 0; i + 1 < k; i++) {
      const faces = sides === 2 ? 1 : sides;
      for (let s = 0; s < faces; s++) {
        const s2 = (s + 1) % sides;
        const a0 = base + i * sides + s,
          a1 = base + i * sides + s2,
          b1 = base + (i + 1) * sides + s2,
          b0 = base + (i + 1) * sides + s;
        indices.set([a0, a1, b1, b0], f * 4);
        const u0 = s / faces,
          u1 = (s + 1) / faces,
          v0 = i / (k - 1),
          v1 = (i + 1) / (k - 1);
        uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], f * 8);
        if (mat) mat[f] = materialIndex![ci] ?? 0;
        f++;
        offsets[f] = f * 4;
      }
    }
    pi += k;
  });
  return {
    positions: pos,
    offsets,
    indices,
    uvs,
    normals: new Float32Array(nf * 4 * 3),
    smooth: new Uint8Array(nf).fill(1),
    material_index: mat,
  };
}

function norm(v: number[]) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
}
function cross(a: number[], b: number[], out: number[]) {
  const x = a[1] * b[2] - a[2] * b[1],
    y = a[2] * b[0] - a[0] * b[2],
    z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

const tubeCache = new WeakMap<EvalMesh, Map<string, EvalMesh>>();

/** How strands become render geometry (Render ▸ Curves): cross-section sides and subdivisions. */
export interface StrandShape {
  /** 2 = flat ribbon, ≥ 3 = tube */
  sides: number;
  /** each segment is split into 2^subdivisions along a smooth curve */
  subdivisions: number;
}

/** Points (and radii) of a polyline refined along a Catmull–Rom curve, 2^levels pieces per segment. */
export function subdivideStrand(points: ArrayLike<number>, radius: ArrayLike<number> | number, levels: number): { points: Float32Array; radius: Float32Array | number } {
  const k = points.length / 3;
  const per = 1 << Math.max(0, Math.min(4, Math.round(levels)));
  if (per === 1 || k < 2) return { points: Float32Array.from(points), radius: typeof radius === 'number' ? radius : Float32Array.from(radius) };
  const n = (k - 1) * per + 1;
  const out = new Float32Array(n * 3);
  const rad = typeof radius === 'number' ? radius : new Float32Array(n);
  const P = (i: number, c: number) => points[Math.max(0, Math.min(k - 1, i)) * 3 + c];
  for (let i = 0; i < k - 1; i++) {
    for (let s = 0; s < per; s++) {
      const t = s / per,
        t2 = t * t,
        t3 = t2 * t;
      const o = (i * per + s) * 3;
      for (let c = 0; c < 3; c++) {
        const p0 = P(i - 1, c),
          p1 = P(i, c),
          p2 = P(i + 1, c),
          p3 = P(i + 2, c);
        out[o + c] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      }
      if (typeof rad !== 'number') {
        const r = radius as ArrayLike<number>;
        rad[i * per + s] = (r[i] ?? DEFAULT_RADIUS) * (1 - t) + (r[i + 1] ?? DEFAULT_RADIUS) * t;
      }
    }
  }
  for (let c = 0; c < 3; c++) out[(n - 1) * 3 + c] = points[(k - 1) * 3 + c];
  if (typeof rad !== 'number') rad[n - 1] = (radius as ArrayLike<number>)[k - 1] ?? DEFAULT_RADIUS;
  return { points: out, radius: rad };
}

/** Tubes for an evaluated hair mesh (cached per shape). */
export function tubesFor(m: EvalMesh, shape: StrandShape = { sides: 3, subdivisions: 0 }): EvalMesh | null {
  if (!m.curves?.length) return null;
  let per = tubeCache.get(m);
  if (!per) tubeCache.set(m, (per = new Map()));
  const key = `${shape.sides}|${shape.subdivisions}`;
  let t = per.get(key);
  if (!t) {
    const disp = hairDisplay.get(m);
    const radius = disp?.radius ?? DEFAULT_RADIUS;
    if (shape.subdivisions > 0) {
      // refine every curve, carrying its slice of the per-point radii
      const curves: { points: Float32Array }[] = [];
      const radii: number[] = [];
      let pi = 0;
      for (const c of m.curves) {
        const k = c.points.length / 3;
        const r = typeof radius === 'number' ? radius : Array.from({ length: k }, (_, i) => radius[pi + i] ?? DEFAULT_RADIUS);
        const sd = subdivideStrand(c.points, r, shape.subdivisions);
        curves.push({ points: sd.points });
        if (typeof sd.radius === 'number') for (let i = 0; i < sd.points.length / 3; i++) radii.push(sd.radius);
        else radii.push(...sd.radius);
        pi += k;
      }
      t = strandTubes(curves, radii, shape.sides);
    } else t = strandTubes(m.curves, radius, shape.sides);
    per.set(key, t);
  }
  return t;
}

/** Strand shape of the render settings for an engine (Render ▸ Curves). */
export const strandShapeHooks: { shape?: (doc: import('../data/types').DocumentData, mode: 'raster' | 'pathtrace') => StrandShape } = {};

const meshes = new WeakMap<RenderScene, Map<string, Mesh>>();

renderSceneHooks.push((rs, appRef, o) => {
  let byOb = meshes.get(rs);
  if (!byOb) meshes.set(rs, (byOb = new Map()));
  const doc = appRef.doc;
  const renderable = o.final ? renderVisibleObjects(doc) : null;
  const seen = new Set<string>();
  let changed = false;
  for (const ev of appRef.graph.objects.values()) {
    if (ev.ob.type !== 'CURVES' || !ev.mesh || o.hideSurfaces) continue;
    const visible = renderable ? renderable.has(ev.id) : ev.visible && !ev.ob.hide_render && (!o.localView || o.localView.has(ev.id));
    if (!visible) continue;
    const tubes = tubesFor(ev.mesh, strandShapeHooks.shape?.(doc, rs.mode));
    if (!tubes) continue;
    seen.add(ev.id);
    const geo = meshGeometry(tubes).geometry;
    const vm = viewportMaterial(doc, materialSlots(doc, ev.ob)[0] ?? null);
    const mat: Material = rs.mode === 'pathtrace' ? pathTracerMaterial(vm) : vm;
    let m = byOb.get(ev.id);
    if (!m) {
      m = new Mesh(geo, mat);
      m.matrixAutoUpdate = false;
      m.userData.id = ev.id;
      rs.scene.add(m);
      byOb.set(ev.id, m);
      changed = true;
    }
    if (m.geometry !== geo) {
      m.geometry = geo;
      changed = true;
    }
    if (m.material !== mat) {
      m.material = mat;
      changed = true;
    }
    m.matrix.copy(ev.world);
    m.matrixWorld.copy(ev.world);
    m.castShadow = ev.ob.visible_shadow !== false;
    m.receiveShadow = true;
  }
  for (const [id, m] of byOb)
    if (!seen.has(id)) {
      rs.scene.remove(m);
      byOb.delete(id);
      changed = true;
    }
  if (changed) rs.structureVersion++;
});
