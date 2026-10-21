// .blend import of NURBS surfaces: grids, orders, knot flags and resolutions come through and the
// tessellation matches the recorded evaluated positions (tests/fixtures/blend/make_surface.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBlend } from '../../src/io/blend/convert';
import { surfaceToMesh } from '../../src/surface/nurbs';
import type { DocumentData } from '../../src/data/types';

const dir = new URL('../fixtures/blend/', import.meta.url);
const ref = JSON.parse(readFileSync(new URL('surface.json', dir), 'utf8')) as Record<string, { nv: number; nf: number; co: number[][] }>;

describe('.blend NURBS surfaces', () => {
  it('imports surface objects and evaluates them like the source', async () => {
    const doc: DocumentData = (await readBlend(new Uint8Array(readFileSync(new URL('surface_zstd.blend', dir))))).doc;
    for (const [name, r] of Object.entries(ref)) {
      const ob = Object.values(doc.objects).find((o) => o.name === name)!;
      expect(ob.type).toBe('SURFACE');
      const cu = doc.curves[ob.data!];
      const m = surfaceToMesh(cu);
      expect(m.positions.length / 3, name).toBe(r.nv);
      expect(m.offsets.length - 1, name).toBe(r.nf);
      let worst = 0;
      r.co.forEach((p, k) => {
        const i = k * 7 * 3;
        worst = Math.max(worst, Math.hypot(m.positions[i] - p[0], m.positions[i + 1] - p[1], m.positions[i + 2] - p[2]));
      });
      expect(worst, name).toBeLessThan(1e-3);
    }
  });
});
