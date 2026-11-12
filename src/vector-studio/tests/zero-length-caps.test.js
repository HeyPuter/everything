import { describe, it, expect } from 'vitest';
import { pathOf, compoundPathOf } from '../src/render/draw.js';
import { writePDF } from '../src/features/io/pdf.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createCompound } from '../src/model/nodes.js';

const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
const red = { type: 'solid', color: '#ff0000' };

// Canvas and PDF viewers skip a subpath with no length; with round or square caps it must still
// show as a dot or a square, as it does in SVG.
describe('zero-length subpaths with caps', () => {
  it('trace as a tiny segment on the canvas only when round or square caps show', () => {
    const style = (strokeCap) => ({ fill: null, stroke: red, strokeWidth: 20, strokeCap });
    for (const cap of ['round', 'square']) {
      for (const closed of [false, true]) {
        const anchors = closed ? [pt(200, 170)] : [pt(200, 170), pt(200, 170)];
        const ops = pathOf(createPath(anchors, closed, style(cap))).ops;
        expect(ops[0]).toEqual(['M', 200, 170]);
        expect(ops).toHaveLength(2);
        const [op, x, y] = ops[1];
        expect(op).toBe('L');
        expect(x).toBeGreaterThan(200);
        expect(x).toBeLessThan(200.01);
        expect(y).toBe(170);
      }
    }
    // Butt caps, and ordinary paths, trace as before.
    expect(pathOf(createPath([pt(200, 170), pt(200, 170)], false, style('butt'))).ops).toEqual([
      ['M', 200, 170],
      ['L', 200, 170],
    ]);
    expect(pathOf(createPath([pt(0, 0), pt(10, 0)], false, style('round'))).ops).toEqual([
      ['M', 0, 0],
      ['L', 10, 0],
    ]);
    // A compound path's dot subpath gets the segment; its other subpaths don't change.
    const doc = VDocument.create({ width: 400, height: 300 });
    const a = createPath([pt(50, 50), pt(50, 50)], false);
    const b = createPath([pt(0, 0), pt(10, 0)], false);
    const c = createCompound([a.id, b.id], style('round'));
    doc.transact('t', () => doc.insert(c, doc.layers()[0].id, Infinity, [a, b]));
    const ops = compoundPathOf(doc, doc.get(c.id)).ops;
    expect(ops[1][1]).toBeGreaterThan(50);
    expect(ops.slice(2)).toEqual([
      ['M', 0, 0],
      ['L', 10, 0],
    ]);
  });

  it('paint a dot in PDF export with round or square caps', async () => {
    const doc = VDocument.create({ width: 400, height: 300 });
    const layer = doc.layers()[0].id;
    doc.transact('t', () => {
      doc.insert(
        createPath([pt(200, 170), pt(200, 170)], false, {
          fill: null,
          stroke: red,
          strokeWidth: 20,
          strokeCap: 'round',
        }),
        layer,
      );
      doc.insert(
        createPath([pt(240, 170)], true, {
          fill: null,
          stroke: red,
          strokeWidth: 20,
          strokeCap: 'square',
        }),
        layer,
      );
      doc.insert(
        createPath([pt(280, 170), pt(280, 170)], false, {
          fill: null,
          stroke: red,
          strokeWidth: 20,
          strokeCap: 'butt',
        }),
        layer,
      );
    });
    const { bytes } = await writePDF(doc, doc.artboards, { compress: false });
    const s = new TextDecoder('latin1').decode(bytes);
    expect(s).toMatch(/200 170 m\n200\.001 170 l\n/);
    expect(s).toMatch(/240 170 m\n240\.001 170 l\n/);
    expect(s).not.toMatch(/240 170 m\n240\.001 170 l\nh/);
    expect(s).toMatch(/280 170 m\n280 170 l\n/);
  });
});
