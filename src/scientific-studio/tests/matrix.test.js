import { describe, expect, it } from 'vitest';
import {
  add,
  evalCommand,
  eye,
  mul,
  sample,
  scale,
  solve,
  zeros,
} from '../src/engine/matrix.js';

describe('scientific matrix engine', () => {
  it('builds identity and zeros', () => {
    expect(eye(2)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(zeros(2)[0]).toEqual([0, 0]);
  });

  it('adds multiplies and scales', () => {
    const a = eye(2);
    expect(add(a, a)).toEqual([
      [2, 0],
      [0, 2],
    ]);
    expect(mul(a, scale(a, 3))).toEqual([
      [3, 0],
      [0, 3],
    ]);
  });

  it('solves linear systems', () => {
    const A = [
      [2, 1],
      [1, 1],
    ];
    const x = solve(A, [5, 3]);
    expect(x[0]).toBeCloseTo(2, 8);
    expect(x[1]).toBeCloseTo(1, 8);
  });

  it('samples plots and evaluates console commands', () => {
    expect(sample(Math.sin, 0, Math.PI, 4).length).toBe(5);
    const r = evalCommand('eye 2');
    expect(r.ok).toBe(true);
    expect(r.matrix).toEqual(eye(2));
    expect(evalCommand('plot cos').plot?.length).toBeGreaterThan(0);
  });
});
