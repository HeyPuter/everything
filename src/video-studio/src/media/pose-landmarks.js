/**
 * Body landmarks found on this device: a small open model (Apache-2.0,
 * MediaPipe pose landmarker, lite) on the MediaPipe Tasks runtime, both
 * bundled with the app and only fetched the first time a body tool is used.
 * detectPoses() is synchronous once ready, so the compositor can call it
 * while drawing a frame.
 */
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import modelUrl from './models/pose-landmarker.task?url';
import { lazyModel } from './lazy-model.js';

/** Most people looked for in one frame. */
export const MAX_POSES = 3;
/** Points per person. */
export const POSE_POINTS = 33;

const model = lazyModel(async () => {
  const { PoseLandmarker } = await import('@mediapipe/tasks-vision');
  return PoseLandmarker.createFromOptions(
    { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
    {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numPoses: MAX_POSES,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      outputSegmentationMasks: false,
    },
  );
}, 'Body detection could not start in this browser.');

export const poseModelReady = () => model.ready();
export const poseModelState = () => model.state();
export const poseModelError = () => model.error();
export const onPoseModelChange = (fn) => model.onChange(fn);

/**
 * People in an upright image: { pts, vis } per person, pts a Float32Array
 * of POSE_POINTS x, y pairs in 0..1 of the image (y down, points out of the
 * picture fall outside 0..1) and vis how likely each point is visible; null
 * while the model is not ready.
 */
export function detectPoses(image) {
  const m = model.instance;
  if (!m) return null;
  const res = m.detect(image);
  try {
    return (res.landmarks || []).filter((p) => p.length >= POSE_POINTS).map((p) => {
      const pts = new Float32Array(POSE_POINTS * 2);
      const vis = new Float32Array(POSE_POINTS);
      for (let i = 0; i < POSE_POINTS; i++) {
        pts[i * 2] = p[i].x;
        pts[i * 2 + 1] = p[i].y;
        vis[i] = p[i].visibility ?? 1;
      }
      return { pts, vis };
    });
  } finally {
    res.close?.();
  }
}
