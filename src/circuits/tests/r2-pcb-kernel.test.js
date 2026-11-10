// Kernel requests, round 2.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createKernel } from '../src/kernel/ops.js';
import { defaultRules } from '../src/model/schema.js';
import { mm } from '../src/core/units.js';

const wasm = fs.readFileSync(path.resolve(import.meta.dirname, '../src/kernel/kernel.wasm'));

const library = {
  tht: {
    id: 'tht',
    name: 'Header',
    prefix: 'J',
    symbol: { pins: [], graphics: [] },
    footprint: {
      name: 'tht',
      pads: [
        {
          num: '1',
          x: 0,
          y: 0,
          shape: 'round',
          w: mm(1.7),
          h: mm(1.7),
          side: 'thru',
          drill: mm(1),
        },
      ],
      graphics: [],
    },
  },
};

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

function board(objects) {
  return {
    id: 'b',
    kind: 'pcb',
    name: 'Board',
    board: { outline: square(0, 0, mm(30), mm(20)), origin: { x: 0, y: 0 }, copper: 2 },
    rules: defaultRules(),
    nets: { GND: {}, VCC: {} },
    objects,
  };
}

let kernel;
beforeAll(async () => {
  kernel = await createKernel(wasm);
});

describe('shelved pours', () => {
  const header = (id, x, net) => ({
    id,
    t: 'comp',
    comp: 'tht',
    x,
    y: mm(10),
    rot: 0,
    side: 'top',
    designator: id,
    padNets: { 1: net },
  });
  const pour = (id, net, extra) => ({
    id,
    t: 'pour',
    layer: 'top',
    net,
    pts: square(mm(1), mm(1), mm(29), mm(19)),
    clearance: mm(0.3),
    ...extra,
  });

  it('are not filled and leave their area to the pours after them', async () => {
    const parts = [header('J1', mm(8), 'GND'), header('J2', mm(22), 'VCC')];
    const both = board([
      ...parts,
      pour('gnd', 'GND', { priority: 0 }),
      pour('vcc', 'VCC', { priority: 1 }),
    ]);
    const width = (polys) => {
      const xs = polys.flatMap((rings) => rings[0].filter((_, i) => i % 2 === 0));
      return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    };
    const filled = await kernel.pours(both, library);
    // The ground pour comes first and takes the area; VCC is left with its own pad.
    expect(width(filled.get('gnd'))).toBeGreaterThan(mm(25));
    expect(width(filled.get('vcc'))).toBeLessThan(mm(3));

    const shelved = board([
      ...parts,
      pour('gnd', 'GND', { priority: 0, shelved: true }),
      pour('vcc', 'VCC', { priority: 1 }),
    ]);
    const fills = await kernel.pours(shelved, library);
    expect(fills.has('gnd')).toBe(false);
    expect(width(fills.get('vcc'))).toBeGreaterThan(mm(25));
  });
});
