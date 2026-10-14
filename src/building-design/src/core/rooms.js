/**
 * Room boundaries. The outlines of room-bounding walls, columns and room
 * separation lines on a level form a planar arrangement; a room is the
 * smallest face of that arrangement that contains the room's point, minus
 * any islands (free-standing walls or columns) inside it.
 */
import { dist, signedArea, pointInPolygon, segmentIntersect, sub, dot, area as polyArea, centroid, perimeter } from './geom.js';

const SNAP = 0.5;

/**
 * Faces of the arrangement of segments: [{ loop, area }] where bounded faces
 * have positive (counterclockwise) area.
 */
export function arrangementFaces(segments) {
  const segs = segments.filter(([a, b]) => dist(a, b) > SNAP);
  // Grid of segment bounding boxes for intersection candidates.
  const G = 1500;
  const grid = new Map();
  segs.forEach(([a, b], i) => {
    const x0 = Math.floor(Math.min(a[0], b[0]) / G);
    const x1 = Math.floor(Math.max(a[0], b[0]) / G);
    const y0 = Math.floor(Math.min(a[1], b[1]) / G);
    const y1 = Math.floor(Math.max(a[1], b[1]) / G);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  const splits = segs.map(() => [0, 1]);
  const checked = new Set();
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++)
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p];
        const j = list[q];
        const key = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (checked.has(key)) continue;
        checked.add(key);
        const [a, b] = segs[i];
        const [c, d] = segs[j];
        const hit = segmentIntersect(a, b, c, d, 1e-7);
        if (hit) {
          splits[i].push(hit.t);
          splits[j].push(hit.u);
        }
        // Endpoints touching the other segment (T contacts within tolerance).
        touch(splits[i], a, b, c);
        touch(splits[i], a, b, d);
        touch(splits[j], c, d, a);
        touch(splits[j], c, d, b);
      }
  }

  // Vertices with snapping.
  const verts = [];
  const vgrid = new Map();
  const vkey = (x, y) => `${Math.round(x / SNAP)},${Math.round(y / SNAP)}`;
  const vertex = (p) => {
    const rx = Math.round(p[0] / SNAP);
    const ry = Math.round(p[1] / SNAP);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = vgrid.get(`${rx + i},${ry + j}`);
        if (list) for (const v of list) if (dist(verts[v].p, p) <= SNAP) return v;
      }
    const id = verts.length;
    verts.push({ p, out: [] });
    const k = vkey(p[0], p[1]);
    if (!vgrid.has(k)) vgrid.set(k, []);
    vgrid.get(k).push(id);
    return id;
  };
  const edgeSet = new Set();
  const EK = 1 << 24;
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(splits[i].map((t) => Math.max(0, Math.min(1, t))))].sort((x, y) => x - y);
    let prev = vertex(a);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k];
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const v = vertex(p);
      if (v !== prev) {
        const key = prev < v ? prev * EK + v : v * EK + prev;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          verts[prev].out.push(v);
          verts[v].out.push(prev);
        }
      }
      prev = v;
    }
  });

  // Sort outgoing edges by angle.
  for (const v of verts) {
    const angles = new Map(v.out.map((x) => [x, ang(v.p, verts[x].p)]));
    v.out.sort((x, y) => angles.get(x) - angles.get(y));
  }
  const NV = verts.length;
  const visited = new Set();
  const faces = [];
  for (let u = 0; u < verts.length; u++) {
    for (const v0 of verts[u].out) {
      if (visited.has(u * NV + v0)) continue;
      const loop = [];
      let a = u;
      let b = v0;
      let guard = 0;
      while (!visited.has(a * NV + b) && guard++ < 100000) {
        visited.add(a * NV + b);
        loop.push(verts[a].p);
        const out = verts[b].out;
        const k = out.length;
        const i = out.indexOf(a);
        const next = out[(i - 1 + k) % k];
        a = b;
        b = next;
      }
      if (loop.length >= 3) faces.push({ loop, area: signedArea(loop) });
    }
  }
  return faces;
}

function touch(list, a, b, p) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-9) return;
  const t = dot(sub(p, a), ab) / l2;
  if (t <= 0 || t >= 1) return;
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  if (dist(q, p) <= SNAP) list.push(t);
}

function ang(o, p) {
  return Math.atan2(p[1] - o[1], p[0] - o[0]);
}

/**
 * Segments bounding rooms on a level: wall outlines (from the solved walls),
 * hubs, room separators (slightly extended so they close against walls) and
 * column outlines.
 */
export function boundarySegments(doc, solved, levelId, columnOutline) {
  const segs = [];
  for (const g of solved.walls.values()) {
    if (g.wall.roomBounding === false) continue;
    const p = [g.R0, g.R1, g.L1, g.L0];
    for (let i = 0; i < 4; i++) segs.push([p[i], p[(i + 1) % 4]]);
  }
  for (const hub of solved.hubs) for (let i = 0; i < hub.poly.length; i++) segs.push([hub.poly[i], hub.poly[(i + 1) % hub.poly.length]]);
  for (const s of doc.all('roomSeparator')) {
    if (s.levelId !== levelId) continue;
    const d = sub(s.b, s.a);
    const l = Math.hypot(d[0], d[1]);
    if (l < 1) continue;
    const e = [(d[0] / l) * 3, (d[1] / l) * 3];
    segs.push([
      [s.a[0] - e[0], s.a[1] - e[1]],
      [s.b[0] + e[0], s.b[1] + e[1]],
    ]);
  }
  if (columnOutline) {
    for (const c of doc.all('column')) {
      if (c.levelId !== levelId) continue;
      const poly = columnOutline(c);
      for (let i = 0; i < poly.length; i++) segs.push([poly[i], poly[(i + 1) % poly.length]]);
    }
  }
  return segs;
}

const FACE_CELL = 4000;

/** Spatial index of faces by bounding box. */
export function indexFaces(faces) {
  const grid = new Map();
  for (const f of faces) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of f.loop) {
      if (q[0] < x0) x0 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[0] > x1) x1 = q[0];
      if (q[1] > y1) y1 = q[1];
    }
    f.bbox = { x0, y0, x1, y1 };
    const cx0 = Math.floor(x0 / FACE_CELL);
    const cx1 = Math.floor(x1 / FACE_CELL);
    const cy0 = Math.floor(y0 / FACE_CELL);
    const cy1 = Math.floor(y1 / FACE_CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) {
      if (!grid.has('big')) grid.set('big', []);
      grid.get('big').push(f);
      continue;
    }
    for (let x = cx0; x <= cx1; x++)
      for (let y = cy0; y <= cy1; y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(f);
      }
  }
  return grid;
}

function facesNear(grid, faces, box) {
  if (!grid) return faces;
  const out = new Set(grid.get('big') || []);
  const cx0 = Math.floor(box.x0 / FACE_CELL);
  const cx1 = Math.floor(box.x1 / FACE_CELL);
  const cy0 = Math.floor(box.y0 / FACE_CELL);
  const cy1 = Math.floor(box.y1 / FACE_CELL);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) return faces;
  for (let x = cx0; x <= cx1; x++)
    for (let y = cy0; y <= cy1; y++) for (const f of grid.get(`${x},${y}`) || []) out.add(f);
  return out;
}

/** Find the room region containing point p among arrangement faces. */
export function regionAt(faces, p, grid = null) {
  let best = null;
  for (const f of facesNear(grid, faces, { x0: p[0], y0: p[1], x1: p[0], y1: p[1] })) {
    if (f.area <= 1) continue;
    if (f.bbox && (p[0] < f.bbox.x0 || p[0] > f.bbox.x1 || p[1] < f.bbox.y0 || p[1] > f.bbox.y1)) continue;
    if (!pointInPolygon(p, f.loop)) continue;
    if (!best || f.area < best.area) best = f;
  }
  if (!best) return null;
  const holes = [];
  const candidates = best.bbox ? facesNear(grid, faces, best.bbox) : faces;
  for (const f of candidates) {
    if (f.area >= 0) continue;
    // An island's outer cycle inside the room (not the room's own boundary).
    if (Math.abs(f.area) >= best.area) continue;
    const q = f.loop[0];
    if (!pointInPolygon(q, best.loop) || onLoop(q, best.loop)) continue;
    if (pointInPolygon(p, f.loop)) continue;
    holes.push(f.loop.slice().reverse());
  }
  const net = best.area - holes.reduce((s, h) => s + polyArea(h), 0);
  return { outer: best.loop, holes, area: net, perimeter: perimeter(best.loop) + holes.reduce((s, h) => s + perimeter(h), 0), center: centroid(best.loop) };
}

function onLoop(p, loop) {
  return loop.some((q) => dist(p, q) < SNAP * 2);
}

/** Per-level cache of room arrangements. */
export class RoomSolver {
  constructor(doc, walls, columnOutline) {
    this.doc = doc;
    this.walls = walls;
    this.columnOutline = columnOutline;
    this.cache = new Map();
  }

  invalidate(levelId) {
    if (levelId === undefined) this.cache.clear();
    else this.cache.delete(levelId);
  }

  faces(levelId) {
    let f = this.cache.get(levelId);
    if (!f) {
      const segs = boundarySegments(this.doc, this.walls.level(levelId), levelId, this.columnOutline);
      const faces = arrangementFaces(segs);
      f = { faces, grid: indexFaces(faces), rooms: new Map() };
      this.cache.set(levelId, f);
    }
    return f;
  }

  /** Region of a room element (cached per room point). */
  room(room) {
    const f = this.faces(room.levelId);
    const key = `${room.at[0]},${room.at[1]}`;
    if (!f.rooms.has(key)) f.rooms.set(key, regionAt(f.faces, room.at, f.grid));
    return f.rooms.get(key);
  }

  regionAt(levelId, p) {
    const f = this.faces(levelId);
    return regionAt(f.faces, p, f.grid);
  }
}
