// Sculpt Curves mode brushes: Comb, Add, Delete, Density, Snake Hook, Grow / Shrink, Pinch,
// Puff, Smooth, Slide and Selection Paint. Strokes are driven by the shared stroke runner; the
// brush math lives in brushmath.ts. Ctrl inverts brushes that have an opposite, Shift smooths.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import type { DocumentData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { runStroke } from '../paint/stroke';
import {
  combDab,
  deleteHits,
  growShrinkDab,
  minRootDistance,
  mirroredProjector,
  newStrandShape,
  pinchDab,
  PointHash,
  puffDab,
  rootsOf,
  segmentLengths,
  selectionPaintDab,
  slideDab,
  smoothDab,
  snakeHookDab,
  symmetryPasses,
  thinRoots,
  type BrushParams,
  type NeighbourStrand,
  type Projector,
} from './brushmath';
import { activeHair, projectorFor, surfaceOf, worldOf } from './common';
import { DEFAULT_RADIUS, SURFACE_UV, appendCurves, cloneHair, curveCount, getAttr, keepCurves, pointCount, rng, setAttr, type CurveInput } from './data';
import { Surface } from './surface';
import type { CurvesBrush, CurvesSculptSettings, HairCurvesData } from './types';

export const SCULPT_TOOLS: { id: string; label: string; icon: string; description: string }[] = [
  { id: 'builtin_brush.Selection Paint', label: 'Selection Paint', icon: 'hair_selection', description: 'Paint the selection the other brushes are limited to (Ctrl deselects)' },
  { id: 'builtin_brush.Add', label: 'Add', icon: 'hair_add', description: 'Grow new curves on the surface' },
  { id: 'builtin_brush.Delete', label: 'Delete', icon: 'hair_delete', description: 'Remove the curves under the brush' },
  { id: 'builtin_brush.Density', label: 'Density', icon: 'hair_density', description: 'Thin out or fill in curves to keep a minimum distance between roots' },
  { id: 'builtin_brush.Comb', label: 'Comb', icon: 'hair_comb', description: 'Drag curves along with the brush, keeping their length' },
  { id: 'builtin_brush.Snake Hook', label: 'Snake Hook', icon: 'hair_snake', description: 'Pull curve tips along the stroke so the curves follow it' },
  { id: 'builtin_brush.Grow/Shrink', label: 'Grow/Shrink', icon: 'hair_grow', description: 'Make curves longer (Ctrl: shorter)' },
  { id: 'builtin_brush.Pinch', label: 'Pinch', icon: 'hair_pinch', description: 'Pull curves toward the brush centre (Ctrl: push away)' },
  { id: 'builtin_brush.Puff', label: 'Puff', icon: 'hair_puff', description: 'Make curves stand up along the surface normal (Ctrl: lay them down)' },
  { id: 'builtin_brush.Smooth', label: 'Smooth', icon: 'hair_smooth', description: 'Smooth out kinks in the curves' },
  { id: 'builtin_brush.Slide', label: 'Slide', icon: 'hair_slide', description: 'Move curves along the surface' },
];

const BASE: CurvesBrush = { size: 50, strength: 0.5, falloff: 'SMOOTH' };
const DEFAULTS: Record<string, Partial<CurvesBrush>> = {
  'builtin_brush.Comb': { strength: 1 },
  'builtin_brush.Add': { strength: 1, size: 30, add_amount: 1, curve_length: 0.3, curve_radius: 0.005, points_per_curve: 8, interpolation_neighbors: 5, use_length_interpolate: true, use_shape_interpolate: true, use_point_count_interpolate: true, use_radius_interpolate: true },
  'builtin_brush.Delete': { strength: 1, falloff: 'CONSTANT' },
  'builtin_brush.Density': { strength: 1, size: 60, minimum_distance: 0.05, density_mode: 'AUTO', density_add_attempts: 100, curve_length: 0.3, curve_radius: 0.005, points_per_curve: 8, use_length_interpolate: true, use_shape_interpolate: true, use_point_count_interpolate: true, use_radius_interpolate: true },
  'builtin_brush.Snake Hook': { strength: 1 },
  'builtin_brush.Grow/Shrink': { strength: 0.5, use_uniform_scale: false, minimum_length: 0 },
  'builtin_brush.Pinch': { strength: 0.5 },
  'builtin_brush.Puff': { strength: 0.5 },
  'builtin_brush.Smooth': { strength: 0.5 },
  'builtin_brush.Slide': { strength: 1 },
  'builtin_brush.Selection Paint': { strength: 1, selection_value: 1 },
};

export function curvesSculptSettings(doc: DocumentData): CurvesSculptSettings {
  const ts = doc.scene.tool_settings as unknown as { curves_sculpt?: CurvesSculptSettings };
  ts.curves_sculpt ??= { brushes: {} };
  ts.curves_sculpt.brushes ??= {};
  return ts.curves_sculpt;
}

export function curvesBrush(doc: DocumentData, tool: string): CurvesBrush {
  const s = curvesSculptSettings(doc);
  return (s.brushes[tool] ??= { ...BASE, ...(DEFAULTS[tool] ?? {}) });
}

export const activeSculptTool = () => activeTools.SCULPT_CURVES ?? 'builtin_brush.Comb';

/** World-space length of `px` pixels at a world point (for 3D brush sizes). */
export function pixelsToWorld(v: View3D, at: Vector3, px: number): number {
  const s = v.project(at.clone());
  const a = v.unproject(s.x, s.y, at),
    b = v.unproject(s.x + px, s.y, at);
  return a.distanceTo(b);
}

/** Normal matrix from a 4×4 (for directions). */
const normalMat = (m: Matrix4) => new Matrix3().getNormalMatrix(m);

/** Neighbour strands of a root for interpolating new curves (hair space). */
function neighbours(hc: HairCurvesData, roots: Float32Array, normals: Float32Array | null, at: Vector3, k: number): (NeighbourStrand & { curve: number })[] {
  const nc = curveCount(hc);
  if (!nc || k <= 0) return [];
  const best: { c: number; d: number }[] = [];
  for (let c = 0; c < nc; c++) {
    const d = Math.hypot(roots[c * 3] - at.x, roots[c * 3 + 1] - at.y, roots[c * 3 + 2] - at.z);
    if (best.length < k) {
      best.push({ c, d });
      best.sort((a, b) => a.d - b.d);
    } else if (d < best[k - 1].d) {
      best[k - 1] = { c, d };
      best.sort((a, b) => a.d - b.d);
    }
  }
  const o = hc.curve_offsets;
  return best.map(({ c, d }) => ({
    curve: c,
    root: [roots[c * 3], roots[c * 3 + 1], roots[c * 3 + 2]],
    normal: normals ? [normals[c * 3], normals[c * 3 + 1], normals[c * 3 + 2]] : strandDir(hc, c),
    points: hc.positions.subarray(o[c] * 3, o[c + 1] * 3),
    weight: 1 / Math.max(1e-4, d),
  }));
}

function strandDir(hc: HairCurvesData, c: number): [number, number, number] {
  const o = hc.curve_offsets;
  const a = o[c],
    e = o[c + 1] - 1;
  const d = new Vector3(hc.positions[e * 3] - hc.positions[a * 3], hc.positions[e * 3 + 1] - hc.positions[a * 3 + 1], hc.positions[e * 3 + 2] - hc.positions[a * 3 + 2]);
  if (d.lengthSq() < 1e-12) d.set(0, 0, 1);
  d.normalize();
  return [d.x, d.y, d.z];
}

interface SurfaceCtx {
  s: Surface;
  toSurface: Matrix4;
  fromSurface: Matrix4;
  nToHair: Matrix3;
  surfaceWorldInv: Matrix4;
}

function surfaceCtx(ob: import('../data/types').ObjectData, hc: HairCurvesData): SurfaceCtx | null {
  const so = surfaceOf(ob, hc);
  if (!so) return null;
  const surfWorld = app.graph.get(so.ob.id)!.world;
  return { s: Surface.of(so.mesh), toSurface: so.toSurface, fromSurface: so.fromSurface, nToHair: normalMat(so.fromSurface), surfaceWorldInv: surfWorld.clone().invert() };
}

/** Root normals of all curves (hair space), from the surface or the curve direction. */
function rootNormals(hc: HairCurvesData, sc: SurfaceCtx | null): Float32Array {
  const nc = curveCount(hc);
  const out = new Float32Array(nc * 3);
  const o = hc.curve_offsets;
  const p = new Vector3();
  for (let c = 0; c < nc; c++) {
    let n: Vector3 | null = null;
    if (sc) {
      p.fromArray(hc.positions, o[c] * 3).applyMatrix4(sc.toSurface);
      const h = sc.s.closest(p);
      if (h) n = h.normal.clone().applyMatrix3(sc.nToHair).normalize();
    }
    if (!n) n = new Vector3(...strandDir(hc, c));
    n.toArray(out, c * 3);
  }
  return out;
}

/** Points that went inside the surface are pushed back out (curves listed in `curves`). */
function collide(hc: HairCurvesData, sc: SurfaceCtx, curves: number[]) {
  const o = hc.curve_offsets;
  const P = hc.positions;
  const p = new Vector3();
  for (const c of curves)
    for (let i = o[c] + 1; i < o[c + 1]; i++) {
      p.fromArray(P, i * 3).applyMatrix4(sc.toSurface);
      const h = sc.s.closest(p);
      if (!h) continue;
      const d = p.clone().sub(h.point);
      if (d.dot(h.normal) >= 0) continue;
      h.point.addScaledVector(h.normal, 1e-4).applyMatrix4(sc.fromSurface).toArray(P, i * 3);
    }
}

/** Surface UVs of some curves' roots (after roots moved). */
function updateRootUVs(hc: HairCurvesData, sc: SurfaceCtx, curves: Iterable<number>) {
  if (!sc.s.hasUV) return;
  const a = getAttr(hc, SURFACE_UV);
  const uv = a ? Float32Array.from(a.data) : new Float32Array(curveCount(hc) * 2);
  const p = new Vector3();
  for (const c of curves) {
    p.fromArray(hc.positions, hc.curve_offsets[c] * 3).applyMatrix4(sc.toSurface);
    const h = sc.s.closest(p);
    if (h?.uv) uv.set(h.uv, c * 2);
  }
  setAttr(hc, SURFACE_UV, 'CURVE', 'FLOAT2', uv);
}

export interface StrokeOptions {
  tool: string;
  invert: boolean;
}

/**
 * New strands rooted at surface hits under screen positions `pts` (view pixels). Shapes follow
 * the brush settings or neighbouring strands.
 */
function strandsAt(v: View3D, hc: HairCurvesData, sc: SurfaceCtx, pts: { x: number; y: number }[], b: CurvesBrush, accept?: (root: Vector3) => boolean): CurveInput[] {
  const out: CurveInput[] = [];
  const roots = rootsOf({ positions: hc.positions, offsets: hc.curve_offsets });
  const toSurfaceWorld = sc.surfaceWorldInv;
  const radii = getAttr(hc, 'radius')?.data;
  for (const q of pts) {
    const r = v.ray(q.x, q.y);
    const origin = r.origin.clone().applyMatrix4(toSurfaceWorld);
    const dir = r.dir.clone().transformDirection(toSurfaceWorld);
    const hit = sc.s.raycast(origin, dir);
    if (!hit) continue;
    const root = hit.point.clone().applyMatrix4(sc.fromSurface);
    if (accept && !accept(root)) continue;
    const n = hit.normal.clone().applyMatrix3(sc.nToHair).normalize();
    const nb = neighbours(hc, roots, null, root, b.interpolation_neighbors ?? 5);
    const shape = newStrandShape([root.x, root.y, root.z], [n.x, n.y, n.z], {
      length: b.curve_length ?? 0.3,
      points: b.points_per_curve ?? 8,
      neighbours: nb,
      interpolateLength: !!b.use_length_interpolate,
      interpolateShape: !!b.use_shape_interpolate,
      interpolatePointCount: !!b.use_point_count_interpolate,
    });
    let radius = b.curve_radius ?? DEFAULT_RADIUS;
    if (b.use_radius_interpolate && radii && nb.length) {
      // average root radius of the neighbours
      let s = 0,
        w = 0;
      const o = hc.curve_offsets;
      for (const x of nb) {
        s += radii[o[x.curve]] * x.weight;
        w += x.weight;
      }
      if (w > 0) radius = s / w;
    }
    out.push({ points: shape, radius, uv: hit.uv ?? undefined });
  }
  return out;
}

/** Random points in a screen disk. */
function diskSamples(cx: number, cy: number, r: number, n: number, rand: () => number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2,
      d = Math.sqrt(rand()) * r;
    out.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d });
  }
  return out;
}

let strokeSeed = 1;

/** Run a sculpt stroke from a pointer press in the viewport. */
export function startCurvesStroke(v: View3D, e: PointerEvent, opts: StrokeOptions) {
  const a = activeHair();
  if (!a) return;
  const { ob, hc } = a;
  const doc = app.doc;
  const tool = opts.tool;
  const b = curvesBrush(doc, tool);
  const snapshot = cloneHair(hc);
  const sc = surfaceCtx(ob, hc);
  const passes = symmetryPasses(hc.use_mirror_x, hc.use_mirror_y, hc.use_mirror_z);
  const rand = rng(strokeSeed++);
  let lengths = segmentLengths({ positions: hc.positions, offsets: hc.curve_offsets });
  let normals: Float32Array | null = tool === 'builtin_brush.Puff' ? rootNormals(hc, sc) : null;
  const slid = new Set<number>();
  let prev: { x: number; y: number } | null = null;
  let changed = false;
  hc.positions = hc.positions.slice();
  const world = worldOf(ob);
  const proj = () => projectorFor(v, world);
  const mask = () => {
    const s = getAttr(hc, '.selection');
    if (!s) return null;
    if (s.domain === 'POINT') return s.data as Float32Array;
    const out = new Float32Array(pointCount(hc));
    const o = hc.curve_offsets;
    for (let c = 0; c + 1 < o.length; c++) out.fill(s.data[c], o[c], o[c + 1]);
    return out;
  };
  const topologyChanged = () => {
    lengths = segmentLengths({ positions: hc.positions, offsets: hc.curve_offsets });
    if (normals) normals = rootNormals(hc, sc);
  };
  const forPasses = (fn: (p: Projector) => number[] | void) => {
    const base = proj();
    const touched = new Set<number>();
    for (const m of passes) {
      const r = fn(m[0] || m[1] || m[2] ? mirroredProjector(base, m) : base);
      if (r) for (const c of r) touched.add(c);
    }
    return [...touched];
  };

  runStroke(v, e, {
    spacing: () => (tool === 'builtin_brush.Add' || tool === 'builtin_brush.Density' ? 50 : 0),
    radiusPx: () => b.size,
    settings: () => ({ stroke_method: 'SPACE' }),
    dab: (d) => {
      const bp: BrushParams = { x: d.x, y: d.y, radius: b.size, strength: b.strength * d.pressure, falloff: b.falloff, mask: mask() };
      const dx = prev ? d.x - prev.x : 0,
        dy = prev ? d.y - prev.y : 0;
      // motion brushes act around the previous dab position
      const at: BrushParams = prev ? { ...bp, x: prev.x, y: prev.y } : bp;
      prev = { x: d.x, y: d.y };
      const strands = { positions: hc.positions, offsets: hc.curve_offsets };
      let touched: number[] = [];
      switch (tool) {
        case 'builtin_brush.Comb':
          touched = forPasses((p) => combDab(strands, p, at, dx, dy, lengths));
          break;
        case 'builtin_brush.Snake Hook':
          touched = forPasses((p) => snakeHookDab(strands, p, at, dx, dy));
          if (touched.length) lengths = segmentLengths(strands);
          break;
        case 'builtin_brush.Pinch':
          touched = forPasses((p) => pinchDab(strands, p, bp, opts.invert, lengths));
          break;
        case 'builtin_brush.Smooth':
          touched = forPasses((p) => smoothDab(strands, p, bp));
          if (touched.length) lengths = segmentLengths(strands);
          break;
        case 'builtin_brush.Puff':
          if (normals) touched = forPasses((p) => puffDab(strands, p, bp, normals!, lengths, opts.invert));
          break;
        case 'builtin_brush.Grow/Shrink':
          touched = forPasses((p) => growShrinkDab(strands, p, bp, !opts.invert, { uniform: !!b.use_uniform_scale, minLength: b.minimum_length ?? 0 }));
          if (touched.length) lengths = segmentLengths(strands);
          break;
        case 'builtin_brush.Slide': {
          if (!sc) break;
          const snap = (x: number, y: number, z: number): [number, number, number] | null => {
            const h = sc.s.closest(new Vector3(x, y, z).applyMatrix4(sc.toSurface));
            return h ? (h.point.applyMatrix4(sc.fromSurface).toArray() as [number, number, number]) : null;
          };
          touched = forPasses((p) => slideDab(strands, p, at, dx, dy, snap));
          touched.forEach((c) => slid.add(c));
          break;
        }
        case 'builtin_brush.Delete': {
          const kill = new Uint8Array(curveCount(hc));
          forPasses((p) => {
            deleteHits(strands, p, bp).forEach((x, i) => x && (kill[i] = 1));
          });
          if (kill.some((x) => x)) {
            keepCurves(
              hc,
              Array.from(kill, (x) => x ^ 1),
            );
            hc.positions = hc.positions.slice();
            topologyChanged();
            changed = true;
          }
          break;
        }
        case 'builtin_brush.Selection Paint': {
          const perCurve = hc.selection_domain === 'CURVE';
          const s = getAttr(hc, '.selection');
          const cur = s && s.domain === hc.selection_domain ? Float32Array.from(s.data) : new Float32Array(perCurve ? curveCount(hc) : pointCount(hc)).fill(s ? 0 : 1);
          let any = false;
          const value = opts.invert ? 0 : (b.selection_value ?? 1);
          for (const m of passes) if (selectionPaintDab(strands, m[0] || m[1] || m[2] ? mirroredProjector(proj(), m) : proj(), bp, cur, value, perCurve)) any = true;
          if (any) {
            setAttr(hc, '.selection', hc.selection_domain, 'FLOAT', cur);
            changed = true;
          }
          break;
        }
        case 'builtin_brush.Add': {
          if (!sc) break;
          const n = Math.max(1, Math.round(b.add_amount ?? 1));
          const made = strandsAt(v, hc, sc, diskSamples(d.x, d.y, b.size, n, rand), b);
          if (made.length) {
            appendCurves(hc, withMirrors(made, hc, sc), true);
            topologyChanged();
            changed = true;
          }
          break;
        }
        case 'builtin_brush.Density': {
          if (!sc) break;
          if (densityDab(v, hc, ob, sc, d.x, d.y, b, opts.invert, rand)) {
            topologyChanged();
            changed = true;
          }
          break;
        }
      }
      if (touched.length) {
        changed = true;
        if (sc && hc.use_sculpt_collision && tool !== 'builtin_brush.Slide' && tool !== 'builtin_brush.Grow/Shrink') collide(hc, sc, touched);
      }
    },
    update: () => {
      if (!changed) return;
      // a new array identity per update so evaluation and drawing pick up the change
      hc.positions = hc.positions.slice();
      app.changed('doc');
    },
    end: () => {
      if (sc && slid.size) updateRootUVs(hc, sc, slid);
      if (changed) app.pushUndo(SCULPT_TOOLS.find((t) => t.id === tool)?.label ?? 'Sculpt Curves');
      app.changed('doc');
    },
    cancel: () => {
      Object.assign(hc, cloneHair(snapshot));
      app.changed('doc');
    },
  });
}

/** Mirrored copies of new strands for the enabled symmetry axes (roots snapped back to the surface). */
function withMirrors(list: CurveInput[], hc: HairCurvesData, sc: SurfaceCtx): CurveInput[] {
  const passes = symmetryPasses(hc.use_mirror_x, hc.use_mirror_y, hc.use_mirror_z).slice(1);
  if (!passes.length) return list;
  const out = [...list];
  for (const m of passes) {
    const s = [m[0] ? -1 : 1, m[1] ? -1 : 1, m[2] ? -1 : 1];
    for (const c of list) {
      const pts = Float32Array.from(c.points);
      for (let i = 0; i < pts.length; i++) pts[i] *= s[i % 3];
      const root = new Vector3(pts[0], pts[1], pts[2]).applyMatrix4(sc.toSurface);
      const h = sc.s.closest(root);
      if (h) {
        const off = h.point.applyMatrix4(sc.fromSurface).sub(new Vector3(pts[0], pts[1], pts[2]));
        for (let i = 0; i < pts.length; i += 3) {
          pts[i] += off.x;
          pts[i + 1] += off.y;
          pts[i + 2] += off.z;
        }
      }
      out.push({ ...c, points: pts, uv: h?.uv ?? undefined });
    }
  }
  return out;
}

/** Density: thin out roots closer than the minimum distance, or add curves keeping it. */
function densityDab(v: View3D, hc: HairCurvesData, ob: import('../data/types').ObjectData, sc: SurfaceCtx, x: number, y: number, b: CurvesBrush, invert: boolean, rand: () => number): boolean {
  const minDist = Math.max(1e-5, b.minimum_distance ?? 0.05);
  const roots = rootsOf({ positions: hc.positions, offsets: hc.curve_offsets });
  const world = worldOf(ob);
  // roots under the brush (screen space)
  const under: number[] = [];
  const p = new Vector3();
  for (let c = 0; c < curveCount(hc); c++) {
    p.fromArray(roots, c * 3).applyMatrix4(world);
    const s = v.project(p);
    if (s.z <= 1 && Math.hypot(s.x - x, s.y - y) < b.size) under.push(c);
  }
  let mode = b.density_mode ?? 'AUTO';
  if (mode === 'AUTO') mode = minRootDistance(roots, under.slice(0, 400)) < minDist ? 'REMOVE' : 'ADD';
  if (invert) mode = mode === 'ADD' ? 'REMOVE' : 'ADD';
  if (mode === 'REMOVE') {
    const cand = new Uint8Array(curveCount(hc));
    for (const c of under) cand[c] = 1;
    const kill = thinRoots(roots, cand, minDist, rand);
    if (!kill.some((k) => k)) return false;
    keepCurves(
      hc,
      Array.from(kill, (k) => k ^ 1),
    );
    hc.positions = hc.positions.slice();
    return true;
  }
  const hash = new PointHash(minDist);
  for (let c = 0; c < curveCount(hc); c++) hash.add(roots[c * 3], roots[c * 3 + 1], roots[c * 3 + 2]);
  const attempts = Math.max(1, Math.round(b.density_add_attempts ?? 100));
  const accept = (r: Vector3) => {
    if (hash.near(r.x, r.y, r.z, minDist)) return false;
    hash.add(r.x, r.y, r.z);
    return true;
  };
  const made = strandsAt(v, hc, sc, diskSamples(x, y, b.size, attempts, rand), b, accept);
  if (!made.length) return false;
  appendCurves(hc, withMirrors(made, hc, sc), true);
  return true;
}

