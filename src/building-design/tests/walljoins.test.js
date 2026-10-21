import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { WallSolver } from '../src/core/walls.js';

/** Two 200 mm walls meeting at (0, 0): one along +X, one along +Y. */
function corner(styleA) {
  const p = project();
  const x = p.wall([0, 0], [4000, 0], { joinStyleA: styleA });
  const y = p.wall([0, 0], [0, 3000]);
  const solved = new WallSolver(p.doc).level(p.L1.id);
  return { gx: solved.walls.get(x.id), gy: solved.walls.get(y.id), half: solved.walls.get(x.id).axis.half };
}

describe('wall joins', () => {
  it('miter: both walls reach the outer corner', () => {
    const { gx, gy, half } = corner('miter');
    const xs = [gx.L0[0], gx.R0[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-half, 3);
    expect(xs[1]).toBeCloseTo(half, 3);
    const ys = [gy.L0[1], gy.R0[1]].sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-half, 3);
  });

  it('butt: the marked wall stops at the other wall, which runs through', () => {
    const { gx, gy, half } = corner('butt');
    // The X wall's start is square, at the Y wall's inner face.
    expect(gx.L0[0]).toBeCloseTo(half, 3);
    expect(gx.R0[0]).toBeCloseTo(half, 3);
    // The Y wall runs down to the X wall's outer face.
    expect(Math.min(gy.L0[1], gy.R0[1])).toBeCloseTo(-half, 3);
    expect(Math.max(gy.L0[1], gy.R0[1])).toBeCloseTo(-half, 3);
    expect(gx.ends[0].kind).toBe('tee');
  });
});
