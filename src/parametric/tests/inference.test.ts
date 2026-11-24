import { expect, it } from 'vitest';
import type { SkCurve, SkEntity } from '../src/model/types';
import { snapPoint } from '../src/app/sketch/inference';
import { SketchIndex, closestOnSegment, distanceToCurve, tessellate } from '../src/sketch/geom';
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

it('measures nearby splines exactly while skipping far ones', () => {
  const ents: SkEntity[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) { ents.push({ id: `s${i}`, t: 'point', x: i * 10, y: Math.sin(i) * 6 }); ids.push(`s${i}`); }
  const sp: SkEntity = { id: 'sp', t: 'spline', pts: ids };
  ents.push(sp);
  const ix = new SketchIndex(ents);
  const poly = tessellate(ix, sp as SkCurve, 0.005);
  for (const p of [[33.3, 1.7], [0, 0], [71, -4], [12, 9], [-5, 2]] as [number, number][]) {
    let want = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) want = Math.min(want, closestOnSegment(p, poly[i], poly[i + 1]).d);
    expect(distanceToCurve(ix, sp as SkCurve, p).d).toBeCloseTo(want, 12);
    expect(distanceToCurve(ix, sp as SkCurve, p, want + 1e-9).d).toBeCloseTo(want, 12);
  }
  // Farther than asked about: not measured.
  expect(distanceToCurve(ix, sp as SkCurve, [35, 80], 1).d).toBe(Infinity);
  // Snapping onto a spline still finds it.
  const s = snapPoint(sketch('S', ents), [33.3, poly.find((q) => Math.abs(q[0] - 33.3) < 0.5)![1] + 0.1], { tol: 1 });
  expect(s).toMatchObject({ kind: 'on', curveId: 'sp' });
});

it('ends a horizontal or vertical snap exactly where its guide crosses a nearby curve', () => {
  const sk = sketch('S', [
    { id: 'c', t: 'point', x: 20, y: -20 }, { id: 'd', t: 'point', x: 20, y: 20 }, { id: 'V', t: 'line', a: 'c', b: 'd' },
    { id: 'o', t: 'point', x: 40, y: 0 }, { id: 'C', t: 'circle', c: 'o', r: 8 },
  ]);
  // A cursor just past the vertical line: the end used to stay where the cursor was, off the line.
  expect(snapPoint(sk, [20.6, 5.2], { tol: 1, from: [-10, 5] })).toEqual({ p: [20, 5], raw: [20.6, 5.2], kind: 'h', curveId: 'V' });
  const s = snapPoint(sk, [48.3, 3.1], { tol: 1.5, from: [36, 3] });
  expect(s).toMatchObject({ kind: 'h', curveId: 'C' });
  expect(s.p[0]).toBeCloseTo(40 + Math.sqrt(55), 12);
  expect(s.p[1]).toBe(3);
  // Vertical too; and away from any curve the snap is only a direction.
  expect(snapPoint(sk, [40.2, 8.4], { tol: 1, from: [40, -2] })).toMatchObject({ p: [40, 8], kind: 'v', curveId: 'C' });
  expect(snapPoint(sk, [5, 5.1], { tol: 1, from: [-10, 5] })).toEqual({ p: [5, 5], raw: [5, 5.1], kind: 'h', guide: undefined });
});
