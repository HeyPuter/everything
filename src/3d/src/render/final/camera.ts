// Scene camera → three.js camera for final renders (exact frame, lens shift, depth of field).
import { OrthographicCamera, Vector3, Matrix4, type Camera, PerspectiveCamera } from 'three';
import { PhysicalCamera } from 'three-gpu-pathtracer';
import type { App } from '../../app/app';
import { panoramaParams } from './ptcamera';

/** Half extents of the camera frame at distance 1 (perspective) – pure for testing. */
export function frustumHalfExtents(ca: { sensor_fit: 'AUTO' | 'HORIZONTAL' | 'VERTICAL'; sensor_width: number; sensor_height: number; lens: number }, aspect: number): [number, number] {
  const horizontal = ca.sensor_fit === 'HORIZONTAL' || (ca.sensor_fit === 'AUTO' && aspect >= 1);
  const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
  const half = sensor / 2 / ca.lens;
  return horizontal ? [half, half / aspect] : [half * aspect, half];
}

/** Build the active scene camera for an image of w×h pixels (null when the scene has no camera). */
export function renderCamera(app: App, w: number, h: number, cameraId = app.doc.scene.camera): Camera | null {
  const doc = app.doc;
  const ev = cameraId ? app.graph.get(cameraId) : undefined;
  const ca = ev?.ob.type === 'CAMERA' && ev.ob.data ? doc.cameras[ev.ob.data] : undefined;
  if (!ev || !ca) return null;
  const r = doc.scene.render;
  const aspect = (w * r.pixel_aspect_x) / (h * r.pixel_aspect_y);
  let cam: Camera;
  if (ca.type === 'ORTHO') {
    const o = new OrthographicCamera();
    const horizontal = ca.sensor_fit === 'HORIZONTAL' || (ca.sensor_fit === 'AUTO' && aspect >= 1);
    const hw = horizontal ? ca.ortho_scale / 2 : (ca.ortho_scale / 2) * aspect;
    const hh = hw / aspect;
    const sx = ca.shift_x * ca.ortho_scale,
      sy = ca.shift_y * ca.ortho_scale;
    o.left = -hw + sx;
    o.right = hw + sx;
    o.top = hh + sy;
    o.bottom = -hh + sy;
    o.near = ca.clip_start;
    o.far = ca.clip_end;
    o.updateProjectionMatrix();
    cam = o;
  } else {
    const p = new PhysicalCamera();
    const [hx, hy] = frustumHalfExtents(ca, aspect);
    p.fov = (2 * Math.atan(hy) * 180) / Math.PI;
    p.aspect = aspect;
    p.near = ca.clip_start;
    p.far = ca.clip_end;
    p.updateProjectionMatrix();
    if (ca.shift_x || ca.shift_y) {
      // shift is a fraction of the larger frame dimension
      const s = 2 * Math.max(hx, hy);
      p.projectionMatrix.elements[8] = (ca.shift_x * s) / hx;
      p.projectionMatrix.elements[9] = (ca.shift_y * s) / hy;
      p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
    }
    if (ca.dof.use_dof) {
      let dist = ca.dof.focus_distance;
      const fo = ca.dof.focus_object ? app.graph.get(ca.dof.focus_object) : undefined;
      if (fo) {
        const cp = new Vector3().setFromMatrixPosition(ev.world);
        const fwd = new Vector3(0, 0, -1).transformDirection(ev.world);
        dist = Math.max(1e-3, new Vector3().setFromMatrixPosition(fo.world).sub(cp).dot(fwd));
      }
      p.focusDistance = dist;
      p.apertureBlades = ca.dof.aperture_blades >= 3 ? ca.dof.aperture_blades : 0;
      p.bokehSize = ca.lens / Math.max(0.1, ca.dof.aperture_fstop);
      const d = ca.dof as typeof ca.dof & { aperture_rotation?: number; aperture_ratio?: number };
      p.apertureRotation = d.aperture_rotation ?? 0;
      p.anamorphicRatio = d.aperture_ratio ?? 1;
    } else p.fStop = Infinity;
    cam = p;
  }
  const scale = new Vector3();
  ev.world.decompose(cam.position, cam.quaternion, scale);
  cam.updateMatrixWorld(true);
  // panoramic projections are traced by the path tracer (ptcamera.ts); rasterizers use the perspective
  const pano = panoramaParams(ca);
  if (pano) cam.userData.panorama = pano;
  return cam;
}

/** Copy of a viewport camera with a different aspect ratio (viewport renders). */
export function viewportCameraForAspect(src: Camera, aspect: number): Camera {
  let cam: Camera;
  if ((src as OrthographicCamera).isOrthographicCamera) {
    const s = src as OrthographicCamera;
    const o = s.clone();
    const hh = (s.top - s.bottom) / 2 / s.zoom;
    const cy = (s.top + s.bottom) / 2;
    const cx = (s.left + s.right) / 2;
    o.zoom = 1;
    o.top = cy + hh;
    o.bottom = cy - hh;
    o.left = cx - hh * aspect;
    o.right = cx + hh * aspect;
    o.updateProjectionMatrix();
    cam = o;
  } else {
    const p = (src as PerspectiveCamera).clone();
    p.aspect = aspect;
    p.updateProjectionMatrix();
    cam = p;
  }
  cam.matrixWorld.copy(src.matrixWorld);
  cam.matrixWorld.decompose(cam.position, cam.quaternion, new Vector3());
  cam.updateMatrixWorld(true);
  return cam;
}

/** Apply a sub-pixel jitter (pixels) to a camera's projection matrix in place. */
export function jitterProjection(cam: Camera, base: Matrix4, jx: number, jy: number, w: number, h: number) {
  const pm = (cam as PerspectiveCamera).projectionMatrix;
  pm.copy(base);
  const e = pm.elements;
  const dx = (2 * jx) / w,
    dy = (2 * jy) / h;
  if ((cam as OrthographicCamera).isOrthographicCamera) {
    e[12] += dx;
    e[13] += dy;
  } else {
    e[8] += dx;
    e[9] += dy;
  }
  (cam as PerspectiveCamera).projectionMatrixInverse.copy(pm).invert();
}

// ---------------------------------------------------------------------------
// depth of field by camera jitter (realtime engine) and render regions

/** Aperture radius in meters for a focal length (mm) and f-stop. */
export function apertureRadius(lensMm: number, fstop: number): number {
  return lensMm / 1000 / (2 * Math.max(0.01, fstop));
}

/**
 * Point on the aperture for two uniform numbers: a disk (blades < 3) or a regular polygon with
 * `blades` corners, rotated by `rotation` and stretched by `ratio` (anamorphic bokeh).
 * Returns coordinates within the unit aperture.
 */
export function apertureSample(u1: number, u2: number, blades: number, rotation = 0, ratio = 1): [number, number] {
  let x: number, y: number;
  if (blades >= 3) {
    // pick a triangle (centre, corner k, corner k+1) and sample it uniformly
    const n = Math.floor(blades);
    const t = u1 * n;
    const k = Math.min(n - 1, Math.floor(t));
    const v = t - k;
    const a0 = (2 * Math.PI * k) / n,
      a1 = (2 * Math.PI * (k + 1)) / n;
    const s = Math.sqrt(v);
    // barycentric (1 - s, s(1 - u2), s u2)
    const bx = s * (1 - u2),
      by = s * u2;
    x = bx * Math.cos(a0) + by * Math.cos(a1);
    y = bx * Math.sin(a0) + by * Math.sin(a1);
  } else {
    const r = Math.sqrt(u1),
      a = 2 * Math.PI * u2;
    x = r * Math.cos(a);
    y = r * Math.sin(a);
  }
  if (rotation) {
    const c = Math.cos(rotation),
      s = Math.sin(rotation);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  if (ratio && ratio !== 1) {
    if (ratio > 1) x /= ratio;
    else y *= ratio;
  }
  return [x, y];
}

export interface DofParams {
  /** aperture radius (m) */
  radius: number;
  focus: number;
  blades: number;
  rotation: number;
  ratio: number;
}

/** Depth-of-field parameters of the scene camera, or null when it has none. */
export function cameraDof(app: App, cameraId = app.doc.scene.camera): DofParams | null {
  const doc = app.doc;
  const ev = cameraId ? app.graph.get(cameraId) : undefined;
  const ca = ev?.ob.type === 'CAMERA' && ev.ob.data ? doc.cameras[ev.ob.data] : undefined;
  if (!ev || !ca || ca.type !== 'PERSP' || !ca.dof.use_dof) return null;
  let dist = ca.dof.focus_distance;
  const fo = ca.dof.focus_object ? app.graph.get(ca.dof.focus_object) : undefined;
  if (fo) {
    const cp = new Vector3().setFromMatrixPosition(ev.world);
    const fwd = new Vector3(0, 0, -1).transformDirection(ev.world);
    dist = Math.max(1e-3, new Vector3().setFromMatrixPosition(fo.world).sub(cp).dot(fwd));
  }
  const dof = ca.dof as typeof ca.dof & { aperture_rotation?: number; aperture_ratio?: number };
  return { radius: apertureRadius(ca.lens, ca.dof.aperture_fstop), focus: Math.max(1e-3, dist), blades: ca.dof.aperture_blades, rotation: dof.aperture_rotation ?? 0, ratio: dof.aperture_ratio ?? 1 };
}

/**
 * Move a perspective camera across its aperture by (ox, oy) meters (camera space) and shear its
 * projection so the focus plane stays fixed: averaging many such views gives depth of field.
 * `basePos` / `baseProj` are the unjittered position and projection.
 */
export function apertureJitter(cam: Camera, basePos: Vector3, baseProj: Matrix4, ox: number, oy: number, focus: number) {
  const p = cam as PerspectiveCamera;
  const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  cam.position.copy(basePos).addScaledVector(right, ox).addScaledVector(up, oy);
  cam.updateMatrixWorld(true);
  const e = p.projectionMatrix.copy(baseProj).elements;
  e[8] -= (e[0] * ox) / focus;
  e[9] -= (e[5] * oy) / focus;
  p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
}

export interface PixelRect {
  /** left column and top row (top-down) */
  x: number;
  y: number;
  w: number;
  h: number;
}

type Border = { use_border?: boolean; border_min_x?: number; border_min_y?: number; border_max_x?: number; border_max_y?: number };

/** Pixel rectangle of the render region in a W×H image, or null when the whole frame renders. */
export function regionRect(r: Border, W: number, H: number): PixelRect | null {
  if (!r.use_border) return null;
  const cl = (v: number | undefined, d: number) => Math.min(1, Math.max(0, v ?? d));
  const x0 = Math.floor(cl(r.border_min_x, 0) * W),
    x1 = Math.ceil(cl(r.border_max_x, 1) * W);
  // the region is measured bottom-up
  const top = Math.floor((1 - cl(r.border_max_y, 1)) * H),
    bottom = Math.ceil((1 - cl(r.border_min_y, 0)) * H);
  const w = x1 - x0,
    h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  if (w === W && h === H) return null;
  return { x: x0, y: top, w, h };
}

/** Restrict a camera's projection (in place) to a pixel rectangle of a W×H frame. */
export function cropProjection(cam: Camera, rect: PixelRect, W: number, H: number) {
  const p = cam as PerspectiveCamera;
  // NDC bounds of the rectangle (y up)
  const nx0 = (2 * rect.x) / W - 1,
    nx1 = (2 * (rect.x + rect.w)) / W - 1;
  const ny1 = 1 - (2 * rect.y) / H,
    ny0 = 1 - (2 * (rect.y + rect.h)) / H;
  const sx = 2 / (nx1 - nx0),
    sy = 2 / (ny1 - ny0);
  const tx = -(nx1 + nx0) / (nx1 - nx0),
    ty = -(ny1 + ny0) / (ny1 - ny0);
  const m = new Matrix4().set(sx, 0, 0, tx, 0, sy, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1);
  p.projectionMatrix.premultiply(m);
  p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
}
