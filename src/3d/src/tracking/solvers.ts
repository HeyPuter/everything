// "Camera Solver" and "Object Solver" constraints: move the owner along the camera / object motion
// reconstructed by the camera solver.
//  - Camera Solver: owner = (owner's own transform) · camera(frame). The owner's own location,
//    rotation and scale place the whole reconstruction in the scene, which is what the scene
//    orientation tools (Set Floor, Set Origin, …) edit.
//  - Object Solver: owner = camera world · (object relative to the camera at frame) · inverse ·
//    owner, with the object solution scaled by the tracking object's scale.
import { Matrix4, Vector3 } from 'three';
import type { Constraint, DocumentData } from '../data/types';
import { app, registerOperators } from '../app/app';
import type { ConstraintContext } from '../eval/types';
import { constraintTypes } from '../eval/constraints';
import { clipTable, type MovieClipData } from './types';
import { objectNamed, sceneReconstructedMatrix } from './reconstruction';

export function solverClip(doc: DocumentData, c: Constraint): MovieClipData | null {
  const id = c.use_active_clip !== false ? doc.scene.active_clip : (c.clip as string | null);
  return (id && clipTable(doc)[id]) || null;
}

const _m = new Matrix4();

/** Object relative to the camera at a scene frame (scale applied), or null without a solution. */
export function objectInCamera(clip: MovieClipData, objectName: string, sceneFrame: number, out = new Matrix4()): Matrix4 | null {
  const o = objectNamed(clip, objectName);
  if (o.is_camera) return null;
  const M = sceneReconstructedMatrix(clip, o.data, sceneFrame, _m);
  if (!M) return null;
  out.copy(M).invert();
  const s = o.scale || 1;
  const p = new Vector3().setFromMatrixPosition(out).multiplyScalar(s);
  out.setPosition(p);
  return out.multiply(new Matrix4().makeScale(s, s, s));
}

constraintTypes.CAMERA_SOLVER = {
  type: 'CAMERA_SOLVER',
  label: 'Camera Solver',
  category: 'MOTION_TRACKING',
  defaults: () => ({ use_active_clip: true, clip: null }),
  isValid: (c, { doc }) => !!solverClip(doc, c)?.tracking.reconstruction?.is_valid,
  apply(owner: Matrix4, c: Constraint, ctx: ConstraintContext) {
    const clip = solverClip(ctx.doc, c);
    if (!clip) return;
    const M = sceneReconstructedMatrix(clip, clip.tracking, ctx.frame, new Matrix4());
    if (M) owner.multiply(M);
  },
} as (typeof constraintTypes)[string];

constraintTypes.OBJECT_SOLVER = {
  type: 'OBJECT_SOLVER',
  label: 'Object Solver',
  category: 'MOTION_TRACKING',
  defaults: () => ({ use_active_clip: true, clip: null, object: '', camera: null, set_inverse_pending: false, inverse_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }),
  deps: (c: Constraint, doc: DocumentData) => [(c.camera as string | null) ?? doc.scene.camera],
  isValid: (c, { doc }) => {
    const clip = solverClip(doc, c);
    if (!clip || !c.object) return false;
    const o = objectNamed(clip, c.object as string);
    return !o.is_camera && !!o.data.reconstruction?.is_valid;
  },
  apply(owner: Matrix4, c: Constraint, ctx: ConstraintContext) {
    const clip = solverClip(ctx.doc, c);
    if (!clip || !c.object) return;
    const camId = (c.camera as string | null) ?? ctx.doc.scene.camera;
    const camEv = camId ? ctx.graph.get(camId) : undefined;
    if (!camEv) return;
    const rel = objectInCamera(clip, c.object as string, ctx.frame);
    if (!rel) return;
    const inv = new Matrix4().fromArray((c.inverse_matrix as number[]) ?? new Matrix4().toArray());
    const out = camEv.world.clone().multiply(rel).multiply(inv).multiply(owner);
    owner.copy(out);
  },
} as (typeof constraintTypes)[string];

// ---------------------------------------------------------------------------
// Set / Clear Inverse of the Object Solver

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const solverOf = (p: Record<string, unknown>) => app.activeObject?.constraints.find((c) => c.type === 'OBJECT_SOLVER' && (!p.constraint || c.name === p.constraint)) ?? null;
const props = [
  { id: 'constraint', label: 'Constraint', type: 'string' as const, default: '', hidden: true },
  { id: 'owner', label: 'Owner', type: 'enum' as const, default: 'OBJECT', items: [['OBJECT', 'Object']] as [string, string][], hidden: true },
];

registerOperators([
  {
    idname: 'constraint.objectsolver_set_inverse',
    label: 'Set Inverse',
    description: 'Keep the object where it is now: the solved motion is applied relative to the current frame',
    props,
    poll: () => !!solverOf({}),
    exec: (ctx, p) => {
      const c = solverOf(p);
      const clip = c && solverClip(ctx.doc, c);
      if (!c || !clip) return 'CANCELLED';
      const camId = (c.camera as string | null) ?? ctx.doc.scene.camera;
      app.graph.evaluate(ctx.doc);
      const camEv = camId ? app.graph.get(camId) : undefined;
      const rel = objectInCamera(clip, c.object as string, ctx.doc.scene.frame_current);
      if (!camEv || !rel) {
        app.report('ERROR', 'The object solver needs a camera and a solved tracking object');
        return 'CANCELLED';
      }
      c.inverse_matrix = camEv.world.clone().multiply(rel).invert().toArray();
    },
  },
  {
    idname: 'constraint.objectsolver_clear_inverse',
    label: 'Clear Inverse',
    description: 'Forget the stored inverse: the solved motion is applied from the camera directly',
    props,
    poll: () => !!solverOf({}),
    exec: (_ctx, p) => {
      const c = solverOf(p);
      if (!c) return 'CANCELLED';
      c.inverse_matrix = [...IDENTITY16];
    },
  },
]);
