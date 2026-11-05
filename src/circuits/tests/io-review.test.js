// Regression tests from the manufacturing-output and import review.
import { describe, it, expect } from 'vitest';
import { exportGerbers } from '../src/io/gerber.js';
import { mm } from '../src/core/units.js';
import { defaultRules } from '../src/model/schema.js';

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
