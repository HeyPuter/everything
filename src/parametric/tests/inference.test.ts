import { expect, it } from 'vitest';
import { snapPoint } from '../src/app/sketch/inference';
import { sketch } from './helpers';

it('snaps to a point at the origin rather than the origin, so a chain started there closes on it', () => {
  for (const at of [0, 1e-13]) {
    const sk = sketch('S', [{ id: 'p1', t: 'point', x: at, y: -at }, { id: 'p2', t: 'point', x: 20, y: 5 }]);
    const s = snapPoint(sk, [0.05, -0.04], { tol: 1 });
    expect(s).toMatchObject({ kind: 'point', pointId: 'p1' });
  }
  // Without one (or with it excluded) the origin itself is the snap.
  const sk = sketch('S', [{ id: 'p1', t: 'point', x: 0, y: 0 }]);
  expect(snapPoint(sk, [0.05, -0.04], { tol: 1, exclude: new Set(['p1']) })).toMatchObject({ kind: 'origin', pointId: 'O' });
  expect(snapPoint(sketch('S', []), [0.05, -0.04], { tol: 1 })).toMatchObject({ kind: 'origin' });
  // A point merely near the origin does not take over from it.
  expect(snapPoint(sketch('S', [{ id: 'p1', t: 'point', x: 0.3, y: 0 }]), [-0.05, 0], { tol: 1 })).toMatchObject({ kind: 'origin' });
});
