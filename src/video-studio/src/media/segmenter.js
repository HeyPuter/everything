/**
 * Person segmentation that runs on this device: a small open model
 * (Apache-2.0, MediaPipe selfie segmenter) on the MediaPipe Tasks runtime,
 * both bundled with the app and only fetched the first time background
 * removal is used. segment() is synchronous once ready() has resolved, so
 * the compositor can call it while drawing a frame.
 */
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import modelUrl from './models/person-segmenter.tflite?url';
import { lazyModel } from './lazy-model.js';

/** Side of the square image the model looks at. */
export const SEG_SIZE = 256;

const model = lazyModel(async () => {
  const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
  return ImageSegmenter.createFromOptions(
    { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
    { baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false },
  );
}, 'Background removal could not start in this browser.');

/** Subscribe to the model becoming ready (or failing); returns an unsubscribe. */
export const onSegmenterChange = (fn) => model.onChange(fn);
export const segmenterState = () => model.state();
export const segmenterError = () => model.error();
/** Load the model (once). Resolves to true when segment() can be used. { retry: true } tries again after a failure. */
export const ready = (opts) => model.ready(opts);

/**
 * Person confidence (0..255 per pixel, SEG_SIZE x SEG_SIZE, rows top to
 * bottom) for an upright image of that size, or null while not ready.
 */
export function segment(image) {
  const segmenter = model.instance;
  if (!segmenter) return null;
  const res = segmenter.segment(image);
  try {
    const mask = res.confidenceMasks?.[res.confidenceMasks.length - 1];
    if (!mask) return null;
    const f = mask.getAsFloat32Array();
    const out = new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i++) out[i] = f[i] * 255;
    return { data: out, width: mask.width, height: mask.height };
  } finally {
    res.close();
  }
}
