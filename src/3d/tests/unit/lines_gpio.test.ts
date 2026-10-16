// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { parsePathData, parseColor, parseTransform, svgShapes } from '../../src/lines/svgparse';
import { svgToStrokes, PX_TO_M } from '../../src/lines/gpsvgimport';
import { writeSvg, writePdf, strokeOutline, type ExportObject } from '../../src/lines/gpexport';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <g id="grp1"><rect x="10" y="10" width="100" height="50" fill="#ff0000" stroke="#0000ff" stroke-width="4"/></g>
  <path id="p1" d="M 120 20 C 140 0 160 40 180 20" fill="none" stroke="#00ff00" stroke-width="2"/>
  <circle cx="150" cy="70" r="20" fill="#808080"/>
</svg>`;

describe('svg parsing', () => {
  it('flattens path commands', () => {
    const [p] = parsePathData('M0 0 L10 0 H20 V10 Z');
    expect(p.closed).toBe(true);
    expect(p.pts).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [20, 10],
    ]);
    const rel = parsePathData('m5 5 l5 0 l0 5');
    expect(rel[0].pts[2]).toEqual([10, 10]);
    const curve = parsePathData('M0 0 C0 10 10 10 10 0', 4)[0];
    expect(curve.pts.length).toBe(5);
    expect(curve.pts[4]).toEqual([10, 0]);
    // half circle arc from (0,0) to (20,0): passes through y = ±10
    const arc = parsePathData('M0 0 A10 10 0 0 1 20 0', 8)[0];
    expect(Math.max(...arc.pts.map((q) => Math.abs(q[1])))).toBeCloseTo(10, 0);
    expect(arc.pts[arc.pts.length - 1][0]).toBeCloseTo(20);
    // compound path: two subpaths
    expect(parsePathData('M0 0 L1 0 L1 1 Z M5 5 L6 5 L6 6 Z').length).toBe(2);
  });

  it('reads colours and transforms', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0]);
    expect(parseColor('rgb(0, 128, 255)')![1]).toBeCloseTo(128 / 255);
    expect(parseColor('none')).toBeNull();
    expect(parseColor('navy')).toEqual([0, 0, 128 / 255]);
    const m = parseTransform('translate(10 5) scale(2)');
    expect(m).toEqual([2, 0, 0, 2, 10, 5]);
  });

  it('collects shapes with layers and styles', () => {
    const doc = new DOMParser().parseFromString(SVG, 'image/svg+xml');
    const { shapes } = svgShapes(doc.documentElement, 10);
    expect(shapes.map((s) => s.layer)).toEqual(['grp1', 'p1', 'Layer_000']);
    expect(shapes[0].fill).toEqual([1, 0, 0, 1]);
    expect(shapes[0].stroke).toEqual([0, 0, 1, 1]);
    expect(shapes[0].width).toBe(4);
    expect(shapes[1].fill).toBeNull();
    expect(shapes[2].stroke).toBeNull();
  });

  it('turns shapes into front-plane strokes centred on their bounds', () => {
    const doc = new DOMParser().parseFromString(SVG, 'image/svg+xml');
    const r = svgToStrokes(svgShapes(doc.documentElement, 10).shapes, { scale: 10 });
    const rect = r.layers.get('grp1')![0];
    const k = PX_TO_M * 10;
    // bounds are x 10..180, y 10..90 → centre (95, 50)
    expect(rect.points[0].co[0]).toBeCloseTo((10 - 95) * k, 4);
    expect(rect.points[0].co[2]).toBeCloseTo(-(10 - 50) * k, 4);
    expect(rect.points[0].radius).toBeCloseTo(2 * k, 6);
    expect(rect.cyclic).toBe(true);
    expect(r.kinds.sort()).toEqual(['Both', 'Fill', 'Stroke']);
  });
});

const sample: ExportObject[] = [
  {
    name: 'Stroke',
    layers: [
      {
        name: 'Lines',
        items: [
          { kind: 'fill', fill: { rings: [[[0, 0], [10, 0], [10, 10]]], color: [1, 0, 0, 0.5] } },
          { kind: 'stroke', path: { pts: [[0, 0], [50, 20], [90, 10]], widths: [2, 4, 2], stroke: [0, 0, 0, 1], cyclic: false } },
        ],
      },
    ],
  },
];

describe('vector export', () => {
  it('writes SVG with fills and strokes', () => {
    const svg = writeSvg(sample, 100, 50, { uniformWidth: true, fill: true });
    expect(svg).toContain('<svg');
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill-opacity="0.5"');
    expect(svg).toContain('stroke-width="2.67"');
    const outline = writeSvg(sample, 100, 50, { uniformWidth: false, fill: false });
    expect(outline).not.toContain('#ff0000');
    expect(outline).not.toContain('stroke-width');
    const back = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(back.documentElement.tagName.toLowerCase()).toBe('svg');
  });

  it('outlines variable width strokes', () => {
    const rings = strokeOutline({ pts: [[0, 0], [10, 0]], widths: [2, 4], stroke: [0, 0, 0, 1], cyclic: false });
    expect(rings.length).toBe(1);
    const ys = rings[0].map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(2);
    expect(Math.min(...ys)).toBeCloseTo(-2);
  });

  it('writes a valid PDF with a page per frame', () => {
    const bytes = writePdf([sample, sample], 100, 50, { uniformWidth: true, fill: true });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text.trim().endsWith('%%EOF')).toBe(true);
    // the cross reference offsets point at the objects
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offs = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(text).toContain('/ExtGState');
  });
});
