// Camera solve data plumbing: clip camera ↔ solver intrinsics, solver input from the tracks of a
// tracking object, writing a solution back (reconstruction, bundles, errors, refined lens) and
// evaluating the solved camera at any frame.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { cameraWorldMatrix, bundleWorld, type SolveResult, type SolveSettings, type SolveTrack } from './solve/pipeline';
import { fromPixel, toPixel, type Intrinsics } from './solve/intrinsics';
import { cameraObjectName, reconstructionOf, sceneToClipFrame, trackingObjects, type MovieClipData, type MovieReconstructedCamera, type MovieTrackingReconstruction, type TrackingObjectData } from './types';

/** Solver intrinsics of the clip's camera (pixels, origin bottom-left). */
export function clipIntrinsics(clip: MovieClipData): Intrinsics {
  const cam = clip.tracking.camera;
  const [W, H] = clip.size;
  const focal = (cam.focal_length * W) / Math.max(1e-6, cam.sensor_width);
  const I: Intrinsics = {
    focal,
    cx: ((cam.principal_point[0] + 1) / 2) * W,
    cy: ((cam.principal_point[1] + 1) / 2) * H,
    aspect: cam.pixel_aspect || 1,
    model: cam.distortion_model ?? 'POLYNOMIAL',
    k: [0, 0, 0, 0],
    p: [0, 0],
  };
  if (I.model === 'DIVISION') I.k = [cam.division_k1 ?? 0, cam.division_k2 ?? 0, 0, 0];
  else if (I.model === 'BROWN') {
    I.k = [cam.brown_k1 ?? 0, cam.brown_k2 ?? 0, cam.brown_k3 ?? 0, cam.brown_k4 ?? 0];
    I.p = [cam.brown_p1 ?? 0, cam.brown_p2 ?? 0];
  } else I.k = [cam.k1, cam.k2, cam.k3, 0];
  return I;
}

/** Write refined intrinsics back to the clip camera. */
export function setClipIntrinsics(clip: MovieClipData, I: Intrinsics) {
  const cam = clip.tracking.camera;
  const [W, H] = clip.size;
  cam.focal_length = (I.focal * cam.sensor_width) / Math.max(1, W);
  cam.principal_point = [(I.cx / W) * 2 - 1, (I.cy / H) * 2 - 1];
  if (I.model === 'DIVISION') [cam.division_k1, cam.division_k2] = [I.k[0], I.k[1]];
  else if (I.model === 'BROWN') {
    [cam.brown_k1, cam.brown_k2, cam.brown_k3, cam.brown_k4] = I.k;
    [cam.brown_p1, cam.brown_p2] = I.p;
  } else [cam.k1, cam.k2, cam.k3] = [I.k[0], I.k[1], I.k[2]];
}

/** Remove (or add, `inverse`) the clip's lens distortion from a pixel position (origin bottom-left). */
export function undistortClipPixel(clip: MovieClipData, px: number, py: number, inverse = false): [number, number] {
  const I = clipIntrinsics(clip);
  if (inverse) {
    const nx = (px - I.cx) / I.focal,
      ny = (py - I.cy) / (I.focal * I.aspect);
    return toPixel(I, nx, ny);
  }
  const [x, y] = fromPixel(I, px, py);
  return [I.cx + I.focal * x, I.cy + I.focal * I.aspect * y];
}

/** Solver tracks of a tracking object: enabled markers in pixels (offset applied). */
export function solveTracks(clip: MovieClipData, obj: TrackingObjectData): SolveTrack[] {
  const [W, H] = clip.size;
  return obj.tracks.map((t) => {
    const st: SolveTrack = { name: t.name, weight: t.weight, frames: [], x: [], y: [] };
    for (const m of t.markers) {
      if (m.mute || m.frame < 1 || (clip.frame_duration > 0 && m.frame > clip.frame_duration)) continue;
      st.frames.push(m.frame);
      st.x.push((m.co[0] + t.offset[0]) * W);
      st.y.push((m.co[1] + t.offset[1]) * H);
    }
    return st;
  });
}

export function solveSettings(clip: MovieClipData, obj: TrackingObjectData, isCamera: boolean): SolveSettings {
  const s = clip.tracking.settings;
  return {
    intrinsics: clipIntrinsics(clip),
    refine: isCamera
      ? {
          focal_length: !!s.refine_intrinsics_focal_length,
          principal_point: !!s.refine_intrinsics_principal_point,
          radial_distortion: !!s.refine_intrinsics_radial_distortion,
          tangential_distortion: !!s.refine_intrinsics_tangential_distortion,
        }
      : { focal_length: false, principal_point: false, radial_distortion: false, tangential_distortion: false },
    tripod: isCamera && !!s.use_tripod_solver,
    use_keyframe_selection: s.use_keyframe_selection !== false,
    keyframe_a: obj.keyframe_a ?? 1,
    keyframe_b: obj.keyframe_b ?? 30,
  };
}

/** Store a solver result on the tracking object (and the refined lens on the clip camera). */
export function applySolution(clip: MovieClipData, obj: TrackingObjectData, res: SolveResult, isCamera: boolean) {
  const rec = reconstructionOf(obj);
  rec.is_valid = res.ok;
  rec.average_error = res.ok ? res.error : 0;
  rec.cameras = res.ok ? res.cameras.map((c) => ({ frame: c.frame, matrix: cameraWorldMatrix(c.R, c.t), average_error: c.error })) : [];
  const byTrack = new Map(res.bundles.map((b) => [b.track, b]));
  obj.tracks.forEach((t, i) => {
    const b = res.ok ? byTrack.get(i) : undefined;
    if (b) {
      t.has_bundle = true;
      t.bundle = bundleWorld(b.X);
      t.average_error = b.error;
    } else {
      t.has_bundle = false;
      delete t.bundle;
      t.average_error = 0;
    }
  });
  if (!res.ok) return;
  if (clip.tracking.settings.use_keyframe_selection !== false) {
    obj.keyframe_a = res.keyframe_a;
    obj.keyframe_b = res.keyframe_b;
  }
  if (isCamera) setClipIntrinsics(clip, res.intrinsics);
}

export function clearSolution(obj: TrackingObjectData) {
  obj.reconstruction = { is_valid: false, average_error: 0, cameras: [] };
  for (const t of obj.tracks) {
    t.has_bundle = false;
    delete t.bundle;
    t.average_error = 0;
  }
}

// ---------------------------------------------------------------------------
// evaluation

const _p0 = new Vector3(),
  _p1 = new Vector3(),
  _q0 = new Quaternion(),
  _q1 = new Quaternion(),
  _s0 = new Vector3(),
  _s1 = new Vector3();

/**
 * Solved camera matrix at a (fractional) clip frame, interpolated between the solved frames
 * around it and held at the ends. Null without a valid reconstruction.
 */
export function reconstructedMatrix(rec: MovieTrackingReconstruction | undefined, frame: number, out = new Matrix4()): Matrix4 | null {
  if (!rec?.is_valid || !rec.cameras.length) return null;
  const cams = rec.cameras;
  if (frame <= cams[0].frame) return out.fromArray(cams[0].matrix);
  const last = cams[cams.length - 1];
  if (frame >= last.frame) return out.fromArray(last.matrix);
  let lo = 0,
    hi = cams.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cams[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const a: MovieReconstructedCamera = cams[lo],
    b: MovieReconstructedCamera = cams[hi];
  if (a.frame === frame) return out.fromArray(a.matrix);
  const t = (frame - a.frame) / (b.frame - a.frame);
  new Matrix4().fromArray(a.matrix).decompose(_p0, _q0, _s0);
  new Matrix4().fromArray(b.matrix).decompose(_p1, _q1, _s1);
  return out.compose(_p0.lerp(_p1, t), _q0.slerp(_q1, t), _s0.lerp(_s1, t));
}

/** Solved camera matrix at a scene frame for a tracking object of the clip. */
export function sceneReconstructedMatrix(clip: MovieClipData, obj: TrackingObjectData, sceneFrame: number, out = new Matrix4()): Matrix4 | null {
  return reconstructedMatrix(obj.reconstruction, sceneToClipFrame(clip, sceneFrame), out);
}

/** Tracking object data by name (camera when empty). */
export function objectNamed(clip: MovieClipData, name: string | null | undefined): { data: TrackingObjectData; is_camera: boolean; scale: number } {
  const objs = trackingObjects(clip);
  const o = (name && objs.find((x) => x.name === name)) || objs.find((x) => x.name === cameraObjectName(clip))!;
  return { data: o.data, is_camera: o.is_camera, scale: o.is_camera ? 1 : ((o.data as { scale?: number }).scale ?? 1) };
}

/**
 * Pixel position (origin bottom-left) where the solved camera of a clip frame sees a track's
 * bundle, or null without a solution for that frame or behind the camera.
 */
export function reprojectBundle(clip: MovieClipData, obj: TrackingObjectData, bundle: [number, number, number], frame: number): [number, number] | null {
  const rec = obj.reconstruction;
  if (!rec?.is_valid) return null;
  const cam = rec.cameras.find((c) => c.frame === frame);
  if (!cam) return null;
  const inv = new Matrix4().fromArray(cam.matrix).invert();
  const p = new Vector3(...bundle).applyMatrix4(inv);
  if (p.z >= -1e-9) return null;
  return toPixel(clipIntrinsics(clip), p.x / -p.z, p.y / -p.z);
}
