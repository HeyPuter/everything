// Units of animated properties, for showing F-Curve values the way the property shows them:
// rotation channels in degrees (when the scene uses degrees), locations in metres.
import type { DocumentData, FCurve } from '../data/types';
import type { Unit } from '../ui/widgets';

const ANGLE_TAILS = new Set(['rotation_euler', 'delta_rotation_euler', 'spot_size', 'angle', 'angle_x', 'angle_y', 'roll', 'bbone_rollin', 'bbone_rollout', 'twist', 'shadow_soft_size_angle']);
const DISTANCE_TAILS = new Set(['location', 'delta_location', 'lens_shift', 'clip_start', 'clip_end', 'dof_distance', 'focus_distance', 'shift_x', 'shift_y', 'head_radius', 'tail_radius', 'envelope_distance']);

/** The unit of the property an F-Curve animates. */
export function curveUnit(path: string, index: number): Unit {
  const tail = path.slice(path.lastIndexOf('.') + 1);
  if (tail === 'rotation_axis_angle') return index === 0 ? 'angle' : 'none';
  if (ANGLE_TAILS.has(tail)) return 'angle';
  if (DISTANCE_TAILS.has(tail)) return 'distance';
  return 'none';
}

/** Factor from stored values to displayed ones (degrees for angles when the scene uses degrees). */
export function curveDisplayFactor(doc: DocumentData, fc: FCurve): number {
  if (curveUnit(fc.data_path, fc.array_index) !== 'angle') return 1;
  return doc.scene.unit_settings?.system_rotation === 'RADIANS' ? 1 : 180 / Math.PI;
}
