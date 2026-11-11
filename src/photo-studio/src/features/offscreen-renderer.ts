import { Renderer } from '../renderer/renderer';
import type { ImageEngine } from '../engine/engine';

// Compositors on detached canvases (embedded objects, PSD export) ask for a
// WebGPU adapter and device of their own. That request can stay unanswered
// (seen with software GPUs under load), which would hold the editor busy
// forever; past this wait they use WebGL2, which renders the same.
const GPU_WAIT_MS = 5000;

/** A compositor on a new detached canvas that never waits forever for the GPU. */
export async function createOffscreenRenderer(engine: ImageEngine): Promise<Renderer> {
  const gpu = Renderer.create(document.createElement('canvas'), engine);
  let wait = 0;
  const r = await Promise.race([gpu, new Promise<undefined>((done) => (wait = window.setTimeout(done, GPU_WAIT_MS)))]).finally(() => clearTimeout(wait));
  if (r) return r;
  void gpu.then((late) => late.dispose(), () => {});
  return Renderer.create(document.createElement('canvas'), engine, 'webgl2');
}
