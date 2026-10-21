/**
 * Imported models: geometry read from another tool's file (IFC), shown
 * read-only for coordination, placed like a linked project.
 *
 *   importedModel { name, source, at, rotation, z, parts: [{ color, tris }], count, types }
 *
 * `tris` are flat x, y, z triangles in millimetres in the file's own
 * coordinates; `parts` are grouped by colour to keep the snapshot small.
 */
import { MeshBuilder } from './mesh.js';
import { linkFrame } from './links.js';
import { W, INK } from './plan.js';

/** Group read parts by colour and count element types. */
export function packParts(read) {
  const byColor = new Map();
  const types = {};
  for (const p of read.parts) {
    const key = p.color.join(',');
    if (!byColor.has(key)) byColor.set(key, { color: p.color, tris: [] });
    const t = byColor.get(key).tris;
    for (let i = 0; i < p.tris.length; i++) t.push(p.tris[i]);
    const label = p.type.replace(/^IFC/, '').replace(/STANDARDCASE$/, '');
    types[label] = (types[label] || 0) + 1;
  }
  return { parts: [...byColor.values()], count: read.count, types };
}

export function buildImported(el) {
  const f = linkFrame(el);
  const b = new MeshBuilder();
  const P = (t, i) => [f.c * t[i] - f.s * t[i + 1] + f.x, f.s * t[i] + f.c * t[i + 1] + f.y, t[i + 2] + f.z];
  for (const part of el.parts || []) {
    const t = part.tris;
    const col = part.color;
    for (let i = 0; i + 8 < t.length; i += 9) {
      const a = P(t, i);
      const c = P(t, i + 3);
      const d = P(t, i + 6);
      // Skip slivers.
      const ux = c[0] - a[0];
      const uy = c[1] - a[1];
      const uz = c[2] - a[2];
      const vx = d[0] - a[0];
      const vy = d[1] - a[1];
      const vz = d[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-3) continue;
      b.tri(a, c, d, col);
    }
  }
  return b.build();
}

/** Plan: where the plan's cut plane passes through the imported triangles. */
export function planImported(pc, el, b) {
  if (pc.ceiling) return;
  const f = linkFrame(el);
  const z = pc.cutZ - f.z;
  const P = (x, y) => [f.c * x - f.s * y + f.x, f.s * x + f.c * y + f.y];
  let any = false;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const part of el.parts || []) {
    const t = part.tris;
    for (let i = 0; i + 8 < t.length; i += 9) {
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const a = i + k * 3;
        const c = i + ((k + 1) % 3) * 3;
        const za = t[a + 2] - z;
        const zc = t[c + 2] - z;
        if ((za < 0) !== (zc < 0)) {
          const s = za / (za - zc);
          pts.push(P(t[a] + (t[c] - t[a]) * s, t[a + 1] + (t[c + 1] - t[a + 1]) * s));
        }
      }
      if (pts.length === 2) {
        b.line(pts[0], pts[1], W.medium, 0, INK(220));
        any = true;
        for (const p of pts) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
      }
    }
  }
  if (any) {
    // Picked by a frame around what is cut, so the reference can be moved.
    const t = 1.5 * pc.scale;
    for (const [a, c] of [
      [[x0, y0], [x1, y0]],
      [[x1, y0], [x1, y1]],
      [[x1, y1], [x0, y1]],
      [[x0, y1], [x0, y0]],
    ])
      b.pick([
        [Math.min(a[0], c[0]) - t, Math.min(a[1], c[1]) - t],
        [Math.max(a[0], c[0]) + t, Math.min(a[1], c[1]) - t],
        [Math.max(a[0], c[0]) + t, Math.max(a[1], c[1]) + t],
        [Math.min(a[0], c[0]) - t, Math.max(a[1], c[1]) + t],
      ]);
  }
}
