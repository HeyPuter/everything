/**
 * Planar 2-link robot arm kinematics / IK (original).
 * Isaac Sim–inspired teaching sandbox — not NVIDIA Isaac Sim.
 */

/**
 * @param {number} l1
 * @param {number} l2
 * @param {number} theta1 radians
 * @param {number} theta2 radians
 */
export function forwardKinematics(l1, l2, theta1, theta2) {
  const x1 = l1 * Math.cos(theta1);
  const y1 = l1 * Math.sin(theta1);
  const x2 = x1 + l2 * Math.cos(theta1 + theta2);
  const y2 = y1 + l2 * Math.sin(theta1 + theta2);
  return {
    joints: [
      { x: 0, y: 0 },
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
    tip: { x: x2, y: y2 },
  };
}

/**
 * Analytic 2R inverse kinematics. Returns null if unreachable.
 * Elbow-up solution.
 * @param {number} l1
 * @param {number} l2
 * @param {number} x
 * @param {number} y
 */
export function inverseKinematics(l1, l2, x, y) {
  const r2 = x * x + y * y;
  const r = Math.sqrt(r2);
  const maxReach = l1 + l2;
  const minReach = Math.abs(l1 - l2);
  if (r > maxReach + 1e-9 || r < minReach - 1e-9) return null;

  let cosT2 = (r2 - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  cosT2 = Math.max(-1, Math.min(1, cosT2));
  const theta2 = Math.acos(cosT2); // elbow-up = +acos; use negative for elbow-down
  const k1 = l1 + l2 * Math.cos(theta2);
  const k2 = l2 * Math.sin(theta2);
  const theta1 = Math.atan2(y, x) - Math.atan2(k2, k1);
  return { theta1, theta2 };
}

export function deg(rad) {
  return (rad * 180) / Math.PI;
}

export function rad(degVal) {
  return (degVal * Math.PI) / 180;
}
