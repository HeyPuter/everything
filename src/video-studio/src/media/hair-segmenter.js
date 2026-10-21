/**
 * Hair segmentation on this device: a small open model (Apache-2.0,
 * MediaPipe hair segmenter) on the MediaPipe Tasks runtime, bundled with the
 * app and only fetched the first time hair color is used.
 */
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import modelUrl from './models/hair-segmenter.tflite?url';
import { lazyModel } from './lazy-model.js';

/** Side of the square image the model looks at. */
export const HAIR_SIZE = 512;

const model = lazyModel(async () => {
  const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
  return ImageSegmenter.createFromOptions(
    { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
    { baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false },
  );
}, 'Hair color could not start in this browser.');

export const hairModelReady = (opts) => model.ready(opts);
export const hairModelState = () => model.state();
export const hairModelError = () => model.error();
export const onHairModelChange = (fn) => model.onChange(fn);

/**
 * Hair confidence (0..255 per pixel, rows top to bottom) for an upright
 * square image, or null while not ready.
 */
export function segmentHair(image) {
  const m = model.instance;
  if (!m) return null;
  const res = m.segment(image);
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
