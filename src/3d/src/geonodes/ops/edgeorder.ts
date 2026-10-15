// Edge numbering of mesh primitives. Primitives list their edges in a fixed order (rather than
// in order of first use by faces) so edge indices are predictable: grids by rows then columns,
// round shapes ring by ring.
import type { MeshComponent } from '../geometry';

/** Give a mesh an explicit edge order (vertex pairs). */
export function withEdgeOrder(m: MeshComponent, edges: number[]): MeshComponent {
  m.edgeOrder = { edges: Uint32Array.from(edges), corners: m.corners, loose: m.looseEdges };
  return m;
}

/** Grid with `vx` × `vy` vertices numbered x * vy + y: edges along y per column, then along x per row. */
export function gridEdgeOrder(vx: number, vy: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < vx; x++) for (let y = 0; y + 1 < vy; y++) out.push(x * vy + y, x * vy + y + 1);
  for (let y = 0; y < vy; y++) for (let x = 0; x + 1 < vx; x++) out.push(x * vy + y, (x + 1) * vy + y);
  return out;
}

/**
 * Rings of `n` vertices (after an optional first point, before an optional last point): spokes
 * from the first point, then per ring its loop and the edges to the next ring, then spokes to the
 * last point (`lastPointFirst` lists the last point first in each spoke).
 */
export function ringEdgeOrder(vertCount: number, n: number, firstPoint: boolean, lastPoint: boolean, lastPointFirst = false): number[] {
  const out: number[] = [];
  const start = firstPoint ? 1 : 0;
  const rings = Math.floor((vertCount - start - (lastPoint ? 1 : 0)) / n);
  const v = (k: number, i: number) => start + k * n + (i % n);
  if (firstPoint) for (let i = 0; i < n; i++) out.push(0, v(0, i));
  for (let k = 0; k < rings; k++) {
    for (let i = 0; i < n; i++) out.push(v(k, i), v(k, i + 1));
    if (k + 1 < rings) for (let i = 0; i < n; i++) out.push(v(k, i), v(k + 1, i));
  }
  if (lastPoint) {
    const p = vertCount - 1;
    for (let i = 0; i < n; i++) {
      if (lastPointFirst) out.push(p, v(rings - 1, i));
      else out.push(v(rings - 1, i), p);
    }
  }
  return out;
}

/** Face edges in order of first use, each kept in the direction it is first used (closing edge of each face first). */
export function faceUseEdgeOrder(m: MeshComponent): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const nv = m.vertCount;
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    for (let c = s; c < e; c++) {
      const a = m.corners[c === s ? e - 1 : c - 1],
        b = m.corners[c];
      const k = Math.min(a, b) * nv + Math.max(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a, b);
    }
  }
  return out;
}
