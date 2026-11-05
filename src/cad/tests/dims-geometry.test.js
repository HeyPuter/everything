import { describe, expect, it } from 'vitest';
import { defaultHeader } from '../src/core/schema.js';
import { defaultDimStyle } from '../src/core/styles.js';
import {
  DIAMETER_SIGN,
  angularSector,
  buildDimension,
  buildLeader,
  dimensionBounds,
  dimensionText,
  measureDimension,
} from '../src/core/dims.js';

const header = defaultHeader();
const style = (props) => ({ ...defaultDimStyle(), ...props });

function dim(props) {
  return {
    type: 'dimension',
    dimType: 'linear',
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 0,
    x3: 0,
    y3: 0,
    x4: 0,
    y4: 0,
    lx: 50,
    ly: 10,
    rot: 0,
    text: '',
    style: 'Standard',
    ordAxis: 'x',
    ...props,
  };
}

const isVertical = (l) => l.pts.length === 4 && Math.abs(l.pts[0] - l.pts[2]) < 1e-9;
const isHorizontal = (l) => l.pts.length === 4 && Math.abs(l.pts[1] - l.pts[3]) < 1e-9;

describe('measureDimension', () => {
  it('measures each type', () => {
    expect(measureDimension(dim())).toBe(100);
    expect(measureDimension(dim({ x2: 30, y2: 40, rot: Math.PI / 2 }))).toBeCloseTo(40, 9);
    expect(measureDimension(dim({ dimType: 'aligned', x2: 30, y2: 40 }))).toBe(50);
    expect(measureDimension(dim({ dimType: 'radius', x2: 3, y2: 4 }))).toBe(5);
    expect(measureDimension(dim({ dimType: 'diameter', x2: 3, y2: 4 }))).toBe(10);
    expect(measureDimension(dim({ dimType: 'ordinate', x1: -30, y1: 12 }))).toBe(30);
    expect(measureDimension(dim({ dimType: 'ordinate', x1: -30, y1: 12, ordAxis: 'y' }))).toBe(12);
  });

  it('measures the angular sector holding the location', () => {
    const a = dim({ dimType: 'angular', x1: 10, y1: 0, x2: 0, y2: 10, x3: 0, y3: 0, lx: 5, ly: 5 });
    expect(measureDimension(a)).toBeCloseTo(Math.PI / 2, 12);
    expect(measureDimension({ ...a, lx: -5, ly: -5 })).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(angularSector({ ...a, lx: -5, ly: -5 }).start).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('dimensionText', () => {
  it('formats with style precision and trailing zeros', () => {
    expect(dimensionText(dim(), style({ precision: 2, trailingZeros: true }), header)).toBe('100.00');
    expect(dimensionText(dim(), style({ precision: 2, trailingZeros: false }), header)).toBe('100');
    expect(dimensionText(dim({ x2: 12.345 }), style({ precision: 2 }), header)).toBe('12.35');
  });

  it('applies prefix, suffix and overrides', () => {
    const st = style({ prefix: '(', suffix: ')' });
    expect(dimensionText(dim(), st, header)).toBe('(100)');
    expect(dimensionText(dim({ text: '<> TYP' }), style(), header)).toBe('100 TYP');
    expect(dimensionText(dim({ text: 'SEE NOTE' }), style(), header)).toBe('SEE NOTE');
  });

  it('marks radius, diameter and angles', () => {
    expect(dimensionText(dim({ dimType: 'radius', x2: 5 }), style(), header)).toBe('R5');
    expect(dimensionText(dim({ dimType: 'diameter', x2: 5 }), style(), header)).toBe(DIAMETER_SIGN + '10');
    const a = dim({ dimType: 'angular', x1: 10, y1: 0, x2: 0, y2: 10, lx: 5, ly: 5 });
    expect(dimensionText(a, style(), header)).toBe('90°');
    expect(dimensionText(a, style({ precision: 1, trailingZeros: true }), header)).toBe('90.0°');
    expect(dimensionText(a, style({ precision: 2 }), { ...header, angularFormat: 'dms' })).toBe('90°0\'');
  });

  it('follows the header linear format', () => {
    const arch = { ...header, units: 'in', linearFormat: 'architectural' };
    expect(dimensionText(dim({ x2: 40.5 }), style({ precision: 4 }), arch)).toBe('3\'-4 1/2"');
  });
});

describe('linear dimension', () => {
  const g = buildDimension(dim(), style({ precision: 2, trailingZeros: true }), header);

  it('draws the dimension line through the location', () => {
    const line = g.lines.find((l) => isHorizontal(l) && Math.abs(l.pts[1] - 10) < 1e-9);
    expect(line).toBeTruthy();
    expect(Math.min(line.pts[0], line.pts[2])).toBeCloseTo(0, 9);
    expect(Math.max(line.pts[0], line.pts[2])).toBeCloseTo(100, 9);
  });

  it('draws vertical extension lines with offset and extension', () => {
    const ext = g.lines.filter(isVertical);
    expect(ext.length).toBe(2);
    expect(ext.map((l) => l.pts[0]).sort((a, b) => a - b)).toEqual([0, 100]);
    for (const l of ext) {
      expect(Math.min(l.pts[1], l.pts[3])).toBeCloseTo(0.625, 9);
      expect(Math.max(l.pts[1], l.pts[3])).toBeCloseTo(11.25, 9);
    }
  });

  it('puts arrows on the extension lines pointing outward', () => {
    expect(g.fills.length).toBe(2);
    const tips = g.fills.map((f) => [f[0][0], f[0][1]]).sort((a, b) => a[0] - b[0]);
    expect(tips[0]).toEqual([0, 10]);
    expect(tips[1]).toEqual([100, 10]);
    // The left arrow body lies to the right of its tip (pointing outward).
    const left = g.fills.find((f) => f[0][0] === 0)[0];
    expect(left[2]).toBeGreaterThan(0);
    expect(left[2]).toBeCloseTo(2.5, 9);
  });

  it('centers the text above the line', () => {
    expect(g.text.value).toBe('100.00');
    expect(g.text.x).toBeCloseTo(50, 9);
    expect(g.text.y).toBeCloseTo(10 + 0.625 + 1.25, 9);
    expect(g.text.rot).toBe(0);
    expect(g.text.h).toBe(2.5);
    expect(g.text.halign).toBe('center');
    expect(g.text.valign).toBe('middle');
  });

  it('breaks the line around centered text', () => {
    const c = buildDimension(dim(), style({ textPlacement: 'centered' }), header);
    expect(c.text.y).toBeCloseTo(10, 9);
    expect(c.lines.filter((l) => isHorizontal(l) && Math.abs(l.pts[1] - 10) < 1e-9).length).toBe(2);
  });

  it('reads vertical dimensions from the left', () => {
    const v = buildDimension(dim({ x2: 0, y2: 100, lx: -10, ly: 50, rot: Math.PI / 2 }), style(), header);
    expect(v.text.rot).toBeCloseTo(Math.PI / 2, 9);
    expect(v.text.x).toBeLessThan(-10);
    expect(v.lines.filter(isHorizontal).length).toBe(2);
    const h = buildDimension(dim({ x2: 0, y2: 100, lx: -10, ly: 50, rot: Math.PI / 2 }), style({ textAlign: 'horizontal' }), header);
    expect(h.text.rot).toBe(0);
  });

  it('keeps text upright when the points run right to left', () => {
    const r = buildDimension(dim({ x1: 100, x2: 0, ly: -10 }), style(), header);
    expect(r.text.rot).toBeCloseTo(0, 9);
    expect(r.text.y).toBeGreaterThan(-10);
  });

  it('moves arrows and text outside when they do not fit', () => {
    const t = buildDimension(dim({ x2: 3, lx: 1.5 }), style(), header);
    const tips = t.fills.map((f) => f[0]);
    // Left arrow points right (body to the left of the tip at x = 0).
    const left = tips.find((r) => r[0] === 0);
    expect(left[2]).toBeLessThan(0);
    expect(t.text.x).toBeGreaterThan(3);
    const line = t.lines.find((l) => isHorizontal(l) && Math.abs(l.pts[1] - 10) < 1e-9);
    expect(Math.min(line.pts[0], line.pts[2])).toBeLessThan(0);
    expect(Math.max(line.pts[0], line.pts[2])).toBeGreaterThan(3);
  });

  it('scales sizes', () => {
    const s = buildDimension(dim(), style({ scale: 2 }), header);
    expect(s.text.h).toBe(5);
    const f = s.fills.find((r) => r[0][0] === 0)[0];
    expect(f[2]).toBeCloseTo(5, 9);
  });
});

describe('aligned dimension', () => {
  it('runs parallel to the origins', () => {
    const ent = dim({ dimType: 'aligned', x2: 30, y2: 40, lx: 15 - 8, ly: 20 + 6 });
    const g = buildDimension(ent, style(), header);
    expect(g.text.value).toBe('50');
    expect(g.text.rot).toBeCloseTo(Math.atan2(40, 30), 9);
    const tips = g.fills.map((f) => [f[0][0], f[0][1]]);
    expect(tips[0][0]).toBeCloseTo(-8, 9);
    expect(tips[0][1]).toBeCloseTo(6, 9);
    expect(tips[1][0]).toBeCloseTo(22, 9);
    expect(tips[1][1]).toBeCloseTo(46, 9);
    // Extension lines are perpendicular to the origins line.
    const ext = g.lines.slice(0, 2);
    for (const l of ext) {
      const dx = l.pts[2] - l.pts[0],
        dy = l.pts[3] - l.pts[1];
      expect(dx * 30 + dy * 40).toBeCloseTo(0, 9);
    }
  });
});

describe('angular dimension', () => {
  const ent = dim({ dimType: 'angular', x1: 10, y1: 0, x2: 0, y2: 10, x3: 0, y3: 0, lx: 20, ly: 20 });
  const g = buildDimension(ent, style(), header);

  it('draws an arc at the location radius', () => {
    const r = Math.hypot(20, 20);
    const arc = g.lines.find((l) => l.pts.length > 4);
    expect(arc).toBeTruthy();
    for (let i = 0; i < arc.pts.length; i += 2) expect(Math.hypot(arc.pts[i], arc.pts[i + 1])).toBeCloseTo(r, 9);
    expect(arc.pts[0]).toBeCloseTo(r, 9);
    expect(arc.pts[arc.pts.length - 1]).toBeCloseTo(r, 9);
  });

  it('extends the rays to the arc', () => {
    const ext = g.lines.filter((l) => l.pts.length === 4);
    expect(ext.length).toBe(2);
    expect(ext.some((l) => isHorizontal(l) && Math.max(l.pts[0], l.pts[2]) > Math.hypot(20, 20))).toBe(true);
    expect(ext.some((l) => isVertical(l))).toBe(true);
  });

  it('labels 90 degrees at the middle of the arc', () => {
    expect(g.text.value).toBe('90°');
    expect(Math.atan2(g.text.y, g.text.x)).toBeCloseTo(Math.PI / 4, 9);
    expect(Math.hypot(g.text.x, g.text.y)).toBeGreaterThan(Math.hypot(20, 20));
    expect(g.fills.length).toBe(2);
  });

  it('skips extension lines when the arc crosses the rays', () => {
    const inner = buildDimension({ ...ent, lx: 6, ly: 6 }, style(), header);
    expect(inner.lines.length).toBe(1);
    expect(inner.lines[0].pts.length).toBeGreaterThan(4);
  });

  it('puts arrows on tails outside a tight arc', () => {
    const tight = buildDimension({ ...ent, lx: 2, ly: 2 }, style(), header);
    expect(tight.lines.filter((l) => l.pts.length === 4).length).toBe(2);
    expect(tight.fills.length).toBe(2);
    expect(Math.atan2(tight.text.y, tight.text.x)).toBeGreaterThan(Math.PI / 2);
  });
  it('puts tight text past the end nearer the location, so mirroring draws the mirror image', () => {
    // vertex (0, 0), rays at 0 and 30 degrees, location near the 0 degree ray
    const a = { ...ent, x1: 10, y1: 0, x2: 10 * Math.cos(Math.PI / 6), y2: 5, lx: 3, ly: 0.4 };
    const t = buildDimension(a, style(), header).text;
    expect(t.y).toBeLessThan(0);
    // mirrored across the y axis: the text is mirrored too
    const m = { ...a, x1: -a.x1, x2: -a.x2, lx: -a.lx };
    const tm = buildDimension(m, style(), header).text;
    expect(tm.x).toBeCloseTo(-t.x, 9);
    expect(tm.y).toBeCloseTo(t.y, 9);
  });
});

describe('radius and diameter', () => {
  it('draws a radius with arrow on the curve', () => {
    const g = buildDimension(dim({ dimType: 'radius', x1: 0, y1: 0, x2: 5, y2: 0, lx: 3, ly: 0 }), style(), header);
    expect(g.text.value).toBe('R5');
    expect(g.fills.length).toBe(1);
    expect(g.fills[0][0][0]).toBeCloseTo(5, 9);
    expect(g.fills[0][0][1]).toBeCloseTo(0, 9);
    // Center mark: two short lines crossing at the centre.
    const marks = g.lines.filter((l) => Math.abs((l.pts[0] + l.pts[2]) / 2) < 1e-9 && Math.abs((l.pts[1] + l.pts[3]) / 2) < 1e-9);
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it('runs out to an outside location', () => {
    const g = buildDimension(dim({ dimType: 'radius', x1: 0, y1: 0, x2: 5, y2: 0, lx: 0, ly: 12 }), style(), header);
    const leader = g.lines.find((l) => l.pts[3] === 12);
    expect(leader).toBeTruthy();
    expect(g.fills[0][0][1]).toBeCloseTo(5, 9);
    expect(g.text.y).toBeGreaterThan(12);
  });

  it('draws a diameter across the centre', () => {
    const g = buildDimension(dim({ dimType: 'diameter', x1: 0, y1: 0, x2: 5, y2: 0, lx: 2, ly: 0 }), style({ centerMark: 0 }), header);
    expect(g.text.value).toBe(DIAMETER_SIGN + '10');
    expect(g.fills.length).toBe(2);
    expect(g.lines.length).toBe(1);
    expect(g.lines[0].pts).toEqual([-5, 0, 5, 0]);
  });
});

describe('ordinate dimension', () => {
  it('leads from the feature with a jog', () => {
    const g = buildDimension(dim({ dimType: 'ordinate', x1: 30, y1: 10, x2: 35, y2: 40, ordAxis: 'x' }), style(), header);
    expect(g.text.value).toBe('30');
    const l = g.lines[0];
    expect(l.pts[0]).toBe(30);
    expect(l.pts[1]).toBeCloseTo(10.625, 9);
    expect(l.pts.slice(-2)).toEqual([35, 40]);
    expect(l.pts.length).toBe(8);
    expect(g.text.rot).toBeCloseTo(Math.PI / 2, 9);
    expect(g.text.y).toBeGreaterThan(40);
  });

  it('measures y datums along x', () => {
    const g = buildDimension(dim({ dimType: 'ordinate', x1: 10, y1: 25, x2: -20, y2: 25, ordAxis: 'y' }), style(), header);
    expect(g.text.value).toBe('25');
    expect(g.lines[0].pts.length).toBe(4);
    expect(g.text.x).toBeLessThan(-20);
    expect(g.text.rot).toBe(0);
  });
});

describe('arrow types', () => {
  it('draws each type', () => {
    const count = (t) => {
      const g = buildDimension(dim(), style({ arrowType: t }), header);
      return [g.fills.length, g.lines.length];
    };
    expect(count('closed')).toEqual([2, 3]);
    expect(count('open')).toEqual([0, 5]);
    expect(count('tick')).toEqual([0, 5]);
    expect(count('dot')).toEqual([2, 3]);
    expect(count('none')).toEqual([0, 3]);
  });
});

describe('leader', () => {
  it('draws arrow, landing and text', () => {
    const g = buildLeader({ type: 'leader', pts: [0, 0, 10, 10, 20, 10], text: 'NOTE', h: 0 }, style());
    expect(g.lines[0].pts).toEqual([0, 0, 10, 10, 20, 10]);
    expect(g.fills.length).toBe(1);
    const tri = g.fills[0][0];
    expect([tri[0], tri[1]]).toEqual([0, 0]);
    // Body sits up the first segment.
    expect(tri[2]).toBeGreaterThan(0);
    expect(tri[3]).toBeGreaterThan(0);
    expect(g.lines[1].pts).toEqual([20, 10, 22.5, 10]);
    expect(g.text).toMatchObject({ x: 23.125, y: 10, h: 2.5, halign: 'left', valign: 'middle', value: 'NOTE' });
  });

  it('right-justifies text when the leader runs left', () => {
    const g = buildLeader({ type: 'leader', pts: [0, 0, -10, 5], text: 'A', h: 3 }, style());
    expect(g.text.halign).toBe('right');
    expect(g.text.x).toBeCloseTo(-13.125, 9);
    expect(g.text.h).toBe(3);
  });

  it('omits text and landing when empty', () => {
    const g = buildLeader({ type: 'leader', pts: [0, 0, 10, 0], text: '' }, style());
    expect(g.lines.length).toBe(1);
    expect(g.text).toBe(null);
  });
});

describe('dimensionBounds', () => {
  it('covers lines, arrows and text', () => {
    const b = dimensionBounds(dim(), style(), header);
    expect(b[0]).toBeLessThanOrEqual(0);
    expect(b[2]).toBeGreaterThanOrEqual(100);
    expect(b[1]).toBeCloseTo(0.625, 9);
    // Text centre sits gap + h/2 above the line; its cap line is h/2 higher.
    expect(b[3]).toBeCloseTo(10 + 0.625 + 2.5, 9);
  });

  it('handles leaders', () => {
    const b = dimensionBounds({ type: 'leader', pts: [0, 0, 10, 10], text: 'X', h: 2 }, style());
    expect(b[0]).toBeLessThanOrEqual(0);
    expect(b[2]).toBeGreaterThan(10 + 2.5);
  });
});
