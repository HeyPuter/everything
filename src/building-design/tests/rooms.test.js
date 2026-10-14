import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { WallSolver } from '../src/core/walls.js';
import { RoomSolver, arrangementFaces } from '../src/core/rooms.js';

describe('arrangement', () => {
  it('finds the faces of two squares sharing an edge', () => {
    const segs = [
      [[0, 0], [2, 0]],
      [[2, 0], [2, 1]],
      [[2, 1], [0, 1]],
      [[0, 1], [0, 0]],
      [[1, 0], [1, 1]],
    ].map(([a, b]) => [a.map((v) => v * 1000), b.map((v) => v * 1000)]);
    const faces = arrangementFaces(segs);
    const bounded = faces.filter((f) => f.area > 0).map((f) => Math.round(f.area / 1e6));
    expect(bounded.sort()).toEqual([1, 1]);
    expect(faces.filter((f) => f.area < 0)).toHaveLength(1);
  });
});

describe('rooms', () => {
  it('measures a room at the inside faces of its walls', () => {
    const { doc, box, L1 } = project();
    box(0, 0, 5000, 4000);
    const walls = new WallSolver(doc);
    const rooms = new RoomSolver(doc, walls);
    const r = rooms.regionAt(L1.id, [2500, 2000]);
    expect(r).not.toBeNull();
    expect(r.area).toBeCloseTo(4800 * 3800, -2);
    expect(r.perimeter).toBeCloseTo(2 * (4800 + 3800), 0);
  });

  it('splits a room with an interior wall and with a separator', () => {
    const { doc, box, wall, add, L1 } = project();
    box(0, 0, 6000, 4000);
    wall([3000, 0], [3000, 4000]);
    const walls = new WallSolver(doc);
    let rooms = new RoomSolver(doc, walls);
    const left = rooms.regionAt(L1.id, [1000, 2000]);
    expect(left.area).toBeCloseTo(2800 * 3800, -2);
    add({ kind: 'roomSeparator', levelId: L1.id, a: [3000, 2000], b: [6000, 2000] });
    walls.invalidate();
    rooms = new RoomSolver(doc, walls);
    const quarter = rooms.regionAt(L1.id, [4500, 1000]);
    expect(quarter.area).toBeLessThan(2800 * 3800);
    expect(quarter.area).toBeGreaterThan(2800 * 1800);
  });

  it('returns null outside of any enclosure', () => {
    const { doc, box, L1 } = project();
    box(0, 0, 5000, 4000);
    const rooms = new RoomSolver(doc, new WallSolver(doc));
    expect(rooms.regionAt(L1.id, [9000, 9000])).toBeNull();
  });

  it('subtracts free-standing islands', () => {
    const { doc, box, wall, L1 } = project();
    box(0, 0, 8000, 8000);
    wall([3000, 4000], [5000, 4000]);
    const rooms = new RoomSolver(doc, new WallSolver(doc));
    const r = rooms.regionAt(L1.id, [1000, 1000]);
    expect(r.holes).toHaveLength(1);
    expect(r.area).toBeCloseTo(7800 * 7800 - 2000 * 200, -2);
  });
});
