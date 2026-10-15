// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { newMeshData, newCamera } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const trs = (t: number[], rz = 0, s = [1, 1, 1]) => new Matrix4().compose(new Vector3(...t), new Quaternion().setFromEuler(new Euler(0, 0, rz)), new Vector3(...s));
type Obj = { world: Matrix4; ob?: object; pose?: unknown };
function ctxOf(objs: Record<string, Obj>, cameras: Record<string, unknown> = {}): ModifierContext {
  const all: Record<string, Obj> = { ob: { world: new Matrix4() }, ...objs };
  for (const [id, o] of Object.entries(all)) o.ob ??= { id, type: 'EMPTY', data: null, name: id };
  return { ob: { id: 'ob', name: 'ob' }, graph: { get: (id: string) => all[id] }, doc: { cameras } } as unknown as ModifierContext;
}
const run = (type: string, m: EvalMesh, props: Record<string, unknown>, ctx: ModifierContext) => {
  const t = modifierTypes[type];
  return t.apply(m, { ...t.defaults(), type, name: type, id: 'md', ...props } as never, ctx);
};
const uvs = (m: EvalMesh, n = 4) => Array.from(m.uvs.slice(0, n * 2));
const close = (a: number[], b: number[][]) => b.flat().forEach((v, i) => expect(a[i]).toBeCloseTo(v, 4));

describe('UV Project', () => {
  const grid = () => newMeshData('g', prim.grid(2, 2)) as unknown as EvalMesh;
  it('projects along an empty with its XY square mapped to 0..1', () => {
    const ctx = ctxOf({ e: { world: trs([0.5, 0, 3], 0, [2, 1, 1]) } });
    close(uvs(run('UV_PROJECT', grid(), { projectors: ['e'] }, ctx)), [[0.125, 0], [0.375, 0], [0.375, 0.5], [0.125, 0.5]]);
    const rot = ctxOf({ e: { world: trs([0.5, 0, 3], Math.PI / 6, [2, 1, 1]) } });
    close(uvs(run('UV_PROJECT', grid(), { projectors: ['e'] }, rot)), [[0.05024, 0.44199], [0.26675, 0.19199], [0.39175, 0.625], [0.17524, 0.875]]);
  });

  it('projects through a camera with aspect, scale, shift and sensor fit', () => {
    const cam = { ...newCamera('C') } as Record<string, unknown>;
    const ctx = ctxOf({ c: { world: trs([0.2, 0.1, 4]), ob: { id: 'c', type: 'CAMERA', data: 'cd' } } }, { cd: cam });
    const go = (p: Record<string, unknown> = {}) => uvs(run('UV_PROJECT', grid(), { projectors: ['c'], ...p }, ctx));
    close(go(), [[0.08333, 0.11806], [0.43056, 0.11806], [0.43056, 0.46528], [0.08333, 0.46528]]);
    close(go({ scale_x: 2 }), [[0.29167, 0.11806], [0.46528, 0.11806], [0.46528, 0.46528], [0.29167, 0.46528]]);
    close(go({ aspect_y: 2 }), [[-0.33333, 0.11806], [0.36111, 0.11806], [0.36111, 0.46528], [-0.33333, 0.46528]]);
    close(go({ aspect_x: 2 }), [[0.08333, -0.26389], [0.43056, -0.26389], [0.43056, 0.43056], [0.08333, 0.43056]]);
    Object.assign(cam, { type: 'ORTHO', ortho_scale: 3 });
    close(go(), [[0.1, 0.13333], [0.43333, 0.13333], [0.43333, 0.46667], [0.1, 0.46667]]);
    Object.assign(cam, { type: 'PERSP', shift_x: 0.1, shift_y: 0.05 });
    close(go(), [[-0.01667, 0.06806], [0.33056, 0.06806], [0.33056, 0.41528], [-0.01667, 0.41528]]);
    Object.assign(cam, { shift_x: 0, shift_y: 0, sensor_fit: 'VERTICAL' });
    close(go(), [[-0.125, -0.07292], [0.39583, -0.07292], [0.39583, 0.44792], [-0.125, 0.44792]]);
  });
});

describe('UV Warp', () => {
  const plane = () => newMeshData('p', prim.plane(2)) as unknown as EvalMesh;
  const none = ctxOf({});
  it('offsets, scales and rotates around the center', () => {
    close(uvs(run('UV_WARP', plane(), { offset: [0.1, 0.2] }, none)), [[0.1, 0.2], [1.1, 0.2], [1.1, 1.2], [0.1, 1.2]]);
    close(uvs(run('UV_WARP', plane(), { scale: [2, 0.5] }, none)), [[-0.5, 0.25], [1.5, 0.25], [1.5, 0.75], [-0.5, 0.75]]);
    close(uvs(run('UV_WARP', plane(), { rotation: Math.PI / 6 }, none)), [[0.31699, -0.18301], [1.18301, 0.31699], [0.68301, 1.18301], [-0.18301, 0.68301]]);
    close(uvs(run('UV_WARP', plane(), { rotation: Math.PI / 6, center: [0, 0] }, none)), [[0, 0], [0.86603, 0.5], [0.36603, 1.36603], [-0.5, 0.86603]]);
    close(uvs(run('UV_WARP', plane(), { rotation: Math.PI / 6, offset: [0.1, 0.2], scale: [2, 0.5] }, none)), [[0.10718, 0.2701], [1.83923, 0.5201], [0.83923, 0.95311], [-0.89282, 0.70311]]);
  });

  it('follows the transform between two objects', () => {
    const ctx = ctxOf({ a: { world: trs([0.3, 0.1, 0]) }, b: { world: trs([1, 0.5, 2], Math.PI / 2, [2, 2, 2]) } });
    close(uvs(run('UV_WARP', plane(), { object_from: 'a', object_to: 'b' }, ctx)), [[0.05, 1.1], [0.05, 0.6], [0.55, 0.6], [0.55, 1.1]]);
    close(uvs(run('UV_WARP', plane(), { object_from: 'a', object_to: 'b', axis_u: 'Y', axis_v: 'Z' }, ctx)), [[0.85, -0.75], [0.85, -0.75], [0.85, -0.25], [0.85, -0.25]]);
    close(uvs(run('UV_WARP', plane(), { object_from: 'a', object_to: 'b', offset: [0.1, 0.2], scale: [2, 0.5], rotation: Math.PI / 6 }, ctx)), [[0.18505, 1.04641], [0.31005, 0.18038], [0.52655, 0.68038], [0.40155, 1.54641]]);
    // one object alone does nothing
    close(uvs(run('UV_WARP', plane(), { object_from: 'a' }, ctx)), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  });
});
