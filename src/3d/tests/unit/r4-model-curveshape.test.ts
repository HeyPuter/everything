// @vitest-environment happy-dom
// Bevelled curves from a .blend file: 3D fill modes, bevel start / end factors with their mappings and
// taper radius modes give the recorded vertex counts and bounds (tests/fixtures/blend/make_curveshape.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import '../../src/ops/data';
import '../../src/modes/index';
import { readBlend } from '../../src/io/blend/convert';

describe('curve geometry (recorded reference)', () => {
  it('fill modes, bevel factors and taper modes', async () => {
    const dir = 'tests/fixtures/blend/';
    const ref = JSON.parse(readFileSync(dir + 'curveshape.json', 'utf8')) as Record<string, { nv: number; nf: number; min: number[]; max: number[] }>;
    const doc = (await readBlend(new Uint8Array(readFileSync(dir + 'curveshape_zstd.blend')))).doc;
    setApp(new App(doc));
    app.graph.evaluate(app.doc);
    for (const [name, r] of Object.entries(ref)) {
      const ob = Object.values(app.doc.objects).find((o) => o.name === name)!;
      const m = app.graph.get(ob.id)!.mesh!;
      expect([m.positions.length / 3, m.offsets.length - 1], name).toEqual([r.nv, r.nf]);
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      const w = app.graph.get(ob.id)!.world;
      for (let i = 0; i < m.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          // object space → the recorded values are object space (origin at the curve)
          lo[k] = Math.min(lo[k], m.positions[i + k]);
          hi[k] = Math.max(hi[k], m.positions[i + k]);
        }
      void w;
      // (the Segments mapping places its cuts within a few millimetres of the reference)
      const tol = name === 'FacSeg' ? 1e-2 : 5e-3;
      lo.forEach((x, k) => expect(Math.abs(x - r.min[k]), `${name} min ${k}`).toBeLessThan(tol));
      hi.forEach((x, k) => expect(Math.abs(x - r.max[k]), `${name} max ${k}`).toBeLessThan(tol));
    }
  });
});
