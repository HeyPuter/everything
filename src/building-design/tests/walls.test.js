import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { WallSolver } from '../src/core/walls.js';
import { wallAxis } from '../src/core/model.js';
import { area } from '../src/core/geom.js';

const close = (p, q) => {
  expect(p[0]).toBeCloseTo(q[0], 3);
  expect(p[1]).toBeCloseTo(q[1], 3);
};

describe('wall axis', () => {
  it('offsets the centerline from the location line', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0], { locationLine: 'exterior' });
    const ax = wallAxis(doc, w);
    // Exterior is the left side (+y); the centerline is half a wall inward.
    close(ax.a, [0, -100]);
    const f = wall([0, 0], [4000, 0], { locationLine: 'exterior', flipped: true });
    close(wallAxis(doc, f).a, [0, 100]);
  });
});

describe('wall joins', () => {
  it('miters an L corner', () => {
    const { doc, wall, L1 } = project();
    const a = wall([0, 0], [4000, 0]);
    const b = wall([4000, 0], [4000, 3000]);
    const s = new WallSolver(doc).level(L1.id);
    const ga = s.walls.get(a.id);
    const gb = s.walls.get(b.id);
    // Outer corner at (4100, -100), inner corner at (3900, 100).
    close(ga.R1, [4100, -100]);
    close(ga.L1, [3900, 100]);
    close(gb.R0, [4100, -100]);
    close(gb.L0, [3900, 100]);
    expect(ga.ends[1].kind).toBe('corner');
    expect(ga.ends[0].kind).toBe('free');
  });

  it('butts a T junction against the host face and interrupts it', () => {
    const { doc, wall, L1 } = project();
    const host = wall([0, 0], [6000, 0]);
    const branch = wall([3000, 0], [3000, 3000]);
    const s = new WallSolver(doc).level(L1.id);
    const g = s.walls.get(branch.id);
    close(g.L0, [2900, 100]);
    close(g.R0, [3100, 100]);
    expect(g.ends[0]).toMatchObject({ kind: 'tee', host: host.id });
    const h = s.walls.get(host.id);
    expect(h.cuts.left).toHaveLength(1);
    expect(h.cuts.left[0][0]).toBeCloseTo(2900, 3);
    expect(h.cuts.left[0][1]).toBeCloseTo(3100, 3);
  });

  it('fills a three-way node with a hub', () => {
    const { doc, wall, L1 } = project();
    wall([0, 0], [3000, 0]);
    wall([0, 0], [-3000, 0]);
    wall([0, 0], [0, 3000]);
    const s = new WallSolver(doc).level(L1.id);
    expect(s.hubs).toHaveLength(1);
    expect(area(s.hubs[0].poly)).toBeGreaterThan(0);
  });

  it('continues collinear walls without a gap', () => {
    const { doc, wall, L1 } = project();
    const a = wall([0, 0], [3000, 0]);
    const b = wall([3000, 0], [6000, 0]);
    const s = new WallSolver(doc).level(L1.id);
    close(s.walls.get(a.id).L1, [3000, 100]);
    close(s.walls.get(b.id).L0, [3000, 100]);
    close(s.walls.get(a.id).R1, [3000, -100]);
  });

  it('closes a rectangle with four mitered corners', () => {
    const { doc, box, L1 } = project();
    const walls = box(0, 0, 5000, 4000);
    const s = new WallSolver(doc).level(L1.id);
    const total = walls.reduce((sum, w) => sum + area(s.walls.get(w.id).poly), 0);
    // Outer 5200 x 4200 minus inner 4800 x 3800.
    expect(total).toBeCloseTo(5200 * 4200 - 4800 * 3800, 0);
  });
});
