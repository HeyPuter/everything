// Sculpt Mode brushes. Every stroke works on the base mesh positions in object space:
// positions are replaced copy-on-write at stroke start, edited in place by each dab, normals and
// GPU buffers are updated locally, and the stroke is committed as one undo step at the end.
import { Matrix3, Quaternion, Vector3 } from 'three';
import { app } from '../app/app';
import { cow, own } from '../data/cow';
import type { MeshData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { activeBrush, brushById, type PaintBrush } from './brushes';
import { falloff, laplacianSmooth, mirror, symmetryPasses } from './math';
import { beginGeometryStroke, meshSession, reevaluate, type Hit, type MeshSession } from './session';
import { runStroke, type Dab } from './stroke';
import { hasMask, invalidatePaintAttributes, maskChanged, writeCornerValues } from './display';
import { normalFactor, strokeAutomask } from './automask';

type Sign = [number, number, number];

interface AnchorPass {
  sign: Sign;
  verts: Int32Array;
  w: Float32Array;
  n: number;
  center: Vector3;
  normal: Vector3;
}

export interface StrokeState {
  v: View3D;
  s: MeshSession;
  me: MeshData;
  brush: PaintBrush;
  tool: string;
  sign: number;
  passes: Sign[];
  orig: Float32Array;
  origN?: Float32Array;
  layer?: Float32Array;
  mask?: Float32Array;
  maskBrush: boolean;
  touchedStamp: Uint32Array;
  stamp: number;
  touched: number[];
  strokeFaces: Uint8Array;
  radiusLocal: number;
  lastHit: Vector3 | null;
  anchor?: {
    startWorld: Vector3;
    startScreen: { x: number; y: number };
    passes: AnchorPass[];
    angle0: number | null;
  };
  snake?: { anchorWorld: Vector3; anchorLocal: Vector3 };
  dabs: number;
  dabTime: number;
  lastEval: number;
  /** static auto-masking factors of this stroke */
  automask?: Float32Array | null;
  /** normal auto-masking: start normal and the current view direction (object space) */
  startNormal?: Vector3 | null;
  viewDir?: Vector3 | null;
}

/** UI callbacks (set by the cursor/UI module; kept out of here so the brush code has no DOM deps). */
export const sculptHooks = {
  afterUpdate: null as null | ((v: View3D) => void),
};

const ANCHORED = new Set(['GRAB', 'THUMB', 'ROTATE']);
let stroke: StrokeState | null = null;

/** Statistics of the last stroke (for profiling / tests). */
export const sculptStats = { dabs: 0, ms: 0, verts: 0 };

function toolSign(b: PaintBrush, invert: boolean) {
  const s = b.direction === 'SUBTRACT' ? -1 : 1;
  return invert ? -s : s;
}

/** Local delta of a world-space vector (linear part of the inverse object matrix). */
function worldToLocalDir(s: MeshSession, d: Vector3): Vector3 {
  const inv = new Matrix3().setFromMatrix4(s.world()).invert();
  return d.clone().applyMatrix3(inv);
}

/** Collect vertices within `radius` of `c` into s.gv/s.gd (distance normalized to the radius). */
function gather(st: StrokeState, c: Vector3, radius: number, viewDir: Vector3 | null, src: Float32Array = st.s.positions): number {
  const s = st.s;
  const P = src,
    vn = s.vn,
    gv = s.gv,
    gd = s.gd;
  const r2 = radius * radius;
  const cx = c.x,
    cy = c.y,
    cz = c.z;
  let n = 0;
  const nv = s.nv;
  const ff = !!st.brush.use_frontface && viewDir;
  const hid = s.hiddenV;
  for (let v = 0; v < nv; v++) {
    if (hid && hid[v]) continue;
    const i = v * 3;
    const dx = P[i] - cx;
    if (dx > radius || dx < -radius) continue;
    const dy = P[i + 1] - cy;
    if (dy > radius || dy < -radius) continue;
    const dz = P[i + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    if (ff && vn[i] * viewDir!.x + vn[i + 1] * viewDir!.y + vn[i + 2] * viewDir!.z > 0) continue;
    gv[n] = v;
    gd[n] = Math.sqrt(d2) / radius;
    n++;
  }
  return n;
}

/** Brush factor for gathered entry k (falloff × strength × (1 - mask)). */
function factors(st: StrokeState, n: number, strength: number, applyMask = true) {
  const s = st.s,
    b = st.brush,
    gf = s.gf,
    gd = s.gd,
    gv = s.gv;
  const fo = b.falloff,
    hard = b.hardness ?? 0;
  const mask = applyMask ? st.mask : undefined;
  const am = applyMask ? st.automask : null;
  const ts = (app as typeof app | undefined)?.doc?.scene.tool_settings.sculpt;
  const sn = applyMask && ts?.use_automasking_start_normal ? st.startNormal : null;
  const vd = applyMask && ts?.use_automasking_view_normal ? st.viewDir : null;
  const vn = s.vn;
  for (let k = 0; k < n; k++) {
    let f = falloff(fo, gd[k], hard) * strength;
    const v = gv[k];
    if (mask) f *= 1 - mask[v];
    if (am) f *= am[v];
    if (sn) f *= normalFactor(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2], sn.x, sn.y, sn.z, ts!.automasking_start_normal_limit ?? 0.35, ts!.automasking_start_normal_falloff ?? 0.25);
    if (vd) f *= normalFactor(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2], -vd.x, -vd.y, -vd.z, ts!.automasking_view_normal_limit ?? 1.57, ts!.automasking_view_normal_falloff ?? 0.25);
    gf[k] = f;
  }
}

/** Area normal and center of the gathered vertices within `nr` (normalized radius). */
function areaPlane(st: StrokeState, n: number, nr: number, fallbackN: Vector3, c: Vector3) {
  const s = st.s,
    P = s.positions,
    vn = s.vn,
    gv = s.gv,
    gd = s.gd;
  let nx = 0,
    ny = 0,
    nz = 0,
    px = 0,
    py = 0,
    pz = 0,
    wsum = 0;
  for (let k = 0; k < n; k++) {
    if (gd[k] > nr) continue;
    const w = 1 - gd[k] / Math.max(nr, 1e-6);
    const i = gv[k] * 3;
    nx += vn[i] * w;
    ny += vn[i + 1] * w;
    nz += vn[i + 2] * w;
    px += P[i] * w;
    py += P[i + 1] * w;
    pz += P[i + 2] * w;
    wsum += w;
  }
  const normal = new Vector3(nx, ny, nz);
  if (normal.lengthSq() < 1e-12) normal.copy(fallbackN);
  normal.normalize();
  const center = wsum > 0 ? new Vector3(px / wsum, py / wsum, pz / wsum) : c.clone();
  return { normal, center };
}

function touch(st: StrokeState, v: number) {
  if (st.touchedStamp[v] !== st.stamp) {
    st.touchedStamp[v] = st.stamp;
    st.touched.push(v);
  }
}

function smoothGathered(st: StrokeState, n: number, amount: number) {
  if (n === 0 || amount <= 0) return;
  const s = st.s,
    gf = s.gf;
  const nb = s.neighbors;
  // stronger smoothing = more iterations of a bounded step
  const iters = Math.max(1, Math.ceil(amount * 2));
  const fac = new Float32Array(n);
  for (let k = 0; k < n; k++) fac[k] = Math.min(1, (gf[k] * amount) / iters / Math.max(1e-6, amount));
  for (let it = 0; it < iters; it++) laplacianSmooth(s.positions, nb.offsets, nb.neighbors, s.gv, fac, n, s.tmp);
  for (let k = 0; k < n; k++) touch(st, s.gv[k]);
}

// ---------------------------------------------------------------------------
// brush tools

function applyTool(st: StrokeState, tool: string, n: number, c: Vector3, sgnv: Sign, area: { normal: Vector3; center: Vector3 }, R: number, strokeDir: Vector3 | null) {
  const s = st.s,
    P = s.positions,
    vn = s.vn,
    gv = s.gv,
    gf = s.gf,
    gd = s.gd;
  const N = area.normal,
    C = area.center;
  const sign = st.sign;
  const b = st.brush;
  switch (tool) {
    case 'DRAW':
    case 'DRAW_SHARP': {
      const k = R * 0.1 * sign;
      for (let i = 0; i < n; i++) {
        const v = gv[i] * 3,
          f = gf[i] * k;
        P[v] += N.x * f;
        P[v + 1] += N.y * f;
        P[v + 2] += N.z * f;
        touch(st, gv[i]);
      }
      break;
    }
    case 'INFLATE': {
      const k = R * 0.06 * sign;
      for (let i = 0; i < n; i++) {
        const v = gv[i] * 3,
          f = gf[i] * k;
        P[v] += vn[v] * f;
        P[v + 1] += vn[v + 1] * f;
        P[v + 2] += vn[v + 2] * f;
        touch(st, gv[i]);
      }
      break;
    }
    case 'BLOB': {
      const k = R * 0.08 * sign;
      for (let i = 0; i < n; i++) {
        const v = gv[i] * 3;
        let dx = P[v] - c.x,
          dy = P[v + 1] - c.y,
          dz = P[v + 2] - c.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l;
        dy /= l;
        dz /= l;
        const f = gf[i] * k;
        P[v] += (N.x * 0.6 + dx * 0.4) * f;
        P[v + 1] += (N.y * 0.6 + dy * 0.4) * f;
        P[v + 2] += (N.z * 0.6 + dz * 0.4) * f;
        touch(st, gv[i]);
      }
      break;
    }
    case 'CREASE': {
      const k = R * 0.08 * sign;
      const pinch = (b.crease_pinch_factor ?? 0.5) * 0.35;
      for (let i = 0; i < n; i++) {
        const v = gv[i] * 3,
          f = gf[i];
        let dx = c.x - P[v],
          dy = c.y - P[v + 1],
          dz = c.z - P[v + 2];
        const dn = dx * N.x + dy * N.y + dz * N.z;
        dx -= N.x * dn;
        dy -= N.y * dn;
        dz -= N.z * dn;
        P[v] += N.x * f * k + dx * f * pinch;
        P[v + 1] += N.y * f * k + dy * f * pinch;
        P[v + 2] += N.z * f * k + dz * f * pinch;
        touch(st, gv[i]);
      }
      break;
    }
    case 'LAYER': {
      if (!st.layer) st.layer = new Float32Array(s.nv);
      if (!st.origN) st.origN = s.vn.slice();
      const L = st.layer,
        O = st.orig,
        ON = st.origN;
      const h = R * 0.3 * sign;
      for (let i = 0; i < n; i++) {
        const vi = gv[i],
          v = vi * 3;
        L[vi] = Math.min(1, L[vi] + gf[i] * 0.5);
        const m = st.mask ? 1 - st.mask[vi] : 1;
        const d = L[vi] * h * m;
        P[v] = O[v] + ON[v] * d;
        P[v + 1] = O[v + 1] + ON[v + 1] * d;
        P[v + 2] = O[v + 2] + ON[v + 2] * d;
        touch(st, vi);
      }
      break;
    }
    case 'SMOOTH':
      smoothGathered(st, n, 1);
      break;
    case 'FLATTEN':
    case 'FILL':
    case 'SCRAPE':
    case 'CLAY':
    case 'CLAY_STRIPS': {
      const clay = tool === 'CLAY' || tool === 'CLAY_STRIPS';
      // plane: area center offset along the normal (clay builds toward a raised plane)
      const off = ((b.plane_offset ?? 0) + (clay ? (tool === 'CLAY_STRIPS' ? 0.18 : 0.12) : 0)) * R * (clay ? sign : 1);
      const px = C.x + N.x * off,
        py = C.y + N.y * off,
        pz = C.z + N.z * off;
      const strength = clay ? 0.5 : 0.35;
      for (let i = 0; i < n; i++) {
        const v = gv[i] * 3;
        const d = (P[v] - px) * N.x + (P[v + 1] - py) * N.y + (P[v + 2] - pz) * N.z;
        let move = 0;
        if (tool === 'FLATTEN') move = sign > 0 ? -d : d * 0.5;
        else if (tool === 'FILL') move = d < 0 ? (sign > 0 ? -d : d * 0.5) : 0;
        else if (tool === 'SCRAPE') move = d > 0 ? (sign > 0 ? -d : d * 0.5) : 0;
        else {
          // clay: only vertices on the near side of the raised plane move toward it
          const ds = d * sign;
          move = ds < 0 ? -d : 0;
        }
        if (!move) continue;
        const f = gf[i] * strength * move;
        P[v] += N.x * f;
        P[v + 1] += N.y * f;
        P[v + 2] += N.z * f;
        touch(st, gv[i]);
      }
      void strokeDir;
      break;
    }
    case 'PINCH': {
      const k = 0.25 * sign;
      for (let i = 0; i < n; i++) {
        const v = gv[i] * 3,
          f = gf[i] * k;
        let dx = c.x - P[v],
          dy = c.y - P[v + 1],
          dz = c.z - P[v + 2];
        const dn = dx * N.x + dy * N.y + dz * N.z;
        dx -= N.x * dn;
        dy -= N.y * dn;
        dz -= N.z * dn;
        P[v] += dx * f;
        P[v + 1] += dy * f;
        P[v + 2] += dz * f;
        touch(st, gv[i]);
      }
      break;
    }
    case 'MASK': {
      const M = st.mask!;
      const mt = b.mask_tool ?? 'DRAW';
      if (mt === 'SMOOTH') {
        smoothMask(st, n);
        break;
      }
      for (let i = 0; i < n; i++) {
        const vi = gv[i];
        const f = Math.min(1, gf[i]);
        M[vi] = sign > 0 ? Math.max(M[vi], f) : Math.min(M[vi], 1 - f);
        touch(st, vi);
      }
      break;
    }
  }
  void gd;
  void sgnv;
}

function smoothMask(st: StrokeState, n: number) {
  const s = st.s,
    M = st.mask!,
    nb = s.neighbors;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = s.gv[k];
    let sum = 0;
    const a = nb.offsets[v],
      e = nb.offsets[v + 1];
    for (let j = a; j < e; j++) sum += M[nb.neighbors[j]];
    const avg = e > a ? sum / (e - a) : M[v];
    out[k] = M[v] + (avg - M[v]) * Math.min(1, s.gf[k]);
  }
  for (let k = 0; k < n; k++) {
    M[s.gv[k]] = out[k];
    touch(st, s.gv[k]);
  }
}

// ---------------------------------------------------------------------------
// stroke

function strokeTool(b: PaintBrush, smoothToggle: boolean) {
  if (smoothToggle) return b.sculpt_tool === 'MASK' ? 'MASK_SMOOTH' : 'SMOOTH';
  return b.sculpt_tool;
}

function dab(st: StrokeState, d: Dab, tool: string) {
  const t0 = performance.now();
  const { v, s, brush: b } = st;
  st.touched.length = 0;
  if (++st.stamp >= 0xfffffff0) {
    st.touchedStamp.fill(0);
    st.stamp = 1;
  }
  const strength = Math.max(0, b.strength) * d.pressure;
  const sym = app.doc.scene.tool_settings.sculpt;
  if (sym.use_automasking_view_normal) st.viewDir = s.localRay(v, d.x, d.y).direction;

  if (ANCHORED.has(tool)) {
    if (d.first) {
      const hit = s.raycast(v, d.x, d.y);
      if (!hit) return;
      st.radiusLocal = s.pixelsToLocal(v, hit.world, b.radius);
      const viewDir = s.localRay(v, d.x, d.y).direction;
      const passes: AnchorPass[] = [];
      for (const sg of st.passes) {
        const c = new Vector3(...mirror(hit.point.toArray(), sg));
        const n = gather(st, c, st.radiusLocal, mirrorVec(viewDir, sg));
        factors(st, n, tool === 'ROTATE' ? Math.min(1, strength * 2) : Math.min(1, strength * 1.5));
        const area = areaPlane(st, n, b.normal_radius_factor ?? 0.5, new Vector3(...mirror(hit.normal.toArray(), sg)), c);
        passes.push({
          sign: sg,
          verts: s.gv.slice(0, n),
          w: s.gf.slice(0, n),
          n,
          center: c,
          normal: area.normal,
        });
      }
      st.anchor = {
        startWorld: hit.world.clone(),
        startScreen: { x: d.x, y: d.y },
        passes,
        angle0: null,
      };
      return;
    }
    const an = st.anchor;
    if (!an) return;
    const curWorld = v.unproject(d.x, d.y, an.startWorld);
    const deltaLocal = worldToLocalDir(s, curWorld.clone().sub(an.startWorld));
    const P = s.positions,
      O = st.orig;
    let angle = 0;
    if (tool === 'ROTATE') {
      const dx = d.x - an.startScreen.x,
        dy = d.y - an.startScreen.y;
      if (Math.hypot(dx, dy) > 6) {
        const a = Math.atan2(dy, dx);
        if (an.angle0 === null) an.angle0 = a;
        angle = a - an.angle0;
      }
    }
    for (const pass of an.passes) {
      const dl = mirrorVec(deltaLocal, pass.sign);
      let q: Quaternion | null = null;
      if (tool === 'ROTATE') {
        const axis = pass.normal.clone();
        const vd = mirrorVec(s.localRay(v, an.startScreen.x, an.startScreen.y).direction, pass.sign);
        if (axis.dot(vd) > 0) axis.negate();
        // mirrored passes rotate the other way so the result stays symmetric
        const flip = pass.sign[0] * pass.sign[1] * pass.sign[2];
        q = new Quaternion();
        void q;
        for (let k = 0; k < pass.n; k++) {
          const vi = pass.verts[k],
            i = vi * 3;
          const qa = new Quaternion().setFromAxisAngle(axis, -angle * pass.w[k] * flip);
          const p = new Vector3(O[i] - pass.center.x, O[i + 1] - pass.center.y, O[i + 2] - pass.center.z).applyQuaternion(qa);
          P[i] = pass.center.x + p.x;
          P[i + 1] = pass.center.y + p.y;
          P[i + 2] = pass.center.z + p.z;
          touch(st, vi);
        }
        continue;
      }
      if (tool === 'THUMB') dl.addScaledVector(pass.normal, -dl.dot(pass.normal));
      for (let k = 0; k < pass.n; k++) {
        const vi = pass.verts[k],
          i = vi * 3,
          w = pass.w[k];
        P[i] = O[i] + dl.x * w;
        P[i + 1] = O[i + 1] + dl.y * w;
        P[i + 2] = O[i + 2] + dl.z * w;
        touch(st, vi);
      }
    }
  } else if (tool === 'SNAKE_HOOK') {
    if (d.first) {
      const hit = s.raycast(v, d.x, d.y);
      if (!hit) return;
      st.radiusLocal = s.pixelsToLocal(v, hit.world, b.radius);
      st.snake = {
        anchorWorld: hit.world.clone(),
        anchorLocal: hit.point.clone(),
      };
      return;
    }
    const sn = st.snake;
    if (!sn) return;
    const curWorld = v.unproject(d.x, d.y, sn.anchorWorld);
    const delta = worldToLocalDir(s, curWorld.clone().sub(sn.anchorWorld));
    const P = s.positions;
    for (const sg of st.passes) {
      const c = mirrorVec(sn.anchorLocal, sg);
      const dl = mirrorVec(delta, sg);
      const n = gather(st, c, st.radiusLocal, null);
      factors(st, n, Math.min(1, strength * 1.2));
      for (let k = 0; k < n; k++) {
        const vi = s.gv[k],
          i = vi * 3,
          w = s.gf[k];
        P[i] += dl.x * w;
        P[i + 1] += dl.y * w;
        P[i + 2] += dl.z * w;
        touch(st, vi);
      }
    }
    sn.anchorWorld.copy(curWorld);
    sn.anchorLocal.add(delta);
  } else {
    const hit: Hit | null = s.raycast(v, d.x, d.y);
    if (!hit) return;
    const R = s.pixelsToLocal(v, hit.world, b.radius);
    st.radiusLocal = R;
    const viewDir = s.localRay(v, d.x, d.y).direction;
    const strokeDir = st.lastHit ? hit.point.clone().sub(st.lastHit) : null;
    if (tool === 'NUDGE') {
      if (st.lastHit && strokeDir && strokeDir.lengthSq() > 0) {
        for (const sg of st.passes) {
          const c = mirrorVec(st.lastHit, sg);
          const n = gather(st, c, R, mirrorVec(viewDir, sg));
          factors(st, n, strength);
          const area = areaPlane(st, n, b.normal_radius_factor ?? 0.5, mirrorVec(hit.normal, sg), c);
          const dl = mirrorVec(strokeDir, sg);
          dl.addScaledVector(area.normal, -dl.dot(area.normal));
          const P = s.positions;
          for (let k = 0; k < n; k++) {
            const i = s.gv[k] * 3,
              w = s.gf[k] * 0.6;
            P[i] += dl.x * w;
            P[i + 1] += dl.y * w;
            P[i + 2] += dl.z * w;
            touch(st, s.gv[k]);
          }
        }
      }
    } else {
      surfaceDab(st, tool, hit.point, hit.normal, viewDir, R, strokeDir, strength);
    }
    st.lastHit = hit.point.clone();
  }

  // normals + GPU buffers for everything this dab moved
  if (st.touched.length) {
    if (st.maskBrush) {
      writeCornerValues(s, 'paintMask', st.mask!, st.touched, st.touched.length);
    } else {
      const faces = s.updateNormals(st.touched, st.touched.length);
      for (const f of faces) st.strokeFaces[f] = 1;
      s.writeFaces(faces, st.me.smooth);
    }
  }
  st.dabs++;
  st.dabTime += performance.now() - t0;
  void sym;
}

/**
 * One dab of a surface brush (everything except the anchored/snake tools) at an object-space
 * point with all symmetry passes. Exported for tests.
 */
export function surfaceDab(st: StrokeState, tool: string, point: Vector3, normal: Vector3, viewDir: Vector3, R: number, strokeDir: Vector3 | null, strength: number) {
  const s = st.s,
    b = st.brush;
  const hit = { point, normal };
  const realTool = tool === 'MASK_SMOOTH' ? 'MASK' : tool;
  const square = realTool === 'CLAY_STRIPS';
  for (const sg of st.passes) {
    const c = mirrorVec(hit.point, sg);
    const vd = mirrorVec(viewDir, sg);
    const n = gather(st, c, square ? R * Math.SQRT2 : R, vd, realTool === 'DRAW_SHARP' ? st.orig : s.positions);
    if (!n) continue;
    const area = areaPlane(st, n, b.normal_radius_factor ?? 0.5, mirrorVec(hit.normal, sg), c);
    if (square) {
      // square footprint aligned with the stroke direction in the area plane
      const X = strokeDir && strokeDir.lengthSq() > 1e-12 ? mirrorVec(strokeDir, sg) : new Vector3(1, 0, 0);
      X.addScaledVector(area.normal, -X.dot(area.normal));
      if (X.lengthSq() < 1e-12) X.set(0, 1, 0).addScaledVector(area.normal, -area.normal.y);
      X.normalize();
      const Y = area.normal.clone().cross(X);
      const P = s.positions;
      for (let k = 0; k < n; k++) {
        const i = s.gv[k] * 3;
        const dx = P[i] - c.x,
          dy = P[i + 1] - c.y,
          dz = P[i + 2] - c.z;
        const lx = Math.abs(dx * X.x + dy * X.y + dz * X.z) / R,
          ly = Math.abs(dx * Y.x + dy * Y.y + dz * Y.z) / R;
        s.gd[k] = Math.max(lx, ly);
      }
    }
    if (realTool === 'MASK') {
      factors(st, n, tool === 'MASK_SMOOTH' ? 1 : strength, false);
      if (tool === 'MASK_SMOOTH') smoothMask(st, n);
      else applyTool(st, 'MASK', n, c, sg, area, R, strokeDir);
      continue;
    }
    factors(st, n, realTool === 'SMOOTH' ? Math.min(1, strength) : strength);
    applyTool(st, realTool, n, c, sg, area, R, strokeDir);
    const auto = b.auto_smooth_factor ?? 0;
    if (auto > 0 && realTool !== 'SMOOTH') {
      factors(st, n, auto);
      smoothGathered(st, n, 1);
    }
  }
}

/** Stroke state without a viewport (tests / scripted strokes). */
export function createStrokeState(s: MeshSession, me: MeshData, brush: PaintBrush, opts: { invert?: boolean; symmetry?: [boolean, boolean, boolean] } = {}): StrokeState {
  const sym = opts.symmetry ?? [false, false, false];
  return {
    v: null as unknown as View3D,
    s,
    me,
    brush,
    tool: brush.sculpt_tool,
    sign: toolSign(brush, !!opts.invert),
    passes: symmetryPasses(sym[0], sym[1], sym[2]),
    orig: me.positions.slice(),
    mask: me.sculpt_mask,
    maskBrush: brush.sculpt_tool === 'MASK',
    touchedStamp: new Uint32Array(s.nv),
    stamp: 1,
    touched: [],
    strokeFaces: new Uint8Array(s.nf),
    radiusLocal: 0,
    lastHit: null,
    dabs: 0,
    dabTime: 0,
    lastEval: 0,
  };
}

function mirrorVec(v: Vector3, s: Sign): Vector3 {
  return new Vector3(v.x * s[0], v.y * s[1], v.z * s[2]);
}

/** Start a sculpt stroke (LMB in Sculpt Mode). */
export function sculptStroke(v: View3D, e: PointerEvent, override?: PaintBrush | null): boolean {
  const b0 = override ?? activeBrush('SCULPT');
  const s = meshSession();
  const ob = app.activeObject;
  const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
  if (!b0 || !s || !me || !ob) return false;
  const smoothToggle = e.shiftKey;
  // Shift: temporary Smooth brush (keeps the current radius), Mask brush smooths the mask
  const smoothBrush = smoothToggle && b0.sculpt_tool !== 'MASK' ? brushById('brush_smooth') : null;
  const brush: PaintBrush = smoothBrush ? { ...smoothBrush, radius: b0.radius, use_frontface: b0.use_frontface } : b0;
  const tool = strokeTool(b0, smoothToggle);
  const maskBrush = tool === 'MASK' || tool === 'MASK_SMOOTH';
  // the first hit decides whether the stroke starts on the surface
  const ANCH = ANCHORED.has(tool) || tool === 'SNAKE_HOOK';
  const firstHit = s.raycast(v, v.local(e).x, v.local(e).y);
  if (!firstHit) return false;
  void ANCH;
  const old = me.positions;
  beginGeometryStroke(s, me, () => {
    if (maskBrush) {
      if (!me.sculpt_mask || me.sculpt_mask.length !== s.nv) me.sculpt_mask = own(new Float32Array(s.nv));
      else cow(me, 'sculpt_mask');
    } else cow(me, 'positions');
  });
  if (maskBrush) {
    maskChanged(me.sculpt_mask!);
    invalidatePaintAttributes();
  }
  const ts = app.doc.scene.tool_settings.sculpt;
  const st: StrokeState = {
    v,
    s,
    me,
    brush,
    tool,
    sign: toolSign(brush, e.ctrlKey || e.metaKey),
    passes: symmetryPasses(ts.use_symmetry_x, ts.use_symmetry_y, ts.use_symmetry_z),
    orig: old !== me.positions ? old : me.positions.slice(),
    mask: me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : undefined,
    maskBrush,
    touchedStamp: new Uint32Array(s.nv),
    stamp: 1,
    touched: [],
    strokeFaces: new Uint8Array(s.nf),
    radiusLocal: 0,
    lastHit: null,
    dabs: 0,
    dabTime: 0,
    lastEval: 0,
  };
  if (!hasMask(st.mask) && !maskBrush) st.mask = undefined;
  st.automask = strokeAutomask(s, me, ts, firstHit.face);
  st.startNormal = firstHit.normal.clone();
  stroke = st;
  runStroke(v, e, {
    spacing: () => (ANCHORED.has(tool) ? 0 : Math.max(1, brush.spacing || 10)),
    radiusPx: () => brush.radius,
    dab: (d) => dab(st, d, tool),
    update: () => {
      if (st.maskBrush) {
        maskChanged(st.mask!);
        const m = s.syncedMesh();
        if (!m?.geometry.getAttribute('paintMask')) invalidatePaintAttributes();
        s.flush();
        app.changed('ui');
        return;
      }
      if (s.direct) s.flush();
      else {
        const now = performance.now();
        if (now - st.lastEval > 30) {
          st.lastEval = now;
          reevaluate(s);
        }
      }
      sculptHooks.afterUpdate?.(v);
    },
    end: () => {
      stroke = null;
      sculptStats.dabs = st.dabs;
      sculptStats.ms = st.dabTime;
      sculptStats.verts = s.nv;
      if (!st.maskBrush) {
        updateFlatNormals(st);
        s.finishGeometry();
        if (!s.direct) reevaluate(s);
      } else {
        maskChanged(st.mask!);
        invalidatePaintAttributes();
      }
      app.pushUndo(maskBrush ? 'Mask' : brush.name);
      app.changed('doc');
    },
  });
  return true;
}

/** Keep the per-corner flat normals of the mesh (used by polygon tools) in sync after a stroke. */
function updateFlatNormals(st: StrokeState) {
  const me = st.me,
    s = st.s;
  if (me.normals.length !== s.nc * 3) return;
  const N = cow(me, 'normals');
  const fn = s.fn;
  for (let f = 0; f < s.nf; f++) {
    if (!st.strokeFaces[f]) continue;
    const l = Math.hypot(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]) || 1;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      N[c * 3] = fn[f * 3] / l;
      N[c * 3 + 1] = fn[f * 3 + 1] / l;
      N[c * 3 + 2] = fn[f * 3 + 2] / l;
    }
  }
}

export function sculptStrokeActive() {
  return !!stroke;
}
