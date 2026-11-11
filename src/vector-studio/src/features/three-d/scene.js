/**
 * The 3D pipeline: source shapes -> meshes (cached) -> rotated, culled,
 * depth-ordered, shaded and projected faces -> flat vector shapes.
 *
 *   buildModels(items, fx, opts)  meshes for source items [{ style, subpaths, source }]
 *   renderModels(models, fx, opts) -> { faces, shadow }
 *
 * Faces come out back to front as { rings: [[[x, y], ...]], fill, stroke,
 * strokeWidth, opacity, source } in document space; `shadow` is one set of
 * rings (filled with the nonzero rule) or null.
 *
 * Hidden surfaces: faces of closed solids that turn away from the viewer
 * are dropped; the rest are ordered with a BSP tree (faces that straddle
 * another face's plane are split), or by distance for very large meshes
 * and while dragging (draft).
 */
import { rotationMatrix, rotX, apply3, normalize, dot, sub, newellNormal, lerp3, scale } from './math.js';
import { flattenSubpaths, ringsBounds } from './outline.js';
import { extrudeMesh, revolveMesh, inflateMesh, mirrorX, meshRadius, cornerNormals, faceNormal } from './mesh.js';
import { shade, lightTerms, combine, quantize, rgbOf, hexOf, baseColorOf, brightness } from './shading.js';
import { DETAIL } from './params.js';
import { isGradient } from '../../model/gradients.js';
import { gradientEnds } from '../../model/geometry.js';

/** Hairline overlap (document units) that hides seams between neighboring faces. */
export const SEAM = 0.5;

/** Faces above this count are depth sorted instead of split with a BSP tree. */
export const BSP_LIMIT = 2600;

// ---- meshes ----

const meshCache = new Map();
const MESH_CACHE_SIZE = 24;

/**
 * FNV-style hash of the numbers in subpaths relative to the model's origin
 * (cache key for meshes): meshes are built around the origin, so moving an
 * object reuses its mesh.
 */
function hashSubpaths(subpaths, [x0, y0] = [0, 0]) {
  let h = 2166136261;
  const mix = (v) => {
    h ^= Math.round(v * 64) | 0;
    h = Math.imul(h, 16777619);
  };
  for (const s of subpaths) {
    mix(s.closed ? 7 : 3);
    for (const a of s.anchors) {
      mix(a.x - x0);
      mix(a.y - y0);
      mix((a.ix ?? a.x) - x0);
      mix((a.iy ?? a.y) - y0);
      mix((a.ox ?? a.x) - x0);
      mix((a.oy ?? a.y) - y0);
    }
    mix(-1);
  }
  return (h >>> 0).toString(36);
}

/** The parameters that shape the mesh (everything else only changes the view). */
function meshKey(fx, draft) {
  const k = fx.kind;
  const parts = [k, draft ? 'draft' : fx.detail];
  if (k === 'extrude') parts.push(fx.depth, fx.twist, fx.taper, fx.cap, fx.bevel, fx.bevelWidth, fx.bevelHeight, fx.bevelOut, fx.bevelBack);
  else if (k === 'revolve') parts.push(fx.angle, fx.offset, fx.axis, fx.cap);
  else if (k === 'inflate') parts.push(fx.depth, fx.volume, fx.bothSides);
  return parts.join('|');
}

/** Bounds of all items' outlines (the model's frame). */
export function itemsBounds(items) {
  let b = null;
  for (const it of items) {
    for (const s of it.subpaths) {
      for (const a of s.anchors) {
        for (const [x, y] of [
          [a.x, a.y],
          [a.ix ?? a.x, a.iy ?? a.y],
          [a.ox ?? a.x, a.oy ?? a.y],
        ]) {
          if (!b) b = { x0: x, y0: y, x1: x, y1: y };
          else {
            if (x < b.x0) b.x0 = x;
            if (y < b.y0) b.y0 = y;
            if (x > b.x1) b.x1 = x;
            if (y > b.y1) b.y1 = y;
          }
        }
      }
    }
  }
  return b ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
}

/** A mesh for one item's polylines (model space, origin at `origin`). */
export function buildMesh(polys, fx, origin, opts = {}) {
  const det = opts.draft ? DETAIL.low : DETAIL[fx.detail] || DETAIL.medium;
  const local = polys.map((p) => ({ ...p, pts: p.pts.map((q) => [q[0] - origin[0], q[1] - origin[1]]) }));
  if (fx.kind === 'revolve') {
    const right = fx.axis === 'right';
    const off = Math.max(0, fx.offset || 0);
    // Distances from the axis; the profile keeps its side of the axis.
    const prof = local.map((p) => ({ ...p, pts: p.pts.map((q) => [(right ? -q[0] : q[0]) + off, q[1]]) }));
    const m = revolveMesh(prof, { angle: fx.angle, cap: fx.cap, segments: det.segments });
    return right ? mirrorX(m) : m;
  }
  if (fx.kind === 'inflate') return inflateMesh(local, { depth: fx.depth, volume: fx.volume, bothSides: fx.bothSides, grid: det.grid });
  return extrudeMesh(local, { ...fx, draft: opts.draft });
}

/**
 * Models for source items: { item, mesh, normals, corners, base } with a
 * shared origin (the center of the items' bounds, or for Revolve the axis
 * at its middle height) and radius.
 */
export function buildModels(items, fx, opts = {}) {
  const b = itemsBounds(items);
  if (!b) return null;
  const center = [b.x + b.w / 2, b.y + b.h / 2];
  const axisX = fx.kind === 'revolve' ? (fx.axis === 'right' ? b.x + b.w : b.x) : center[0];
  const origin = [axisX, center[1]];
  const det = opts.draft ? DETAIL.low : DETAIL[fx.detail] || DETAIL.medium;
  const models = [];
  let radius = 0;
  for (const it of items) {
    if (fx.kind === 'rotate') {
      const polys = flattenSubpaths(it.subpaths, det.tolerance * 0.5, { closeOpen: false });
      models.push({ item: it, polys });
      for (const p of polys) for (const q of p.pts) radius = Math.max(radius, Math.hypot(q[0] - origin[0], q[1] - origin[1]));
      continue;
    }
    const key = `${meshKey(fx, opts.draft)}|${it.style?.fill ? 'f' : 'o'}|${hashSubpaths(it.subpaths, origin)}`;
    let entry = meshCache.get(key);
    if (entry) {
      meshCache.delete(key);
      meshCache.set(key, entry);
    } else {
      const polys = flattenSubpaths(it.subpaths, det.tolerance, { closeOpen: Boolean(it.style?.fill) });
      const mesh = buildMesh(polys, fx, origin, opts);
      entry = { mesh, normals: mesh.faces.map((f) => faceNormal(mesh, f)), corners: cornerNormals(mesh), radius: meshRadius(mesh) };
      meshCache.set(key, entry);
      while (meshCache.size > MESH_CACHE_SIZE) meshCache.delete(meshCache.keys().next().value);
    }
    radius = Math.max(radius, entry.radius);
    models.push({ item: it, ...entry });
  }
  return { models, origin, center, radius: Math.max(radius, 1e-3) };
}

/** Forget cached meshes (tests). */
export function clearMeshCache() {
  meshCache.clear();
}

// ---- camera ----

/** Camera for a field of view (degrees; 0 = parallel projection) and model radius. */
export function makeCamera(fov, radius, screen) {
  if (!(fov > 0)) {
    return { eye: null, project: (p) => [screen[0] + p[0], screen[1] + p[1]], viewDir: () => [0, 0, 1] };
  }
  const d = radius * (1.15 + 1 / Math.tan(((Math.min(fov, 170) / 2) * Math.PI) / 180));
  const eye = [0, 0, d];
  return {
    eye,
    project: (p) => {
      const k = d / Math.max(d * 0.02, d - p[2]);
      return [screen[0] + p[0] * k, screen[1] + p[1] * k];
    },
    viewDir: (p) => normalize(sub(eye, p)),
  };
}

// ---- BSP ordering ----

function planeOf(poly) {
  const n = normalize(newellNormal(poly.pts));
  return { n, d: dot(n, centroid(poly.pts)) };
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / pts.length, y / pts.length, z / pts.length];
}

/** Clip one ring (with optional per-corner normals) to the side of a plane where sign*dist >= 0. */
function clipRing(pts, ns, dists, sign) {
  const out = [];
  const outN = ns ? [] : null;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const di = dists[i] * sign;
    const dj = dists[j] * sign;
    if (di >= 0) {
      out.push(pts[i]);
      if (ns) outN.push(ns[i]);
    }
    if ((di > 0 && dj < 0) || (di < 0 && dj > 0)) {
      const t = di / (di - dj);
      out.push(lerp3(pts[i], pts[j], t));
      if (ns) outN.push(normalize(lerp3(ns[i], ns[j], t)));
    }
  }
  return out.length >= 3 ? { pts: out, ns: outN } : null;
}

/** Split a polygon by a plane: { front, back } (either may be null). */
function splitPoly(poly, plane, eps) {
  const side = (pts) => pts.map((p) => dot(plane.n, p) - plane.d).map((d) => (Math.abs(d) < eps ? 0 : d));
  const make = (sign) => {
    const main = clipRing(poly.pts, poly.ns, side(poly.pts), sign);
    if (!main) return null;
    const holes = [];
    for (const h of poly.holes) {
      const c = clipRing(h, null, side(h), sign);
      if (c) holes.push(c.pts);
    }
    return { ...poly, pts: main.pts, ns: main.ns, holes, split: true };
  };
  return { front: make(1), back: make(-1) };
}

function classify(poly, plane, eps) {
  let front = 0;
  let back = 0;
  const visit = (pts) => {
    for (const p of pts) {
      const d = dot(plane.n, p) - plane.d;
      if (d > eps) front++;
      else if (d < -eps) back++;
    }
  };
  visit(poly.pts);
  for (const h of poly.holes) visit(h);
  if (front && back) return 'span';
  if (front) return 'front';
  if (back) return 'back';
  return 'on';
}

function buildBSP(polys, eps) {
  if (!polys.length) return null;
  // Of a few candidates, split with the one that cuts the fewest others.
  let pick = 0;
  // (Only for smaller sets: the search itself costs a pass per candidate.)
  if (polys.length > 2 && polys.length < 400) {
    let best = Infinity;
    const tries = Math.min(5, polys.length);
    for (let t = 0; t < tries; t++) {
      const i = Math.floor((t * polys.length) / tries);
      const pl = polys[i].plane;
      let cuts = 0;
      for (const q of polys) if (q !== polys[i] && classify(q, pl, eps) === 'span') cuts++;
      if (cuts < best) {
        best = cuts;
        pick = i;
        if (!cuts) break;
      }
    }
  }
  const root = polys[pick];
  const node = { plane: root.plane, on: [root], front: null, back: null };
  const front = [];
  const back = [];
  for (const q of polys) {
    if (q === root) continue;
    const c = classify(q, root.plane, eps);
    if (c === 'on') node.on.push(q);
    else if (c === 'front') front.push(q);
    else if (c === 'back') back.push(q);
    else {
      const s = splitPoly(q, root.plane, eps);
      if (s.front) front.push({ ...s.front, plane: q.plane });
      if (s.back) back.push({ ...s.back, plane: q.plane });
    }
  }
  node.front = buildBSP(front, eps);
  node.back = buildBSP(back, eps);
  return node;
}

/** Back-to-front order of a BSP tree for a viewer at `eye` (null: parallel view from +z). */
function walkBSP(node, eye, out) {
  if (!node) return;
  const inFront = eye ? dot(node.plane.n, eye) - node.plane.d > 0 : node.plane.n[2] > 0;
  if (inFront) {
    walkBSP(node.back, eye, out);
    out.push(...node.on);
    walkBSP(node.front, eye, out);
  } else {
    walkBSP(node.front, eye, out);
    out.push(...node.on);
    walkBSP(node.back, eye, out);
  }
}

/**
 * Order world-space polygons back to front. Uses a BSP tree unless there
 * are too many polygons or `draft` is set, then sorts by the distance of
 * each polygon's center from the viewer.
 */
export function orderPolys(polys, eye, { draft = false, eps = 1e-6 } = {}) {
  if (!draft && polys.length <= BSP_LIMIT) {
    for (const p of polys) p.plane = planeOf(p);
    const out = [];
    walkBSP(buildBSP(polys, eps), eye, out);
    return out;
  }
  const key = (p) => {
    const c = centroid(p.pts);
    return eye ? Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]) : -c[2];
  };
  return polys
    .map((p) => ({ p, k: key(p) }))
    .sort((a, b) => b.k - a.k)
    .map((e) => e.p);
}

// ---- rendering ----

function lightOf(fx) {
  return {
    dir: normalize([fx.lightX, fx.lightY, fx.lightZ]),
    color: rgbOf(fx.lightColor || '#ffffff'),
    intensity: fx.intensity,
    ambient: fx.ambient,
  };
}

function materialOf(fx) {
  return { id: fx.material, roughness: fx.roughness, specular: fx.specular, metallic: fx.metallic, reflection: fx.reflection };
}

/** Least-squares linear gradient through corner colors of a projected face, or null if flat. */
export function faceGradient(pts2, colors) {
  const n = pts2.length;
  let cx = 0;
  let cy = 0;
  let cl = 0;
  const lum = colors.map(brightness);
  for (let i = 0; i < n; i++) {
    cx += pts2[i][0];
    cy += pts2[i][1];
    cl += lum[i];
  }
  cx /= n;
  cy /= n;
  cl /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxl = 0;
  let syl = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts2[i][0] - cx;
    const dy = pts2[i][1] - cy;
    const dl = lum[i] - cl;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxl += dx * dl;
    syl += dy * dl;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-12) return null;
  const a = (sxl * syy - syl * sxy) / det;
  const b = (syl * sxx - sxl * sxy) / det;
  const g = Math.hypot(a, b);
  if (g < 1e-9) return null;
  const ux = a / g;
  const uy = b / g;
  const ts = pts2.map((p) => (p[0] - cx) * ux + (p[1] - cy) * uy);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  if (t1 - t0 < 1e-6) return null;
  const order = ts.map((t, i) => i).sort((i, j) => ts[i] - ts[j]);
  const stops = [];
  for (const i of order) {
    const offset = (ts[i] - t0) / (t1 - t0);
    const color = hexOf(colors[i]);
    const last = stops[stops.length - 1];
    if (last && Math.abs(last.offset - offset) < 1e-4) continue;
    stops.push({ offset, color, opacity: 1 });
  }
  if (stops.length < 2 || stops.every((s) => s.color === stops[0].color)) return null;
  return { type: 'linear', stops, x1: cx + ux * t0, y1: cy + uy * t0, x2: cx + ux * t1, y2: cy + uy * t1 };
}

/** Clip a polygon of [x, y, ...values] to lo <= value[k] <= hi (values interpolate along edges). */
function clipValue(poly, k, lo, hi) {
  const pass = (pts, keep) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const da = keep(a[k]);
      const db = keep(b[k]);
      if (da >= 0) out.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const t = da / (da - db);
        out.push(a.map((v, j) => v + (b[j] - v) * t));
      }
    }
    return out;
  };
  let out = poly;
  if (lo > -Infinity) out = pass(out, (v) => v - lo);
  if (out.length >= 3 && hi < Infinity) out = pass(out, (v) => hi - v);
  return out.length >= 3 ? out : null;
}

/** Levels a value range crosses: [{ level, lo, hi }] for `steps` levels (bands centered on the levels). */
function bandsOf(min, max, steps) {
  const n = steps - 1;
  const out = [];
  for (let j = Math.round(min * n); j <= Math.round(max * n); j++) {
    out.push({ level: j / n, lo: j === 0 ? -Infinity : (j - 0.5) / n, hi: j === n ? Infinity : (j + 0.5) / n });
  }
  return out;
}

/**
 * Cut a face of [x, y, diff, spec, env] vertices into pieces of equal
 * quantized diffuse light and highlight: [{ pts, diff, spec }].
 */
export function bandPieces(verts, steps) {
  const range = (k, pts) => [Math.min(...pts.map((v) => v[k])), Math.max(...pts.map((v) => v[k]))];
  const out = [];
  const [d0, d1] = range(2, verts);
  for (const bd of bandsOf(d0, d1, steps)) {
    const pd = bandsOf(d0, d1, steps).length === 1 ? verts : clipValue(verts, 2, bd.lo, bd.hi);
    if (!pd) continue;
    const [s0, s1] = range(3, pd);
    const sb = bandsOf(s0, s1, steps);
    for (const bs of sb) {
      const ps = sb.length === 1 ? pd : clipValue(pd, 3, bs.lo, bs.hi);
      if (ps) out.push({ pts: ps, diff: bd.level, spec: bs.level });
    }
  }
  return out;
}

const avg = (cs) => [0, 1, 2].map((k) => cs.reduce((s, c) => s + c[k], 0) / cs.length);

/**
 * Turn models into flat shapes.
 * opts: { draft, screen: [x, y] where the model origin lands (default: origin) }
 */
export function renderModels(scene, fx, opts = {}) {
  const { models, radius } = scene;
  const screen = opts.screen || scene.origin;
  const R = rotationMatrix(fx.rotX, fx.rotY, fx.rotZ);
  const cam = makeCamera(fx.perspective, radius, screen);
  const light = lightOf(fx);
  const mat = materialOf(fx);
  const wire = fx.material === 'wire';
  const glass = (fx.opacity ?? 1) < 0.999;
  const steps = fx.shading === 'banded' ? fx.steps : 0;
  const polys = [];
  const shadowRings = [];
  const eps = radius * 1e-6;

  if (fx.kind === 'rotate') return renderFlat(scene, fx, R, cam, light, mat, screen);

  models.forEach((m, mi) => {
    const verts = m.mesh.verts.map((v) => apply3(R, v));
    const base = rgbOf(baseColorOf(m.item.style, fx.color));
    m.mesh.faces.forEach((f, fi) => {
      const pts = f.rings[0].map((i) => verts[i]);
      let n = apply3(R, m.normals[fi]);
      let ns = m.corners[fi] ? m.corners[fi].map((c) => apply3(R, c)) : null;
      const c = centroid(pts);
      const facing = dot(n, cam.eye ? normalize(sub(cam.eye, c)) : [0, 0, 1]) > 1e-7;
      if (fx.shadow && (f.twoSided || !m.mesh.closed || dot(n, light.dir) > 0)) shadowRings.push(pts.map((p) => p));
      if (!facing) {
        // Closed solids hide their far side; open surfaces show their inside.
        if (!wire && !glass && m.mesh.closed && !f.twoSided) return;
        n = scale(n, -1);
        if (ns) ns = ns.map((q) => scale(q, -1));
      }
      const holes = f.rings.slice(1).map((r) => r.map((i) => verts[i]));
      polys.push({ pts, ns, n, holes, mi, part: f.part, split: false, base, back: !facing });
    });
  });

  // Faces that bend (twisted sides) are split into triangles so each piece is flat.
  const flat = [];
  for (const p of polys) {
    if (p.pts.length > 3 && !p.holes.length && nonPlanar(p.pts, eps * 1000)) {
      for (let k = 1; k < p.pts.length - 1; k++) {
        flat.push({ ...p, pts: [p.pts[0], p.pts[k], p.pts[k + 1]], ns: p.ns ? [p.ns[0], p.ns[k], p.ns[k + 1]] : null });
      }
    } else flat.push(p);
  }
  // Caps first: as the first splitters they cut others instead of being cut (no seams across them).
  flat.sort((a, b) => (b.part === 'cap') - (a.part === 'cap'));
  const ordered = orderPolys(flat, cam.eye, { draft: opts.draft, eps: radius * 1e-5 });

  const faces = [];
  const seam = wire || glass ? 0 : SEAM;
  for (const p of ordered) {
    const pts2 = p.pts.map(cam.project);
    const holes2 = p.holes.map((h) => h.map(cam.project));
    const src = models[p.mi].item.source;
    if (wire) {
      faces.push({ rings: [pts2, ...holes2], fill: null, stroke: { type: 'solid', color: hexOf(p.base) }, strokeWidth: 0.5, opacity: 1, source: src });
      continue;
    }
    if (p.ns && fx.shading === 'banded' && mat.id !== 'unlit') {
      // Bands follow the lighting across neighboring faces: each face is cut
      // along the same light levels, so band edges run smoothly.
      const verts = p.pts.map((q, i) => {
        const t = lightTerms(p.ns[i], cam.viewDir(q), mat, light);
        return [pts2[i][0], pts2[i][1], t.diff, t.spec, t.env];
      });
      for (const piece of bandPieces(verts, steps)) {
        const env = quantize(piece.pts.reduce((a, v) => a + v[4], 0) / piece.pts.length, steps);
        const color = { type: 'solid', color: hexOf(combine(p.base, { diff: piece.diff, spec: piece.spec, env }, mat, light)) };
        const ring = piece.pts.map((v) => [v[0], v[1]]);
        faces.push({ rings: [ring], fill: color, stroke: seam ? color : null, strokeWidth: seam, opacity: glass ? fx.opacity : 1, source: src });
      }
      continue;
    }
    let fill;
    if (p.ns && fx.shading === 'smooth') {
      const cols = p.pts.map((q, i) => shade(p.base, p.ns[i], cam.viewDir(q), mat, light, 0));
      fill = faceGradient(pts2, cols) || { type: 'solid', color: hexOf(avg(cols)) };
    } else {
      const c = centroid(p.pts);
      const n = p.ns ? normalize(p.ns.reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0])) : p.n;
      fill = { type: 'solid', color: hexOf(shade(p.base, n, cam.viewDir(c), mat, light, steps)) };
    }
    // Split caps can carry bridge edges along the cut; outlining them would show.
    const outline = seam && !(p.split && p.holes.length) && !(p.split && p.part === 'cap');
    faces.push({ rings: [pts2, ...holes2], fill, stroke: outline ? fill : null, strokeWidth: outline ? seam : 0, opacity: glass ? fx.opacity : 1, source: src });
  }
  const shadow = fx.shadow ? shadowOf(shadowRings, fx, light, cam, scene, R) : null;
  return { faces, shadow };
}

function nonPlanar(pts, tol) {
  const n = normalize(newellNormal(pts));
  const d = dot(n, pts[0]);
  return pts.some((p) => Math.abs(dot(n, p) - d) > tol);
}

/**
 * Shadow rings: faces projected along the light onto a floor under the
 * object (or a wall behind it), then through the camera. The floor is level
 * before the X tilt, so tilting the object toward the viewer shows the
 * floor from above. Rings are wound the same way so the nonzero rule
 * fills their union.
 */
function shadowOf(rings, fx, light, cam, scene, R) {
  const L = light.dir;
  // The plane's normal points toward the object (up from the floor, out of the wall).
  const n = fx.shadowPlane === 'behind' ? [0, 0, 1] : apply3(rotX(fx.rotX), [0, -1, 0]);
  const facing = dot(n, L);
  if (facing < 0.05) return null;
  let lo = Infinity;
  for (const m of scene.models) for (const v of m.mesh?.verts || []) lo = Math.min(lo, dot(n, apply3(R, v)));
  if (!Number.isFinite(lo)) return null;
  const c = lo - (fx.shadowDistance || 0);
  const maxT = scene.radius * 6;
  const toPlane = (p) => {
    const t = Math.min(maxT, (dot(n, p) - c) / facing);
    return [p[0] - L[0] * t, p[1] - L[1] * t, p[2] - L[2] * t];
  };
  const out = [];
  for (const r of rings) {
    const pts = r.map((p) => cam.project(toPlane(p)));
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(a) < 1e-9) continue;
    out.push(a < 0 ? pts.reverse() : pts);
  }
  return out.length ? { rings: out, opacity: fx.shadowOpacity } : null;
}

/** Rotate: the artwork itself turned in space, keeping its own paint (shaded unless Flat Color). */
function renderFlat(scene, fx, R, cam, light, mat, screen) {
  const faces = [];
  const n0 = apply3(R, [0, 0, 1]);
  const facing = dot(n0, cam.eye ? normalize(cam.eye) : [0, 0, 1]) > 0;
  const n = facing ? n0 : scale(n0, -1);
  const lit = (paint) => {
    if (!paint || mat.id === 'unlit' || mat.id === 'wire' || paint.type !== 'solid') return paint;
    return { ...paint, color: hexOf(shade(rgbOf(paint.color), n, cam.viewDir([0, 0, 0]), mat, light, fx.shading === 'banded' ? fx.steps : 0)) };
  };
  const [ox, oy] = scene.origin;
  const place = (x, y) => cam.project(apply3(R, [x - ox, y - oy, 0]));
  const shadowRings = [];
  for (const m of scene.models) {
    const style = m.item.style;
    const rings = m.polys.map((p) => p.pts.map((q) => place(q[0], q[1])));
    const closed = m.polys.map((p) => p.closed);
    if (fx.shadow) for (const p of m.polys) if (p.closed) shadowRings.push(p.pts.map((q) => apply3(R, [q[0] - ox, q[1] - oy, 0])));
    const paint = (p) => {
      if (!isGradient(p)) return lit(p);
      const b = ringsBounds(m.polys.map((q) => q.pts));
      const g = p.x1 === undefined && b ? gradientEnds(p, b) : p;
      const a = place(g.x1, g.y1);
      const c = place(g.x2, g.y2);
      return { ...g, x1: a[0], y1: a[1], x2: c[0], y2: c[1] };
    };
    faces.push({
      rings,
      closed,
      style: { ...style, fill: paint(style.fill), stroke: paint(style.stroke) },
      fillRule: m.item.fillRule || 'nonzero',
      source: m.item.source,
    });
  }
  const shadow = fx.shadow ? shadowOf(shadowRings, fx, light, cam, { ...scene, models: scene.models.map((m) => ({ mesh: { verts: m.polys.flatMap((p) => p.pts.map((q) => [q[0] - ox, q[1] - oy, 0])) } })) }, R) : null;
  return { faces, shadow, flat: true, screen };
}
