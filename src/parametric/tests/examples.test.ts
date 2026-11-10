import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import { EXAMPLES } from '../src/app/examples';
import { parseDocument, serializeDocument } from '../src/model/document';
import { solveSketch } from '../src/sketch/solver';
import type { SkDimension } from '../src/model/types';

beforeAll(async () => {
  setOc(await init());
});

describe('built-in examples', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.name} rebuilds without errors`, async () => {
      const original = ex.make();
      const doc = parseDocument(serializeDocument(original));
      expect(doc).toEqual(original);
      for (const f of doc.features) {
        if (f.type !== 'sketch') continue;
        const res = solveSketch(f.entities, f.constraints, { value: (d: SkDimension) => Number(d.value) });
        expect(res.converged, `${f.name} solves`).toBe(true);
        expect(res.status).not.toBe('over');
      }
      const b = new ModelBuilder();
      const r = await b.build({ features: doc.features, upTo: doc.features.length, blobs: {}, quality: 0 });
      expect(r.status.filter((s) => !s.ok)).toEqual([]);
      expect(b.massProperties()!.volume).toBeGreaterThan(0);
    });
  }
});
