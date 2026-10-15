// Shadow options of the realtime engine: map resolution from the per-light texel limit, filter
// radius, and jittered soft shadows (the shadow-casting position moves across the light's shape
// from sample to sample, so accumulated samples give physically sized penumbrae).
import { Matrix4, Quaternion, Vector3 } from 'three';
import { halton } from '../final/units';
import { shadowMapSize } from './settings';

/** Point on the unit disk for jitter sample `i` (low-discrepancy, area uniform). */
export function diskSample(i: number): [number, number] {
  const r = Math.sqrt(halton(i + 1, 2));
  const a = 2 * Math.PI * halton(i + 1, 3);
  return [r * Math.cos(a), r * Math.sin(a)];
}

/**
 * Jittered light matrix: point / spot lights move within their radius across the plane facing
 * `toward` (the scene); suns tilt within their angular radius. `base` is not modified.
 */
export function jitteredLightMatrix(base: Matrix4, kind: 'point' | 'spot' | 'sun', radius: number, angle: number, i: number, toward: Vector3, out = new Matrix4()): Matrix4 {
  const [u, v] = diskSample(i);
  const pos = new Vector3(),
    rot = new Quaternion(),
    scl = new Vector3();
  base.decompose(pos, rot, scl);
  if (kind === 'sun') {
    // tilt the light's -Z axis by up to half the angular diameter
    const t = Math.tan(angle / 2);
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.atan(v * t)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.atan(u * t)));
    return out.compose(pos, rot.multiply(q), scl);
  }
  // offset across the plane perpendicular to the direction from the light to the scene
  const d = toward.clone().sub(pos);
  if (d.lengthSq() < 1e-12) d.set(0, 0, -1);
  d.normalize();
  const a = Math.abs(d.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
  const x = new Vector3().crossVectors(d, a).normalize();
  const y = new Vector3().crossVectors(d, x);
  pos.addScaledVector(x, u * radius).addScaledVector(y, v * radius);
  return out.compose(pos, rot, scl);
}

export interface ShadowMapRequest {
  kind: 'point' | 'spot' | 'sun';
  /** world-space size covered by the map at the shadowed surfaces */
  coverage: number;
  /** world-space size covered 1 unit away from the light (absolute limits) */
  unitCoverage: number;
  limit: number;
  absolute: boolean;
  /** Sampling ▸ Shadows ▸ Cube / Cascade Size */
  budget: number;
  scale: number;
}

/** Shadow map size per light. Point lights render six faces into one texture: their faces stay smaller. */
export function lightShadowMapSize(q: ShadowMapRequest): number {
  const cap = q.kind === 'point' ? Math.min(1024, q.budget * 2) : q.kind === 'spot' ? Math.min(2048, q.budget * 2) : Math.min(4096, q.budget * 2);
  return shadowMapSize(q.absolute ? q.unitCoverage : q.coverage, q.limit, cap, q.scale);
}
