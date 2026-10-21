/**
 * 3D geometry for model elements. Each builder returns a mesh (see
 * mesh.js) in absolute project coordinates, or null.
 *
 * ctx: { doc, walls: WallSolver, material(id) }
 */
import { MeshBuilder, Frame, hexToRgba } from './mesh.js';
import { add, scale, sub, dot, norm, perp, len, clipHalfPlane, triangulate } from './geom.js';
import { verticalExtent, openingSize, hostedBy, levelElevation, stairLayout, wallAxis, rampLayout } from './model.js';
import { cutFace, segmentInside, segmentOutside } from './roofcut.js';
import { buildSweep } from './sweeps.js';
import { buildTruss } from './truss.js';
import { buildImported } from './imported.js';
import { buildModelText } from './modeltext.js';
import { axisParam, hubsOf } from './walls.js';
import { typeThickness } from './catalog.js';
import { roofFaces, roofHeightAt, verticalThickness, planeHeight, edgeProfile } from './roof.js';
import { buildFamily } from './families.js';
import { stairFlights, flightOutline, SPIRAL_CORE } from './stairs.js';
import { mepSize, mepPlan, systemOf } from './mep.js';
import { delaunay } from './topo.js';

export function materialColor(ctx, id, fallback = '#c8c8c8') {
  const m = id ? ctx.material(id) : null;
  return hexToRgba(m?.color || fallback, m?.opacity ?? 1);
}

/** Colour of the layer with a given function, or of the thickest layer. */
function layerColor(ctx, type, which) {
  const layers = type?.layers || [];
  if (!layers.length) return materialColor(ctx, null);
  if (which === 'first') return materialColor(ctx, layers[0].materialId);
  if (which === 'last') return materialColor(ctx, layers.at(-1).materialId);
  const core = layers.find((l) => l.function === 'structure') || layers.reduce((a, b) => (b.thickness > a.thickness ? b : a), layers[0]);
  return materialColor(ctx, core.materialId);
}

export function build3D(ctx, el) {
  switch (el.kind) {
    case 'wall':
      return buildWall(ctx, el);
    case 'wallSweep':
      return buildSweep(ctx, el);
    case 'truss':
      return buildTruss(ctx, el);
    case 'importedModel':
      return buildImported(el);
    case 'modelText':
      return buildModelText(ctx, el);
    case 'floor':
      return buildSlab(ctx, el, 'floor');
    case 'ceiling':
      return buildSlab(ctx, el, 'ceiling');
    case 'roof':
      return buildRoof(ctx, el);
    case 'door':
      return buildDoor(ctx, el);
    case 'window':
      return buildWindow(ctx, el);
    case 'column':
      return buildColumn(ctx, el);
    case 'beam':
      return buildBeam(ctx, el);
    case 'stair':
      return buildStair(ctx, el);
    case 'railing':
      return buildRailing(ctx, el);
    case 'component':
      return buildComponent(ctx, el);
    case 'ramp':
      return buildRamp(ctx, el);
    case 'modelLine':
      return buildModelLine(ctx, el);
    case 'footing':
      return buildFooting(ctx, el);
    case 'wallFooting':
      return buildWallFooting(ctx, el);
    case 'brace':
      return buildBrace(ctx, el);
    case 'duct':
    case 'pipe':
    case 'cableTray':
    case 'conduit':
      return buildMep(ctx, el);
    case 'topo':
      return buildTopo(ctx, el);
    case 'mass':
      return buildMass(ctx, el);
    default:
      return null;
  }
}

// Foundations, bracing, services, site and masses ------------------------------------------------

/** Plan outline of an isolated footing. */
export function footingOutline(doc, el) {
  const t = doc.get(el.typeId) || {};
  const w = +t.width || 1200;
  const l = +t.length || w;
  const fr = new Frame(el.at, ((+el.rotation || 0) * Math.PI) / 180);
  return [
    [-w / 2, -l / 2],
    [w / 2, -l / 2],
    [w / 2, l / 2],
    [-w / 2, l / 2],
  ].map((p) => fr.apply(p));
}

function buildFooting(ctx, el) {
  const t = ctx.doc.get(el.typeId) || {};
  const top = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0);
  const b = new MeshBuilder();
  b.prism(footingOutline(ctx.doc, el), [], top - (+t.thickness || 450), top, materialColor(ctx, t.materialId || 'mat-concrete'));
  return b.build();
}

/** Plan outline of a wall foundation: the strip under its wall, past the free ends. */
export function wallFootingOutline(doc, el) {
  const w = doc.get(el.wallId);
  if (!w) return null;
  const t = doc.get(el.typeId) || {};
  const width = +t.width || 600;
  const ax = wallAxis(doc, w);
  const ext = width / 2 - ax.half;
  const a = sub(ax.a, scale(ax.dir, Math.max(0, ext)));
  const c = add(ax.b, scale(ax.dir, Math.max(0, ext)));
  const hw = scale(ax.n, width / 2);
  return [sub(a, hw), sub(c, hw), add(c, hw), add(a, hw)];
}

function buildWallFooting(ctx, el) {
  const w = ctx.doc.get(el.wallId);
  const outline = wallFootingOutline(ctx.doc, el);
  if (!w || !outline) return null;
  const t = ctx.doc.get(el.typeId) || {};
  const { base } = verticalExtent(ctx.doc, w);
  const b = new MeshBuilder();
  b.prism(outline, [], base - (+t.thickness || 300), base, materialColor(ctx, t.materialId || 'mat-concrete'));
  return b.build();
}

/** End heights of a brace. */
export function braceHeights(doc, el) {
  const z0 = levelElevation(doc, el.levelId) + (+el.baseOffset || 0);
  const z1 = el.topLevelId && doc.get(el.topLevelId) ? levelElevation(doc, el.topLevelId) + (+el.topOffset || 0) : z0 + (+el.height || 3000);
  return { z0, z1 };
}

function buildBrace(ctx, el) {
  const t = ctx.doc.get(el.typeId) || {};
  const { z0, z1 } = braceHeights(ctx.doc, el);
  const b = new MeshBuilder();
  b.beam3([el.a[0], el.a[1], z0], [el.b[0], el.b[1], z1], +t.width || 200, +t.depth || 200, materialColor(ctx, t.materialId || 'mat-steel'));
  return b.build();
}

function buildMep(ctx, el) {
  if (!el.a || !el.b) return null;
  const { round, w, h } = mepSize(ctx.doc, el);
  const { a, b: e } = mepPlan(ctx.doc, el);
  const z = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0);
  const col = hexToRgba(systemOf(el).color);
  const b = new MeshBuilder();
  if (round) b.tube([a[0], a[1], z], [e[0], e[1], z], w / 2, col, { segments: el.kind === 'conduit' ? 8 : 16 });
  else b.beam3([a[0], a[1], z], [e[0], e[1], z], w, h, col);
  // Fittings where runs meet: a sleeve on this run, and the joint itself
  // (drawn by one of the runs that meet there).
  if (el.kind === 'duct' || el.kind === 'pipe') {
    const len = Math.hypot(el.b[0] - el.a[0], el.b[1] - el.a[1]);
    const d = len > 1e-6 ? [(el.b[0] - el.a[0]) / len, (el.b[1] - el.a[1]) / len] : [1, 0];
    const fit = [Math.round(col[0] * 0.82), Math.round(col[1] * 0.82), Math.round(col[2] * 0.82), col[3]];
    for (const [p, into] of [
      [el.a, d],
      [el.b, [-d[0], -d[1]]],
    ]) {
      const others = ctx.doc.all(el.kind).filter((o) => o.id !== el.id && o.levelId === el.levelId && ((Math.abs(o.a[0] - p[0]) < 1 && Math.abs(o.a[1] - p[1]) < 1) || (Math.abs(o.b[0] - p[0]) < 1 && Math.abs(o.b[1] - p[1]) < 1)));
      if (!others.length) continue;
      const at = (s) => [p[0] + into[0] * s, p[1] + into[1] * s, z];
      if (round) {
        const r = w / 2;
        b.tube(at(r * 0.9), at(r * 1.6), r * 1.15, fit, { segments: 16 });
        if (others.every((o) => o.id > el.id)) b.sphere([p[0], p[1], z], r * 1.12, fit, { segments: 16, rings: 10 });
      } else {
        b.beam3(at(w / 2), at(w / 2 + 60), w + 30, h + 30, fit);
        if (others.every((o) => o.id > el.id)) b.beam3([p[0] - w * 0.55 * into[0], p[1] - w * 0.55 * into[1], z], [p[0] + w * 0.55 * into[0], p[1] + w * 0.55 * into[1], z], w * 1.1, h * 1.05, fit);
      }
    }
  }
  return b.build();
}

function buildTopo(ctx, el) {
  const P = el.points || [];
  if (P.length < 3) return null;
  const tris = delaunay(P);
  if (!tris.length) return null;
  const col = materialColor(ctx, el.materialId || 'mat-earth');
  const zMin = Math.min(...P.map((p) => p[2])) - (+el.thickness || 1000);
  const b = new MeshBuilder();
  const count = new Map();
  for (const [i, j, k] of tris) {
    const A = P[i];
    const C = P[j];
    const D = P[k];
    orientedTri(b, A, C, D, col, true);
    orientedTri(b, [A[0], A[1], zMin], [C[0], C[1], zMin], [D[0], D[1], zMin], col, false);
    for (const [u, v] of [
      [i, j],
      [j, k],
      [k, i],
    ]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  // Skirt along the outer edges (used by one triangle only).
  for (const [key, n] of count) {
    if (n !== 1) continue;
    const [u, v] = key.split(',').map(Number);
    const p = P[u];
    const q = P[v];
    b.quad([p[0], p[1], zMin], [q[0], q[1], zMin], q, p, col);
    b.edge(p, q);
    b.edge([p[0], p[1], zMin], [q[0], q[1], zMin]);
  }
  return b.build();
}

function buildMass(ctx, el) {
  if (!el.boundary || el.boundary.length < 3) return null;
  const base = levelElevation(ctx.doc, el.levelId) + (+el.baseOffset || 0);
  const b = new MeshBuilder();
  b.prism(el.boundary, el.holes || [], base, base + (+el.height || 10000), [176, 190, 214, 110]);
  return b.build();
}

// Ramps and model lines -------------------------------------------------------------------

function buildRamp(ctx, el) {
  const g = rampLayout(ctx.doc, el);
  if (g.run < 1) return null;
  const type = ctx.doc.get(el.typeId) || {};
  const col = materialColor(ctx, type.materialId || 'mat-concrete');
  const b = new MeshBuilder();
  const origin = add(el.a, scale(g.side, -g.width / 2));
  const th = g.thickness;
  b.extrudeProfile(
    [
      [0, g.base - th],
      [g.run, g.top - th],
      [g.run, g.top],
      [0, g.base],
    ],
    origin,
    g.dir,
    g.width,
    col,
  );
  if (el.railings !== false) {
    const rail = materialColor(ctx, 'mat-steel');
    const H = 900;
    for (const off of [50, g.width - 50]) {
      const p0 = add(origin, scale(g.side, off));
      b.extrudeProfile(
        [
          [0, g.base + H - 40],
          [g.run, g.top + H - 40],
          [g.run, g.top + H],
          [0, g.base + H],
        ],
        add(p0, scale(g.side, -20)),
        g.dir,
        40,
        rail,
      );
      const posts = Math.max(2, Math.round(g.run / 1200) + 1);
      for (let i = 0; i < posts; i++) {
        const s = (g.run * i) / (posts - 1);
        const z = g.base + (g.rise * s) / g.run;
        b.cylinder(add(p0, scale(g.dir, s)), 15, z, z + H - 40, rail, { segments: 8, edges: false });
      }
    }
  }
  return b.build();
}

function buildModelLine(ctx, el) {
  if (!el.a || !el.b) return null;
  const z = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0);
  const b = new MeshBuilder();
  b.edge([el.a[0], el.a[1], z], [el.b[0], el.b[1], z]);
  return b.build();
}

// Walls -----------------------------------------------------------------------------

/** Openings of a wall as axis intervals and absolute heights. */
export function wallOpenings(doc, wall, base, top) {
  const out = [];
  for (const el of hostedBy(doc, wall.id)) {
    const { width, height, sill } = openingSize(doc, el);
    const z0 = base + sill;
    const z1 = Math.min(top, z0 + height);
    if (z1 - z0 < 1 || width < 1) continue;
    out.push({ id: el.id, u0: el.t - width / 2, u1: el.t + width / 2, z0: Math.max(base, z0), z1, kind: el.kind });
  }
  return out.sort((a, b) => a.u0 - b.u0);
}

function buildWall(ctx, w) {
  const g = ctx.walls.wall(w.id);
  if (!g) return null;
  const type = ctx.doc.get(w.typeId);
  if (type?.curtain) return buildCurtainWall(ctx, w, g, type);
  const b = new MeshBuilder();
  const { axis, base, top } = g;
  const { dir, n, half } = axis;
  const ext = layerColor(ctx, type, 'first');
  const int = layerColor(ctx, type, 'last');
  const core = layerColor(ctx, type, 'core');
  const leftCol = w.flipped ? int : ext;
  const rightCol = w.flipped ? ext : int;

  const uL0 = axisParam(axis, g.L0);
  const uL1 = axisParam(axis, g.L1);
  const uR0 = axisParam(axis, g.R0);
  const uR1 = axisParam(axis, g.R1);
  const lo = Math.max(uL0, uR0) + 1;
  const hi = Math.min(uL1, uR1) - 1;
  const ops = wallOpenings(ctx.doc, w, base, top)
    .map((o) => ({ ...o, u0: Math.max(o.u0, lo), u1: Math.min(o.u1, hi) }))
    .filter((o) => o.u1 - o.u0 > 1);

  const P = (u, side, z) => [axis.a[0] + dir[0] * u + n[0] * side * half, axis.a[1] + dir[1] * u + n[1] * side * half, z];

  const roofTop = attachedTop(ctx.doc, w, base);
  if (roofTop) {
    buildAttachedWall(b, { g, axis, base, top, ops, P, roofTop, leftCol, rightCol, core, uL0, uL1, uR0, uR1 });
    for (const hub of hubsOf(ctx.walls.level(w.levelId), w.id)) b.prism(hub.poly, [], hub.base, hub.top, core, { edges: false });
    return b.build();
  }

  // Side faces.
  const right = faceLoops(uR0, uR1, base, top, ops);
  const left = faceLoops(uL0, uL1, base, top, ops);
  const oR = [axis.a[0] - n[0] * half, axis.a[1] - n[1] * half, 0];
  const oL = [axis.a[0] + n[0] * half, axis.a[1] + n[1] * half, 0];
  for (const f of right) b.planar(oR, [dir[0], dir[1], 0], [0, 0, 1], f.outer, f.holes, rightCol);
  for (const f of left)
    b.planar(
      oL,
      [-dir[0], -dir[1], 0],
      [0, 0, 1],
      f.outer.map((p) => [-p[0], p[1]]),
      f.holes.map((hh) => hh.map((p) => [-p[0], p[1]])),
      leftCol,
    );

  // Reveals.
  for (const o of ops) {
    b.quad(P(o.u0, -1, o.z0), P(o.u0, 1, o.z0), P(o.u0, 1, o.z1), P(o.u0, -1, o.z1), core);
    b.quad(P(o.u1, 1, o.z0), P(o.u1, -1, o.z0), P(o.u1, -1, o.z1), P(o.u1, 1, o.z1), core);
    if (o.z1 < top - 0.5) b.quad(P(o.u0, -1, o.z1), P(o.u0, 1, o.z1), P(o.u1, 1, o.z1), P(o.u1, -1, o.z1), core);
    if (o.z0 > base + 0.5) b.quad(P(o.u0, -1, o.z0), P(o.u1, -1, o.z0), P(o.u1, 1, o.z0), P(o.u0, 1, o.z0), core);
  }

  // Top and bottom, interrupted by openings that reach them.
  const poly = [g.R0, g.R1, g.L1, g.L0];
  const topCuts = ops.filter((o) => o.z1 >= top - 0.5).map((o) => [o.u0, o.u1]);
  const botCuts = ops.filter((o) => o.z0 <= base + 0.5).map((o) => [o.u0, o.u1]);
  for (const part of splitByCuts(poly, axis, topCuts)) b.horizontal(part, [], top, true, core);
  for (const part of splitByCuts(poly, axis, botCuts)) b.horizontal(part, [], base, false, core);

  // Square ends.
  if (g.ends[0].kind === 'free') b.quad([g.L0[0], g.L0[1], base], [g.R0[0], g.R0[1], base], [g.R0[0], g.R0[1], top], [g.L0[0], g.L0[1], top], core);
  if (g.ends[1].kind === 'free') b.quad([g.R1[0], g.R1[1], base], [g.L1[0], g.L1[1], base], [g.L1[0], g.L1[1], top], [g.R1[0], g.R1[1], top], core);

  // Hubs owned by this wall.
  for (const hub of hubsOf(ctx.walls.level(w.levelId), w.id)) b.prism(hub.poly, [], hub.base, hub.top, core, { edges: false });

  // Edges.
  const faceEdges = (side, u0, u1) => {
    for (const z of [base, top]) {
      const cuts = z === top ? topCuts : botCuts;
      for (const [s0, s1] of keepIntervals(u0, u1, cuts)) b.edge(P(s0, side, z), P(s1, side, z));
    }
  };
  faceEdges(1, uL0, uL1);
  faceEdges(-1, uR0, uR1);
  const endEdges = (e, L, R) => {
    const info = g.ends[e];
    if (info.kind === 'free') {
      b.edge([L[0], L[1], base], [R[0], R[1], base]);
      b.edge([L[0], L[1], top], [R[0], R[1], top]);
    }
    if (info.kind !== 'corner' || info.angle > 0.05) {
      b.edge([L[0], L[1], base], [L[0], L[1], top]);
      b.edge([R[0], R[1], base], [R[0], R[1], top]);
    }
  };
  endEdges(0, g.L0, g.R0);
  endEdges(1, g.L1, g.R1);
  for (const o of ops) {
    for (const side of [-1, 1]) {
      if (o.z0 > base + 0.5) b.edge(P(o.u0, side, o.z0), P(o.u1, side, o.z0));
      if (o.z1 < top - 0.5) b.edge(P(o.u0, side, o.z1), P(o.u1, side, o.z1));
      b.edge(P(o.u0, side, o.z0), P(o.u0, side, o.z1));
      b.edge(P(o.u1, side, o.z0), P(o.u1, side, o.z1));
    }
  }
  return b.build();
}

/**
 * Top of a wall attached to a roof: a function of the plan point giving the
 * roof underside (or null when the wall is not attached).
 */
export function attachedTop(doc, w, base) {
  if (!w.attachTopId) return null;
  const roof = doc.get(w.attachTopId);
  if (!roof || roof.kind !== 'roof' || !roof.boundary?.length) return null;
  const g = roofGeometry(doc, roof);
  return (p) => {
    const inside = pointInPoly(p, g.poly);
    if (!inside) return null;
    const z = g.base + (g.planes.length ? roofHeightAt(g.planes, p) : 0);
    return z > base + 10 ? z : null;
  };
}

function pointInPoly(p, poly) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const c = poly[j];
    if (a[1] > p[1] !== c[1] > p[1] && p[0] < ((c[0] - a[0]) * (p[1] - a[1])) / (c[1] - a[1]) + a[0]) r = !r;
  }
  return r;
}

/** Side faces sampled along the wall so their tops follow the roof. */
function buildAttachedWall(b, { g, axis, base, top, ops, P, roofTop, leftCol, rightCol, core, uL0, uL1, uR0, uR1 }) {
  const step = 150;
  const zAt = (u, side) => {
    const p = P(u, side, 0);
    return roofTop([p[0], p[1]]) ?? top;
  };
  const samples = (u0, u1) => {
    const out = [];
    const n = Math.max(1, Math.ceil((u1 - u0) / step));
    for (let i = 0; i <= n; i++) out.push(u0 + ((u1 - u0) * i) / n);
    return out;
  };
  const face = (side, u0, u1, col) => {
    const us = samples(u0, u1);
    const bottom = ops.filter((o) => o.z0 <= base + 0.5).sort((x, y) => x.u0 - y.u0);
    const outer = [[u0, base]];
    for (const o of bottom) outer.push([o.u0, base], [o.u0, o.z1], [o.u1, o.z1], [o.u1, base]);
    outer.push([u1, base]);
    for (let i = us.length - 1; i >= 0; i--) outer.push([us[i], zAt(us[i], side)]);
    const holes = ops
      .filter((o) => o.z0 > base + 0.5)
      .map((o) => [
        [o.u0, o.z0],
        [o.u1, o.z0],
        [o.u1, o.z1],
        [o.u0, o.z1],
      ]);
    const origin = P(0, side, 0);
    if (side < 0) b.planar(origin, [axis.dir[0], axis.dir[1], 0], [0, 0, 1], dedupe(outer), holes, col);
    else b.planar(origin, [-axis.dir[0], -axis.dir[1], 0], [0, 0, 1], dedupe(outer).map((q) => [-q[0], q[1]]), holes.map((hh) => hh.map((q) => [-q[0], q[1]])), col);
    for (let i = 0; i + 1 < us.length; i++) b.edge(P(us[i], side, zAt(us[i], side)), P(us[i + 1], side, zAt(us[i + 1], side)));
    b.edge(P(u0, side, base), P(u1, side, base));
    b.edge(P(u0, side, base), P(u0, side, zAt(u0, side)));
    b.edge(P(u1, side, base), P(u1, side, zAt(u1, side)));
    for (const o of ops) {
      if (o.z0 > base + 0.5) b.edge(P(o.u0, side, o.z0), P(o.u1, side, o.z0));
      b.edge(P(o.u0, side, o.z1), P(o.u1, side, o.z1));
      b.edge(P(o.u0, side, o.z0), P(o.u0, side, o.z1));
      b.edge(P(o.u1, side, o.z0), P(o.u1, side, o.z1));
    }
  };
  face(-1, uR0, uR1, rightCol);
  face(1, uL0, uL1, leftCol);
  // Reveals.
  for (const o of ops) {
    b.quad(P(o.u0, -1, o.z0), P(o.u0, 1, o.z0), P(o.u0, 1, o.z1), P(o.u0, -1, o.z1), core);
    b.quad(P(o.u1, 1, o.z0), P(o.u1, -1, o.z0), P(o.u1, -1, o.z1), P(o.u1, 1, o.z1), core);
    b.quad(P(o.u0, -1, o.z1), P(o.u0, 1, o.z1), P(o.u1, 1, o.z1), P(o.u1, -1, o.z1), core);
    if (o.z0 > base + 0.5) b.quad(P(o.u0, -1, o.z0), P(o.u1, -1, o.z0), P(o.u1, 1, o.z0), P(o.u0, 1, o.z0), core);
  }
  // Top: a strip between the two faces.
  const lo = Math.min(uL0, uR0);
  const hi = Math.max(uL1, uR1);
  const us = samples(lo, hi);
  const clampL = (u) => Math.max(uL0, Math.min(uL1, u));
  const clampR = (u) => Math.max(uR0, Math.min(uR1, u));
  for (let i = 0; i + 1 < us.length; i++) {
    const a0 = clampR(us[i]);
    const a1 = clampR(us[i + 1]);
    const c0 = clampL(us[i]);
    const c1 = clampL(us[i + 1]);
    b.quad(P(a0, -1, zAt(a0, -1)), P(a1, -1, zAt(a1, -1)), P(c1, 1, zAt(c1, 1)), P(c0, 1, zAt(c0, 1)), core);
  }
  // Bottom.
  b.horizontal([g.R0, g.R1, g.L1, g.L0], [], base, false, core);
  // Square ends.
  if (g.ends[0].kind === 'free') b.quad([g.L0[0], g.L0[1], base], [g.R0[0], g.R0[1], base], [g.R0[0], g.R0[1], zAt(uR0, -1)], [g.L0[0], g.L0[1], zAt(uL0, 1)], core);
  if (g.ends[1].kind === 'free') b.quad([g.R1[0], g.R1[1], base], [g.L1[0], g.L1[1], base], [g.L1[0], g.L1[1], zAt(uL1, 1)], [g.R1[0], g.R1[1], zAt(uR1, -1)], core);
}

/** Keep the parts of [u0, u1] outside the cut intervals. */
export function keepIntervals(u0, u1, cuts) {
  const out = [];
  let cur = u0;
  for (const [a, b] of cuts.slice().sort((x, y) => x[0] - y[0])) {
    if (b <= cur || a >= u1) continue;
    if (a > cur) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (u1 > cur) out.push([cur, u1]);
  return out;
}

/** Split a wall outline across its axis, leaving out the cut intervals. */
export function splitByCuts(poly, axis, cuts) {
  if (!cuts.length) return [poly];
  const us = poly.map((p) => axisParam(axis, p));
  const lo = Math.min(...us);
  const hi = Math.max(...us);
  const out = [];
  const off = dot(axis.dir, axis.a);
  for (const [s0, s1] of keepIntervals(lo, hi, cuts)) {
    let p = clipHalfPlane(poly, scale(axis.dir, -1), -(s0 + off));
    p = clipHalfPlane(p, axis.dir, s1 + off);
    if (p.length >= 3) out.push(p);
  }
  return out;
}

/**
 * Face outline in (u, z) between u0 and u1 with rectangular openings.
 * Openings touching the bottom or top become notches; an opening spanning
 * the full height splits the face.
 */
function faceLoops(u0, u1, base, top, ops) {
  const full = ops.filter((o) => o.z0 <= base + 0.5 && o.z1 >= top - 0.5);
  const ranges = keepIntervals(u0, u1, full.map((o) => [o.u0, o.u1]));
  const faces = [];
  for (const [a, c] of ranges) {
    const inside = ops.filter((o) => !full.includes(o) && o.u0 >= a - 0.01 && o.u1 <= c + 0.01);
    const bottom = inside.filter((o) => o.z0 <= base + 0.5).sort((x, y) => x.u0 - y.u0);
    const topN = inside.filter((o) => o.z1 >= top - 0.5).sort((x, y) => y.u0 - x.u0);
    const outer = [[a, base]];
    for (const o of bottom) outer.push([o.u0, base], [o.u0, o.z1], [o.u1, o.z1], [o.u1, base]);
    outer.push([c, base], [c, top]);
    for (const o of topN) outer.push([o.u1, top], [o.u1, o.z0], [o.u0, o.z0], [o.u0, top]);
    outer.push([a, top]);
    const holes = inside
      .filter((o) => o.z0 > base + 0.5 && o.z1 < top - 0.5)
      .map((o) => [
        [o.u0, o.z0],
        [o.u1, o.z0],
        [o.u1, o.z1],
        [o.u0, o.z1],
      ]);
    faces.push({ outer: dedupe(outer), holes });
  }
  return faces;
}

function dedupe(loop) {
  const out = [];
  for (const p of loop) if (!out.length || Math.abs(out.at(-1)[0] - p[0]) > 1e-6 || Math.abs(out.at(-1)[1] - p[1]) > 1e-6) out.push(p);
  if (out.length > 1 && Math.abs(out[0][0] - out.at(-1)[0]) < 1e-6 && Math.abs(out[0][1] - out.at(-1)[1]) < 1e-6) out.pop();
  return out;
}

/**
 * Curtain wall grid line positions: `us` along the wall and `vs` up from
 * its base, both including the two ends. The type spaces panels equally;
 * a wall's own grid lines (curtainU, curtainV) replace that layout.
 */
export function curtainGrid(axisLength, height, type, wall = null) {
  const c = type.curtain || {};
  const lines = (own, total, spacing) => {
    if (own?.length) return [0, ...[...new Set(own.map((x) => Math.round(+x)))].filter((x) => x > 1 && x < total - 1).sort((a, b) => a - b), total];
    const n = Math.max(1, Math.round(total / spacing));
    return Array.from({ length: n + 1 }, (_, i) => (total * i) / n);
  };
  const us = lines(wall?.curtainU, axisLength, +c.hSpacing || 1500);
  const vs = lines(wall?.curtainV, height, +c.vSpacing || 1200);
  return { us, vs, nu: us.length - 1, nv: vs.length - 1 };
}

function buildCurtainWall(ctx, w, g, type) {
  const b = new MeshBuilder();
  const { axis, base, top } = g;
  const { dir, n } = axis;
  const c = type.curtain || {};
  const mw = +c.mullionWidth || 50;
  const md = +c.mullionDepth || 150;
  const mul = materialColor(ctx, c.materialId || 'mat-aluminum');
  const glass = materialColor(ctx, 'mat-glass');
  const L = axis.length;
  const H = top - base;
  const { us, vs, nu, nv } = curtainGrid(L, H, type, w);
  const frame = new Frame(axis.a, Math.atan2(dir[1], dir[0]), base);
  const box = (x0, y0, z0, x1, y1, z1, col, opts) => b.prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => frame.apply(p)), [], base + z0, base + z1, col, opts);
  // Mullion segments can be removed one by one (wall.mullionsOff: 'v:i:j' and 'h:j:i').
  const off = new Set(w.mullionsOff || []);
  for (let i = 0; i <= nu; i++) {
    const u = Math.min(L - mw / 2, Math.max(mw / 2, us[i]));
    for (let j = 0; j < nv; j++) if (!off.has(`v:${i}:${j}`)) box(u - mw / 2, -md / 2, vs[j], u + mw / 2, md / 2, vs[j + 1], mul);
  }
  for (let j = 0; j <= nv; j++) {
    const z = Math.min(H - mw / 2, Math.max(mw / 2, vs[j]));
    for (let i = 0; i < nu; i++) if (!off.has(`h:${j}:${i}`)) box(us[i] + mw / 2, -md / 2 + 10, z - mw / 2, us[i + 1] - mw / 2, md / 2 - 10, z + mw / 2, mul);
  }
  // Panels: glass unless the wall says otherwise (wall.panels['i:j'] = 'solid' | 'empty' | 'door').
  const solid = materialColor(ctx, c.panelMaterialId || 'mat-paint-white');
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const kind = w.panels?.[`${i}:${j}`] || 'glass';
      if (kind === 'empty') continue;
      const x0 = us[i] + mw / 2;
      const x1 = us[i + 1] - mw / 2;
      const z0 = vs[j] + mw / 2;
      const z1 = vs[j + 1] - mw / 2;
      if (x1 - x0 < 1 || z1 - z0 < 1) continue;
      if (kind === 'solid') {
        box(x0, -15, z0, x1, 15, z1, solid);
        continue;
      }
      if (kind === 'door') {
        // A glazed door leaf: a frame round the glass and a pull handle.
        const f = Math.min(80, (x1 - x0) / 6);
        box(x0, -25, z0, x0 + f, 25, z1, mul);
        box(x1 - f, -25, z0, x1, 25, z1, mul);
        box(x0 + f, -25, z0, x1 - f, 25, z0 + f * 1.5, mul);
        box(x0 + f, -25, z1 - f, x1 - f, 25, z1, mul);
        box(x1 - f * 2.2, 25, z0 + (z1 - z0) * 0.35, x1 - f * 1.8, 70, z0 + (z1 - z0) * 0.6, mul);
        box(x0 + f, -6, z0 + f * 1.5, x1 - f, 6, z1 - f, glass, { edges: false });
        continue;
      }
      box(x0, -6, z0, x1, 6, z1, glass, { edges: false });
    }
  void n;
  return b.build();
}

// Slabs ------------------------------------------------------------------------------

function buildSlab(ctx, el, what) {
  if (!el.boundary || el.boundary.length < 3) return null;
  const type = ctx.doc.get(el.typeId);
  const th = Math.max(1, typeThickness(type) || (what === 'floor' ? 300 : 20));
  const z = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0);
  const b = new MeshBuilder();
  const topCol = layerColor(ctx, type, what === 'floor' ? 'first' : 'last');
  const coreCol = layerColor(ctx, type, 'core');
  const botCol = layerColor(ctx, type, what === 'floor' ? 'last' : 'first');
  if (what === 'floor') b.prism(el.boundary, el.holes || [], z - th, z, coreCol, { top: topCol, bottom: botCol, sides: coreCol });
  else b.prism(el.boundary, el.holes || [], z, z + th, coreCol, { top: topCol, bottom: botCol, sides: coreCol });
  return b.build();
}

// Roofs -------------------------------------------------------------------------------

export function roofGeometry(doc, el) {
  const type = doc.get(el.typeId);
  const th = Math.max(1, typeThickness(type) || 300);
  const base = levelElevation(doc, el.levelId) + (+el.baseOffset || 0);
  const rf = roofFaces(el.boundary, el.slopes);
  return { ...rf, th, base, type };
}

function buildRoof(ctx, el) {
  if (!el.boundary || el.boundary.length < 3) return null;
  const { poly, planes, faces, th, base, type } = roofGeometry(ctx.doc, el);
  const b = new MeshBuilder();
  const topCol = layerColor(ctx, type, 'first');
  const coreCol = layerColor(ctx, type, 'core');
  const zb = (p, pl) => base + (pl ? planeHeight(pl, p) : 0);
  const holes = (el.holes || []).filter((h) => h.length >= 3);
  for (const f of faces) {
    const vt = verticalThickness(th, f.plane);
    // Openings inside the face are holes; openings across its edge take a notch out of it.
    const { pieces, inner, crossing } = cutFace(f.poly, holes);
    for (const piece of pieces) {
      const { points, tris } = triangulate(piece.outer, piece.holes);
      for (let i = 0; i < tris.length; i += 3) {
        const [a, c, d] = [points[tris[i]], points[tris[i + 1]], points[tris[i + 2]]];
        const A = [a[0], a[1], zb(a, f.plane) + vt];
        const C = [c[0], c[1], zb(c, f.plane) + vt];
        const D = [d[0], d[1], zb(d, f.plane) + vt];
        orientedTri(b, A, C, D, topCol, true);
        orientedTri(b, [a[0], a[1], zb(a, f.plane)], [c[0], c[1], zb(c, f.plane)], [d[0], d[1], zb(d, f.plane)], coreCol, false);
      }
    }
    const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const top = (p) => [p[0], p[1], zb(p, f.plane) + vt];
    // The face outline, except where openings cross it.
    for (let i = 0; i < f.poly.length; i++) {
      const p = f.poly[i];
      const q = f.poly[(i + 1) % f.poly.length];
      for (const [t0, t1] of crossing.length ? segmentOutside(p, q, crossing) : [[0, 1]]) b.edge(top(lerp(p, q, t0)), top(lerp(p, q, t1)));
    }
    // Sides of openings cut through this face (only the part of each side on this face).
    for (const h of [...inner, ...crossing]) {
      const whole = inner.includes(h);
      for (let i = 0; i < h.length; i++) {
        const hp = h[i];
        const hq = h[(i + 1) % h.length];
        for (const [t0, t1] of whole ? [[0, 1]] : segmentInside(hp, hq, f.poly)) {
          const p = lerp(hp, hq, t0);
          const q = lerp(hp, hq, t1);
          const P0 = [p[0], p[1], zb(p, f.plane)];
          const Q0 = [q[0], q[1], zb(q, f.plane)];
          b.quad(Q0, P0, [p[0], p[1], P0[2] + vt], [q[0], q[1], Q0[2] + vt], coreCol);
          b.edge([p[0], p[1], P0[2] + vt], [q[0], q[1], Q0[2] + vt]);
          b.edge(P0, Q0);
        }
      }
    }
  }
  // Sides along the footprint.
  const activeAt = (p) => {
    if (!planes.length) return null;
    let best = null;
    let h = Infinity;
    for (const pl of planes) {
      const v = planeHeight(pl, p);
      if (v < h - 1e-6) {
        h = v;
        best = pl;
      }
    }
    return best;
  };
  const hAt = (p) => base + (planes.length ? roofHeightAt(planes, p) : 0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const pts = edgeProfile(faces, a, c);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k];
      const q = pts[k + 1];
      const pl = activeAt([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      const vt = verticalThickness(th, pl);
      const P0 = [p[0], p[1], hAt(p)];
      const Q0 = [q[0], q[1], hAt(q)];
      const Q1 = [q[0], q[1], hAt(q) + vt];
      const P1 = [p[0], p[1], hAt(p) + vt];
      b.quad(P0, Q0, Q1, P1, coreCol);
      b.edge(P0, Q0);
    }
    const z0 = hAt(a);
    b.edge([a[0], a[1], z0], [a[0], a[1], z0 + verticalThickness(th, activeAt(a))]);
  }
  return b.build();
}

function orientedTri(b, A, C, D, col, up) {
  const nz = (C[0] - A[0]) * (D[1] - A[1]) - (C[1] - A[1]) * (D[0] - A[0]);
  if ((nz >= 0) === up) b.tri(A, C, D, col);
  else b.tri(A, D, C, col);
}

// Doors and windows -------------------------------------------------------------------

function hostFrame(ctx, el) {
  const host = ctx.doc.get(el.hostId);
  if (!host || host.kind !== 'wall') return null;
  const axis = wallAxis(ctx.doc, host);
  const { base, top } = verticalExtent(ctx.doc, host);
  const at = add(axis.a, scale(axis.dir, el.t));
  const frame = new Frame(at, Math.atan2(axis.dir[1], axis.dir[0]), base);
  return { host, axis, base, top, frame, thick: axis.half * 2, extSign: host.flipped ? -1 : 1 };
}

function frameBox(b, frame, x0, y0, z0, x1, y1, z1, col, opts) {
  const lx = Math.min(x0, x1);
  const hx = Math.max(x0, x1);
  const ly = Math.min(y0, y1);
  const hy = Math.max(y0, y1);
  if (hx - lx < 0.01 || hy - ly < 0.01 || Math.abs(z1 - z0) < 0.01) return;
  b.prism(
    [
      [lx, ly],
      [hx, ly],
      [hx, hy],
      [lx, hy],
    ].map((p) => frame.apply(p)),
    [],
    frame.z + Math.min(z0, z1),
    frame.z + Math.max(z0, z1),
    col,
    opts,
  );
}

function buildDoor(ctx, el) {
  const hf = hostFrame(ctx, el);
  if (!hf) return null;
  const type = ctx.doc.get(el.typeId) || {};
  const { width: W, height: Hraw } = openingSize(ctx.doc, el);
  const H = Math.min(Hraw, hf.top - hf.base);
  const b = new MeshBuilder();
  const f = hf.frame;
  const fw = +type.frameWidth || 50;
  const fd = Math.min(hf.thick, +type.frameDepth || hf.thick);
  const frameCol = materialColor(ctx, type.frameMaterialId || 'mat-wood-light');
  const panelCol = materialColor(ctx, type.panelMaterialId || 'mat-door');
  const glass = materialColor(ctx, 'mat-glass');
  const fam = type.family || 'single';
  if (fam !== 'overhead') {
    frameBox(b, f, -W / 2, -fd / 2, 0, -W / 2 + fw, fd / 2, H, frameCol);
    frameBox(b, f, W / 2 - fw, -fd / 2, 0, W / 2, fd / 2, H, frameCol);
    frameBox(b, f, -W / 2, -fd / 2, H - fw, W / 2, fd / 2, H, frameCol);
  }
  const pt = +type.thickness || 44;
  const face = (el.flipFacing ? -1 : 1) * hf.extSign;
  const yc = 0;
  const x0 = -W / 2 + fw;
  const x1 = W / 2 - fw;
  const ph = H - fw;
  const panel = (a, c, y, glazed) => {
    if (!glazed) return frameBox(b, f, a, y - pt / 2, 0, c, y + pt / 2, ph - 3, panelCol);
    const st = Math.min(110, (c - a) / 4);
    frameBox(b, f, a, y - pt / 2, 0, a + st, y + pt / 2, ph - 3, panelCol);
    frameBox(b, f, c - st, y - pt / 2, 0, c, y + pt / 2, ph - 3, panelCol);
    frameBox(b, f, a + st, y - pt / 2, 0, c - st, y + pt / 2, 220, panelCol);
    frameBox(b, f, a + st, y - pt / 2, ph - 3 - st, c - st, y + pt / 2, ph - 3, panelCol);
    frameBox(b, f, a + st, y - 4, 220, c - st, y + 4, ph - 3 - st, glass, { edges: false });
  };
  switch (fam) {
    case 'double': {
      const m = (x0 + x1) / 2;
      panel(x0, m - 2, yc, type.glazing);
      panel(m + 2, x1, yc, type.glazing);
      break;
    }
    case 'sliding': {
      const m = (x0 + x1) / 2;
      panel(x0, m + 40, yc - pt * 0.6 * face, true);
      panel(m - 40, x1, yc + pt * 0.6 * face, true);
      break;
    }
    case 'bifold': {
      const n = 4;
      const wpan = (x1 - x0) / n;
      for (let i = 0; i < n; i++) frameBox(b, f, x0 + i * wpan + 1, -15, 0, x0 + (i + 1) * wpan - 1, 15, ph - 3, panelCol);
      break;
    }
    case 'overhead': {
      frameBox(b, f, -W / 2, -fd / 2, 0, -W / 2 + 40, fd / 2, H, frameCol);
      frameBox(b, f, W / 2 - 40, -fd / 2, 0, W / 2, fd / 2, H, frameCol);
      const sections = 4;
      for (let i = 0; i < sections; i++) frameBox(b, f, -W / 2 + 40, -20, (i * H) / sections + 1, W / 2 - 40, 20, ((i + 1) * H) / sections - 1, panelCol);
      break;
    }
    case 'opening':
      break;
    default:
      panel(x0, x1, yc, type.glazing);
  }
  return b.build();
}

function buildWindow(ctx, el) {
  const hf = hostFrame(ctx, el);
  if (!hf) return null;
  const type = ctx.doc.get(el.typeId) || {};
  const { width: W, height: H, sill } = openingSize(ctx.doc, el);
  const b = new MeshBuilder();
  const f = hf.frame;
  const fw = +type.frameWidth || 60;
  const fd = Math.min(hf.thick, +type.frameDepth || 100);
  const col = materialColor(ctx, type.frameMaterialId || 'mat-paint-white');
  const glass = materialColor(ctx, 'mat-glass');
  const z0 = sill;
  const z1 = Math.min(sill + H, hf.top - hf.base);
  const ext = (el.flipFacing ? -1 : 1) * hf.extSign;
  // Frame sits toward the exterior face.
  const yc = ext * (hf.thick / 2 - fd / 2);
  const y0 = yc - fd / 2;
  const y1 = yc + fd / 2;
  frameBox(b, f, -W / 2, y0, z0, -W / 2 + fw, y1, z1, col);
  frameBox(b, f, W / 2 - fw, y0, z0, W / 2, y1, z1, col);
  frameBox(b, f, -W / 2 + fw, y0, z0, W / 2 - fw, y1, z0 + fw, col);
  frameBox(b, f, -W / 2 + fw, y0, z1 - fw, W / 2 - fw, y1, z1, col);
  const fam = type.family || 'fixed';
  const mullion = fw * 0.8;
  if (fam === 'doubleHung' || fam === 'awning') {
    const zm = (z0 + z1) / 2;
    frameBox(b, f, -W / 2 + fw, y0 + 5, zm - mullion / 2, W / 2 - fw, y1 - 5, zm + mullion / 2, col);
  } else if (fam === 'sliding' || (fam === 'casement' && W > 1000)) {
    frameBox(b, f, -mullion / 2, y0 + 5, z0 + fw, mullion / 2, y1 - 5, z1 - fw, col);
  }
  frameBox(b, f, -W / 2 + fw, yc - 4, z0 + fw, W / 2 - fw, yc + 4, z1 - fw, glass, { edges: false });
  // Sill on the exterior.
  const yo = ext * hf.thick / 2;
  frameBox(b, f, -W / 2 - 30, yo, z0 - 30, W / 2 + 30, yo + ext * 50, z0, col);
  return b.build();
}

// Structure ------------------------------------------------------------------------------

function buildColumn(ctx, el) {
  const type = ctx.doc.get(el.typeId) || {};
  const { base, top } = verticalExtent(ctx.doc, el);
  const b = new MeshBuilder();
  const col = materialColor(ctx, type.materialId || 'mat-concrete');
  const w = +type.width || 450;
  const d = +type.depth || w;
  if (type.shape === 'round') b.cylinder(el.at, w / 2, base, top, col, { segments: 32 });
  else {
    const fr = new Frame(el.at, ((+el.rotation || 0) * Math.PI) / 180, 0);
    b.prism(
      [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ].map((p) => fr.apply(p)),
      [],
      base,
      top,
      col,
    );
  }
  return b.build();
}

function buildBeam(ctx, el) {
  const type = ctx.doc.get(el.typeId) || {};
  const l = len(sub(el.b, el.a));
  if (l < 1) return null;
  const zt = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0);
  const w = +type.width || 300;
  const d = +type.depth || 600;
  const dir = norm(sub(el.b, el.a));
  const n = perp(dir);
  const pts = [add(el.a, scale(n, -w / 2)), add(el.b, scale(n, -w / 2)), add(el.b, scale(n, w / 2)), add(el.a, scale(n, w / 2))];
  const b = new MeshBuilder();
  b.prism(pts, [], zt - d, zt, materialColor(ctx, type.materialId || 'mat-concrete'));
  return b.build();
}

// Stairs and railings ----------------------------------------------------------------------

export function stairGeometry(doc, el) {
  const lay = stairLayout(doc, el);
  const d = sub(el.b, el.a);
  const dir = len(d) > 1 ? norm(d) : [1, 0];
  return { ...lay, dir, side: perp(dir) };
}

function buildStair(ctx, el) {
  const type = ctx.doc.get(el.typeId) || {};
  const g = stairFlights(ctx.doc, el);
  const th = +type.thickness || 150;
  const col = materialColor(ctx, type.materialId || 'mat-concrete');
  const b = new MeshBuilder();
  if (g.spiral) {
    // Wedge treads around a central column, each at its riser height.
    const s = g.spiral;
    const tt = Math.min(th, g.riserHeight * 0.8);
    const arc = (r, a0, a1) => Array.from({ length: 7 }, (_, k) => {
      const a = a0 + ((a1 - a0) * k) / 6;
      return [s.c[0] + Math.cos(a) * r, s.c[1] + Math.sin(a) * r];
    });
    for (let i = 0; i < s.treads; i++) {
      const a0 = s.a0 + s.step * i;
      const a1 = a0 + s.step * 1.04;
      const outer = arc(s.rout, a0, a1);
      const inner = arc(s.rin, a1, a0);
      const z = g.base + (i + 1) * g.riserHeight;
      b.prism([...outer, ...inner], [], z - tt, z, col);
    }
    b.cylinder(s.c, SPIRAL_CORE, g.base, g.base + g.risers * g.riserHeight + 900, materialColor(ctx, 'mat-steel'), { segments: 16 });
    return b.build();
  }
  for (const f of g.flights) buildFlight(b, el, type, f, g, th, col, ctx);
  for (const l of g.landings) b.prism(l.poly, [], l.z - (type.monolithic !== false ? th : 40), l.z, col);
  return b.build();
}

function buildFlight(b, el, type, f, g, th, col, ctx) {
  const { riserHeight: rh, tread: td, width: W } = g;
  const { dir, side } = f;
  const base = f.z0;
  const origin = add(f.start, scale(side, -W / 2));
  const n = f.risers;
  const sEnd = f.run;
  if (n < 2) {
    b.prism(flightOutline({ ...f, run: Math.max(1, td * 0.2) }, W), [], base, base + rh, col);
    return;
  }
  if (type.monolithic !== false) {
    const prof = [[0, base]];
    for (let i = 0; i < n - 1; i++) {
      prof.push([i * td, base + (i + 1) * rh]);
      prof.push([(i + 1) * td, base + (i + 1) * rh]);
    }
    prof.push([sEnd, base + n * rh]);
    const ang = Math.atan2(rh, td);
    const zu = (s) => base + rh + Math.tan(ang) * s - th / Math.cos(ang);
    prof.push([sEnd, Math.max(base, zu(sEnd))]);
    const s0 = Math.max(0, Math.min(sEnd - 1, (th / Math.cos(ang) - rh) / Math.tan(ang)));
    prof.push([s0, base]);
    b.extrudeProfile(dedupe(prof), origin, dir, W, col);
  } else {
    const tt = th;
    for (let i = 0; i < n - 1; i++) {
      const z = base + (i + 1) * rh;
      const s0 = i * td - 25;
      const s1 = (i + 1) * td;
      const pts = [add(origin, scale(dir, s0)), add(origin, scale(dir, s1)), add(add(origin, scale(dir, s1)), scale(side, W)), add(add(origin, scale(dir, s0)), scale(side, W))];
      b.prism(pts, [], z - tt, z, col);
    }
    const ang = Math.atan2(rh, td);
    for (const off of [0, W - 40]) {
      const prof = [
        [0, base],
        [sEnd, base + n * rh - 200],
        [sEnd, base + n * rh],
        [0, base + 200 + rh],
      ];
      void ang;
      b.extrudeProfile(prof, add(origin, scale(side, off)), dir, 40, col);
    }
  }
  if (el.railings !== false) {
    const rail = materialColor(ctx, 'mat-steel');
    const h = 900;
    for (const off of [60, W - 60]) {
      const p0 = add(add(origin, scale(side, off)), scale(dir, td * 0.5));
      const p1 = add(add(origin, scale(side, off)), scale(dir, sEnd - td * 0.2));
      const z0 = base + rh * 1.5 + h;
      const z1 = base + n * rh - rh * 0.2 + h;
      const prof = [
        [0, z0 - 40],
        [len(sub(p1, p0)), z1 - 40],
        [len(sub(p1, p0)), z1],
        [0, z0],
      ];
      b.extrudeProfile(prof, add(p0, scale(side, -20)), dir, 40, rail);
      const posts = Math.max(2, Math.round(sEnd / 1200) + 1);
      for (let i = 0; i < posts; i++) {
        const s = td * 0.5 + ((sEnd - td * 0.7) * i) / (posts - 1);
        const step = Math.min(n - 1, Math.floor(s / td));
        const zb = base + (step + 1) * rh;
        const zt = z0 + ((z1 - z0) * (s - td * 0.5)) / Math.max(1, sEnd - td * 0.7);
        const c = add(add(origin, scale(side, off)), scale(dir, s));
        b.cylinder(c, 15, zb, zt, rail, { segments: 8, edges: false });
      }
    }
  }
}

function buildRailing(ctx, el) {
  if (!el.path || el.path.length < 2) return null;
  const type = ctx.doc.get(el.typeId) || {};
  const z = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0);
  const H = +type.height || 1100;
  const r = +type.rail || 50;
  const bw = +type.baluster || 20;
  const sp = +type.spacing || 110;
  const col = materialColor(ctx, type.materialId || 'mat-steel');
  const glass = materialColor(ctx, 'mat-glass');
  const b = new MeshBuilder();
  for (let i = 0; i + 1 < el.path.length; i++) {
    const a = el.path[i];
    const c = el.path[i + 1];
    const L = len(sub(c, a));
    if (L < 1) continue;
    const dir = norm(sub(c, a));
    const fr = new Frame(a, Math.atan2(dir[1], dir[0]), z);
    frameBox(b, fr, 0, -r / 2, H - r, L, r / 2, H, col);
    if (type.glass) {
      frameBox(b, fr, bw, -6, 80, L - bw, 6, H - r - 30, glass, { edges: false });
      frameBox(b, fr, 0, -bw / 2, 0, bw, bw / 2, H - r, col);
    } else {
      const count = Math.max(1, Math.floor(L / sp));
      for (let k = 0; k <= count; k++) {
        const s = Math.min(L - bw / 2, Math.max(bw / 2, (k * L) / count));
        frameBox(b, fr, s - bw / 2, -bw / 2, 0, s + bw / 2, bw / 2, H - r, col, { edges: false });
      }
    }
  }
  if (type.glass) {
    const last = el.path.at(-1);
    const prev = el.path.at(-2);
    const dir = norm(sub(last, prev));
    const fr = new Frame(last, Math.atan2(dir[1], dir[0]), z);
    frameBox(b, fr, -bw, -bw / 2, 0, 0, bw / 2, H - r, col);
  }
  return b.build();
}

// Components ---------------------------------------------------------------------------------

function buildComponent(ctx, el) {
  const type = ctx.doc.get(el.typeId);
  if (!type) return null;
  const z = levelElevation(ctx.doc, el.levelId) + (+el.offset || 0) + (+type.elevation || 0);
  const frame = new Frame(el.at, ((+el.rotation || 0) * Math.PI) / 180, z);
  const b = new MeshBuilder();
  buildFamily(type, frame, b, (id) => ctx.material(id));
  return b.build();
}
