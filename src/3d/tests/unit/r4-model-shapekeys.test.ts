// @vitest-environment happy-dom
// Absolute shape keys: evaluation time between keys with per-key interpolation (recorded reference),
// re-timing, and .blend import (tests/fixtures/blend/make_shapekeys.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/modeling/index';
import { readBlend } from '../../src/io/blend/convert';
import { absoluteShape, baseEvalMesh } from '../../src/eval/depsgraph';
import type { MeshData, ShapeKey } from '../../src/data/types';

type Interp = NonNullable<ShapeKey['interpolation']>;
function plane(vals: number[], types: string): MeshData {
  setApp(new App(startupDocument()));
  const me = Object.values(app.doc.meshes)[0] as MeshData;
  me.shape_keys = vals.map((z, i) => ({ name: `K${i}`, data: Float32Array.from(me.positions, (x, j) => (j % 3 === 2 ? z : x)), value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: 'K0', interpolation: (types[i] === 'B' ? 'KEY_BSPLINE' : 'KEY_LINEAR') as Interp }));
  me.use_relative = false;
  return me;
}
const z = (me: MeshData, t: number) => +absoluteShape(me, t)![2].toFixed(5);

describe('absolute shape keys (recorded reference)', () => {
  const vals = [0, 1, 2.5, 3];
  const ts = [0, 5, 10, 15, 20, 25, 30, 35];
  const REF: [string, number[]][] = [
    ['BBBB', [0.16667, 0.53125, 1.08333, 1.73958, 2.33333, 2.71875, 2.91667, 2.91667]],
    ['BBBL', [0.16667, 0.53125, 1.08333, 1.73958, 2.33333, 2.73438, 3.0, 3.0]],
    ['LLLL', [0.0, 0.5, 1.0, 1.75, 2.5, 2.75, 3.0, 3.0]],
    ['BBLB', [0.16667, 0.53125, 1.08333, 1.74479, 2.5, 2.73438, 2.91667, 2.91667]],
    ['LBBB', [0.0, 0.51562, 1.08333, 1.73958, 2.33333, 2.71875, 2.91667, 2.91667]],
  ];
  it.each(REF)('%s', (types, want) => {
    const me = plane(vals, types);
    ts.forEach((t, i) => expect(z(me, t), `t=${t}`).toBeCloseTo(want[i], 4));
  });
  it('the evaluated mesh follows eval_time; re-time spaces the keys 10 apart', () => {
    const me = plane(vals, 'LLLL');
    me.eval_time = 15;
    expect(baseEvalMesh(me).positions[2]).toBeCloseTo(1.75, 5);
    me.shape_keys[2].frame = 13;
    app.doc.scene.active_object = Object.values(app.doc.objects).find((o) => o.data === me.id)!.id;
    expect(app.run('object.shape_key_retime')).toBe('FINISHED');
    expect(me.shape_keys.map((k) => k.frame)).toEqual([0, 10, 20, 30]);
  });
  it('.blend absolute keys keep their frames, interpolation and evaluation time', async () => {
    const dir = 'tests/fixtures/blend/';
    const ref = JSON.parse(readFileSync(dir + 'shapekeys.json', 'utf8'));
    const doc = (await readBlend(new Uint8Array(readFileSync(dir + 'shapekeys_zstd.blend')))).doc;
    const me = Object.values(doc.meshes)[0];
    expect(me.use_relative).toBe(false);
    expect(me.eval_time).toBeCloseTo(ref.eval_time, 4);
    expect(me.shape_keys.map((k) => Math.round(k.frame!))).toEqual(ref.frames.map(Math.round));
    for (const [t, want] of Object.entries(ref.z)) expect(+absoluteShape(me, +t)![2].toFixed(4)).toBeCloseTo(want as number, 3);
  });
});
