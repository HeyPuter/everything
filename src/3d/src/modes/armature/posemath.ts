// Pure helpers for Pose Mode tools: left/right name flipping, naming by axis and the
// in-between ("pose slide") value blends and pose propagation. Free of UI imports for unit testing.
import type { FCurve } from '../../data/types';
import { calcHandles } from '../../anim/fcurve';

function swapCase(src: string, target: string) {
  if (src === src.toUpperCase()) return target.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return target[0].toUpperCase() + target.slice(1).toLowerCase();
  return target.toLowerCase();
}

const SEPS = '._\\- ';

/** Mirror a bone name's side (Hand.L ↔ Hand.R, L_Hand ↔ R_Hand, HandLeft ↔ HandRight). */
export function flipSideName(name: string, stripNumbers = false): string {
  let base = name,
    num = '';
  const m = /^(.*?)(\.\d+)$/.exec(name);
  if (m) {
    base = m[1];
    num = stripNumbers ? '' : m[2];
  }
  const flipLetter = (c: string) => ({ L: 'R', R: 'L', l: 'r', r: 'l' })[c] ?? c;
  // single letter suffix after a separator: Hand.L / hand_l / Hand-L / Hand L
  let r = new RegExp(`^(.*[${SEPS}])([LRlr])$`).exec(base);
  if (r) return r[1] + flipLetter(r[2]) + num;
  // single letter prefix before a separator: L_Hand / l.hand / R.Hand
  r = new RegExp(`^([LRlr])([${SEPS}].*)$`).exec(base);
  if (r) return flipLetter(r[1]) + r[2] + num;
  // whole words anywhere: Left/Right in any case
  r = /(left|right)/i.exec(base);
  if (r) {
    const w = r[1];
    const target = w.toLowerCase() === 'left' ? 'right' : 'left';
    return base.slice(0, r.index) + swapCase(w, target) + base.slice(r.index + w.length) + num;
  }
  return base + num;
}

const AXIS_SUFFIX: Record<'XAXIS' | 'YAXIS' | 'ZAXIS', [string, string]> = {
  XAXIS: ['L', 'R'],
  YAXIS: ['Bk', 'Fr'],
  ZAXIS: ['Top', 'Bot'],
};
const ALL_SUFFIXES = ['L', 'R', 'l', 'r', 'Fr', 'Bk', 'Top', 'Bot'];

/**
 * Name a bone by which side of an axis it lies on (`value` is the head coordinate, or the
 * tail's when the head is on the axis). Bones on the X/Y center keep their name.
 */
export function autosideName(name: string, value: number, axis: 'XAXIS' | 'YAXIS' | 'ZAXIS'): string {
  const eps = 1e-5;
  let stem = name;
  const m = new RegExp(`^(.*)[${SEPS}](${ALL_SUFFIXES.join('|')})$`).exec(name);
  if (m) stem = m[1];
  if (Math.abs(value) < eps && axis !== 'ZAXIS') return name;
  const [pos, neg] = AXIS_SUFFIX[axis];
  return `${stem}.${value >= -eps ? pos : neg}`;
}

export type SlideMode = 'PUSH' | 'RELAX' | 'BREAKDOWN' | 'BLEND_TO_NEIGHBOR' | 'BLEND_WITH_REST';

/**
 * New value of one channel for an in-between tool. `prev`/`next` are the values at the
 * neighbouring keyframes, `t` the current frame's position between them (0..1).
 */
export function slideValue(mode: SlideMode, v: number, prev: number, next: number, t: number, factor: number, rest: number): number {
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  const breakdown = lerp(prev, next, t);
  switch (mode) {
    case 'PUSH':
      return v + (v - breakdown) * factor;
    case 'RELAX':
      return v + (breakdown - v) * factor;
    case 'BREAKDOWN':
      return lerp(prev, next, factor);
    case 'BLEND_TO_NEIGHBOR':
      return factor < 0.5 ? lerp(v, prev, (0.5 - factor) * 2) : lerp(v, next, (factor - 0.5) * 2);
    case 'BLEND_WITH_REST':
      return lerp(v, rest, factor);
  }
}

/** Rest value of a pose bone channel. */
export function poseRestValue(prop: string, index: number): number {
  if (prop === 'scale') return 1;
  if (prop === 'rotation_quaternion') return index === 0 ? 1 : 0;
  if (prop === 'rotation_axis_angle') return index === 2 ? 1 : 0;
  return 0;
}

export type PropagateMode = 'NEXT_KEY' | 'LAST_KEY' | 'BEFORE_FRAME' | 'BEFORE_END' | 'SELECTED_KEYS' | 'SELECTED_MARKERS';

export function propagateCurve(fc: FCurve, value: number, frame: number, mode: PropagateMode, endFrame: number, markerFrames: number[]): number {
  const keys = fc.keyframe_points;
  let targets: typeof keys = [];
  if (mode === 'NEXT_KEY') {
    const k = keys.find((x) => x.co[0] > frame + 1e-4);
    targets = k ? [k] : [];
  } else if (mode === 'LAST_KEY') targets = keys.length && keys[keys.length - 1].co[0] > frame + 1e-4 ? [keys[keys.length - 1]] : [];
  else if (mode === 'BEFORE_FRAME') targets = keys.filter((k) => k.co[0] > frame + 1e-4 && k.co[0] < endFrame);
  else if (mode === 'BEFORE_END') targets = keys.filter((k) => k.co[0] > frame + 1e-4);
  else if (mode === 'SELECTED_KEYS') targets = keys.filter((k) => k.select_control_point);
  else targets = keys.filter((k) => markerFrames.some((m) => Math.abs(m - k.co[0]) < 0.5));
  for (const k of targets) {
    const dy = value - k.co[1];
    k.co[1] = value;
    k.handle_left[1] += dy;
    k.handle_right[1] += dy;
  }
  if (targets.length) calcHandles(fc);
  return targets.length;
}

