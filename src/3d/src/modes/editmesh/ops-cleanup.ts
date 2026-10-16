// Clean Up and dissolve tools: limited/degenerate dissolve, decimate, make planar, split non-planar
// and concave faces, fill holes, collapse edges, delete edge loops, un-subdivide.
import { Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { withEdit } from './context';
import { editPoll, mergeVerts } from './ops-basic';
import { symmetrizeMesh } from './symmetrize';
import { V, faceEdgeKeys, dissolveEdgeSet, dissolveCollinearVerts, splitFace, triangulateCorners, subFace, trisToQuads, removeCorner, dissolveVertex } from './geom';

// ---------------------------------------------------------------------------
// limited dissolve

export interface LimitedDissolveOptions {
  angle: number;
  boundaries?: boolean;
  delimit?: string[];
}

/**
 * Merge selected faces across selected edges flatter than `angle`, then drop vertices on straight
 * runs. Edges are taken flattest first; after each merge the angles of the merged face's edges are
 * measured again against its new (area weighted) normal, so a slowly curving surface stops growing.
 */
export function dissolveLimited(m: MeshEdit, o: LimitedDissolveOptions): boolean {
  const delimit = new Set(o.delimit ?? ['NORMAL']);
  const ef = m.edgeFaces();
  const fsel = new Set(m.selectedFaces());
  const limit = o.angle + 1e-6;
  // candidate edges and the faces they join
  const cands: { k: string; fa: number; fb: number }[] = [];
  for (const [k, l] of ef) {
    if (l.length !== 2) continue;
    const [a, b] = k.split(':').map(Number);
    if (!m.sel[a] || !m.sel[b] || m.hide[a] || m.hide[b]) continue;
    const [fa, ca] = l[0],
      [fb, cb] = l[1];
    if (fa === fb || (!fsel.has(fa) && !fsel.has(fb))) continue;
    const A = m.faces[fa],
      B = m.faces[fb];
    if (delimit.has('MATERIAL') && A.material !== B.material) continue;
    if (delimit.has('SEAM') && (A.seams[ca] || B.seams[cb])) continue;
    if (delimit.has('SHARP') && (A.sharp[ca] || B.sharp[cb])) continue;
    if (delimit.has('UV')) {
      const uvA = [A.uvs[ca * 2], A.uvs[ca * 2 + 1], A.uvs[((ca + 1) % A.verts.length) * 2], A.uvs[((ca + 1) % A.verts.length) * 2 + 1]];
      const jb = (cb + 1) % B.verts.length;
      const uvB = [B.uvs[jb * 2], B.uvs[jb * 2 + 1], B.uvs[cb * 2], B.uvs[cb * 2 + 1]];
      if (uvA.some((x, i) => Math.abs(x - uvB[i]) > 1e-5)) continue;
    }
    // NORMAL delimit: don't merge faces whose winding disagrees
    if (delimit.has('NORMAL') && A.verts[(ca + 1) % A.verts.length] === B.verts[(cb + 1) % B.verts.length]) continue;
    cands.push({ k, fa, fb });
  }
  // regions of merged faces with their summed (area weighted) normal
  const parent = m.faces.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const sum = m.faces.map((f) => {
    const n = new Vector3();
    const p0 = V(m.p(f.verts[0]));
    for (let i = 1; i < f.verts.length - 1; i++) n.add(V(m.p(f.verts[i])).sub(p0).cross(V(m.p(f.verts[i + 1])).sub(p0)));
    return n;
  });
  const regionEdges = new Map<number, number[]>(); // region root -> candidate indices on its outline
  cands.forEach((c, i) => {
    for (const f of [c.fa, c.fb]) (regionEdges.get(f) ?? regionEdges.set(f, []).get(f)!).push(i);
  });
  // binary heap of [angle, candidate, stamp]; stale entries are skipped
  const stamp = new Int32Array(cands.length);
  const heap: [number, number, number][] = [];
  const push = (e: [number, number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  const angleOf = (c: { fa: number; fb: number }) => {
    const ra = find(c.fa),
      rb = find(c.fb);
    return ra === rb ? 0 : sum[ra].angleTo(sum[rb]);
  };
  cands.forEach((c, i) => {
    const a = angleOf(c);
    if (a <= limit) push([a, i, 0]);
  });
  const accepted: string[] = [];
  const taken = new Uint8Array(cands.length);
  while (heap.length) {
    const [, i, st] = pop();
    if (st !== stamp[i] || taken[i]) continue;
    const c = cands[i];
    const ra = find(c.fa),
      rb = find(c.fb);
    taken[i] = 1;
    accepted.push(c.k);
    if (ra === rb) continue;
    if (sum[ra].angleTo(sum[rb]) > limit) {
      taken[i] = 0;
      accepted.pop();
      continue;
    }
    parent[rb] = ra;
    sum[ra].add(sum[rb]);
    const list = [...(regionEdges.get(ra) ?? []), ...(regionEdges.get(rb) ?? [])];
    regionEdges.set(ra, list);
    // the merged face's outline edges get a fresh angle
    for (const j of list) {
      if (taken[j]) continue;
      stamp[j]++;
      const a = angleOf(cands[j]);
      if (a <= limit) push([a, j, stamp[j]]);
    }
  }
  const n = dissolveEdgeSet(m, accepted);
  // vertices left between two edges: straight ones go; open borders go entirely with `boundaries`
  const sel = new Set(m.selectedVerts());
  let removed = 0;
  if (o.boundaries) {
    const border = new Set<number>();
    for (const [k, l] of m.edgeFaces()) if (l.length === 1) k.split(':').forEach((x) => border.add(Number(x)));
    const forced = new Set([...sel].filter((v) => border.has(v)));
    removed += dissolveCollinearVerts(m, forced, Math.PI);
    sel.clear();
    for (const v of m.selectedVerts()) sel.add(v);
  }
  removed += dissolveCollinearVerts(m, sel, Math.max(o.angle, 1e-3));
  return n + removed > 0;
}

// ---------------------------------------------------------------------------
// degenerate dissolve

/** Collapse edges shorter than `threshold` and drop faces that became degenerate. */
export function dissolveDegenerate(m: MeshEdit, threshold: number): number {
  const parent = Array.from({ length: m.vcount }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  let n = 0;
  for (const [a, b] of m.selectedEdges()) {
    if (V(m.p(a)).distanceTo(V(m.p(b))) > threshold) continue;
    const ra = find(a),
      rb = find(b);
    if (ra === rb) continue;
    parent[rb] = ra;
    n++;
  }
  const map = parent.map((_, i) => find(i));
  const before = m.faces.length;
  if (n) m.remap(map);
  // zero-area faces
  const fsel = new Set(m.selectedFaces());
  const keep: EFace[] = [];
  m.faces.forEach((f, i) => {
    if (fsel.has(i) && V(m.faceNormal(f)).lengthSq() === 0 && polyArea(m, f) < threshold * threshold) return;
    keep.push(f);
  });
  m.faces = keep;
  return n + (before - m.faces.length);
}

function polyArea(m: MeshEdit, f: EFace) {
  const n = new Vector3();
  const p0 = V(m.p(f.verts[0]));
  for (let i = 1; i < f.verts.length - 1; i++) n.add(V(m.p(f.verts[i])).sub(p0).cross(V(m.p(f.verts[i + 1])).sub(p0)));
  return n.length() / 2;
}

// ---------------------------------------------------------------------------
// make planar

export function makePlanar(m: MeshEdit, factor: number, repeat: number) {
  const faces = m.selectedFaces();
  if (!faces.length) return false;
  for (let it = 0; it < repeat; it++) {
    const acc = new Map<number, { p: Vector3; n: number }>();
    for (const fi of faces) {
      const f = m.faces[fi];
      const c = V(m.faceCenter(f)),
        nrm = V(m.faceNormal(f));
      for (const v of f.verts) {
        const p = V(m.p(v));
        const proj = p.clone().addScaledVector(nrm, -p.clone().sub(c).dot(nrm));
        const a = acc.get(v);
        if (a) {
          a.p.add(proj);
          a.n++;
        } else acc.set(v, { p: proj, n: 1 });
      }
    }
    for (const [v, a] of acc) {
      if (m.hide[v]) continue;
      const target = a.p.multiplyScalar(1 / a.n);
      const p = V(m.p(v)).lerp(target, factor);
      m.setP(v, [p.x, p.y, p.z]);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// split non-planar / concave faces

/** Largest angle between a corner's triangle normal and the face normal. */
function nonPlanarity(m: MeshEdit, verts: number[]): number {
  if (verts.length < 4) return 0;
  const n = new Vector3();
  const pts = verts.map((v) => V(m.p(v)));
  for (let i = 0; i < pts.length; i++) n.add(pts[i].clone().cross(pts[(i + 1) % pts.length]));
  if (n.lengthSq() < 1e-20) return 0;
  n.normalize();
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length],
      b = pts[i],
      c = pts[(i + 1) % pts.length];
    const t = b.clone().sub(a).cross(c.clone().sub(b));
    if (t.lengthSq() < 1e-20) continue;
    worst = Math.max(worst, t.normalize().angleTo(n));
  }
  return worst;
}

export function splitNonPlanar(m: MeshEdit, limit: number): number {
  let splits = 0;
  const queue = m.selectedFaces();
  while (queue.length) {
    const fi = queue.pop()!;
    const f = m.faces[fi];
    const n = f.verts.length;
    if (n < 4 || nonPlanarity(m, f.verts) <= limit) continue;
    let best: [number, number] | null = null,
      bestScore = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = f.verts.slice(i, j + 1),
          b = [...f.verts.slice(j), ...f.verts.slice(0, i + 1)];
        const score = Math.max(nonPlanarity(m, a), nonPlanarity(m, b));
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = [i, j];
        }
      }
    if (!best) continue;
    const nf = splitFace(m, fi, best[0], best[1]);
    splits++;
    queue.push(fi, nf);
  }
  return splits;
}

function isConvex(m: MeshEdit, verts: number[], normal: Vector3) {
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = V(m.p(verts[(i + n - 1) % n])),
      b = V(m.p(verts[i])),
      c = V(m.p(verts[(i + 1) % n]));
    if (b.clone().sub(a).cross(c.clone().sub(b)).dot(normal) < -1e-9) return false;
  }
  return true;
}

/** Split concave faces into convex parts (triangulate, then merge triangles back while convex). */
export function splitConcave(m: MeshEdit): number {
  let count = 0;
  const out: EFace[] = [];
  const fsel = new Set(m.selectedFaces());
  m.faces.forEach((f, fi) => {
    const normal = V(m.faceNormal(f));
    if (!fsel.has(fi) || f.verts.length < 4 || isConvex(m, f.verts, normal)) return out.push(f);
    // corner lists of each part
    let parts = triangulateCorners(m, f).map((t) => [...t]);
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) {
          const A = parts[i],
            B = parts[j];
          // shared diagonal x→y in A appears as y→x in B
          for (let s = 0; s < A.length; s++) {
            const x = A[s],
              y = A[(s + 1) % A.length];
            const t = B.indexOf(y);
            if (t < 0 || B[(t + 1) % B.length] !== x) continue;
            const joined = [...A.slice(s + 1), ...A.slice(0, s + 1)].slice(0, A.length - 1);
            // joined: y … (corner before x) ; then x … from B after x back to before y
            const fromB: number[] = [];
            for (let k = 1; k < B.length; k++) fromB.push(B[(t + 1 + k - 1) % B.length]);
            const poly = [...joined, ...fromB];
            if (new Set(poly).size !== poly.length) continue;
            if (!isConvex(m, poly.map((c) => f.verts[c]), normal)) continue;
            parts[i] = poly;
            parts.splice(j, 1);
            merged = true;
            break outer;
          }
        }
    }
    parts = parts.map((p) => p);
    for (const p of parts) out.push(subFace(m, f, p));
    count++;
  });
  m.faces = out;
  return count;
}

// ---------------------------------------------------------------------------
// fill holes

/** Fill boundary loops whose vertices are all selected and that have at most `sides` edges (0 = any). */
export function fillHoles(m: MeshEdit, sides: number): number {
  const ef = m.edgeFaces();
  // directed boundary edges, reversed so the new face winds against its neighbours
  const next = new Map<number, number[]>();
  for (const [k, l] of ef) {
    if (l.length !== 1) continue;
    const [fi, ci] = l[0];
    const f = m.faces[fi];
    const a = f.verts[ci],
      b = f.verts[(ci + 1) % f.verts.length];
    if (!m.sel[a] || !m.sel[b]) continue;
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
    void k;
  }
  const used = new Set<string>();
  let filled = 0;
  for (const start of next.keys()) {
    for (const first of next.get(start)!) {
      if (used.has(`${start}>${first}`)) continue;
      const loop = [start];
      let cur = first,
        prev = start,
        ok = true;
      const local = new Set([`${start}>${first}`]);
      while (cur !== start) {
        loop.push(cur);
        const outs = (next.get(cur) ?? []).filter((x) => !used.has(`${cur}>${x}`) && !local.has(`${cur}>${x}`));
        if (!outs.length || loop.length > m.vcount) {
          ok = false;
          break;
        }
        const nx = outs[0];
        local.add(`${cur}>${nx}`);
        prev = cur;
        cur = nx;
      }
      void prev;
      if (!ok || loop.length < 3) continue;
      for (const e of local) used.add(e);
      if (sides > 0 && loop.length > sides) continue;
      const tmpl = m.faces[ef.get(edgeKey(loop[0], loop[1]))![0][0]];
      m.faces.push(m.makeFace(loop, tmpl));
      filled++;
    }
  }
  return filled;
}

// ---------------------------------------------------------------------------
// collapse / delete edge loop

/** Collapse each connected group of selected edges (and faces) into its centre point. */
export function collapseEdges(m: MeshEdit): number {
  const edges = m.selectedEdges();
  if (!edges.length) return 0;
  const parent = Array.from({ length: m.vcount }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const [a, b] of edges) parent[find(b)] = find(a);
  const groups = new Map<number, number[]>();
  for (const [a, b] of edges)
    for (const v of [a, b]) {
      const r = find(v);
      const g = groups.get(r) ?? groups.set(r, []).get(r)!;
      if (!g.includes(v)) g.push(v);
    }
  const list = [...groups.values()];
  const pos = list.map((g) => {
    const c = new Vector3();
    for (const v of g) c.add(V(m.p(v)));
    return c.multiplyScalar(1 / g.length);
  });
  mergeVerts(m, list, pos);
  return list.length;
}

/** Dissolve the selected edge loops and the vertices they leave on straight runs. */
export function deleteEdgeLoops(m: MeshEdit): boolean {
  const edges = m.selectedEdges();
  if (!edges.length) return false;
  const verts = new Set(edges.flat());
  const n = dissolveEdgeSet(m, edges.map(([a, b]) => edgeKey(a, b)));
  // 2-valence vertices that were on the loop
  const nb = m.neighbors();
  for (const v of verts) {
    if (nb[v]?.length !== 2) continue;
    for (const f of m.faces) {
      const i = f.verts.indexOf(v);
      if (i >= 0 && f.verts.length > 3) removeCorner(f, i);
    }
  }
  m.compact();
  return n > 0;
}

// ---------------------------------------------------------------------------
// un-subdivide

/**
 * One un-subdivide step on the selected faces. Vertices are coloured alternately across the edge
 * graph, anchored at the irregular vertices (interior vertices not joined to four edges), or at the
 * first regular vertex when there are none; regular vertices of the second colour (four edges
 * inside, three on an open border) are dissolved, after splitting each quad along its diagonal
 * between kept corners. Two steps undo one level of grid subdivision.
 */
export function unsubdivideStep(m: MeshEdit): boolean {
  const fsel = m.selectedFaces();
  if (!fsel.length) return false;
  const selFaces = new Set(fsel);
  const ef = m.edgeFaces();
  const region = new Set<number>();
  for (const fi of fsel) for (const v of m.faces[fi].verts) region.add(v);
  // edges of the selected faces and their use count
  const adj = new Map<number, Set<number>>();
  /** colours spread only across edges between two faces */
  const inner = new Map<number, number[]>();
  const border = new Set<number>();
  for (const [k, l] of ef) {
    const inSel = l.filter(([fi]) => selFaces.has(fi)).length;
    if (!inSel) continue;
    const [a, b] = k.split(':').map(Number);
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
    if (inSel === 1 || l.length === 1) border.add(a).add(b);
    else {
      (inner.get(a) ?? inner.set(a, []).get(a)!).push(b);
      (inner.get(b) ?? inner.set(b, []).get(b)!).push(a);
    }
  }
  const valence = (v: number) => adj.get(v)?.size ?? 0;
  const regular = (v: number) => (border.has(v) ? valence(v) === 3 : valence(v) === 4);
  const sorted = [...region].sort((x, y) => x - y);
  let seeds = sorted.filter((v) => !border.has(v) && valence(v) !== 4);
  if (!seeds.length) seeds = sorted.filter(regular).slice(0, 1);
  if (!seeds.length) return false;
  const color = new Map<number, number>();
  const queue: number[] = [];
  for (const s of seeds)
    if (!color.has(s)) {
      color.set(s, 0);
      queue.push(s);
    }
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const w of inner.get(u) ?? []) {
      if (color.has(w)) continue;
      color.set(w, 1 - color.get(u)!);
      queue.push(w);
    }
  }
  const remove = new Set(sorted.filter((v) => color.get(v) === 1 && regular(v)));
  if (!remove.size) return false;
  // split quads with removed corners along the diagonal between their kept corners
  for (const fi of fsel) {
    const f = m.faces[fi];
    if (f.verts.length !== 4) continue;
    const k = f.verts.findIndex((v) => remove.has(v));
    if (k < 0 || remove.has(f.verts[(k + 1) % 4]) || remove.has(f.verts[(k + 3) % 4])) continue;
    splitFace(m, fi, (k + 1) % 4, (k + 3) % 4);
  }
  // each removed vertex's fan becomes one face
  let n = 0;
  for (const v of remove) if (dissolveVertex(m, v)) n++;
  if (n) m.compact();
  return n > 0;
}

// ---------------------------------------------------------------------------
// decimate (quadric edge collapse on the selected triangles; region borders are locked)

export function decimate(m: MeshEdit, ratio: number, opts: { weights?: number[]; symmetryAxis?: number; lockPlane?: number } = {}): boolean {
  if (opts.symmetryAxis !== undefined && opts.symmetryAxis >= 0) {
    // symmetric: drop the selected negative half, reduce the rest (vertices on the mirror plane stay there), mirror it back
    const ax = opts.symmetryAxis;
    const eps = 1e-5;
    if (ratio >= 1) return false;
    m.faces = m.faces.filter((f) => !(m.isFaceSelected(f) && f.verts.every((v) => m.pos[v * 3 + ax] < eps) && f.verts.some((v) => m.pos[v * 3 + ax] < -eps)));
    const map = m.compact();
    let weights = opts.weights;
    if (weights) {
      const w = new Array<number>(m.vcount).fill(0);
      map.forEach((nv, ov) => nv >= 0 && (w[nv] = weights![ov] ?? 0));
      weights = w;
    }
    decimate(m, ratio, { weights, lockPlane: ax });
    return symmetrizeMesh(m, ax, false, eps);
  }
  const fsel = m.selectedFaces();
  if (!fsel.length || ratio >= 1) return false;
  const selSet = new Set(fsel);
  const selFaceSizes = new Map(fsel.map((fi) => [fi, m.faces[fi].verts.length]));
  // triangulate the selected faces
  const tris: number[] = [];
  const triSrc: number[] = [];
  const triCorners: number[] = [];
  for (const fi of fsel) {
    const f = m.faces[fi];
    for (const t of triangulateCorners(m, f)) {
      tris.push(f.verts[t[0]], f.verts[t[1]], f.verts[t[2]]);
      triCorners.push(...t);
      triSrc.push(fi);
    }
  }
  const nt = tris.length / 3;
  const target = Math.max(1, Math.round(nt * ratio));
  // locked: vertices used by unselected faces or loose edges
  const locked = new Uint8Array(m.vcount);
  m.faces.forEach((f, i) => {
    if (!selSet.has(i)) for (const v of f.verts) locked[v] = 1;
  });
  for (const [a, b] of m.looseEdges) locked[a] = locked[b] = 1;
  if (opts.lockPlane !== undefined) for (let v = 0; v < m.vcount; v++) if (Math.abs(m.pos[v * 3 + opts.lockPlane]) < 1e-5) locked[v] = 1;
  const P = m.pos;
  const Q = new Float64Array(m.vcount * 10);
  const addPlane = (v: number, n: Vector3, d: number, w: number) => {
    const q = [n.x * n.x, n.x * n.y, n.x * n.z, n.x * d, n.y * n.y, n.y * n.z, n.y * d, n.z * n.z, n.z * d, d * d];
    for (let i = 0; i < 10; i++) Q[v * 10 + i] += q[i] * w;
  };
  const edgeUse = new Map<string, number>();
  for (let t = 0; t < nt; t++) {
    const a = V(m.p(tris[t * 3])),
      b = V(m.p(tris[t * 3 + 1])),
      c = V(m.p(tris[t * 3 + 2]));
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const area = n.length();
    if (area < 1e-20) continue;
    n.multiplyScalar(1 / area);
    for (let k = 0; k < 3; k++) addPlane(tris[t * 3 + k], n, -n.dot(a), area);
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(tris[t * 3 + k], tris[t * 3 + ((k + 1) % 3)]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  // border edges get perpendicular constraint planes so the outline is preserved
  for (let t = 0; t < nt; t++) {
    const a = V(m.p(tris[t * 3])),
      b = V(m.p(tris[t * 3 + 1])),
      c = V(m.p(tris[t * 3 + 2]));
    const fn = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    for (let k = 0; k < 3; k++) {
      const x = tris[t * 3 + k],
        y = tris[t * 3 + ((k + 1) % 3)];
      if (edgeUse.get(edgeKey(x, y)) !== 1) continue;
      const px = V(m.p(x));
      const e = V(m.p(y)).sub(px);
      const n = e.clone().cross(fn).normalize();
      // heavy enough that corners of the outline outlast any interior collapse
      addPlane(x, n, -n.dot(px), 1e4 * e.lengthSq());
      addPlane(y, n, -n.dot(px), 1e4 * e.lengthSq());
    }
  }
  const err = (q: Float64Array, x: number, y: number, z: number) => q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  const parent = Int32Array.from({ length: m.vcount }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  const vt: number[][] = Array.from({ length: m.vcount }, () => []);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vt[tris[t * 3 + k]].push(t);
  const alive = new Uint8Array(nt).fill(1);
  let live = nt;
  const weight = (v: number) => (opts.weights ? 1 + 4 * (opts.weights[v] ?? 0) : 1);
  const ver = new Int32Array(m.vcount);
  type Cand = { a: number; b: number; cost: number; p: number[]; va: number; vb: number };
  const evalEdge = (a: number, b: number): Cand | null => {
    if (locked[a] && locked[b]) return null;
    const q = new Float64Array(10);
    for (let i = 0; i < 10; i++) q[i] = Q[a * 10 + i] + Q[b * 10 + i];
    const pa = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]],
      pb = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
    const opts2 = locked[a] ? [pa] : locked[b] ? [pb] : [pa, pb, pa.map((x, i) => (x + pb[i]) / 2)];
    if (!locked[a] && !locked[b]) {
      // the point of least error, when the quadric pins one down near the edge
      const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
      const scale = Math.abs(q[0] * q[4] * q[7]) + 1e-30;
      if (Math.abs(det) > 1e-6 * scale) {
        const bx = -q[3],
          by = -q[6],
          bz = -q[8];
        const x = (bx * (q[4] * q[7] - q[5] * q[5]) - q[1] * (by * q[7] - q[5] * bz) + q[2] * (by * q[5] - q[4] * bz)) / det;
        const y = (q[0] * (by * q[7] - q[5] * bz) - bx * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * bz - by * q[2])) / det;
        const z = (q[0] * (q[4] * bz - by * q[5]) - q[1] * (q[1] * bz - by * q[2]) + bx * (q[1] * q[5] - q[4] * q[2])) / det;
        const o = [x, y, z];
        const len = V(pa).distanceTo(V(pb));
        if (o.every(Number.isFinite) && V(o).distanceTo(V(pa).lerp(V(pb), 0.5)) <= len) opts2.push(o);
      }
    }
    let best = opts2[0],
      bc = Infinity;
    for (const o of opts2) {
      const c = err(q, o[0], o[1], o[2]);
      if (c < bc) {
        bc = c;
        best = o;
      }
    }
    return { a, b, cost: Math.max(0, bc) * weight(a) * weight(b) + V(pa).distanceToSquared(V(pb)) * 1e-9, p: best, va: ver[a], vb: ver[b] };
  };
  const heap: Cand[] = [];
  const push = (c: Cand | null) => {
    if (!c) return;
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= heap[i].cost) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let s = i;
        if (l < heap.length && heap[l].cost < heap[s].cost) s = l;
        if (r < heap.length && heap[r].cost < heap[s].cost) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  for (const k of edgeUse.keys()) {
    const [a, b] = k.split(':').map(Number);
    push(evalEdge(a, b));
  }
  while (live > target && heap.length) {
    const c = pop();
    const a = find(c.a),
      b = find(c.b);
    if (a === b) continue;
    // an end moved or absorbed a neighbour since this edge was measured: measure again
    if (a !== c.a || b !== c.b || c.va !== ver[a] || c.vb !== ver[b]) {
      push(evalEdge(a, b));
      continue;
    }
    // link condition: the two vertices may share at most two neighbours (keeps the surface manifold)
    const ring = (v: number) => {
      const s = new Set<number>();
      for (const t of vt[v]) if (alive[t]) for (let k = 0; k < 3; k++) s.add(find(tris[t * 3 + k]));
      s.delete(v);
      return s;
    };
    const ra = ring(a),
      rb = ring(b);
    let shared = 0;
    for (const x of ra) if (rb.has(x)) shared++;
    const sharedTris = vt[a].filter((t) => alive[t] && [0, 1, 2].some((k) => find(tris[t * 3 + k]) === b)).length;
    if (shared > sharedTris) continue;
    // reject flips
    const np = V(c.p);
    let bad = false;
    for (const v of [a, b])
      for (const t of vt[v]) {
        if (!alive[t] || bad) continue;
        const vs = [find(tris[t * 3]), find(tris[t * 3 + 1]), find(tris[t * 3 + 2])];
        if (vs.includes(a) && vs.includes(b)) continue;
        const pts = vs.map((x) => V(m.p(x)));
        const after = vs.map((x, i) => (x === a || x === b ? np : pts[i]));
        const n0 = pts[1].clone().sub(pts[0]).cross(pts[2].clone().sub(pts[0]));
        const n1 = after[1].clone().sub(after[0]).cross(after[2].clone().sub(after[0]));
        if (n0.dot(n1) <= 0) bad = true;
      }
    if (bad) continue;
    parent[b] = a;
    m.setP(a, c.p);
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    locked[a] = locked[a] | locked[b];
    if (opts.weights) opts.weights[a] = Math.max(opts.weights[a] ?? 0, opts.weights[b] ?? 0);
    vt[a].push(...vt[b]);
    ver[a]++;
    const around = new Set<number>();
    for (const t of vt[a]) {
      if (!alive[t]) continue;
      const vs = [find(tris[t * 3]), find(tris[t * 3 + 1]), find(tris[t * 3 + 2])];
      if (vs[0] === vs[1] || vs[1] === vs[2] || vs[0] === vs[2]) {
        alive[t] = 0;
        live--;
        continue;
      }
      for (const v of vs) if (v !== a) around.add(v);
    }
    for (const v of around) push(evalEdge(Math.min(a, v) === a ? a : v, Math.min(a, v) === a ? v : a));
  }
  // rebuild: unselected faces unchanged, selected replaced by surviving triangles
  const out: EFace[] = m.faces.filter((_, i) => !selSet.has(i));
  const bySource = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    const src = m.faces[triSrc[t]];
    const cs = [triCorners[t * 3], triCorners[t * 3 + 1], triCorners[t * 3 + 2]];
    const f = subFace(m, src, cs);
    f.verts = f.verts.map(find);
    if (new Set(f.verts).size < 3) continue;
    (bySource.get(triSrc[t]) ?? bySource.set(triSrc[t], []).get(triSrc[t])!).push(out.length);
    out.push(f);
  }
  m.faces = out;
  // a quad whose two triangles both survived becomes a quad again
  const rejoin = new Set<number>();
  for (const [src, tris] of bySource) if (tris.length === 2 && selFaceSizes.get(src) === 4) tris.forEach((t) => rejoin.add(t));
  trisToQuads(m, rejoin, Math.PI);
  m.compact();
  return true;
}

// ---------------------------------------------------------------------------

const angleDeg = (d: number) => (d * Math.PI) / 180;

registerOperators([
  {
    idname: 'mesh.dissolve_limited',
    label: 'Limited Dissolve',
    description: 'Dissolve selected edges and vertices that lie on nearly flat surfaces or straight lines',
    props: [
      { id: 'angle_limit', label: 'Max Angle', type: 'float', default: angleDeg(5), min: 0, max: Math.PI, subtype: 'angle' },
      { id: 'use_dissolve_boundaries', label: 'All Boundaries', type: 'bool', default: false },
      { id: 'delimit', label: 'Delimit', type: 'enum', default: 'NORMAL', items: [['NORMAL', 'Normal'], ['MATERIAL', 'Material'], ['SEAM', 'Seam'], ['SHARP', 'Sharp'], ['UV', 'UVs']] },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const delimit = Array.isArray(p.delimit) ? (p.delimit as string[]) : [p.delimit as string];
      if (!withEdit((m) => dissolveLimited(m, { angle: p.angle_limit as number, boundaries: !!p.use_dissolve_boundaries, delimit }))) return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.dissolve_degenerate',
    label: 'Degenerate Dissolve',
    description: 'Collapse edges shorter than the merge distance and remove faces with no area',
    props: [{ id: 'threshold', label: 'Merge Distance', type: 'float', default: 0.0001, min: 1e-6, max: 50, softMax: 10, subtype: 'distance' }],
    poll: editPoll,
    exec: (_ctx, p) => {
      let n = 0;
      withEdit((m) => {
        const k = dissolveDegenerate(m, p.threshold as number);
        n += k;
        return k > 0;
      });
      app.report('INFO', `Removed ${n} element(s)`);
    },
  },
  {
    idname: 'mesh.decimate',
    label: 'Decimate Geometry',
    description: 'Reduce the number of faces of the selection while keeping its shape',
    props: [
      { id: 'ratio', label: 'Ratio', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
      { id: 'use_vertex_group', label: 'Vertex Group', type: 'bool', default: false },
      { id: 'vertex_group_factor', label: 'Weight', type: 'float', default: 1, min: 0, max: 1000, softMax: 10, showIf: (p) => !!p.use_vertex_group },
      { id: 'invert_vertex_group', label: 'Invert', type: 'bool', default: false, showIf: (p) => !!p.use_vertex_group },
      { id: 'use_symmetry', label: 'Symmetry', type: 'bool', default: false },
      { id: 'symmetry_axis', label: 'Axis', type: 'enum', default: 'Y', items: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], showIf: (p) => !!p.use_symmetry },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const ratio = p.ratio as number;
      if (ratio >= 1) return 'FINISHED';
      withEdit((m, ob) => {
        let weights: number[] | undefined;
        const gi = ob.vertex_group_active_index ?? 0;
        if (p.use_vertex_group && m.weights.length) {
          const w = m.weights[gi >= 0 ? gi : 0] ?? [];
          weights = Array.from({ length: m.vcount }, (_, i) => {
            const x = Math.max(0, Math.min(1, w[i] ?? 0));
            return (p.invert_vertex_group ? 1 - x : x) * (p.vertex_group_factor as number);
          });
        }
        return decimate(m, ratio, { weights, symmetryAxis: p.use_symmetry ? ['X', 'Y', 'Z'].indexOf(p.symmetry_axis as string) : undefined });
      });
    },
  },
  {
    idname: 'mesh.face_make_planar',
    label: 'Make Planar Faces',
    description: 'Flatten the selected faces',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: -10, max: 10, softMin: 0, softMax: 1 },
      { id: 'repeat', label: 'Iterations', type: 'int', default: 1, min: 1, max: 10000, softMax: 200 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => makePlanar(m, p.factor as number, p.repeat as number)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.vert_connect_nonplanar',
    label: 'Split Non-Planar Faces',
    description: 'Split faces that bend more than the angle limit into flatter parts',
    props: [{ id: 'angle_limit', label: 'Max Angle', type: 'float', default: angleDeg(5), min: 0, max: Math.PI, subtype: 'angle' }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => splitNonPlanar(m, p.angle_limit as number) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.vert_connect_concave',
    label: 'Split Concave Faces',
    description: 'Split concave faces into convex parts',
    poll: editPoll,
    exec: () => (withEdit((m) => splitConcave(m) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.fill_holes',
    label: 'Fill Holes',
    description: 'Fill boundary holes whose vertices are selected',
    props: [{ id: 'sides', label: 'Sides', type: 'int', default: 4, min: 0, max: 1000, softMax: 100 }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => fillHoles(m, p.sides as number) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.edge_collapse',
    label: 'Collapse Edges & Faces',
    description: 'Collapse each connected group of selected edges and faces into a single vertex',
    poll: editPoll,
    exec: () => (withEdit((m) => collapseEdges(m) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.delete_edgeloop',
    label: 'Delete Edge Loop',
    description: 'Remove the selected edge loops, joining the faces on both sides',
    props: [{ id: 'use_face_split', label: 'Face Split', type: 'bool', default: true }],
    poll: editPoll,
    exec: () => (withEdit((m) => deleteEdgeLoops(m)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.unsubdivide',
    label: 'Un-Subdivide',
    description: 'Undo grid subdivision of the selected quads',
    props: [{ id: 'iterations', label: 'Iterations', type: 'int', default: 2, min: 1, max: 1000, softMax: 100 }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const ok = withEdit((m) => {
        let any = false;
        for (let i = 0; i < (p.iterations as number); i++) {
          if (!unsubdivideStep(m)) break;
          any = true;
        }
        return any;
      });
      return ok ? 'FINISHED' : 'CANCELLED';
    },
  },
]);

export { dissolveCollinearVerts, faceEdgeKeys };
