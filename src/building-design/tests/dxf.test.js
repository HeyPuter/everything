import { describe, it, expect } from 'vitest';
import { parseDXF } from '../src/io/dxf.js';

const dxf = (units, body) =>
  ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\n');

describe('DXF import', () => {
  it('reads lines in the file units', () => {
    const r = parseDXF(dxf(6, ['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '2', '21', '0']));
    expect(r.unitsMM).toBe(1000);
    expect(r.lines).toEqual([
      [
        [0, 0],
        [2000, 0],
      ],
    ]);
  });

  it('reads closed polylines and bulge arcs', () => {
    const r = parseDXF(dxf(4, ['0', 'LWPOLYLINE', '90', '3', '70', '1', '10', '0', '20', '0', '10', '100', '20', '0', '42', '1', '10', '100', '20', '100']));
    // Three edges, one of them a half circle split into several segments.
    expect(r.lines.length).toBeGreaterThan(3);
    const last = r.lines.at(-1);
    expect(last[1]).toEqual([0, 0]);
  });

  it('reads circles and text, and skips paper space', () => {
    const r = parseDXF(dxf(1, ['0', 'CIRCLE', '10', '0', '20', '0', '40', '1', '0', 'TEXT', '10', '1', '20', '2', '40', '0.5', '1', 'Kitchen', '0', 'LINE', '67', '1', '10', '0', '20', '0', '11', '1', '21', '1']));
    expect(r.lines.length).toBe(48);
    expect(r.texts[0]).toMatchObject({ text: 'Kitchen', at: [25.4, 50.8] });
  });
});
