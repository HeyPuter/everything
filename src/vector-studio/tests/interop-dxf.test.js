import { describe, it, expect } from 'vitest';
import { readDXF, convertDXF, dxfPairs, mtextPlain } from '../src/features/interop/dxf/dxf-import.js';
import { writeDXF } from '../src/features/interop/dxf/dxf-export.js';
import { aciColor, nearestAci, nearestLineweight } from '../src/features/interop/dxf/common.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createText, createCompound } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { pathBounds } from '../src/model/bezier.js';

const dxf = (sections) => `${sections.map(([name, body]) => `0\nSECTION\n2\n${name}\n${body.trim()}\n0\nENDSEC`).join('\n')}\n0\nEOF\n`;
const ent = (type, pairs) => `0\n${type}\n${pairs.map(([c, v]) => `${c}\n${v}`).join('\n')}`;
const FAM = ['Inter', 'Roboto'];

function convert(text, unitPt = 1) {
  const data = readDXF(text);
  const r = convertDXF(data, { unitPt, families: FAM });
  const all = [...r.nodes.values()];
  return { data, r, all, shapes: all.filter((n) => n.type !== 'group' && !all.some((c) => c.type === 'compound' && c.children.includes(n.id))) };
}

const bounds = (n) => pathBounds(n.anchors, n.closed);

describe('DXF import', () => {
  const header = `9\n$INSUNITS\n70\n4\n9\n$LTSCALE\n40\n1`;
  const tables = [
    '0\nTABLE\n2\nLTYPE',
    ent('LTYPE', [[2, 'DASHED'], [70, 0], [73, 2], [40, 0.75], [49, 0.5], [49, -0.25]]),
    '0\nENDTAB\n0\nTABLE\n2\nLAYER',
    ent('LAYER', [[2, 'Walls'], [70, 0], [62, 1], [6, 'CONTINUOUS']]),
    ent('LAYER', [[2, 'Hidden'], [70, 0], [62, -3], [6, 'DASHED']]),
    ent('LAYER', [[2, 'Locked'], [70, 4], [62, 5], [420, 0x336699]]),
    '0\nENDTAB',
  ].join('\n');

  it('reads lines, polylines with bulges, arcs, circles and ellipses on their layers', () => {
    const entities = [
      ent('LINE', [[8, 'Walls'], [10, 0], [20, 0], [11, 100], [21, 0]]),
      ent('LWPOLYLINE', [[8, 'Hidden'], [90, 3], [70, 1], [10, 0], [20, 0], [42, 1], [10, 10], [20, 0], [10, 10], [20, 10]]),
      ent('ARC', [[8, 'Walls'], [10, 50], [20, 50], [40, 10], [50, 0], [51, 90]]),
      ent('CIRCLE', [[8, 'Locked'], [10, 0], [20, 0], [40, 5]]),
      ent('ELLIPSE', [[8, 'Walls'], [10, 0], [20, 0], [11, 20], [21, 0], [40, 0.5], [41, 0], [42, 6.283185307]]),
    ].join('\n');
    const { r, shapes, data } = convert(dxf([['HEADER', header], ['TABLES', tables], ['ENTITIES', entities]]));
    expect(data.units).toBe(4);
    expect(r.layers.map((l) => l.name)).toEqual(['Walls', 'Hidden', 'Locked']);
    expect(r.layers[1].hidden).toBe(true);
    expect(r.layers[2].locked).toBe(true);
    // Nodes come grouped by layer: Walls (line, arc, ellipse), Hidden (polyline), Locked (circle).
    const byLayer = (name) => r.layers.find((l) => l.name === name).ids.map((id) => shapes.find((n) => n.id === id));
    const [line, arc, ell] = byLayer('Walls');
    const [poly] = byLayer('Hidden');
    const [circle] = byLayer('Locked');
    expect(line.stroke.color).toBe('#ff0000');
    // y is flipped (DXF y up).
    expect(line.anchors.map((a) => [a.x, a.y + 0])).toEqual([[0, 0], [100, 0]]);
    expect(poly.closed).toBe(true);
    expect(poly.stroke.color).toBe(aciColor(3));
    expect(poly.dash).toEqual([0.5, 0.25]);
    // The bulge of 1 is a half circle below the chord (0,0)-(10,0) in DXF space: above it on the page.
    const pb = bounds(poly);
    expect(pb.y + pb.h).toBeCloseTo(5, 1);
    const ab = bounds(arc);
    expect(ab.x).toBeCloseTo(50);
    expect(ab.w).toBeCloseTo(10);
    expect(ab.y).toBeCloseTo(-60);
    expect(circle.stroke.color).toBe('#336699');
    const cb = bounds(circle);
    expect(cb.w).toBeCloseTo(10);
    expect(circle.closed).toBe(true);
    const eb = bounds(ell);
    expect(eb.w).toBeCloseTo(40);
    expect(eb.h).toBeCloseTo(20);
  });

  it('reads old-style polylines, splines, solids, hatches and text', () => {
    const entities = [
      '0\nPOLYLINE\n8\n0\n66\n1\n70\n0',
      ent('VERTEX', [[8, 0], [10, 0], [20, 0]]),
      ent('VERTEX', [[8, 0], [10, 10], [20, 0]]),
      ent('VERTEX', [[8, 0], [10, 10], [20, 10]]),
      '0\nSEQEND',
      ent('SPLINE', [[8, 0], [70, 8], [71, 3], [72, 8], [73, 4], ...[0, 0, 0, 0, 1, 1, 1, 1].map((k) => [40, k]), [10, 0], [20, 0], [10, 10], [20, 20], [10, 20], [20, 20], [10, 30], [20, 0]]),
      ent('SOLID', [[8, 0], [62, 2], [10, 0], [20, 0], [11, 10], [21, 0], [12, 0], [22, 10], [13, 10], [23, 10]]),
      ent('HATCH', [[8, 0], [62, 4], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], [92, 2], [72, 0], [73, 1], [93, 3], [10, 0], [20, 0], [10, 5], [20, 0], [10, 0], [20, 5], [97, 0]]),
      ent('TEXT', [[8, 0], [10, 5], [20, 5], [40, 2.5], [1, 'Room %%d 25'], [50, 90]]),
      ent('MTEXT', [[8, 0], [10, 0], [20, 50], [40, 5], [71, 1], [1, '{\\fArial|b1;Bold}\\Psecond line']]),
    ].join('\n');
    const { shapes } = convert(dxf([['ENTITIES', entities]]));
    const [pl, spline, solid, hatch, text, mtext] = shapes;
    expect(pl.anchors).toHaveLength(3);
    expect(pl.closed).toBe(false);
    // A single-span cubic B-spline with clamped knots is exactly one Bezier segment.
    expect(spline.anchors).toHaveLength(2);
    expect(spline.anchors[0]).toMatchObject({ x: 0, ox: 10, oy: -20 });
    expect(spline.anchors[1]).toMatchObject({ x: 30, ix: 20, iy: -20 });
    expect(solid.fill.color).toBe('#ffff00');
    expect(solid.anchors).toHaveLength(4);
    expect(hatch.fill.color).toBe('#00ffff');
    expect(hatch.stroke).toBeNull();
    expect(text.type).toBe('text');
    expect(text.text).toBe('Room ° 25');
    expect(text.char.fontSize).toBeCloseTo(3.5);
    // Rotated 90 degrees counter-clockwise.
    expect(text.transform[1]).toBeCloseTo(-1);
    expect(mtext.text).toBe('Bold\nsecond line');
  });

  it('expands block references with scale, rotation and arrays', () => {
    const blocks = [ent('BLOCK', [[2, 'SQ'], [8, 0], [70, 0], [10, 0], [20, 0]]), ent('LWPOLYLINE', [[8, 0], [62, 0], [90, 4], [70, 1], [10, 0], [20, 0], [10, 1], [20, 0], [10, 1], [20, 1], [10, 0], [20, 1]]), '0\nENDBLK'].join('\n');
    const entities = [ent('INSERT', [[8, 0], [62, 1], [2, 'SQ'], [10, 10], [20, 10], [41, 2], [42, 2], [70, 3], [44, 5]])].join('\n');
    const { all } = convert(dxf([['BLOCKS', blocks], ['ENTITIES', entities]]));
    const g = all.find((n) => n.type === 'group');
    expect(g.name).toBe('SQ');
    expect(g.children).toHaveLength(3);
    const squares = g.children.map((id) => all.find((n) => n.id === id));
    // ByBlock color comes from the insert.
    expect(squares.every((s) => s.stroke.color === '#ff0000')).toBe(true);
    expect(bounds(squares[2]).x).toBeCloseTo(20);
    expect(bounds(squares[2]).w).toBeCloseTo(2);
  });

  it('applies drawing units', () => {
    const text = dxf([['ENTITIES', ent('LINE', [[8, 0], [10, 0], [20, 0], [11, 1], [21, 0]])]]);
    const { shapes } = convert(text, 72 / 25.4);
    expect(shapes[0].anchors[1].x).toBeCloseTo(2.8346, 3);
  });

  it('parses group codes and MTEXT formatting', () => {
    expect(dxfPairs('0\nSECTION\n2\nENTITIES\n')).toEqual([[0, 'SECTION'], [2, 'ENTITIES']]);
    expect(mtextPlain('\\A1;{\\C1;Red} \\U+00B0\\~x\\Pnext')).toBe('Red ° x\nnext');
    expect(() => readDXF('hello')).toThrow(/not a DXF/);
  });
});

describe('DXF export', () => {
  const sampleDoc = () => {
    const doc = VDocument.create({ width: 200, height: 100 });
    const layer = doc.layers()[0];
    doc.transact('x', () => {
      doc.updateRoot({});
      doc.update(layer.id, { name: 'Outline/Cut' });
      doc.insert(createPath(rectangle(10, 10, 50, 30), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: { type: 'solid', color: '#0000ff' }, strokeWidth: 2 }), layer.id);
      doc.insert(createPath(ellipse(100, 10, 40, 40), true, { fill: null, stroke: { type: 'solid', color: '#00ff00' }, strokeWidth: 1 }), layer.id);
      doc.insert(createPath(ellipse(150, 10, 40, 20), true, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 1 }), layer.id);
      const curve = [{ x: 10, y: 90, ix: 10, iy: 90, ox: 30, oy: 60 }, { x: 60, y: 90, ix: 40, iy: 60, ox: 60, oy: 90 }];
      doc.insert(createPath(curve, false, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 0.5 }), layer.id);
      doc.insert(createText('Label', 100, 80, { char: { ...createText('').char, fontSize: 10 } }), layer.id);
    });
    return doc;
  };

  it('writes entities that import back with their geometry, colors and layers', () => {
    const doc = sampleDoc();
    const { text, warnings } = writeDXF(doc, { rect: doc.artboards[0], unit: 'pt' });
    expect(warnings).toEqual([]);
    expect(text).toContain('AC1015');
    for (const t of ['HATCH', 'LWPOLYLINE', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'TEXT']) expect(text).toContain(`\r\n${t}\r\n`);
    const { r, shapes } = convert(text);
    expect(r.layers.map((l) => l.name)).toContain('Outline_Cut');
    const rect = shapes.find((s) => s.stroke?.color === '#0000ff');
    const b = bounds(rect);
    // DXF y is up from the artboard's bottom: importing flips back around y = 0.
    expect([b.x, b.w, b.h].map(Math.round)).toEqual([10, 50, 30]);
    expect(Math.round(-b.y - b.h)).toBe(100 - 40);
    expect(shapes.find((s) => s.fill?.color === '#ff0000')).toBeTruthy();
    const circle = shapes.find((s) => s.stroke?.color === '#00ff00');
    expect(bounds(circle).w).toBeCloseTo(40, 1);
    const curve = shapes.find((s) => s.anchors?.length === 2 && Math.abs(s.anchors[0].ox - 30) < 1e-6);
    expect(curve).toBeTruthy();
    const label = shapes.find((s) => s.type === 'text');
    expect(label.text).toBe('Label');
    expect(label.char.fontSize).toBeCloseTo(10 * 0.7 * 1.4, 1);
  });

  it('writes R12 files with flattened curves and units', () => {
    const doc = sampleDoc();
    const { text } = writeDXF(doc, { rect: doc.artboards[0], version: 'R12', unit: 'mm' });
    expect(text).toContain('AC1009');
    expect(text).not.toContain('SPLINE');
    expect(text).not.toContain('LWPOLYLINE');
    expect(text).toContain('\r\nPOLYLINE\r\n');
    const { shapes } = convert(text, 72 / 25.4);
    const rect = shapes.find((s) => s.stroke?.color === '#0000ff');
    expect(bounds(rect).w).toBeCloseTo(50, 1);
  });

  it('maps colors and lineweights', () => {
    expect(nearestAci('#ff0000')).toBe(1);
    expect(nearestAci('#000000')).toBe(7);
    expect(nearestAci('#ffffff')).toBe(7);
    expect(aciColor(13)).toBe('#cc6666');
    expect(nearestLineweight(1)).toBe(35);
  });

  it('writes compound paths as several outlines with one hatch', () => {
    const doc = VDocument.create({ width: 100, height: 100 });
    const layer = doc.layers()[0];
    doc.transact('x', () => {
      const a = createPath(rectangle(0, 0, 100, 100), true, { fill: null, stroke: null });
      const b = createPath(rectangle(25, 25, 50, 50), true, { fill: null, stroke: null });
      const c = createCompound([a.id, b.id], { fill: { type: 'solid', color: '#000000' }, stroke: null }, { fillRule: 'evenodd' });
      doc.insert(c, layer.id, Infinity, [a, b]);
    });
    const { text } = writeDXF(doc, { rect: doc.artboards[0], unit: 'pt' });
    expect(text.match(/\r\nHATCH\r\n/g)).toHaveLength(1);
    expect(text).toMatch(/91\r\n2\r\n/);
  });
});
