/**
 * Linked projects: another project shown inside this one, read-only, for
 * coordination (a structural or services model, a neighbouring building).
 *
 *   link { name, data, path?, at, rotation, z }
 *
 * `data` is a snapshot of the linked project (its items as JSON), so a link
 * works offline and for collaborators who cannot open the source file;
 * `path` is where it came from, for reloading. The link is placed by
 * moving its origin to `at`, turning it by `rotation` degrees and raising
 * it by `z`.
 */
import { PlanBuilder } from './plan.js';

export function linkFrame(el) {
  const r = ((+el.rotation || 0) * Math.PI) / 180;
  return { c: Math.cos(r), s: Math.sin(r), x: el.at?.[0] || 0, y: el.at?.[1] || 0, z: +el.z || 0, r };
}

export function linkPoint(f, p) {
  return [f.c * p[0] - f.s * p[1] + f.x, f.s * p[0] + f.c * p[1] + f.y];
}

/** Snapshot of a project for a link. */
export function linkData(doc) {
  return JSON.stringify(doc.toJSON());
}

/** The level of the linked project that a host plan at `elevation` shows. */
export function linkedLevel(linked, el, elevation) {
  const target = elevation - (+el.z || 0);
  const levels = linked.levels();
  const exact = levels.find((l) => Math.abs(l.elevation - target) < 1);
  if (exact) return exact;
  return levels.filter((l) => l.elevation <= target + 1).at(-1) || null;
}

/** Append 2D graphics moved into the host's coordinates. */
export function appendPlan(out, g, f) {
  const P = (p) => linkPoint(f, p);
  for (const l of g.lines) out.lines.push({ ...l, a: P(l.a), b: P(l.b) });
  for (const fl of g.fills) out.fills.push({ ...fl, poly: fl.poly.map(P), holes: (fl.holes || []).map((h) => h.map(P)) });
  for (const t of g.texts) out.texts.push({ ...t, at: P(t.at), rot: (t.rot || 0) + f.r });
  for (const p of g.picks) out.picks.push(p.map(P));
}

export function emptyPlan() {
  return new PlanBuilder();
}

/** Merge meshes into one, moved into the host's coordinates. */
export function combineMeshes(meshes, f) {
  let nPos = 0;
  let nEdge = 0;
  for (const m of meshes) {
    nPos += m.pos.length;
    nEdge += m.edges.length;
  }
  if (!nPos && !nEdge) return null;
  const pos = new Float32Array(nPos);
  const nrm = new Int8Array(nPos);
  const col = new Uint8Array((nPos / 3) * 4);
  const edges = new Float32Array(nEdge);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const put = (src, dst, i) => {
    const x = src[i];
    const y = src[i + 1];
    const X = f.c * x - f.s * y + f.x;
    const Y = f.s * x + f.c * y + f.y;
    const Z = src[i + 2] + f.z;
    dst[i] = X;
    dst[i + 1] = Y;
    dst[i + 2] = Z;
    if (X < min[0]) min[0] = X;
    if (Y < min[1]) min[1] = Y;
    if (Z < min[2]) min[2] = Z;
    if (X > max[0]) max[0] = X;
    if (Y > max[1]) max[1] = Y;
    if (Z > max[2]) max[2] = Z;
  };
  let o = 0;
  let oc = 0;
  let oe = 0;
  for (const m of meshes) {
    const p = pos.subarray(o, o + m.pos.length);
    for (let i = 0; i < m.pos.length; i += 3) {
      put(m.pos, p, i);
      const nx = m.nrm[i];
      const ny = m.nrm[i + 1];
      nrm[o + i] = Math.round(f.c * nx - f.s * ny);
      nrm[o + i + 1] = Math.round(f.s * nx + f.c * ny);
      nrm[o + i + 2] = m.nrm[i + 2];
    }
    col.set(m.col, oc);
    const e = edges.subarray(oe, oe + m.edges.length);
    for (let i = 0; i < m.edges.length; i += 3) put(m.edges, e, i);
    o += m.pos.length;
    oc += m.col.length;
    oe += m.edges.length;
  }
  return { pos, nrm, col, edges, bounds: { min, max } };
}
