/**
 * Press proofs on the GPU: with WebGL2, Proof Colors for a CMYK device
 * runs the canvas through an exact lookup table of the press simulation
 * (ink-gl.js) instead of the fitted SVG filter.
 */
import { buildLut, proofCmyk, colorSettings, documentCmykProfile } from './color-management.js';
import { proofSettings, proofDevice } from './proof.js';
import { runInkPass, gpuAvailable } from './ink-gl.js';

/** { key, fn } of the press proof for the editor's proof setup, or null when it is not a press proof. */
export function pressProof(app, editor) {
  const kind = editor.viewOptions.proof || 'cmyk';
  const cs = colorSettings(app);
  if (kind === 'cmyk') {
    const profile = documentCmykProfile(app, editor.doc);
    const opts = { intent: cs.intent, bpc: cs.bpc };
    return { key: `proof:${profile}:${opts.intent}:${opts.bpc}`, fn: (rgb) => proofCmyk(rgb, profile, opts) };
  }
  if (kind === 'custom') {
    const p = proofSettings(app);
    const dev = proofDevice(app, editor.doc, p.device);
    if (dev.kind !== 'cmyk') return null;
    const opts = { intent: p.intent, bpc: cs.bpc, paper: p.paper, black: p.black };
    return { key: `proof:${dev.id}:${opts.intent}:${opts.bpc}:${opts.paper}:${opts.black}`, fn: (rgb) => proofCmyk(rgb, dev.id, opts) };
  }
  return null;
}

/** Whether the canvas proof of this editor is drawn here (so the CSS filter stays off). */
export function gpuHandlesProof(app, editor) {
  return Boolean(editor?.viewOptions.proofColors && pressProof(app, editor) && gpuAvailable());
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
