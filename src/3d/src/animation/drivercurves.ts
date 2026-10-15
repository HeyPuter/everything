// Driver F-Curves: each driver owns an F-Curve that maps the driver value (x) to the property
// value (y). The animation editors work on (object, action, F-Curve) triples, so the drivers of an
// object are presented through a stand-in action that lists their curves.
import type { ActionData, AnimData, Driver, FCurve, ObjectData } from '../data/types';

/** The driver's mapping curve (created on demand for drivers made before curves existed). */
export function ensureDriverCurve(d: Driver): FCurve {
  if (!d.fcurve) d.fcurve = { data_path: d.data_path, array_index: d.array_index, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
  return d.fcurve;
}

/** New driver curve with the default Generator modifier (a straight y = x line that can be reshaped). */
export function defaultDriverCurve(d: Pick<Driver, 'data_path' | 'array_index'>): FCurve {
  return { data_path: d.data_path, array_index: d.array_index, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [{ type: 'GENERATOR', coefficients: [0, 1] }] };
}

const standIns = new WeakMap<AnimData, ActionData>();

export const DRIVER_ACTION_PREFIX = 'drivers:';

/** Stand-in action listing an object's driver curves (rebuilt on every call, identity kept). */
export function driverAction(ob: ObjectData): ActionData {
  const ad = ob.animation_data!;
  let a = standIns.get(ad);
  if (!a) standIns.set(ad, (a = { id: `${DRIVER_ACTION_PREFIX}${ob.id}`, name: 'Drivers', fcurves: [] }));
  a.fcurves = ad.drivers.map(ensureDriverCurve);
  return a;
}

export const isDriverAction = (a: ActionData | undefined) => !!a && a.id.startsWith(DRIVER_ACTION_PREFIX);

/** The driver that owns a curve. */
export function driverOfCurve(ob: ObjectData, fc: FCurve): Driver | undefined {
  return ob.animation_data?.drivers.find((d) => d.fcurve === fc);
}

/** Keys define the mapping once added: drop the untouched default Generator so they take effect. */
export function dropDefaultGenerator(fc: FCurve) {
  const m = fc.modifiers;
  if (m.length === 1 && m[0].type === 'GENERATOR' && !m[0].use_additive && !m[0].mute && JSON.stringify(m[0].coefficients) === '[0,1]' && !m[0].use_restricted_range && !m[0].use_influence) fc.modifiers = [];
}
