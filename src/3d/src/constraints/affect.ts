// "Affect Transform": limit constraints that also hold back interactive transforms, so the object's
// own location/rotation/scale never leave the allowed range while it is moved.
import { Matrix4 } from 'three';
import { app, onAppReady } from '../app/app';
import type { ObjectData } from '../data/types';
import { objectTransformFilters } from '../ops/transform';
import { solveObjectConstraints } from '../eval/constraint_solve';
import { applyMatrixToObject, localMatrix } from '../eval/transform';

const LIMITS = new Set(['LIMIT_LOCATION', 'LIMIT_ROTATION', 'LIMIT_SCALE', 'LIMIT_DISTANCE']);

/** Clamp an object's own transform by its limit constraints that affect transforms. */
export function limitObjectTransform(ob: ObjectData) {
  const list = ob.constraints.filter((c) => LIMITS.has(c.type) && c.use_transform_limit && !c.mute && c.influence > 0);
  if (!list.length) return;
  const ev = app.graph.get(ob.id);
  const parent = ev?.parentMatrix ?? null;
  const world = localMatrix(ob, new Matrix4());
  if (parent) world.premultiply(parent);
  solveObjectConstraints(app.graph, app.doc, ob, world, parent, list);
  const local = parent ? parent.clone().invert().multiply(world) : world;
  const before = { location: [...ob.location], rotation: [...ob.rotation_euler], q: [...ob.rotation_quaternion], scale: [...ob.scale] };
  applyMatrixToObject(ob, local);
  // only the channels a limit constraint governs change
  const kinds = new Set(list.map((c) => c.type));
  if (!kinds.has('LIMIT_LOCATION') && !kinds.has('LIMIT_DISTANCE')) ob.location = before.location as typeof ob.location;
  if (!kinds.has('LIMIT_ROTATION')) {
    ob.rotation_euler = before.rotation as typeof ob.rotation_euler;
    ob.rotation_quaternion = before.q as typeof ob.rotation_quaternion;
  }
  if (!kinds.has('LIMIT_SCALE')) ob.scale = before.scale as typeof ob.scale;
}

// registered once the app exists: the transform operators module may still be loading here
onAppReady(() => objectTransformFilters.push(limitObjectTransform));
