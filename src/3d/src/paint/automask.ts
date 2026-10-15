// Sculpt auto-masking: per-stroke factors that keep brushes on the part of the mesh they started
// on (topology, face set), away from borders (mesh / face set boundaries), in or out of cavities,
// or on surfaces facing the start normal / the view.
import type { MeshData, SculptSettings } from '../data/types';
import type { MeshSession } from './session';
import { boundaryVerts, faceSetBoundaryVerts, faceSetsOf } from './fsdata';
import { topologySteps } from './expandmath';
import { cavityValues, smoothValues } from './maskmath';

export function automaskActive(ts: SculptSettings): boolean {
  return !!(ts.use_automasking_topology || ts.use_automasking_face_sets || ts.use_automasking_boundary_edges || ts.use_automasking_boundary_face_sets || ts.use_automasking_cavity || ts.use_automasking_cavity_inverted);
}

export function normalAutomaskActive(ts: SculptSettings): boolean {
  return !!(ts.use_automasking_start_normal || ts.use_automasking_view_normal);
}

/** Static auto-mask factors for a stroke starting on `face` (null when no static mode is on). */
export function strokeAutomask(s: MeshSession, me: MeshData, ts: SculptSettings, face: number): Float32Array | null {
  if (!automaskActive(ts)) return null;
  const nv = s.nv;
  const out = new Float32Array(nv).fill(1);
  const nb = s.neighbors;
  if (ts.use_automasking_topology) {
    const start: number[] = [];
    for (let c = s.offsets[face]; c < s.offsets[face + 1]; c++) start.push(s.indices[c]);
    const d = topologySteps(nb.offsets, nb.neighbors, start);
    for (let v = 0; v < nv; v++) if (d[v] === Infinity) out[v] = 0;
  }
  if (ts.use_automasking_face_sets) {
    const fs = faceSetsOf(me);
    if (fs) {
      const id = fs[face];
      const vf = s.vf;
      for (let v = 0; v < nv; v++)
        for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++)
          if (fs[vf.faces[k]] !== id) {
            out[v] = 0;
            break;
          }
    }
  }
  const steps = Math.max(1, ts.automasking_boundary_edges_propagation_steps ?? 1);
  const fromBorder = (b: Uint8Array) => {
    const src: number[] = [];
    for (let v = 0; v < nv; v++) if (b[v]) src.push(v);
    if (!src.length) return;
    const d = topologySteps(nb.offsets, nb.neighbors, src);
    for (let v = 0; v < nv; v++) out[v] *= Math.min(1, d[v] / steps);
  };
  if (ts.use_automasking_boundary_edges) fromBorder(boundaryVerts(me));
  if (ts.use_automasking_boundary_face_sets) fromBorder(faceSetBoundaryVerts(me));
  if (ts.use_automasking_cavity || ts.use_automasking_cavity_inverted) {
    let cav = cavityValues(s.positions, s.vn, nb.offsets, nb.neighbors);
    cav = smoothValues(cav, nb.offsets, nb.neighbors, ts.automasking_cavity_blur_steps ?? 0);
    let max = 0;
    for (const c of cav) max = Math.max(max, Math.abs(c));
    const k = ((ts.automasking_cavity_factor ?? 1) * 4 + 0.01) / (max || 1);
    for (let v = 0; v < nv; v++) {
      // cavity: only the dips; inverted: only the peaks / flat parts
      const c = Math.max(0, Math.min(1, cav[v] * k));
      out[v] *= ts.use_automasking_cavity_inverted ? 1 - c : c;
    }
  }
  return out;
}

/** Factor (0..1) of a normal against a reference direction with an angle limit and falloff (radians). */
export function normalFactor(nx: number, ny: number, nz: number, rx: number, ry: number, rz: number, limit: number, falloff: number): number {
  const ang = Math.acos(Math.max(-1, Math.min(1, nx * rx + ny * ry + nz * rz)));
  if (ang <= limit) return 1;
  if (ang >= limit + falloff || falloff <= 0) return 0;
  const t = (ang - limit) / falloff;
  return 1 - t * t * (3 - 2 * t);
}
