import { cross, dot, sub } from '../core/math';
import { position, triangulate, type Topology, type ComponentMode } from './topology';
import { uvElements } from './uv';

export type UVLayoutOperation =
  | { type: 'seams'; mode: ComponentMode; ids: number[]; marked: boolean }
  | { type: 'unwrap'; mode: ComponentMode; ids: number[]; padding: number }
  | { type: 'uv-pack'; mode: ComponentMode; ids: number[]; padding: number };
import { edgeKey, nextCorner, seamEdges, markSeams } from './seams';
export { seamEdges, markSeams } from './seams';
function selectedFaces(t: Topology, ids: number[]) {
  if (!ids.length || ids.some((f) => !Number.isInteger(f) || f < 0 || f >= t.offsets.length - 1))
    throw new Error('Select faces in the 3D view first.');
  return [...new Set(ids)];
}

// Cut corner connectivity at seams, preserving separate copies of a seam vertex.
function charts(t: Topology, ids: number[]) {
  const parent = new Int32Array(t.indices.length).fill(-1);
  const root = (c: number): number => {
    while (parent[c] !== c) {
      parent[c] = parent[parent[c]];
      c = parent[c];
    }
    return c;
  };
  const links = new Map<string, { f: number; a: number; b: number }[]>();
  for (const f of ids)
    for (let c = t.offsets[f]; c < t.offsets[f + 1]; c++) {
      parent[c] = c;
      const b = nextCorner(t, f, c),
        key = edgeKey(t.indices[c], t.indices[b]);
      const entries = links.get(key) ?? [];
      entries.push({ f, a: c, b });
      links.set(key, entries);
    }
  const seams = seamEdges(t),
    neighbors = new Map(ids.map((f) => [f, [] as number[]]));
  for (const [key, entries] of links) {
    if (entries.length > 2) throw new Error('Unwrap requires manifold edges.');
    if (entries.length !== 2 || seams.has(key)) continue;
    const [a, b] = entries;
    if (t.indices[a.a] !== t.indices[b.b])
      throw new Error('Unwrap requires consistently oriented faces.');
    parent[root(a.a)] = root(b.b);
    parent[root(a.b)] = root(b.a);
    neighbors.get(a.f)!.push(b.f);
    neighbors.get(b.f)!.push(a.f);
  }
  const seen = new Set<number>(),
    result: { faces: number[]; nodes: number[]; corners: number[] }[] = [];
  for (const seed of ids) {
    if (seen.has(seed)) continue;
    const fs = [seed];
    seen.add(seed);
    for (let i = 0; i < fs.length; i++)
      for (const f of neighbors.get(fs[i])!)
        if (!seen.has(f)) {
          seen.add(f);
          fs.push(f);
        }
    const corners = fs.flatMap((f) =>
      Array.from({ length: t.offsets[f + 1] - t.offsets[f] }, (_, i) => t.offsets[f] + i),
    );
    result.push({ faces: fs, corners, nodes: corners.map(root) });
  }
  return result;
}

// Least-squares conformal mapping: two fixed boundary vertices remove similarity
// freedom; a preconditioned conjugate-gradient solve keeps storage linear in mesh size.
export function unwrapUV(t: Topology, selection: number[], padding: number, pins?: Map<number, [number, number]>): Topology {
  const ids = selectedFaces(t, selection),
    uvs = t.uvs.slice();
  const islands: number[][] = [];
  for (const chart of charts(t, ids)) {
    const roots = [...new Set(chart.nodes)],
      index = new Map(roots.map((c, i) => [c, i]));
    const cornerNode = new Map(chart.corners.map((c, i) => [c, index.get(chart.nodes[i])!]));
    const n = roots.length,
      links = new Map<string, [number, number, number]>();
    for (const f of chart.faces)
      for (let c = t.offsets[f]; c < t.offsets[f + 1]; c++) {
        const a = cornerNode.get(c)!,
          b = cornerNode.get(nextCorner(t, f, c))!,
          key = edgeKey(a, b);
        const entry = links.get(key);
        if (entry) entry[2]++;
        else links.set(key, [a, b, 1]);
      }
    const boundary = [...links.values()].filter((e) => e[2] === 1);
    const adjacency = new Map<number, number[]>();
    for (const [a, b] of boundary) {
      adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
      adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
    }
    if (
      !boundary.length ||
      [...adjacency.values()].some((a) => a.length !== 2) ||
      n - links.size + chart.faces.length !== 1
    )
      throw new Error(
        'Add seams so each selected chart opens into a disk (no closed shells or holes).',
      );
    const visited = new Set<number>(),
      pending = [boundary[0][0]];
    while (pending.length) {
      const a = pending.pop()!;
      if (visited.has(a)) continue;
      visited.add(a);
      pending.push(...adjacency.get(a)!);
    }
    if (visited.size !== adjacency.size)
      throw new Error('Add seams to connect the chart boundaries.');
    const points = roots.map((c) => position(t, t.indices[c]));
    // user pins (two or more distinct places) are kept exactly and the chart is not repacked
    const pinned = new Map<number, [number, number]>();
    if (pins)
      for (const c of chart.corners) {
        const pin = pins.get(c);
        if (pin) pinned.set(cornerNode.get(c)!, pin);
      }
    let pinSpan = 0;
    for (const a of pinned.values()) for (const b of pinned.values()) pinSpan = Math.max(pinSpan, Math.hypot(a[0] - b[0], a[1] - b[1]));
    const usePins = pinned.size >= 2 && pinSpan > 1e-9;
    const pinA = boundary[0][0];
    let pinB = pinA,
      distance = 0;
    for (const i of adjacency.keys()) {
      const d = Math.hypot(...sub(points[i], points[pinA]));
      if (d > distance) {
        distance = d;
        pinB = i;
      }
    }
    if (distance < 1e-10) throw new Error('Cannot unwrap a chart with zero extent.');
    const fixed = new Map<number, number>();
    if (usePins) {
      for (const [node, [u, v]] of pinned) {
        fixed.set(node * 2, u);
        fixed.set(node * 2 + 1, v);
      }
      distance = pinSpan;
    } else {
      fixed.set(pinA * 2, 0);
      fixed.set(pinA * 2 + 1, 0);
      fixed.set(pinB * 2, distance);
      fixed.set(pinB * 2 + 1, 0);
    }
    const free = new Int32Array(n * 2).fill(-1);
    let size = 0;
    for (let i = 0; i < free.length; i++) if (!fixed.has(i)) free[i] = size++;
    const rows: { ids: number[]; values: number[]; rhs: number }[] = [];
    const triangles: number[][] = [];
    for (const f of chart.faces) {
      const start = t.offsets[f],
        ps = Array.from(t.indices.subarray(start, t.offsets[f + 1]), (v) => position(t, v));
      const tris = triangulate(ps);
      for (let j = 0; j < tris.length; j += 3) {
        const ns = tris.slice(j, j + 3).map((c) => cornerNode.get(start + c)!);
        triangles.push(ns);
        const [a, b, c] = ns.map((i) => points[i]),
          ab = sub(b, a),
          ac = sub(c, a);
        const length = Math.hypot(...ab),
          twiceArea = Math.hypot(...cross(ab, ac));
        if (length < 1e-12 || twiceArea < 1e-12)
          throw new Error('Remove degenerate faces before unwrapping.');
        const x = dot(ab, ac) / length,
          y = twiceArea / length,
          w = 1 / Math.sqrt(twiceArea);
        const gx = [-y, y, 0],
          gy = [x - length, -x, length];
        for (let axis = 0; axis < 2; axis++) {
          const row = { ids: [] as number[], values: [] as number[], rhs: 0 };
          for (let k = 0; k < 3; k++)
            for (let uv = 0; uv < 2; uv++) {
              const variable = ns[k] * 2 + uv,
                coefficient =
                  w * (axis === 0 ? (uv === 0 ? gx[k] : -gy[k]) : uv === 0 ? gy[k] : gx[k]);
              if (fixed.has(variable)) row.rhs -= coefficient * fixed.get(variable)!;
              else {
                row.ids.push(free[variable]);
                row.values.push(coefficient);
              }
            }
          rows.push(row);
        }
      }
    }
    const rhs = new Float64Array(size),
      diagonal = new Float64Array(size);
    for (const row of rows)
      row.ids.forEach((id, j) => {
        rhs[id] += row.values[j] * row.rhs;
        diagonal[id] += row.values[j] ** 2;
      });
    if (diagonal.some((v) => v < 1e-20))
      throw new Error('Unwrap chart is singular; add more seams.');
    const multiply = (input: Float64Array, output: Float64Array) => {
      output.fill(0);
      for (const row of rows) {
        let value = 0;
        row.ids.forEach((id, j) => {
          value += input[id] * row.values[j];
        });
        row.ids.forEach((id, j) => {
          output[id] += value * row.values[j];
        });
      }
    };
    const solution = new Float64Array(size),
      r = rhs.slice(),
      z = r.map((v, i) => v / diagonal[i]),
      direction = z.slice(),
      product = new Float64Array(size);
    const inner = (a: Float64Array, b: Float64Array) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    let rz = inner(r, z);
    const tolerance = Math.max(1e-24, inner(rhs, rhs) * 1e-14);
    for (
      let iteration = 0;
      iteration < Math.min(2500, size * 3 + 20) && inner(r, r) > tolerance;
      iteration++
    ) {
      multiply(direction, product);
      const denom = inner(direction, product);
      if (!(denom > 0)) break;
      const alpha = rz / denom;
      for (let i = 0; i < size; i++) {
        solution[i] += alpha * direction[i];
        r[i] -= alpha * product[i];
        z[i] = r[i] / diagonal[i];
      }
      const next = inner(r, z),
        beta = next / rz;
      rz = next;
      for (let i = 0; i < size; i++) direction[i] = z[i] + beta * direction[i];
    }
    if (inner(r, r) > tolerance * 100)
      throw new Error('Unwrap did not converge. Split the chart with more seams.');
    const coordinates = Array.from(free, (id, i) => fixed.get(i) ?? solution[id]);
    let sign = 0;
    for (const [a, b, c] of triangles) {
      const area =
        (coordinates[b * 2] - coordinates[a * 2]) *
          (coordinates[c * 2 + 1] - coordinates[a * 2 + 1]) -
        (coordinates[b * 2 + 1] - coordinates[a * 2 + 1]) *
          (coordinates[c * 2] - coordinates[a * 2]);
      if (!Number.isFinite(area)) throw new Error('Unwrap folded or collapsed a face. Add more seams and retry.');
      // pins may legitimately force folds; only free solves are checked
      if (!usePins && (Math.abs(area) < distance * distance * 1e-12 || (sign && Math.sign(area) !== sign)))
        throw new Error('Unwrap folded or collapsed a face. Add more seams and retry.');
      sign = Math.sign(area);
    }
    chart.corners.forEach((c) => {
      const i = cornerNode.get(c)!;
      uvs[c * 2] = coordinates[i * 2];
      uvs[c * 2 + 1] = coordinates[i * 2 + 1];
    });
    if (!usePins) islands.push(chart.corners);
  }
  return islands.length ? packCharts({ ...t, uvs }, islands, padding) : { ...t, uvs };
}

export function packUV(t: Topology, selection: number[], padding: number): Topology {
  const chosen = new Set(selectedFaces(t, selection));
  const islands = uvElements(t, 'island').filter((island) =>
    island.faces.some((f) => chosen.has(f)),
  );
  if (islands.some((island) => island.faces.some((f) => !chosen.has(f))))
    throw new Error('Select complete UV islands in the 3D view before packing.');
  return packCharts(
    t,
    islands.map((island) => island.corners),
    padding,
  );
}
function packCharts(t: Topology, islands: number[][], padding: number): Topology {
  if (!Number.isFinite(padding) || padding < 0.001 || padding > 0.1)
    throw new Error('UV padding must be between 0.001 and 0.1.');
  const faceOf = new Int32Array(t.indices.length);
  for (let f = 0; f < t.offsets.length - 1; f++) faceOf.fill(f, t.offsets[f], t.offsets[f + 1]);
  const boxes = islands
    .map((corners) => {
      let surface = 0,
        area = 0,
        minU = Infinity,
        minV = Infinity,
        maxU = -Infinity,
        maxV = -Infinity;
      for (const f of new Set(corners.map((c) => faceOf[c]))) {
        const start = t.offsets[f],
          ps = Array.from(t.indices.subarray(start, t.offsets[f + 1]), (v) => position(t, v)),
          triangles = triangulate(ps);
        for (let i = 0; i < triangles.length; i += 3) {
          const [a, b, c] = triangles.slice(i, i + 3);
          surface += Math.hypot(...cross(sub(ps[b], ps[a]), sub(ps[c], ps[a]))) / 2;
          const u = (v: number) => t.uvs[(start + v) * 2],
            v = (v: number) => t.uvs[(start + v) * 2 + 1];
          area += Math.abs((u(b) - u(a)) * (v(c) - v(a)) - (v(b) - v(a)) * (u(c) - u(a))) / 2;
        }
      }
      if (surface < 1e-16 || area < 1e-16)
        throw new Error('Unwrap zero-area islands before packing.');
      const density = Math.sqrt(surface / area);
      for (const c of corners) {
        minU = Math.min(minU, t.uvs[c * 2]);
        maxU = Math.max(maxU, t.uvs[c * 2]);
        minV = Math.min(minV, t.uvs[c * 2 + 1]);
        maxV = Math.max(maxV, t.uvs[c * 2 + 1]);
      }
      return {
        corners,
        minU,
        minV,
        density,
        width: (maxU - minU) * density,
        height: (maxV - minV) * density,
        x: 0,
        y: 0,
      };
    })
    .sort((a, b) => b.height - a.height);
  const fit = (scale: number) => {
    let x = padding,
      y = padding,
      row = 0;
    for (const b of boxes) {
      const w = b.width * scale,
        h = b.height * scale;
      if (x + w + padding > 1) {
        x = padding;
        y += row + padding;
        row = 0;
      }
      if (x + w + padding > 1 || y + h + padding > 1) return false;
      b.x = x;
      b.y = y;
      x += w + padding;
      row = Math.max(row, h);
    }
    return true;
  };
  if (!fit(0)) throw new Error('Too many islands for this padding. Reduce padding.');
  let low = 0,
    high = 1 / Math.max(...boxes.map((b) => Math.max(b.width, b.height)));
  for (let i = 0; i < 48; i++) {
    const middle = (low + high) / 2;
    if (fit(middle)) low = middle;
    else high = middle;
  }
  if (low < 1e-12) throw new Error('Too many islands for this padding. Reduce padding.');
  fit(low);
  const uvs = t.uvs.slice();
  for (const b of boxes)
    for (const c of b.corners) {
      uvs[c * 2] = b.x + (t.uvs[c * 2] - b.minU) * b.density * low;
      uvs[c * 2 + 1] = b.y + (t.uvs[c * 2 + 1] - b.minV) * b.density * low;
    }
  return { ...t, uvs };
}
export function layoutUV(t: Topology, op: UVLayoutOperation) {
  if (op.type === 'seams') {
    if (op.mode !== 'edge') throw new Error('Switch to Edge selection to mark seams.');
    return {
      topology: markSeams(t, op.ids, op.marked),
      ids: op.ids,
      mode: op.mode,
    };
  }
  if (op.mode !== 'face') throw new Error('Switch to Face selection to unwrap or pack.');
  return {
    topology:
      op.type === 'unwrap' ? unwrapUV(t, op.ids, op.padding) : packUV(t, op.ids, op.padding),
    ids: op.ids,
    mode: op.mode,
  };
}
