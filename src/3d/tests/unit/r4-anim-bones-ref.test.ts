// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import { pythonAvailable, runPy } from './support/python';
import expected from '../fixtures/anim/bones_expected.json';

/** Bone constraints and IK: the same Python scenario script, results compared with the reference run. */
describe('bone constraints match the reference', () => {
  let py = false;
  let got: Record<string, Record<string, number[][]>> = {};
  beforeAll(async () => {
    py = await pythonAvailable();
    if (!py) return;
    setApp(new App(startupDocument()));
    const src = readFileSync(new URL('../fixtures/anim/bones_scene.py', import.meta.url), 'utf8');
    const printed = runPy(src);
    got = JSON.parse(printed.split('\n').find((l) => l.startsWith('JSON'))!.slice(4));
  }, 120000);
  for (const [name, bones] of Object.entries(expected as Record<string, Record<string, number[][]>>)) {
    it(name, () => {
      if (!py) return;
      for (const [bone, want] of Object.entries(bones)) {
        const m = got[name]?.[bone];
        expect(m, `${name} ${bone}`).toBeTruthy();
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) expect(m[r][c], `${name} ${bone} [${r}][${c}]`).toBeCloseTo(want[r][c], 3);
      }
    });
  }
});
