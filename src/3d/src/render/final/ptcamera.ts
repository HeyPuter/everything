// Panoramic cameras for the path tracer: camera rays for equirectangular, equiangular cube face,
// mirror ball, fisheye (equidistant, equisolid, lens polynomial) and central cylindrical
// projections. The camera's view direction is -Z, +X is right and +Y is up in camera space.
import { Vector4 } from 'three';
import type { CameraData } from '../../data/types';

export type PanoramaType = 'EQUIRECTANGULAR' | 'EQUIANGULAR_CUBEMAP_FACE' | 'MIRRORBALL' | 'FISHEYE_EQUIDISTANT' | 'FISHEYE_EQUISOLID' | 'FISHEYE_LENS_POLYNOMIAL' | 'CENTRAL_CYLINDRICAL';

export const PANORAMA_TYPES: [PanoramaType, string][] = [
  ['EQUIRECTANGULAR', 'Equirectangular'],
  ['EQUIANGULAR_CUBEMAP_FACE', 'Equiangular Cubemap Face'],
  ['MIRRORBALL', 'Mirror Ball'],
  ['FISHEYE_EQUIDISTANT', 'Fisheye Equidistant'],
  ['FISHEYE_EQUISOLID', 'Fisheye Equisolid'],
  ['FISHEYE_LENS_POLYNOMIAL', 'Fisheye Lens Polynomial'],
  ['CENTRAL_CYLINDRICAL', 'Central Cylindrical'],
];

/** Panoramic settings of a camera (bpy names) with defaults. */
export interface PanoramaSettings {
  panorama_type: PanoramaType;
  fisheye_fov: number;
  fisheye_lens: number;
  latitude_min: number;
  latitude_max: number;
  longitude_min: number;
  longitude_max: number;
  fisheye_polynomial_k0: number;
  fisheye_polynomial_k1: number;
  fisheye_polynomial_k2: number;
  fisheye_polynomial_k3: number;
  fisheye_polynomial_k4: number;
  central_cylindrical_range_u_min: number;
  central_cylindrical_range_u_max: number;
  central_cylindrical_range_v_min: number;
  central_cylindrical_range_v_max: number;
  central_cylindrical_radius: number;
}

export function defaultPanorama(): PanoramaSettings {
  return {
    panorama_type: 'FISHEYE_EQUISOLID',
    fisheye_fov: Math.PI,
    fisheye_lens: 10.5,
    latitude_min: -Math.PI / 2,
    latitude_max: Math.PI / 2,
    longitude_min: -Math.PI,
    longitude_max: Math.PI,
    // a typical wide fisheye lens (radius on the sensor in mm → angle)
    fisheye_polynomial_k0: 0,
    fisheye_polynomial_k1: -0.0195,
    fisheye_polynomial_k2: 0,
    fisheye_polynomial_k3: 3e-6,
    fisheye_polynomial_k4: 0,
    central_cylindrical_range_u_min: -Math.PI,
    central_cylindrical_range_u_max: Math.PI,
    central_cylindrical_range_v_min: -1,
    central_cylindrical_range_v_max: 1,
    central_cylindrical_radius: 1,
  };
}

/** The camera's panoramic settings with every field present. */
export function panorama(ca: CameraData): PanoramaSettings {
  const c = ca as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(defaultPanorama())) if (c[k] === undefined) c[k] = v;
  return ca as unknown as PanoramaSettings;
}

const TYPE_INDEX: Record<PanoramaType, number> = {
  EQUIRECTANGULAR: 1,
  EQUIANGULAR_CUBEMAP_FACE: 2,
  MIRRORBALL: 3,
  FISHEYE_EQUIDISTANT: 4,
  FISHEYE_EQUISOLID: 5,
  FISHEYE_LENS_POLYNOMIAL: 6,
  CENTRAL_CYLINDRICAL: 7,
};

/** Shader parameters of a panoramic camera (attached to the render camera as userData.panorama). */
export interface PanoramaParams {
  /** x: type index, y: sensor width (mm), z: fov / lens, w: horizontal sensor fit (1) */
  a: [number, number, number, number];
  /** equirectangular: lat min/max, lon min/max; cylindrical: u min/max, v min/max */
  b: [number, number, number, number];
  /** polynomial k0..k3 (fisheye) or cylinder radius (x) */
  c: [number, number, number, number];
  /** polynomial k4 */
  d: [number, number, number, number];
}

export function panoramaParams(ca: CameraData): PanoramaParams | null {
  if (ca.type !== 'PANO') return null;
  const p = panorama(ca);
  const t = TYPE_INDEX[p.panorama_type] ?? 1;
  const fit = ca.sensor_fit === 'VERTICAL' ? 0 : 1;
  const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
  const z = p.panorama_type === 'FISHEYE_EQUISOLID' ? p.fisheye_lens : p.fisheye_fov;
  const cyl = p.panorama_type === 'CENTRAL_CYLINDRICAL';
  return {
    a: [t, sensor, z, fit],
    b: cyl ? [p.central_cylindrical_range_u_min, p.central_cylindrical_range_u_max, p.central_cylindrical_range_v_min, p.central_cylindrical_range_v_max] : [p.latitude_min, p.latitude_max, p.longitude_min, p.longitude_max],
    c: cyl ? [p.central_cylindrical_radius, 0, 0, 0] : [p.fisheye_polynomial_k0, p.fisheye_polynomial_k1, p.fisheye_polynomial_k2, p.fisheye_polynomial_k3],
    d: [p.fisheye_polynomial_k4, p.panorama_type === 'FISHEYE_EQUISOLID' ? p.fisheye_fov : 0, 0, 0],
  };
}

/**
 * Camera-space ray direction for image coordinates `uv` (0..1, y up) of an image with aspect
 * `aspect` (width / height). Null outside the lens circle. Mirrors the GLSL below (unit tested).
 */
export function panoramaDirection(p: PanoramaParams, u: number, v: number, aspect: number): [number, number, number] | null {
  const [type, sensor, z, fit] = p.a;
  const norm = (x: number, y: number, w: number): [number, number, number] => {
    const l = Math.hypot(x, y, w) || 1;
    return [x / l, y / l, w / l];
  };
  const fromAngles = (theta: number, phi: number): [number, number, number] => [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), -Math.cos(theta)];
  // centred coordinates: the fitted dimension spans -1..1
  const px = (u * 2 - 1) * (fit ? 1 : aspect),
    py = (v * 2 - 1) * (fit ? 1 / aspect : 1);
  const r = Math.hypot(px, py);
  const phi = Math.atan2(py, px);
  // frame-filling coordinates (-1..1 on both axes)
  const qx = u * 2 - 1,
    qy = v * 2 - 1;
  switch (type) {
    case 1: {
      const lat = p.b[0] + (p.b[1] - p.b[0]) * v;
      const lon = p.b[2] + (p.b[3] - p.b[2]) * u;
      return [Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)];
    }
    case 2:
      return norm(Math.tan(((u * 2 - 1) * Math.PI) / 4), Math.tan(((v * 2 - 1) * Math.PI) / 4), -1);
    case 3: {
      // the ball fills the frame; its centre looks forward and its rim backward
      const e = Math.hypot(qx, qy);
      if (e > 1) return null;
      const c = Math.sqrt(Math.max(0, 1 - e * e));
      return [2 * c * qx, 2 * c * qy, 1 - 2 * c * c];
    }
    case 4: {
      // the field of view spans the frame in both directions
      const e = Math.hypot(qx, qy);
      if (e > 1) return null;
      return fromAngles((e * z) / 2, Math.atan2(qy, qx));
    }
    case 5: {
      // equisolid lens: radius on the sensor = 2 f sin(theta / 2)
      const rmm = (r * sensor) / 2;
      const s = rmm / (2 * Math.max(z, 1e-4));
      if (s > 1) return null;
      const theta = 2 * Math.asin(s);
      if (theta > p.d[1] / 2) return null;
      return fromAngles(theta, phi);
    }
    case 6: {
      const rmm = (r * sensor) / 2;
      const theta = Math.abs(p.c[0] + p.c[1] * rmm + p.c[2] * rmm * rmm + p.c[3] * rmm ** 3 + p.d[0] * rmm ** 4);
      if (theta > Math.PI) return null;
      return fromAngles(theta, phi);
    }
    default: {
      const a = p.b[0] + (p.b[1] - p.b[0]) * u;
      const h = p.b[2] + (p.b[3] - p.b[2]) * v;
      const R = Math.max(1e-5, p.c[0]);
      return norm(R * Math.sin(a), h, -R * Math.cos(a));
    }
  }
}

const GLSL = /* glsl */ `
uniform vec4 ptPanoA;
uniform vec4 ptPanoB;
uniform vec4 ptPanoC;
uniform vec4 ptPanoD;
bool ptPanoOutside = false;
vec3 ptPanoAngles( float theta, float phi ) { return vec3( sin( theta ) * cos( phi ), sin( theta ) * sin( phi ), - cos( theta ) ); }
vec3 ptPanoDir( vec2 uv ) {
  int type = int( ptPanoA.x + 0.5 );
  float aspect = resolution.x / resolution.y;
  bool fit = ptPanoA.w > 0.5;
  vec2 p = vec2( ( uv.x * 2.0 - 1.0 ) * ( fit ? 1.0 : aspect ), ( uv.y * 2.0 - 1.0 ) * ( fit ? 1.0 / aspect : 1.0 ) );
  float r = length( p );
  float phi = atan( p.y, p.x );
  if ( type == 1 ) {
    float lat = mix( ptPanoB.x, ptPanoB.y, uv.y );
    float lon = mix( ptPanoB.z, ptPanoB.w, uv.x );
    return vec3( sin( lon ) * cos( lat ), sin( lat ), - cos( lon ) * cos( lat ) );
  }
  if ( type == 2 ) return normalize( vec3( tan( ( uv.x * 2.0 - 1.0 ) * PI * 0.25 ), tan( ( uv.y * 2.0 - 1.0 ) * PI * 0.25 ), - 1.0 ) );
  vec2 q = uv * 2.0 - 1.0;
  float e = length( q );
  if ( type == 3 ) {
    if ( e > 1.0 ) { ptPanoOutside = true; return vec3( 0.0, 0.0, - 1.0 ); }
    float c = sqrt( max( 0.0, 1.0 - e * e ) );
    return vec3( 2.0 * c * q, 1.0 - 2.0 * c * c );
  }
  if ( type == 4 ) {
    if ( e > 1.0 ) { ptPanoOutside = true; return vec3( 0.0, 0.0, - 1.0 ); }
    return ptPanoAngles( e * ptPanoA.z * 0.5, atan( q.y, q.x ) );
  }
  if ( type == 5 ) {
    float s = r * ptPanoA.y * 0.5 / ( 2.0 * max( ptPanoA.z, 1e-4 ) );
    float theta = 2.0 * asin( min( s, 1.0 ) );
    if ( s > 1.0 || theta > ptPanoD.y * 0.5 ) { ptPanoOutside = true; return vec3( 0.0, 0.0, - 1.0 ); }
    return ptPanoAngles( theta, phi );
  }
  if ( type == 6 ) {
    float rm = r * ptPanoA.y * 0.5;
    float theta = abs( ptPanoC.x + ptPanoC.y * rm + ptPanoC.z * rm * rm + ptPanoC.w * rm * rm * rm + ptPanoD.x * rm * rm * rm * rm );
    if ( theta > PI ) { ptPanoOutside = true; return vec3( 0.0, 0.0, - 1.0 ); }
    return ptPanoAngles( theta, phi );
  }
  float a = mix( ptPanoB.x, ptPanoB.y, uv.x );
  float h = mix( ptPanoB.z, ptPanoB.w, uv.y );
  float R = max( 1e-5, ptPanoC.x );
  return normalize( vec3( R * sin( a ), h, - R * cos( a ) ) );
}
`;

/** Patch the path tracing shader with panoramic camera rays (null when it does not match). */
export function patchPanorama(src: string): string | null {
  const at = src.indexOf('Ray getCameraRay() {');
  const jitter = 'Ray ray;\n';
  if (at < 0) return null;
  const j = src.indexOf(jitter, at);
  if (j < 0) return null;
  let s =
    src.slice(0, at) +
    GLSL +
    src.slice(at, j + jitter.length) +
    `
		if ( ptPanoA.x > 0.5 ) {
			vec3 ptD = ptPanoDir( jitteredUv );
			ray.direction = normalize( mat3( cameraWorldMatrix ) * ptD );
			ray.origin = ( cameraWorldMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
			return ray;
		}
` +
    src.slice(j + jitter.length);
  // pixels outside the lens circle are black (and empty, so the denoiser keeps the edge)
  const call = 'Ray ray = getCameraRay();';
  const c = s.indexOf(call);
  if (c < 0) return null;
  s = s.slice(0, c + call.length) + '\n if ( ptPanoOutside ) { gl_FragColor = vec4( 0.0 ); return; }' + s.slice(c + call.length);
  return s;
}

export function panoramaUniforms() {
  return { ptPanoA: { value: new Vector4() }, ptPanoB: { value: new Vector4() }, ptPanoC: { value: new Vector4() }, ptPanoD: { value: new Vector4() } };
}

export function applyPanorama(u: ReturnType<typeof panoramaUniforms>, p: PanoramaParams | null) {
  if (!p) {
    u.ptPanoA.value.set(0, 0, 0, 0);
    return;
  }
  u.ptPanoA.value.set(...p.a);
  u.ptPanoB.value.set(...p.b);
  u.ptPanoC.value.set(...p.c);
  u.ptPanoD.value.set(...p.d);
}
