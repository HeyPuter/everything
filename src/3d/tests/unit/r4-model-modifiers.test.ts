// @vitest-environment happy-dom
// Modifier options added in round 4, against recorded reference results: Cast with a control object
// with and without Use Transform.
import { describe, it, expect } from 'vitest';
import { Matrix4, Euler, Vector3, Quaternion } from 'three';
import fx from '../fixtures/r4_cast_transform.json';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const F = fx as Any;

describe('Cast: control object transform', () => {
  const empty = new Matrix4().compose(new Vector3(0.5, 0, 0), new Quaternion().setFromEuler(new Euler(0, 0, 0.5)), new Vector3(2, 1, 1));
  const run = (useTransform: boolean) => {
    const t = modifierTypes.CAST;
    const graph = { get: (id: string) => (id === 'ob' ? { world: new Matrix4(), ob: { id: 'ob' } } : { world: empty, ob: { id: 'e' } }) };
    const m = { positions: Float32Array.from(F.verts.flat()), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) } as EvalMesh;
    return t.apply(m, { ...t.defaults(), object: 'e', factor: 1, use_transform: useTransform } as never, { ob: { id: 'ob' }, doc: { objects: {} }, graph } as unknown as ModifierContext).positions;
  };
  it.each([false, true])('use_transform %s', (ut) => {
    const r = run(ut);
    (F[ut ? 'True' : 'False'] as number[][]).forEach((p, i) => expect(Math.hypot(r[i * 3] - p[0], r[i * 3 + 1] - p[1], r[i * 3 + 2] - p[2]), `vertex ${i}`).toBeLessThan(1e-3));
  });
});
