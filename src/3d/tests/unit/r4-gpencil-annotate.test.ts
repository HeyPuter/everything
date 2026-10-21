import { describe, it, expect } from 'vitest';
import { arrowShape, eraseInCircle, stabilize } from '../../src/greasepencil/annotatemath';
import type { AnnotationStroke } from '../../src/editors/view3d/tools3d';

const screen = (p: number[]) => ({ x: p[0], y: p[1], z: 0 });
const line = (pts: number[][]): AnnotationStroke => ({ points: pts.flatMap((p) => [p[0], p[1], 0]), color: [1, 0, 0], thickness: 2 });

describe('annotation arrow heads', () => {
  it('builds the shapes at the tip, pointing along the line', () => {
    const tip = { x: 100, y: 50 };
    expect(arrowShape('NONE', tip, 1, 0, 10)).toBeNull();
    const a = arrowShape('ARROW', tip, 1, 0, 10)!;
    expect(a.kind).toBe('fill');
    expect(a.pts).toHaveLength(3);
    // the back corners sit behind the tip
    expect(a.pts[1][0]).toBeCloseTo(90);
    expect(Math.abs(a.pts[1][1] - 50)).toBeCloseTo(5.5);
    expect(arrowShape('ARROW_OPEN', tip, 0, 1, 10)!.kind).toBe('line');
    const seg = arrowShape('ARROW_OPEN_INVERTED', tip, 1, 0, 10)!;
    expect(seg.pts[0][0]).toBeCloseTo(100);
    expect(arrowShape('DIAMOND', tip, 1, 0, 10)!.pts).toHaveLength(4);
    expect(arrowShape('ARROW', tip, 0, 0, 10)).toBeNull();
  });
});

describe('annotation eraser', () => {
  it('cuts a straight line where it crosses the circle', () => {
    const out = eraseInCircle(
      [
        line([
          [0, 0],
          [100, 0],
        ]),
      ],
      screen,
      50,
      0,
      10,
      () => false,
    )!;
    expect(out).toHaveLength(2);
    expect(out[0].points.slice(-3)[0]).toBeCloseTo(40);
    expect(out[1].points[0]).toBeCloseTo(60);
  });
  it('drops pieces that are fully inside, keeps locked strokes and reports no change when missed', () => {
    expect(
      eraseInCircle(
        [
          line([
            [0, 0],
            [5, 0],
          ]),
        ],
        screen,
        0,
        0,
        20,
        () => false,
      ),
    ).toEqual([]);
    const keep = line([
      [0, 0],
      [100, 0],
    ]);
    expect(eraseInCircle([keep], screen, 50, 0, 10, () => true)).toBeNull();
    expect(eraseInCircle([keep], screen, 50, 50, 10, () => false)).toBeNull();
  });
  it('arrow heads stay on the outer ends of the pieces', () => {
    const s = {
      ...line([
        [0, 0],
        [100, 0],
      ]),
      arrow_start: 'ARROW' as const,
      arrow_end: 'DIAMOND' as const,
    };
    const out = eraseInCircle([s], screen, 50, 0, 10, () => false)!;
    expect(out[0].arrow_start).toBe('ARROW');
    expect(out[0].arrow_end).toBe('NONE');
    expect(out[1].arrow_start).toBe('NONE');
    expect(out[1].arrow_end).toBe('DIAMOND');
  });
});

describe('annotation stabilizer', () => {
  it('trails the pointer by the radius', () => {
    expect(stabilize({ x: 0, y: 0 }, { x: 5, y: 0 }, 10, 0.5)).toEqual({ x: 0, y: 0 });
    const p = stabilize({ x: 0, y: 0 }, { x: 30, y: 0 }, 10, 0);
    expect(p.x).toBeCloseTo(20);
    expect(stabilize({ x: 0, y: 0 }, { x: 30, y: 0 }, 10, 0.9).x).toBeLessThan(20);
  });
});
