/**
 * Proofs on the GPU: with WebGL2, Proof Colors for a device (press, ICC
 * profile or RGB space) runs the canvas through a lookup table baked from
 * the exact ICC proof transform (ink-gl.js) instead of the fitted SVG
 * filter.
 */
import { buildLut } from './color-management.js';
import { proofSpec } from './proof.js';
import { runInkPass, gpuAvailable } from './ink-gl.js';

/** { key, fn } of the device proof for the editor's proof setup, or null when it is not a device proof. */
export function pressProof(app, editor) {
  const spec = proofSpec(app, editor.doc, editor.viewOptions.proof || 'cmyk');
  if (!spec?.transform) return null;
  const t = spec.transform;
  return { key: spec.key, fn: (rgb) => t.convert(rgb) };
}

/** Whether the canvas proof of this editor is drawn here (so the CSS filter stays off). */
export function gpuHandlesProof(app, editor) {
  return Boolean(editor?.viewOptions.proofColors && gpuAvailable() && pressProof(app, editor));
}

export function drawGpuProof(app, ctx, editor) {
  if (!gpuHandlesProof(app, editor)) return false;
  const spec = pressProof(app, editor);
  const out = runInkPass(ctx.canvas, { mode: 'proof', lut: buildLut(spec.key, 33, spec.fn) });
  if (!out) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(out, 0, 0);
  return true;
}
