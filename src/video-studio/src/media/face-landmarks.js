/**
 * Face landmarks found on this device: a small open model (Apache-2.0,
 * MediaPipe face landmarker) on the MediaPipe Tasks runtime, both bundled
 * with the app and only fetched the first time a face tool is used.
 * detectFaces() is synchronous once ready, so the compositor can call it
 * while drawing a frame.
 */
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import modelUrl from './models/face-landmarker.task?url';
import { lazyModel } from './lazy-model.js';

/** Most faces looked for in one frame. */
export const MAX_FACES = 3;
/** Points per face (the face mesh plus both irises). */
export const FACE_POINTS = 478;

const model = lazyModel(async () => {
  const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
  return FaceLandmarker.createFromOptions(
    { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
    {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: MAX_FACES,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    },
  );
}, 'Face detection could not start in this browser.');

export const faceModelReady = (opts) => model.ready(opts);
export const faceModelState = () => model.state();
export const faceModelError = () => model.error();
export const onFaceModelChange = (fn) => model.onChange(fn);

/**
 * Faces in an upright image: one Float32Array per face of FACE_POINTS x, y
 * pairs in 0..1 of the image (y down), or null while the model is not ready.
 */
export function detectFaces(image) {
  const m = model.instance;
  if (!m) return null;
  const res = m.detect(image);
  return (res.faceLandmarks || []).filter((f) => f.length >= FACE_POINTS).map((f) => {
    const out = new Float32Array(FACE_POINTS * 2);
    for (let i = 0; i < FACE_POINTS; i++) {
      out[i * 2] = f[i].x;
      out[i * 2 + 1] = f[i].y;
    }
    return out;
  });
}
