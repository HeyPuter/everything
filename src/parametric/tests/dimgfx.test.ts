import { expect, it } from 'vitest';
import type { SkDimension } from '../src/model/types';
import { dimGraphics } from '../src/app/sketch/dimgfx';
import { sketch } from './helpers';

it.each(['diameter', 'radius'] as const)('draws a %s dimension line out to the arrow on the edge when its label sits inside the circle', (type) => {
  const sk = sketch('S', [{ id: 'o', t: 'point', x: 0, y: 0 }, { id: 'C', t: 'circle', c: 'o', r: 10 }]);
  const d: Pick<SkDimension, 'type' | 'refs' | 'at'> = { type, refs: ['C'], at: [4, 0] };
  const g = dimGraphics(sk, d, 0.1)!;
  // The line stopped at the label, leaving the arrow at (10, 0) unconnected.
  expect(g.lines[0]).toEqual([type === 'diameter' ? [-10, 0] : [0, 0], [10, 0]]);
  // Outside the circle it still runs to the label.
  expect(dimGraphics(sk, { ...d, at: [15, 0] }, 0.1)!.lines[0][1]).toEqual([15, 0]);
});
