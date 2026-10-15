// Extra viewport navigation helpers: axis-aligned views (Alt while orbiting, relative axis views)
// and the Alt + middle mouse button gestures.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app } from '../../app/app';
import type { ViewName } from '../../render/navcam';
import type { View3D } from './view3d';

const AXES = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)];

function nearestAxis(v: Vector3, exclude?: Vector3): Vector3 {
  let best = AXES[0],
    bd = -Infinity;
  for (const a of AXES) {
    if (exclude && Math.abs(a.dot(exclude)) > 0.5) continue;
    const d = a.dot(v);
    if (d > bd) {
      bd = d;
      best = a;
    }
  }
  return best.clone();
}

/** Name of the axis view looking from `eye` (unit axis from the pivot towards the viewer). */
function viewNameFor(eye: Vector3): ViewName {
  if (eye.z > 0.5) return 'TOP';
  if (eye.z < -0.5) return 'BOTTOM';
  if (eye.y < -0.5) return 'FRONT';
  if (eye.y > 0.5) return 'BACK';
  if (eye.x > 0.5) return 'RIGHT';
  return 'LEFT';
}

/** View rotation looking along -`back` with screen-up `up` (both snapped to world axes). */
export function axisAlignedRotation(back: Vector3, up: Vector3): { rot: Quaternion; name: ViewName } {
  const z = nearestAxis(back);
  const y = nearestAxis(up, z);
  const x = new Vector3().crossVectors(y, z);
  const m = new Matrix4().makeBasis(x, y, z);
  return { rot: new Quaternion().setFromRotationMatrix(m), name: viewNameFor(z) };
}

/** Snap a view to the nearest axis view (keeps the pivot and distance). */
export function snapViewToAxis(v: View3D, rot: Quaternion) {
  const back = new Vector3(0, 0, 1).applyQuaternion(rot),
    up = new Vector3(0, 1, 0).applyQuaternion(rot);
  const a = axisAlignedRotation(back, up);
  v.nav.rot.copy(a.rot);
  v.nav.view = a.name;
}

/**
 * Relative axis view: look from the side of the scene that is currently towards `type`
 * on screen (e.g. TOP looks down from what is now "up").
 */
export function relativeAxisView(v: View3D, type: string) {
  const nav = v.nav;
  const right = nav.right,
    up = nav.up,
    back = nav.forward.negate();
  let eye: Vector3, newUp: Vector3;
  switch (type) {
    case 'TOP':
      eye = up;
      newUp = back.clone().negate();
      break;
    case 'BOTTOM':
      eye = up.clone().negate();
      newUp = back;
      break;
    case 'RIGHT':
      eye = right;
      newUp = up;
      break;
    case 'LEFT':
      eye = right.clone().negate();
      newUp = up;
      break;
    case 'BACK':
      eye = back.clone().negate();
      newUp = up;
      break;
    default:
      eye = back;
      newUp = up;
  }
  const a = axisAlignedRotation(eye, newUp);
  nav.rot.copy(a.rot);
  nav.view = a.name;
  if (nav.autoPersp && !nav.ortho) {
    nav.ortho = true;
    nav.wasAutoOrtho = true;
  }
}


/** Alt + middle mouse: a click centers the view on the surface under the mouse, a drag turns to the axis view on that side. */
export function altMiddle(v: View3D, e: PointerEvent) {
  const sx = e.clientX,
    sy = e.clientY;
  let done = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - sx,
      dy = ev.clientY - sy;
    if (done || Math.hypot(dx, dy) < 12) return;
    done = true;
    const type = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'LEFT' : 'RIGHT') : dy > 0 ? 'TOP' : 'BOTTOM';
    app.run('view3d.view_axis', { type, relative: true });
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (!done) app.run('view3d.view_center_pick', {}, { event: { x: sx, y: sy } });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  void v;
}

// ---------------------------------------------------------------------------
// Scene ray casting (walk navigation gravity & teleport)

const boxCache = new Map<string, { version: number; mesh: unknown; min: Vector3; max: Vector3 }>();

function localBox(id: string, version: number, P: ArrayLike<number>, mesh: unknown) {
  const c = boxCache.get(id);
  if (c && c.version === version && c.mesh === mesh) return c;
  const min = new Vector3(Infinity, Infinity, Infinity),
    max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < P.length; i += 3) {
    min.x = Math.min(min.x, P[i]);
    min.y = Math.min(min.y, P[i + 1]);
    min.z = Math.min(min.z, P[i + 2]);
    max.x = Math.max(max.x, P[i]);
    max.y = Math.max(max.y, P[i + 1]);
    max.z = Math.max(max.z, P[i + 2]);
  }
  const e = { version, mesh, min, max };
  boxCache.set(id, e);
  return e;
}

function rayBox(o: Vector3, d: Vector3, min: Vector3, max: Vector3, far: number) {
  let t0 = 0,
    t1 = far;
  for (const k of ['x', 'y', 'z'] as const) {
    const inv = 1 / d[k];
    let a = (min[k] - o[k]) * inv,
      b = (max[k] - o[k]) * inv;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t1 < t0) return false;
  }
  return true;
}

/** Nearest hit of a world-space ray with visible meshes (distance along the unit direction). */
export function raycastScene(origin: Vector3, dir: Vector3, far = 1e5, skip?: (id: string) => boolean): { point: Vector3; distance: number } | null {
  let best = far;
  let hit: Vector3 | null = null;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    e1 = new Vector3(),
    e2 = new Vector3(),
    pv = new Vector3(),
    tv = new Vector3(),
    qv = new Vector3();
  for (const ev of app.graph.objects.values()) {
    const m = ev.mesh;
    if (!ev.visible || !m || m.offsets.length < 2 || skip?.(ev.id)) continue;
    const inv = ev.world.clone().invert();
    const o = origin.clone().applyMatrix4(inv);
    // the world direction mapped linearly into object space keeps t in world units
    const localDir = dir.clone().applyMatrix4(new Matrix4().copy(inv).setPosition(0, 0, 0));
    const box = localBox(ev.id, ev.geomVersion, m.positions, m);
    if (!rayBox(o, localDir, box.min, box.max, Infinity)) continue;
    const P = m.positions;
    for (let f = 0; f < m.offsets.length - 1; f++) {
      const s = m.offsets[f],
        en = m.offsets[f + 1];
      for (let k = s + 1; k < en - 1; k++) {
        a.fromArray(P, m.indices[s] * 3);
        b.fromArray(P, m.indices[k] * 3);
        c.fromArray(P, m.indices[k + 1] * 3);
        e1.subVectors(b, a);
        e2.subVectors(c, a);
        pv.crossVectors(localDir, e2);
        const det = e1.dot(pv);
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        tv.subVectors(o, a);
        const u = tv.dot(pv) * id;
        if (u < 0 || u > 1) continue;
        qv.crossVectors(tv, e1);
        const vv = localDir.dot(qv) * id;
        if (vv < 0 || u + vv > 1) continue;
        const t = e2.dot(qv) * id;
        if (t > 1e-6 && t < best) {
          best = t;
          hit = o.clone().addScaledVector(localDir, t).applyMatrix4(ev.world);
        }
      }
    }
  }
  return hit ? { point: hit, distance: best } : null;
}
