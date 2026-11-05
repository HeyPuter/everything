// Regression tests from the manufacturing-output and import review.
import { describe, it, expect } from 'vitest';
import { exportGerbers } from '../src/io/gerber.js';
import { mm } from '../src/core/units.js';
import { defaultRules } from '../src/model/schema.js';
import { compFieldPlacement } from '../src/model/pcb.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i],
      yi = r[i + 1],
      xj = r[j],
      yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether the regions of a 4.6 mm Gerber file leave (x, y) dark, honouring LPD/LPC order. */
function regionDarkAt(text, x, y) {
  let dark = true,
    region = null,
    ring = null,
    result = false;
  for (const m of text.matchAll(/%(LP[DC])\*%|(G36|G37)\*|X(-?\d+)Y(-?\d+)D0([12])\*/g)) {
    if (m[1]) dark = m[1] === 'LPD';
    else if (m[2] === 'G36') region = [];
    else if (m[2] === 'G37') {
      if (region.some((r) => inRing(x, y, r))) result = dark;
      region = null;
    } else if (region) {
      if (m[5] === '2') region.push((ring = []));
      ring.push(Number(m[3]), Number(m[4]));
    }
  }
  return result;
}

function pourBoard(objects) {
  return {
    id: 'b',
    kind: 'pcb',
    name: 'Pours',
    board: { outline: square(0, 0, mm(40), mm(30)), origin: { x: 0, y: 0 }, copper: 2 },
    rules: defaultRules(),
    nets: {},
    objects,
  };
}

describe('Gerber pours', () => {
  it('keeps a pour that sits inside another pour’s hole, whatever the document order', () => {
    const small = {
      id: 'small',
      t: 'pour',
      layer: 'bottom',
      pts: square(mm(14), mm(12), mm(22), mm(18)),
      net: 'VCC',
    };
    const big = {
      id: 'big',
      t: 'pour',
      layer: 'bottom',
      pts: square(mm(1), mm(1), mm(39), mm(29)),
      net: 'GND',
    };
    const pourFills = {
      small: [[square(mm(14), mm(12), mm(22), mm(18))]],
      big: [[square(mm(1), mm(1), mm(39), mm(29)), square(mm(13.7), mm(11.7), mm(22.3), mm(18.3))]],
    };
    for (const objects of [
      [small, big],
      [big, small],
    ]) {
      const files = exportGerbers(pourBoard(objects), {}, { pourFills });
      const gbl = files.find((f) => f.layer === 'bottom').content;
      expect(regionDarkAt(gbl, mm(18), mm(15))).toBe(true); // the small pour
      expect(regionDarkAt(gbl, mm(13.8), mm(15))).toBe(false); // the clearance gap
      expect(regionDarkAt(gbl, mm(5), mm(5))).toBe(true); // the big pour
      // Each pour keeps its own net attribute.
      expect(gbl).toContain('%TO.N,VCC*%');
      expect(gbl).toContain('%TO.N,GND*%');
    }
  });
});

/** Bounding box of every drawn coordinate in a Gerber file, in nm. */
function drawnBox(text) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const m of text.matchAll(/X(-?\d+)Y(-?\d+)D0[123]\*/g)) {
    const x = Number(m[1]),
      y = Number(m[2]);
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
  }
  return b;
}

describe('Gerber silkscreen fields', () => {
  const chip = {
    id: 'chip',
    name: 'Chip',
    prefix: 'R',
    symbol: { pins: [], graphics: [] },
    footprint: {
      name: '0805',
      graphics: [],
      pads: [
        { num: '1', x: -mm(1), y: 0, shape: 'rect', w: mm(1), h: mm(1.3), side: 'top' },
        { num: '2', x: mm(1), y: 0, shape: 'rect', w: mm(1), h: mm(1.3), side: 'top' },
      ],
    },
  };
  const boardWith = (comp) =>
    pourBoard([{ id: 'c', t: 'comp', comp: 'chip', designator: 'R1', value: '10k', ...comp }]);
  const legend = (b, layer) =>
    exportGerbers(b, { chip }, {}).find((f) => f.layer === layer).content;

  it('places the designator where the board canvas shows it', () => {
    for (const [side, rot] of [
      ['top', 90],
      ['top', 180],
      ['bottom', 270],
      ['top', 0],
    ]) {
      const comp = { x: mm(20), y: mm(15), rot, side };
      const b = boardWith(comp);
      const f = compFieldPlacement(b.objects[0], 'designator', chip);
      const box = drawnBox(legend(b, side === 'top' ? 'topOverlay' : 'bottomOverlay'));
      expect(Math.abs((box.minX + box.maxX) / 2 - f.x)).toBeLessThan(mm(0.15));
      expect(Math.abs((box.minY + box.maxY) / 2 - f.y)).toBeLessThan(mm(0.15));
      // Text along the part's rotation: a quarter turn makes the text run vertically.
      const vertical = box.maxY - box.minY > box.maxX - box.minX;
      expect(vertical).toBe(rot % 180 === 90);
    }
  });

  it('draws a value field that is shown on the board', () => {
    const shown = legend(
      boardWith({
        x: mm(20),
        y: mm(15),
        rot: 0,
        side: 'top',
        fields: { value: { hidden: false } },
      }),
      'topOverlay',
    );
    const hidden = legend(boardWith({ x: mm(20), y: mm(15), rot: 0, side: 'top' }), 'topOverlay');
    const f = compFieldPlacement(
      { x: mm(20), y: mm(15), rot: 0, side: 'top', fields: { value: { hidden: false } } },
      'value',
      chip,
    );
    expect(drawnBox(shown).minY).toBeLessThan(f.y);
    expect(drawnBox(hidden).minY).toBeGreaterThan(mm(15));
  });

  it('honours the alignment of board text', () => {
    const text = {
      id: 't',
      t: 'text',
      layer: 'topOverlay',
      x: mm(20),
      y: mm(15),
      text: 'ABC',
      h: mm(1),
      w: mm(0.15),
      align: { h: 'right', v: 'top' },
    };
    const box = drawnBox(legend(pourBoard([text]), 'topOverlay'));
    expect(box.maxX).toBeLessThanOrEqual(mm(20) + mm(0.1));
    expect(box.maxY).toBeLessThanOrEqual(mm(15) + mm(0.1));
  });
});
