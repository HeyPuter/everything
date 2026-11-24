import { describe, expect, it } from 'vitest';
import type { EdgeInfo } from '../src/kernel/protocol';
import { Selection, facePlaneRef } from '../src/app/selection';

const edge = (a: [number, number, number], b: [number, number, number]): EdgeInfo => ({
  name: 'e', type: 'line', a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], length: 1, faces: [],
});

describe('selection', () => {
  it('drops selected and hovered vertices that a rebuild moved or removed', () => {
    const s = new Selection();
    // 29.999999523 is how single-precision mesh data gives back 30.
    s.set([{ kind: 'vertex', p: [60, 8, 29.999999523162842] }, { kind: 'vertex', p: [0, 0, 0] }]);
    s.setHover({ kind: 'vertex', p: [60, 8, 30] });
    let emitted = 0;
    s.on(() => emitted++);
    s.revalidate([], [edge([0, 0, 0], [60, 8, 30])]);
    expect(s.items).toHaveLength(2);
    expect(emitted).toBe(0);
    // The plate got thinner: the corner at y = 8 is gone.
    s.revalidate([], [edge([0, 0, 0], [60, 5, 30])]);
    expect(s.items).toEqual([{ kind: 'vertex', p: [0, 0, 0] }]);
    expect(s.hover).toBeNull();
    expect(emitted).toBe(1);
  });
});

describe('face plane references', () => {
  it('keep the direction the face frame takes its x axis from when the face is picked', () => {
    const face = (normal: [number, number, number]) => ({ name: 'f', type: 'plane', center: [0, 0, 0] as [number, number, number], area: 1, feature: 'e', normal });
    expect(facePlaneRef(face([0, 0, 1]))).toMatchObject({ kind: 'face', face: { name: 'f' }, x: [1, 0, 0] });
    expect(facePlaneRef(face([0.99, 0.141, 0]))).toMatchObject({ x: [0, 0, -1] });
    expect(facePlaneRef(face([-1, 0, 0]))).toMatchObject({ x: [0, 0, 1] });
  });
});
