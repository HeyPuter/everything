// Light object shapes for the viewport (pure geometry, unit tested).
//
// A light is drawn in two parts:
//  - object-space lines: spot cone base circles, area shape, direction lines (lightWireShape);
//  - a screen-facing marker of constant pixel size: a small diamond at the centre inside a
//    double dashed ring, with dashed rays for sun lights (lightMarkerShape). Point and spot
//    lights add a screen-facing circle of their radius in world units.
// The spot cone's side lines are its silhouette as seen from the eye (spotSilhouette).

export type Seg = number[]; // flat xyz pairs

export interface LightShapeData {
  type: 'POINT' | 'SUN' | 'SPOT' | 'AREA';
  spot_size: number;
  spot_blend: number;
  shape?: string;
  size: number;
  size_y: number;
  cutoff_distance?: number;
}

/** Length of the spot cone's sides (object space). */
export const SPOT_CONE_LENGTH = 10;
/** Length of a sun's direction line. */
export const SUN_LINE_LENGTH = 20;

function line(out: Seg, a: number[], b: number[]) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function ring(out: Seg, r: number, z: number, n = 48, rx = r) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2,
      a1 = ((i + 1) / n) * Math.PI * 2;
    line(out, [Math.cos(a0) * rx, Math.sin(a0) * r, z], [Math.cos(a1) * rx, Math.sin(a1) * r, z]);
  }
}

/** Half angle of the fully lit inner cone of a spot with the given blend. */
export function spotBlendAngle(spotSize: number, blend: number): number {
  const c = Math.cos(spotSize / 2);
  const inner = c + (1 - c) * Math.max(0, Math.min(1, blend));
  return Math.acos(Math.min(1, inner));
}

/** Base circle (centre z, radius) of a spot cone of half angle `half`. */
export function spotCircle(half: number, length = SPOT_CONE_LENGTH) {
  return { z: -Math.cos(half) * length, r: Math.sin(half) * length };
}

/** Distance the direction line of a spot / area light reaches. */
export function lightLineLength(la: LightShapeData): number {
  return la.cutoff_distance && la.cutoff_distance > 0 ? la.cutoff_distance : 40;
}

/** Object-space lines of a light (light looks down its local -Z). */
export function lightWireShape(la: LightShapeData): Seg {
  const out: Seg = [];
  if (la.type === 'SUN') line(out, [0, 0, 0], [0, 0, -SUN_LINE_LENGTH]);
  else if (la.type === 'SPOT') {
    const half = Math.min(Math.PI / 2 - 1e-4, la.spot_size / 2);
    const c = spotCircle(half);
    ring(out, c.r, c.z, 64);
    if (la.spot_blend > 0) {
      // the fully lit inner cone, drawn in the plane of the outer circle
      ring(out, -c.z * Math.tan(spotBlendAngle(la.spot_size, la.spot_blend)), c.z, 64);
    }
    line(out, [0, 0, 0], [0, 0, -lightLineLength(la)]);
  } else if (la.type === 'AREA') {
    const sx = la.size / 2,
      sy = (la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE' ? la.size_y : la.size) / 2;
    if (la.shape === 'DISK' || la.shape === 'ELLIPSE') ring(out, sy, 0, 48, sx);
    else {
      const c = [
        [-sx, -sy, 0],
        [sx, -sy, 0],
        [sx, sy, 0],
        [-sx, sy, 0],
      ];
      for (let i = 0; i < 4; i++) line(out, c[i], c[(i + 1) % 4]);
    }
    line(out, [0, 0, 0], [0, 0, -lightLineLength(la)]);
  }
  return out;
}

function dashedRing(out: Seg, r: number, dashes: number, offset: number) {
  const step = (Math.PI * 2) / dashes;
  for (let i = 0; i < dashes; i++) {
    const a0 = i * step + offset,
      a1 = a0 + step * 0.5;
    const n = 3;
    for (let k = 0; k < n; k++) {
      const t0 = a0 + ((a1 - a0) * k) / n,
        t1 = a0 + ((a1 - a0) * (k + 1)) / n;
      line(out, [Math.cos(t0) * r, Math.sin(t0) * r, 0], [Math.cos(t1) * r, Math.sin(t1) * r, 0]);
    }
  }
}

/** Screen-facing marker in pixels (x right, y up). */
export function lightMarkerShape(type: LightShapeData['type']): Seg {
  const out: Seg = [];
  // centre diamond
  const d = 3.5;
  line(out, [0, d, 0], [d, 0, 0]);
  line(out, [d, 0, 0], [0, -d, 0]);
  line(out, [0, -d, 0], [-d, 0, 0]);
  line(out, [-d, 0, 0], [0, d, 0]);
  // two dashed rings, the outer one's dashes offset by half a dash
  dashedRing(out, 10, 12, 0);
  dashedRing(out, 12.5, 12, Math.PI / 12);
  if (type === 'SUN') {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const c = Math.cos(a),
        s = Math.sin(a);
      // dashed ray
      line(out, [c * 16, s * 16, 0], [c * 19.5, s * 19.5, 0]);
      line(out, [c * 22, s * 22, 0], [c * 25, s * 25, 0]);
    }
  }
  return out;
}

/** Unit circle (radius 1) for the light radius, scaled by the radius when drawn. */
export function unitCircle(n = 32): Seg {
  const out: Seg = [];
  ring(out, 1, 0, n);
  return out;
}

/**
 * Silhouette lines of the spot cone (apex at the origin, base circle at z, radius r) seen from
 * `eye` (object space; for orthographic views pass the direction towards the viewer and
 * `ortho`). Returns 0 or 2 segments.
 */
export function spotSilhouette(eye: [number, number, number], z: number, r: number, ortho = false): Seg {
  const h = -z;
  const [ex, ey, ez] = eye;
  const rho = Math.hypot(ex, ey);
  // generator at angle θ is on the silhouette when its surface normal (h cosθ, h sinθ, r) is
  // perpendicular to the direction to the eye from the apex (or to the view direction)
  if (rho < 1e-9) return [];
  const k = (-r * ez) / (h * rho);
  if (Math.abs(k) > 1) return [];
  void ortho;
  const phi = Math.atan2(ey, ex);
  const da = Math.acos(k);
  const out: Seg = [];
  for (const th of [phi + da, phi - da]) line(out, [0, 0, 0], [Math.cos(th) * r, Math.sin(th) * r, z]);
  return out;
}
