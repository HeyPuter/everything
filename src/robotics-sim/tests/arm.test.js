import { describe, expect, it } from 'vitest';
import { forwardKinematics, inverseKinematics, rad } from '../src/engine/arm.js';

describe('2R arm kinematics', () => {
  it('FK reaches expected tip for 0° / 0°', () => {
    const { tip } = forwardKinematics(100, 80, 0, 0);
    expect(tip.x).toBeCloseTo(180, 5);
    expect(tip.y).toBeCloseTo(0, 5);
  });

  it('IK round-trips with FK for a reachable point', () => {
    const l1 = 100;
    const l2 = 80;
    const target = { x: 120, y: 40 };
    const ik = inverseKinematics(l1, l2, target.x, target.y);
    expect(ik).not.toBeNull();
    const { tip } = forwardKinematics(l1, l2, ik.theta1, ik.theta2);
    expect(tip.x).toBeCloseTo(target.x, 4);
    expect(tip.y).toBeCloseTo(target.y, 4);
  });

  it('IK returns null when unreachable', () => {
    expect(inverseKinematics(50, 50, 200, 0)).toBeNull();
    // With unequal links, points inside |l1-l2| are unreachable.
    expect(inverseKinematics(80, 30, 0, 0)).toBeNull();
  });

  it('FK at 90° shoulder', () => {
    const { tip } = forwardKinematics(10, 10, rad(90), 0);
    expect(tip.x).toBeCloseTo(0, 5);
    expect(tip.y).toBeCloseTo(20, 5);
  });
});
