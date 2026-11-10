// Round 2 review: manufacturing outputs, import, the project format and storage.

import { describe, it, expect } from 'vitest';
import { exportGerbers } from '../src/io/gerber.js';
import { mm } from '../src/core/units.js';
import { defaultRules } from '../src/model/schema.js';

const emptyBoard = (objects) => ({
  id: 'b1',
  kind: 'pcb',
  name: 'Board.pcb',
  board: {
    outline: [0, 0, mm(30), 0, mm(30), mm(20), 0, mm(20)],
    origin: { x: 0, y: 0 },
    copper: 2,
  },
  rules: defaultRules(),
  nets: {},
  objects,
});
const gerber = (doc, ext, lib = {}) =>
  exportGerbers(doc, lib, {}).find((f) => f.name.endsWith(`.${ext}`))?.content;
/** The drawing commands of a Gerber file, without the header and aperture list. */
const body = (text) =>
  text.split('\n').filter((l) => /^(X|G0[123]|G3[67]|D\d)/.test(l) && !/^G0[14]\*$|^G75/.test(l));

describe('Gerber drawings on paste, mask and mechanical layers', () => {
  const square = { x1: mm(1), y1: mm(1), x2: mm(3), y2: mm(2) };
  const region = [
    'G36*',
    'X1000000Y1000000D02*',
    'X3000000Y1000000D01*',
    'X3000000Y2000000D01*',
    'X1000000Y2000000D01*',
    'X1000000Y1000000D01*',
    'G37*',
  ];

  it('writes shapes drawn on a paste layer into the stencil file', () => {
    const doc = emptyBoard([
      { id: 'f', t: 'fill', layer: 'topPaste', ...square },
      { id: 'r', t: 'region', layer: 'bottomPaste', pts: [0, 0, mm(1), 0, mm(1), mm(1)] },
      { id: 't', t: 'track', layer: 'topPaste', x1: 0, y1: 0, x2: mm(5), y2: 0, w: mm(0.3) },
      {
        id: 'a',
        t: 'arc',
        layer: 'topPaste',
        cx: 0,
        cy: 0,
        r: mm(2),
        a0: 0,
        sweep: 90,
        w: mm(0.3),
      },
    ]);
    const top = gerber(doc, 'GTP');
    expect(body(top)).toEqual(expect.arrayContaining(region));
    expect(top).toContain('%ADD10C,0.3*%');
    expect(top).toContain('X0Y0D02*\nX5000000Y0D01*');
    expect(top).toContain('G03X0Y2000000I-2000000J0D01*');
    expect(top).not.toContain('X1000000Y0D01*');
    expect(body(gerber(doc, 'GBP'))).toEqual([
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y0D01*',
      'G37*',
    ]);
  });

  it('writes fills drawn on a mechanical layer', () => {
    const files = exportGerbers(
      emptyBoard([{ id: 'f', t: 'fill', layer: 'mech1', ...square }]),
      {},
      {},
    );
    const mech = files.find((f) => f.layer === 'mech1');
    expect(mech).toBeTruthy();
    expect(body(mech.content)).toEqual(region);
  });

  it('writes text placed on a solder mask layer as mask openings', () => {
    const text = { id: 'x', t: 'text', x: mm(5), y: mm(5), text: 'I', h: mm(2), w: mm(0.25) };
    const mask = gerber(emptyBoard([{ ...text, layer: 'topSolder' }]), 'GTS');
    const silk = gerber(emptyBoard([{ ...text, layer: 'topOverlay' }]), 'GTO');
    expect(body(silk).length).toBeGreaterThan(1);
    expect(body(mask)).toEqual(body(silk));
    expect(body(gerber(emptyBoard([{ ...text, layer: 'topSolder' }]), 'GBS'))).toEqual([]);
  });
});
