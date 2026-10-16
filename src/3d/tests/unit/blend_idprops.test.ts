// .blend import of custom properties (tests/fixtures/blend/idprops_zstd.blend, written by
// tests/fixtures/blend/make_idprops.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBlend } from '../../src/io/blend/convert';

describe('.blend custom properties', () => {
  it('imports numbers, booleans, text and arrays; skips groups with a warning', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../fixtures/blend/idprops_zstd.blend', import.meta.url)));
    const imp = await readBlend(bytes);
    const ob = Object.values(imp.doc.objects).find((o) => o.name === 'Holder')!;
    const c = ob.custom as Record<string, unknown>;
    expect(c.weight).toBeCloseTo(0.25);
    expect(c.count).toBe(7);
    expect(c.flag).toBe(true);
    expect(c.label).toBe('hello');
    expect(c.vec).toEqual([1, 2, 3]);
    expect(c.ints).toEqual([4, 5]);
    expect('group' in c).toBe(false);
    expect(JSON.stringify(imp.warnings ?? imp)).toContain('Some custom properties not imported');
  });
});
