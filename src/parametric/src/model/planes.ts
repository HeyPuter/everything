import { type Frame, type Vec3, dot, frameFrom, len, scale, sub } from '../math/vec';
import type { BasePlane } from './types';

/**
 * Default planes. Y is up: Front is the XY plane (normal +Z), Top is XZ
 * (normal +Y, sketch Y pointing to -Z) and Right is YZ (normal +X).
 */
export const BASE_FRAMES: Record<BasePlane, Frame> = {
  front: frameFrom([0, 0, 0], [1, 0, 0], [0, 0, 1]),
  top: frameFrom([0, 0, 0], [1, 0, 0], [0, 1, 0]),
  right: frameFrom([0, 0, 0], [0, 0, -1], [1, 0, 0]),
};

export const BASE_PLANE_NAMES: Record<BasePlane, string> = {
  front: 'Front Plane',
  top: 'Top Plane',
  right: 'Right Plane',
};

/** The world direction a planar face's frame takes its x axis from: world X, or Z for a face facing along X. */
export function faceFrameAxis(n: Vec3): Vec3 {
  return Math.abs(n[0]) < 0.99 ? [1, 0, 0] : [0, 0, -Math.sign(n[0])];
}

/**
 * Frame of the plane through p with unit normal n: its origin is the world
 * origin projected on it, its x axis the projection of x (the direction kept
 * from when the face was picked) or, without one or when the plane has turned
 * to face along it, of faceFrameAxis.
 */
export function planeFrame(p: Vec3, n: Vec3, x?: Vec3): Frame {
  const o = sub([0, 0, 0], scale(n, dot(sub([0, 0, 0], p), n)));
  const kept = x && len(sub(x, scale(n, dot(x, n)))) > 0.05 ? x : null;
  return frameFrom(o, kept ?? faceFrameAxis(n), n);
}

/** What else names a base plane (the assistant's plane arguments): no feature may be named so. */
export const BASE_PLANE_ALIASES: Record<string, BasePlane> = {
  front: 'front', 'front plane': 'front', xy: 'front',
  top: 'top', 'top plane': 'top', xz: 'top', zx: 'top',
  right: 'right', 'right plane': 'right', yz: 'right', zy: 'right',
};
