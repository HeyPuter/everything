// Scene-wide evaluation settings from the render properties: Simplify (global limits applied
// while evaluating geometry, separately for the viewport and for final renders; the depsgraph's
// `render` flag picks the set) and Output ▸ Time Stretching.
import type { DocumentData } from '../data/types';

/** Highest subdivision level any modifier may use (Infinity when Simplify is off). */
export function simplifySubdivision(doc: DocumentData, render: boolean): number {
  const r = doc.scene.render;
  if (!r.use_simplify) return Infinity;
  const v = render ? r.simplify_subdivision_render : r.simplify_subdivision;
  return Math.max(0, Math.round(v ?? 6));
}

/** Fraction of child particles that are generated (1 when Simplify is off). */
export function simplifyChildParticles(doc: DocumentData, render: boolean): number {
  const r = doc.scene.render;
  if (!r.use_simplify) return 1;
  const v = render ? r.simplify_child_particles_render : r.simplify_child_particles;
  return Math.max(0, Math.min(1, v ?? 1));
}

/** Part of the evaluated-geometry signature, so changing the limits re-evaluates meshes. */
export function simplifySignature(doc: DocumentData, render: boolean): string {
  if (!doc.scene.render.use_simplify) return '';
  return `|S${simplifySubdivision(doc, render)},${simplifyChildParticles(doc, render)}`;
}

/**
 * Animation time of a scene frame with Time Stretching: `frame_map_old` frames of animation
 * last `frame_map_new` frames (e.g. 100 → 200 plays twice as slow).
 */
export function stretchedFrame(doc: DocumentData, frame: number): number {
  const r = doc.scene.render;
  const o = r.frame_map_old ?? 100,
    n = r.frame_map_new ?? 100;
  if (o === n || o <= 0 || n <= 0) return frame;
  return (frame * o) / n;
}
