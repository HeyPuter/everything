// @vitest-environment happy-dom
// Function, field, topology and input geometry nodes: trees from tests/fixtures/geonodes are
// evaluated and their stored attributes compared with the recorded expected values.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSpec, firstMismatch, type GnSpec } from './gnspec';

const dir = join(__dirname, '../fixtures/geonodes');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cases = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { name: string; spec: GnSpec; expected: Record<string, unknown[]> }[];
  describe(`geometry nodes: ${file.replace('.json', '')}`, () => {
    for (const c of cases)
      it(c.name, () => {
        const r = runSpec(c.spec);
        expect(r.errors).toEqual([]);
        for (const [label, exp] of Object.entries(c.expected)) {
          const got = r.values[label];
          expect(got, `${label} missing`).toBeDefined();
          const i = firstMismatch(exp, got);
          expect(i, `${label}[${i}]: expected ${JSON.stringify(exp[i])}, got ${JSON.stringify(got?.[i])}`).toBe(-1);
        }
      });
  });
}
