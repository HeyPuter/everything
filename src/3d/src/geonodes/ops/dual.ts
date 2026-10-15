// Dual mesh: a vertex at the centre of every face and a face around every vertex. Boundary
// vertices only get a face when boundaries are kept (closed with edge midpoints and the vertex
// itself). Face attributes become point attributes and point attributes face attributes.
import { MeshComponent, allocData, dataComps, type AttrMap } from '../geometry';

/** Directed-edge lookup: corner whose vertex is `a` and whose next vertex is `b`. */
export function directedCorners(m: MeshComponent): Map<number, number> {
  const nv = m.vertCount;
  const map = new Map<number, number>();
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    for (let c = s; c < e; c++) map.set(m.corners[c] * nv + m.corners[c + 1 < e ? c + 1 : s], c);
  }
  return map;
}

export function prevCorner(m: MeshComponent, f: number, c: number) {
  return c === m.faceOffsets[f] ? m.faceOffsets[f + 1] - 1 : c - 1;
}
export function nextCorner(m: MeshComponent, f: number, c: number) {
  return c + 1 === m.faceOffsets[f + 1] ? m.faceOffsets[f] : c + 1;
}

export interface VertexFan {
  /** corners around the vertex in winding order */
  corners: number[];
  /** the fan is open (vertex on a boundary) */
  open: boolean;
}

/** Corners around each vertex, ordered consistently with the face winding. */
export function vertexFans(m: MeshComponent): VertexFan[] {
  const topo = m.topology();
  const nv = m.vertCount;
  const dir = directedCorners(m);
  const cf = topo.cornerFace;
  const fans: VertexFan[] = [];
  for (let v = 0; v < nv; v++) {
    const a = topo.vertFaceOffsets[v],
      b = topo.vertFaceOffsets[v + 1];
    if (a === b) {
      fans.push({ corners: [], open: true });
      continue;
    }
    const cs = Array.from(topo.vertCorners.subarray(a, b)).sort((x, y) => x - y);
    // a fan starts where the edge to the next vertex has no face on its other side
    let start = cs[0];
    let open = false;
    for (const c of cs) {
      const n = m.corners[nextCorner(m, cf[c], c)];
      if (!dir.has(n * nv + v)) {
        start = c;
        open = true;
        break;
      }
    }
    const seen = new Set<number>();
    const order: number[] = [];
    let c: number | undefined = start;
    while (c !== undefined && !seen.has(c)) {
      seen.add(c);
      order.push(c);
      const p = m.corners[prevCorner(m, cf[c], c)];
      c = dir.get(v * nv + p);
    }
    fans.push({ corners: order, open: open || order.length < cs.length });
  }
  return fans;
}

export function dualMesh(m: MeshComponent, keepBoundaries: boolean): MeshComponent {
  const topo = m.topology();
  const nf = m.faceCount,
    nv = m.vertCount;
  const P = m.positions;
  const pos: number[] = [];
  // face centres
  for (let f = 0; f < nf; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    let x = 0,
      y = 0,
      z = 0;
    for (let c = s; c < e; c++) {
      const v = m.corners[c];
      x += P[v * 3];
      y += P[v * 3 + 1];
      z += P[v * 3 + 2];
    }
    const n = Math.max(1, e - s);
    pos.push(x / n, y / n, z / n);
  }
  const fans = vertexFans(m);
  const edgeMid = new Int32Array(topo.edgeCount).fill(-1);
  const vertNew = new Int32Array(nv).fill(-1);
  // vertex sources for attribute transfer: faces (for centres and midpoints) or an old vertex
  const srcFaces: number[][] = [];
  for (let f = 0; f < nf; f++) srcFaces.push([f]);
  if (keepBoundaries) {
    for (let e = 0; e < topo.edgeCount; e++) {
      const k = topo.edgeFaceOffsets[e + 1] - topo.edgeFaceOffsets[e];
      if (k !== 1) continue;
      const a = topo.edges[e * 2],
        b = topo.edges[e * 2 + 1];
      edgeMid[e] = pos.length / 3;
      pos.push((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2);
      srcFaces.push([topo.edgeFaces[topo.edgeFaceOffsets[e]]]);
    }
    for (let v = 0; v < nv; v++) {
      if (!fans[v].open || !fans[v].corners.length) continue;
      vertNew[v] = pos.length / 3;
      pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      srcFaces.push(fans[v].corners.map((c) => topo.cornerFace[c]));
    }
  }
  const edgeOf = (a: number, b: number): number => {
    for (let k = topo.vertEdgeOffsets[a]; k < topo.vertEdgeOffsets[a + 1]; k++) {
      const e = topo.vertEdges[k];
      if (topo.edges[e * 2] === b || topo.edges[e * 2 + 1] === b) return e;
    }
    return -1;
  };
  const offsets: number[] = [0];
  const corners: number[] = [];
  const faceSrc: number[] = [];
  for (let v = 0; v < nv; v++) {
    const fan = fans[v];
    if (!fan.corners.length) continue;
    if (fan.open && !keepBoundaries) continue;
    for (const c of fan.corners) corners.push(topo.cornerFace[c]);
    if (fan.open) {
      if (fan.corners.length < 1) continue;
      const last = fan.corners[fan.corners.length - 1];
      const first = fan.corners[0];
      const lp = m.corners[prevCorner(m, topo.cornerFace[last], last)];
      const fnx = m.corners[nextCorner(m, topo.cornerFace[first], first)];
      const e1 = edgeOf(v, lp),
        e2 = edgeOf(v, fnx);
      if (e1 >= 0 && edgeMid[e1] >= 0) corners.push(edgeMid[e1]);
      corners.push(vertNew[v]);
      if (e2 >= 0 && edgeMid[e2] >= 0) corners.push(edgeMid[e2]);
    }
    offsets.push(corners.length);
    faceSrc.push(v);
  }
  const out = new MeshComponent(new Float32Array(pos), Uint32Array.from(offsets), Uint32Array.from(corners), new Uint32Array(0), new Map(), [...m.materials]);
  const attrs: AttrMap = out.attrs;
  const nvOut = pos.length / 3;
  for (const [name, a] of m.attrs) {
    const comps = dataComps(a.type);
    if (a.domain === 'FACE') {
      const d = allocData(a.type, nvOut);
      for (let i = 0; i < nvOut; i++) {
        const src = srcFaces[i];
        for (let k = 0; k < comps; k++) {
          let s = 0;
          for (const f of src) s += a.data[f * comps + k];
          s /= src.length;
          d[i * comps + k] = a.type === 'BOOLEAN' ? (s >= 0.5 ? 1 : 0) : a.type === 'INT' || a.type === 'INT8' ? Math.round(s) : s;
        }
      }
      attrs.set(name, { domain: 'POINT', type: a.type, data: d });
    } else if (a.domain === 'POINT') {
      const d = allocData(a.type, faceSrc.length);
      faceSrc.forEach((v, i) => {
        for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[v * comps + k];
      });
      attrs.set(name, { domain: 'FACE', type: a.type, data: d });
    }
  }
  return out;
}
