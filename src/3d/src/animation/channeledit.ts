// Pure channel editing helpers (reorder, bake to samples, clean empty animation data),
// kept free of UI imports so they can be unit tested.
import type { ActionData, FCurve, ObjectData } from '../data/types';
import { evaluateFCurve, insertKeyframe } from '../anim/fcurve';
import { groupKey } from './channels';
import { setKeySelected } from './keyedit';

// ---------------------------------------------------------------------------
// Reordering

export type Dir = 'TOP' | 'UP' | 'DOWN' | 'BOTTOM';

/** Move the selected items of a list (in place) one step or to an end; `sel` marks items to move. */
export function moveSelected<T>(list: T[], sel: (t: T) => boolean, dir: Dir): boolean {
  const before = [...list];
  if (dir === 'TOP' || dir === 'BOTTOM') {
    const a = list.filter(sel),
      b = list.filter((t) => !sel(t));
    list.splice(0, list.length, ...(dir === 'TOP' ? [...a, ...b] : [...b, ...a]));
  } else if (dir === 'UP') {
    for (let i = 1; i < list.length; i++)
      if (sel(list[i]) && !sel(list[i - 1])) {
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
      }
  } else {
    for (let i = list.length - 2; i >= 0; i--)
      if (sel(list[i]) && !sel(list[i + 1])) {
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
      }
  }
  return list.some((t, i) => t !== before[i]);
}

/** Reorder an action's channels: selected groups move among groups, selected curves within their group. */
export function moveActionChannels(action: ActionData, dir: Dir, selectedGroups: Set<string>): boolean {
  const groups: string[] = [];
  for (const fc of action.fcurves) if (fc.group && !groups.includes(fc.group)) groups.push(fc.group);
  let changed = moveSelected(groups, (g) => selectedGroups.has(groupKey(action, g)), dir);
  const buckets = new Map<string, FCurve[]>();
  for (const g of groups) buckets.set(g, []);
  const loose: FCurve[] = [];
  for (const fc of action.fcurves) (fc.group ? buckets.get(fc.group)! : loose).push(fc);
  for (const list of [...buckets.values(), loose]) if (moveSelected(list, (fc) => !!fc.select, dir)) changed = true;
  const next = [...groups.flatMap((g) => buckets.get(g)!), ...loose];
  if (next.some((fc, i) => fc !== action.fcurves[i])) {
    action.fcurves = next;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Bake channels

export interface BakeChannelOptions {
  start: number;
  end: number;
  step: number;
  removeOutside: boolean;
  interpolation: 'BEZIER' | 'LINEAR' | 'CONSTANT';
  bakeModifiers: boolean;
}

/** Replace the keys in a frame range with samples of the evaluated curve. */
export function bakeCurve(fc: FCurve, o: BakeChannelOptions) {
  const copy: FCurve = { ...fc, keyframe_points: fc.keyframe_points.map((k) => ({ ...k, co: [...k.co], handle_left: [...k.handle_left], handle_right: [...k.handle_right] })) };
  if (!o.bakeModifiers) copy.modifiers = [];
  const step = Math.max(0.01, o.step);
  const keep = o.removeOutside ? [] : fc.keyframe_points.filter((k) => k.co[0] < o.start - 1e-6 || k.co[0] > o.end + 1e-6);
  fc.keyframe_points = keep;
  for (let f = o.start; f <= o.end + 1e-6; f += step) {
    const k = insertKeyframe(fc, f, evaluateFCurve(copy, f), { interpolation: o.interpolation });
    setKeySelected(k, true);
  }
  if (o.bakeModifiers) fc.modifiers = [];
}

export function cleanAnimData(ob: ObjectData, actions: Record<string, ActionData>): boolean {
  const ad = ob.animation_data;
  if (!ad) return false;
  let changed = false;
  if (ad.action && !actions[ad.action]?.fcurves.length) {
    ad.action = null;
    changed = true;
  }
  const tracks = ad.nla_tracks.filter((t) => t.strips.length);
  if (tracks.length !== ad.nla_tracks.length) {
    ad.nla_tracks = tracks;
    changed = true;
  }
  if (!ad.action && !ad.nla_tracks.length && !ad.drivers.length) {
    ob.animation_data = null;
    changed = true;
  }
  return changed;
}

