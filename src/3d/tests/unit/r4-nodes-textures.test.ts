// @vitest-environment happy-dom
// Texture, color and vector nodes evaluated on the CPU by Geometry Nodes: trees from
// tests/fixtures/geonodes_tex are evaluated and compared with the recorded expected values.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSpec, firstMismatch, type GnSpec } from './gnspec';
import '../../src/geonodes/index';

const dir = join(__dirname, '../fixtures/geonodes_tex');
const REPORT = !!process.env.GN_REPORT;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cases = JSON.parse(readFileSync(join(dir, file), "utf8")) as { name: string; spec: GnSpec; expected: Record<string, unknown[]>; eps?: number }[];
  describe(`geometry nodes: ${file.replace('.json', '')}`, () => {
    for (const c of cases)
      it(c.name, () => {
        const r = runSpec(c.spec);
        if (REPORT) {
          for (const [label, exp] of Object.entries(c.expected)) {
            const got = r.values[label];
            const i = got ? firstMismatch(exp, got, c.eps ?? 1e-3) : -2;
            
            process.stdout.write(`${i === -1 ? 'OK  ' : 'FAIL'} ${label} ${r.errors.join(';')} ${i >= 0 ? `[${i}] exp ${JSON.stringify(exp[i])} got ${JSON.stringify(got?.[i])}` : ''}` + "\n");
          }
          return;
        }
        expect(r.errors).toEqual([]);
        for (const [label, exp] of Object.entries(c.expected)) {
          const got = r.values[label];
          expect(got, `${label} missing`).toBeDefined();
          const i = firstMismatch(exp, got, c.eps ?? 1e-3);
          expect(i, `${label}[${i}]: expected ${JSON.stringify(exp[i])}, got ${JSON.stringify(got?.[i])}`).toBe(-1);
        }
      });
  });
}
