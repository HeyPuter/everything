// Element snapping for interactive transforms: snap targets on other geometry (vertex, edge,
// edge midpoint, face, volume) found under the mouse, plus the snap indicator overlay.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app } from '../app/app';
import type { View3D } from '../editors/view3d/view3d';
import { editModeHooks } from '../editors/view3d/hooks';
import { h } from '../ui/h';
import type { EvalMesh } from '../eval/types';

export type SnapElement = 'INCREMENT' | 'VERTEX' | 'EDGE' | 'FACE' | 'VOLUME' | 'EDGE_MIDPOINT' | 'GRID';

interface Candidate {
  id: string;
  mesh: { positions: ArrayLike<number>; offsets: ArrayLike<number>; indices: ArrayLike<number> };
  world: Matrix4;
  /** vertices that are being moved (excluded as targets) */
  skip?: Uint8Array;
}

const SNAP_PX = 18;

/** Geometry that may be snapped to: everything visible except what is being transformed. */
function candidates(v: View3D): Candidate[] {
  const out: Candidate[] = [];
  const mode = app.doc.mode;
  for (const ev of app.graph.objects.values()) {
    if (!ev.visible || !ev.mesh || ev.mesh.offsets.length < 2) continue;
    if (v.localView && !v.localView.has(ev.id)) continue;
    const ob = ev.ob;
    if (mode === 'OBJECT' && ob.select) continue;
    if (mode === 'EDIT' && app.graph.editObjects.has(ev.id) && ob.type === 'MESH' && ob.data) {
      // snap to the unselected part of the edited mesh itself
      const me = app.doc.meshes[ob.data];
      out.push({ id: ev.id, mesh: me, world: ev.world, skip: me.select_vert });
      continue;
    }
    out.push({ id: ev.id, mesh: ev.mesh as EvalMesh, world: ev.world });
  }
  return out;
}

export interface SnapHit {
  point: Vector3;
  kind: SnapElement;
  /** surface normal (world) for face snapping */
  normal?: Vector3;
}

/** Find the snap target under the mouse for the enabled element types. */
export function findSnapTarget(v: View3D, mouse: { x: number; y: number }, elements: SnapElement[]): SnapHit | null {
  const cands = candidates(v);
  if (!cands.length) return null;
  let best: { d: number; hit: SnapHit } | null = null;
  const consider = (d: number, point: Vector3, kind: SnapElement) => {
    if (d <= SNAP_PX && (!best || d < best.d)) best = { d, hit: { point, kind } };
  };
  const wantV = elements.includes('VERTEX'),
    wantE = elements.includes('EDGE'),
    wantM = elements.includes('EDGE_MIDPOINT');
  if (wantV || wantE || wantM) {
    const p = new Vector3();
    for (const c of cands) {
      const P = c.mesh.positions,
        n = P.length / 3;
      // project every vertex once
      const sx = new Float32Array(n),
        sy = new Float32Array(n),
        ok = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (c.skip?.[i]) continue;
        p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(c.world);
        const s = v.project(p);
        if (s.z > 1 || s.z < -1) continue;
        sx[i] = s.x;
        sy[i] = s.y;
        ok[i] = 1;
        if (wantV) consider(Math.hypot(s.x - mouse.x, s.y - mouse.y), p.clone(), 'VERTEX');
      }
      if (!wantE && !wantM) continue;
      const O = c.mesh.offsets,
        I = c.mesh.indices;
      for (let f = 0; f < O.length - 1; f++)
        for (let k = O[f]; k < O[f + 1]; k++) {
          const a = I[k],
            b = I[k + 1 < O[f + 1] ? k + 1 : O[f]];
          if (a > b || !ok[a] || !ok[b]) continue; // each undirected edge once (interior edges appear twice)
          const ax = sx[a],
            ay = sy[a],
            bx = sx[b],
            by = sy[b];
          const wa = new Vector3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]).applyMatrix4(c.world),
            wb = new Vector3(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]).applyMatrix4(c.world);
          if (wantM) consider(Math.hypot((ax + bx) / 2 - mouse.x, (ay + by) / 2 - mouse.y) - 0.5, wa.clone().lerp(wb, 0.5), 'EDGE_MIDPOINT');
          if (wantE) {
            const dx = bx - ax,
              dy = by - ay,
              l2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((mouse.x - ax) * dx + (mouse.y - ay) * dy) / l2));
            // vertices win over edges at the same distance
            consider(Math.hypot(ax + dx * t - mouse.x, ay + dy * t - mouse.y) + 1, wa.lerp(wb, t), 'EDGE');
          }
        }
    }
  }
  if (best) return (best as { hit: SnapHit }).hit;
  if (elements.includes('FACE') || elements.includes('VOLUME')) {
    const hits = rayHits(v, mouse, cands);
    if (hits.length) {
      if (elements.includes('FACE')) return { point: hits[0].point, kind: 'FACE', normal: hits[0].normal };
      const first = hits[0];
      const exit = hits.find((h2, i) => i > 0 && h2.id === first.id);
      if (exit) return { point: first.point.clone().lerp(exit.point, 0.5), kind: 'VOLUME' };
      return { point: first.point, kind: 'VOLUME' };
    }
  }
  return null;
}

/** All ray/triangle intersections under the mouse, nearest first. */
function rayHits(v: View3D, mouse: { x: number; y: number }, cands: Candidate[]) {
  const { origin, dir } = v.ray(mouse.x, mouse.y);
  const hits: { t: number; point: Vector3; id: string; normal: Vector3 }[] = [];
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    e1 = new Vector3(),
    e2 = new Vector3(),
    pv = new Vector3(),
    tv = new Vector3(),
    qv = new Vector3();
  for (const cand of cands) {
    const P = cand.mesh.positions,
      O = cand.mesh.offsets,
      I = cand.mesh.indices;
    const inv = cand.world.clone().invert();
    const o = origin.clone().applyMatrix4(inv),
      d = dir.clone().transformDirection(inv);
    for (let f = 0; f < O.length - 1; f++) {
      const s = O[f];
      for (let k = s + 1; k + 1 < O[f + 1]; k++) {
        const i0 = I[s],
          i1 = I[k],
          i2 = I[k + 1];
        if (cand.skip && (cand.skip[i0] || cand.skip[i1] || cand.skip[i2])) continue;
        a.set(P[i0 * 3], P[i0 * 3 + 1], P[i0 * 3 + 2]);
        b.set(P[i1 * 3], P[i1 * 3 + 1], P[i1 * 3 + 2]);
        c.set(P[i2 * 3], P[i2 * 3 + 1], P[i2 * 3 + 2]);
        e1.subVectors(b, a);
        e2.subVectors(c, a);
        pv.crossVectors(d, e2);
        const det = e1.dot(pv);
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        tv.subVectors(o, a);
        const u = tv.dot(pv) * id;
        if (u < 0 || u > 1) continue;
        qv.crossVectors(tv, e1);
        const w = d.dot(qv) * id;
        if (w < 0 || u + w > 1) continue;
        const t = e2.dot(qv) * id;
        if (t <= 1e-6) continue;
        const local = o.clone().addScaledVector(d, t);
        const world = local.applyMatrix4(cand.world);
        const normal = new Vector3().crossVectors(e1, e2).applyMatrix3(new Matrix3().getNormalMatrix(cand.world)).normalize();
        if (normal.dot(dir) > 0) normal.negate();
        hits.push({ t: world.distanceTo(origin), point: world, id: cand.id, normal });
      }
    }
  }
  return hits.sort((x, y) => x.t - y.t);
}

// ---------------------------------------------------------------------------
// indicator (drawn while a transform modal is snapping)

export const snapIndicator: { point: Vector3 | null; kind: SnapElement | null } = { point: null, kind: null };

editModeHooks.svg.push((v) => {
  if (!app.modal || !snapIndicator.point) return null;
  const s = v.project(snapIndicator.point);
  if (s.z > 1) return null;
  const shape =
    snapIndicator.kind === 'EDGE' || snapIndicator.kind === 'EDGE_MIDPOINT'
      ? h('rect', { x: s.x - 5, y: s.y - 5, width: 10, height: 10, fill: 'none', stroke: '#fff', 'stroke-width': 1.5, transform: snapIndicator.kind === 'EDGE_MIDPOINT' ? `rotate(45 ${s.x} ${s.y})` : undefined })
      : h('circle', { cx: s.x, cy: s.y, r: 6, fill: 'none', stroke: '#fff', 'stroke-width': 1.5 });
  return h('g', { class: 'snap-indicator' }, shape, h('circle', { cx: s.x, cy: s.y, r: 1.5, fill: '#fff' }));
});
