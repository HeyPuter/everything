// "Follow Track" object constraint (2D mode): places the owner where the active camera sees the
// track's marker, at the owner's current depth along the camera view axis (or on the surface of a
// depth object). The math: the marker frame is
// mapped into the camera frame (Stretch / Fit / Crop for differing aspect ratios), camera shift is
// added in frame units, the sensor is always fitted automatically, and the owner's orientation
// becomes its own rotation/scale composed with the camera's.
import { Matrix4, Vector3 } from 'three';
import type { Constraint, DocumentData } from '../data/types';
import type { ConstraintContext } from '../eval/types';
import { constraintTypes } from '../eval/constraints';
import { clipTable, markerAt, sceneToClipFrame, focalPixels, principalPixels, type MovieClipData } from './types';

export interface FollowCamera {
  type: 'PERSP' | 'ORTHO' | 'PANO';
  lens: number;
  sensor_width: number;
  ortho_scale: number;
  shift_x: number;
  shift_y: number;
}

export interface FollowRender {
  resolution_x: number;
  resolution_y: number;
  pixel_aspect_x: number;
  pixel_aspect_y: number;
}

export type FrameMethod = 'STRETCH' | 'FIT' | 'CROP';

/** Undistort a pixel position (origin bottom-left) with the clip's polynomial lens model. */
export function undistortPixel(clip: MovieClipData, px: number, py: number): [number, number] {
  const cam = clip.tracking.camera;
  const f = focalPixels(clip);
  // the vertical axis is measured in aspect-scaled pixels (the optical center is not scaled)
  const pa = cam.pixel_aspect || 1;
  const fy = f * pa;
  const [cx, cy] = principalPixels(clip);
  const xd = (px - cx) / f,
    yd = (py * pa - cy) / fy;
  // fixed-point inversion of x_d = x_u (1 + k1 r² + k2 r⁴ + k3 r⁶)
  let xu = xd,
    yu = yd;
  for (let i = 0; i < 50; i++) {
    const r2 = xu * xu + yu * yu;
    const k = 1 + cam.k1 * r2 + cam.k2 * r2 * r2 + cam.k3 * r2 * r2 * r2;
    if (Math.abs(k) < 1e-9) break;
    const nx = xd / k,
      ny = yd / k;
    if (Math.abs(nx - xu) < 1e-12 && Math.abs(ny - yu) < 1e-12) {
      xu = nx;
      yu = ny;
      break;
    }
    xu = nx;
    yu = ny;
  }
  return [xu * f + cx, (yu * fy + cy) / pa];
}

/** Distort an undistorted pixel position (inverse of undistortPixel). */
export function distortPixel(clip: MovieClipData, px: number, py: number): [number, number] {
  const cam = clip.tracking.camera;
  const f = focalPixels(clip);
  const pa = cam.pixel_aspect || 1;
  const fy = f * pa;
  const [cx, cy] = principalPixels(clip);
  const x = (px - cx) / f,
    y = (py * pa - cy) / fy;
  const r2 = x * x + y * y;
  const k = 1 + cam.k1 * r2 + cam.k2 * r2 * r2 + cam.k3 * r2 * r2 * r2;
  return [x * k * f + cx, (y * k * fy + cy) / pa];
}

/**
 * Point in camera space for a normalized marker position (0..1, origin bottom-left) at view depth `depth`.
 * `clipAspect` is the footage width / height.
 */
export function markerToCameraSpace(u: number, v: number, depth: number, cam: FollowCamera, render: FollowRender, clipAspect: number, method: FrameMethod): Vector3 {
  const aspect = (render.resolution_x * render.pixel_aspect_x) / Math.max(1e-9, render.resolution_y * render.pixel_aspect_y);
  const size = cam.type === 'ORTHO' ? cam.ortho_scale : (cam.sensor_width * depth) / Math.max(1e-9, cam.lens);
  let w: number, h: number;
  if (aspect >= 1) {
    w = size;
    h = size / aspect;
  } else {
    w = size * aspect;
    h = size;
  }
  let fx = u - 0.5,
    fy = v - 0.5;
  if (method === 'FIT') {
    if (clipAspect > aspect) fy *= aspect / clipAspect;
    else fx *= clipAspect / aspect;
  } else if (method === 'CROP') {
    if (clipAspect > aspect) fx *= clipAspect / aspect;
    else fy *= aspect / clipAspect;
  }
  return new Vector3((fx + cam.shift_x) * w, (fy + cam.shift_y) * h, -depth);
}

/** Möller–Trumbore ray / triangle-fan mesh intersection; returns the nearest positive distance. */
export function rayMesh(origin: Vector3, dir: Vector3, positions: ArrayLike<number>, offsets: ArrayLike<number>, indices: ArrayLike<number>, world: Matrix4): number | null {
  let best: number | null = null;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    e1 = new Vector3(),
    e2 = new Vector3(),
    p = new Vector3(),
    q = new Vector3(),
    t = new Vector3();
  const vert = (i: number, out: Vector3) => out.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(world);
  for (let f = 0; f + 1 < offsets.length; f++) {
    const s = offsets[f],
      e = offsets[f + 1];
    if (e - s < 3) continue;
    vert(indices[s], a);
    for (let k = s + 1; k + 1 < e; k++) {
      vert(indices[k], b);
      vert(indices[k + 1], c);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      p.crossVectors(dir, e2);
      const det = e1.dot(p);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      t.subVectors(origin, a);
      const uu = t.dot(p) * inv;
      if (uu < 0 || uu > 1) continue;
      q.crossVectors(t, e1);
      const vv = dir.dot(q) * inv;
      if (vv < 0 || uu + vv > 1) continue;
      const d = e2.dot(q) * inv;
      if (d > 1e-9 && (best === null || d < best)) best = d;
    }
  }
  return best;
}

export interface FollowInputs {
  clip: MovieClipData;
  trackName: string;
  sceneFrame: number;
  cameraWorld: Matrix4;
  camera: FollowCamera;
  render: FollowRender;
  method: FrameMethod;
  undistort: boolean;
  depthMesh?: { positions: ArrayLike<number>; offsets: ArrayLike<number>; indices: ArrayLike<number>; world: Matrix4 } | null;
}

/** World matrix of the owner after the constraint (owner rotation/scale composed with the camera's). */
export function followTrackMatrix(owner: Matrix4, inp: FollowInputs): Matrix4 | null {
  const track = inp.clip.tracking.tracks.find((t) => t.name === inp.trackName);
  if (!track) return null;
  const mk = markerAt(track, sceneToClipFrame(inp.clip, Math.floor(inp.sceneFrame)));
  if (!mk) return null;
  let u = mk.co[0] + track.offset[0],
    v = mk.co[1] + track.offset[1];
  const [W, H] = inp.clip.size;
  if (inp.undistort && W > 0 && H > 0) {
    const [px, py] = undistortPixel(inp.clip, u * W, v * H);
    u = px / W;
    v = py / H;
  }
  const camInv = inp.cameraWorld.clone().invert();
  const ownerPos = new Vector3().setFromMatrixPosition(owner);
  const local = ownerPos.clone().applyMatrix4(camInv);
  const depth = -local.z;
  const clipAspect = W > 0 && H > 0 ? W / H : 1;
  const pc = markerToCameraSpace(u, v, depth, inp.camera, inp.render, clipAspect, inp.method);
  let world = pc.clone().applyMatrix4(inp.cameraWorld);
  if (inp.depthMesh) {
    const camPos = new Vector3().setFromMatrixPosition(inp.cameraWorld);
    let origin: Vector3, dir: Vector3;
    if (inp.camera.type === 'ORTHO') {
      origin = new Vector3(pc.x, pc.y, 0).applyMatrix4(inp.cameraWorld);
      dir = new Vector3(0, 0, -1).transformDirection(inp.cameraWorld);
    } else {
      origin = camPos;
      dir = world.clone().sub(camPos).normalize();
    }
    const d = rayMesh(origin, dir, inp.depthMesh.positions, inp.depthMesh.offsets, inp.depthMesh.indices, inp.depthMesh.world);
    if (d !== null) world = origin.clone().addScaledVector(dir, d);
  }
  const out = new Matrix4();
  const o3 = new Matrix4().copy(owner).setPosition(0, 0, 0);
  const c3 = new Matrix4().copy(inp.cameraWorld).setPosition(0, 0, 0);
  out.multiplyMatrices(o3, c3);
  out.setPosition(world);
  return out;
}

// ---------------------------------------------------------------------------
// constraint registration

export function constraintClip(doc: DocumentData, c: Constraint): MovieClipData | null {
  const table = clipTable(doc);
  const id = c.use_active_clip ? doc.scene.active_clip : (c.clip as string | null);
  return (id && table[id]) || null;
}

constraintTypes.FOLLOW_TRACK = {
  type: 'FOLLOW_TRACK',
  label: 'Follow Track',
  category: 'MOTION_TRACKING',
  defaults: () => ({ use_active_clip: true, clip: null, track: '', camera: null, depth_object: null, frame_method: 'STRETCH', use_undistorted_position: false }),
  deps: (c: Constraint, doc: DocumentData) => [(c.camera as string | null) ?? doc.scene.camera, c.depth_object as string | null],
  apply(owner: Matrix4, c: Constraint, ctx: ConstraintContext) {
    const clip = constraintClip(ctx.doc, c);
    if (!clip || !c.track) return;
    const camId = (c.camera as string | null) ?? ctx.doc.scene.camera;
    const camEv = camId ? ctx.graph.get(camId) : undefined;
    const camData = camEv?.ob.type === 'CAMERA' && camEv.ob.data ? ctx.doc.cameras[camEv.ob.data] : undefined;
    if (!camEv || !camData) return;
    const depthEv = c.depth_object ? ctx.graph.get(c.depth_object as string) : undefined;
    const r = ctx.doc.scene.render;
    const m = followTrackMatrix(owner, {
      clip,
      trackName: c.track as string,
      sceneFrame: ctx.frame,
      cameraWorld: camEv.world,
      camera: camData,
      render: r,
      method: ((c.frame_method as FrameMethod) ?? 'STRETCH'),
      undistort: !!c.use_undistorted_position,
      depthMesh: depthEv?.mesh ? { positions: depthEv.mesh.positions, offsets: depthEv.mesh.offsets, indices: depthEv.mesh.indices, world: depthEv.world } : null,
    });
    if (m) owner.copy(m);
  },
} as (typeof constraintTypes)[string];
