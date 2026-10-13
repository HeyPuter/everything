import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds, transformNodes } from '../src/model/geometry.js';
import { liveArtwork, isLive, expandLive } from '../src/model/live.js';
import { hitTest } from '../src/render/hit.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { svgToDocument } from '../src/features/io/svg-import.js';
import { writePDF } from '../src/features/io/pdf.js';
import { inflateSync } from 'node:zlib';
import {
  createDimension,
  dimensionLayout,
  layoutIn,
  formatDimLength,
  formatDimAngle,
  dimOptions,
  realLength,
  displayUnit,
  resolvePoints,
  isAttached,
  movePointPatch,
  transformDimension,
  arcAnchors,
} from '../src/features/dimension/dimension-model.js';

beforeAll(async () => {
  installCanvasStub();
  // Registers the live kind.
  await bootAppWithFeatures();
});

const P = (x, y) => ({ x, y });

function docWith(...nodes) {
  const doc = VDocument.create({ width: 600, height: 400 });
  const layer = doc.layers()[0].id;
  doc.transact('add', () => nodes.forEach((n) => doc.insert(n, layer)));
  return doc;
}

describe('dimension values', () => {
  it('formats lengths in the chosen unit with precision and unit labels', () => {
    const o = dimOptions({ units: 'mm', precision: 1 });
    expect(formatDimLength(72, o)).toBe('25.4 mm');
    expect(formatDimLength(72, { ...o, showUnits: false })).toBe('25.4');
    expect(formatDimLength(72, dimOptions({ units: 'in', precision: 3 }))).toBe('1.000 in');
    expect(formatDimLength(36, dimOptions({ precision: 0 }), 'pt')).toBe('36 pt');
    // Auto follows the document's units.
    expect(formatDimLength(72, dimOptions({ precision: 2 }), 'cm')).toBe('2.54 cm');
    expect(formatDimAngle(45.004, dimOptions({ precision: 1 }))).toBe('45.0°');
  });

  it('applies a drawing scale (1 in = 1 ft) and shows feet and inches', () => {
    const o = dimOptions({ scale: { on: true, paper: 1, paperUnit: 'in', real: 1, realUnit: 'ft' }, precision: 2 });
    expect(displayUnit(o, 'pt')).toBe('ft');
    expect(realLength(72, o)).toBeCloseTo(864);
    expect(formatDimLength(108, o)).toBe('1.50 ft');
    const ftin = { ...o, units: 'ftin', precision: 1 };
    expect(formatDimLength(108, ftin)).toBe(`1' 6.0"`);
    // Rounding up to 12 inches carries into the feet.
    expect(formatDimLength(72 * 1.99999, { ...ftin, precision: 0 })).toBe(`2' 0"`);
    // 1:100 in millimeters.
    const metric = dimOptions({ units: 'm', precision: 2, scale: { on: true, paper: 1, paperUnit: 'mm', real: 100, realUnit: 'mm' } });
    expect(formatDimLength(72 / 25.4 * 50, metric)).toBe('5.00 m');
  });
});

describe('linear layout', () => {
  it('measures horizontal, vertical and aligned distances', () => {
    const pts = { p1: P(100, 100), p2: P(400, 200) };
    const h = dimensionLayout(createDimension('linear', pts, { orient: 'horizontal', at: P(250, 60) }));
    expect(h.value).toBeCloseTo(300);
    const v = dimensionLayout(createDimension('linear', pts, { orient: 'vertical', at: P(450, 150) }));
    expect(v.value).toBeCloseTo(100);
    const a = dimensionLayout(createDimension('linear', pts, { orient: 'aligned', at: P(240, 120) }));
    expect(a.value).toBeCloseTo(Math.hypot(300, 100));
    expect(dimensionLayout(createDimension('linear', pts, { orient: 'rotated', angle: 0, at: P(250, 60) })).value).toBeCloseTo(300);
  });

  it('places the dimension line through `at` with extension lines and two end marks', () => {
    const d = createDimension('linear', { p1: P(100, 100), p2: P(300, 100) }, { orient: 'horizontal', at: P(200, 60), dim: { extGap: 2, extOvershoot: 4, labelPosition: 'above' } });
    const lay = dimensionLayout(d);
    expect(lay.track[0].y).toBeCloseTo(60);
    // Two extension lines from 2pt off the points to 4pt past the line.
    const ext = lay.segments.filter(([a, b]) => Math.abs(a.x - b.x) < 1e-9);
    expect(ext).toHaveLength(2);
    expect(ext[0][0].y).toBeCloseTo(98);
    expect(ext[0][1].y).toBeCloseTo(56);
    expect(lay.ends).toHaveLength(2);
    expect(lay.ends.map((e) => Math.sign(e.ux))).toEqual([-1, 1]);
    // The label sits above the line, centered.
    expect(lay.label.x).toBeCloseTo(200);
    expect(lay.label.y).toBeLessThan(60);
    expect(lay.text).toBe('200.00 pt');
  });

  it('cuts the line around an inline label and turns arrows outward when there is no room', () => {
    const inline = dimensionLayout(createDimension('linear', { p1: P(0, 0), p2: P(300, 0) }, { at: P(150, 30), dim: { labelPosition: 'center' } }));
    const dimLines = inline.segments.filter(([a, b]) => Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.y - 30) < 1e-6);
    expect(dimLines).toHaveLength(2);
    const short = dimensionLayout(createDimension('linear', { p1: P(0, 0), p2: P(10, 0) }, { at: P(5, 30) }));
    expect(short.ends.map((e) => Math.sign(e.ux))).toEqual([1, -1]);
  });

  it('keeps vertical labels readable from below', () => {
    const lay = dimensionLayout(createDimension('linear', { p1: P(100, 300), p2: P(100, 100) }, { orient: 'vertical', at: P(60, 200) }));
    expect((lay.label.angle * 180) / Math.PI).toBeCloseTo(-90);
    expect(lay.label.x).toBeLessThan(60);
  });
});

describe('angular and radial layout', () => {
  it('measures the angle between the arms, or the reflex angle on the other side', () => {
    const pts = { vertex: P(100, 100), p1: P(200, 100), p2: P(100, 0) };
    const inside = dimensionLayout(createDimension('angular', pts, { at: P(140, 60) }));
    expect(inside.value).toBeCloseTo(90);
    expect(inside.text).toBe('90.00°');
    expect(inside.arcs.length).toBeGreaterThan(0);
    const reflex = dimensionLayout(createDimension('angular', pts, { at: P(60, 140) }));
    expect(reflex.value).toBeCloseTo(270);
  });

  it('measures radius and diameter with symbols and a center mark', () => {
    const pts = { p1: P(100, 100), p2: P(150, 100) };
    const r = dimensionLayout(createDimension('radial', pts, { orient: 'radius', at: P(180, 100), dim: { precision: 0 } }));
    expect(r.value).toBeCloseTo(50);
    expect(r.text).toBe('R50 pt');
    expect(r.segments.length).toBe(3);
    const d = dimensionLayout(createDimension('radial', pts, { orient: 'diameter', at: P(180, 100), dim: { precision: 0, centerMark: false } }));
    expect(d.text).toBe('Ø100 pt');
    expect(d.ends).toHaveLength(2);
  });

  it('builds arc anchors on the circle', () => {
    const a = arcAnchors(0, 0, 10, 0, Math.PI);
    expect(a).toHaveLength(3);
    expect(a[2].x).toBeCloseTo(-10);
    expect(a[1].y).toBeCloseTo(10);
  });
});

describe('dimensions as live artwork', () => {
  it('generates paths and a label, measures, hits and exports', () => {
    const d = createDimension('linear', { p1: P(100, 100), p2: P(300, 100) }, { orient: 'horizontal', at: P(200, 60) });
    const doc = docWith(d);
    const node = doc.get(d.id);
    expect(isLive(node)).toBe(true);
    const { items } = liveArtwork(doc, node);
    expect(items.filter((n) => n.type === 'text')).toHaveLength(1);
    expect(items.find((n) => n.type === 'text').text).toBe('200.00 pt');
    expect(items.filter((n) => n.type === 'path').length).toBeGreaterThanOrEqual(5);
    const b = nodeBounds(doc, node);
    expect(b.x).toBeLessThanOrEqual(100);
    expect(b.x + b.w).toBeGreaterThanOrEqual(300);
    expect(b.y).toBeLessThan(60);
    expect(hitTest(doc, 150, 60, 2)?.id).toBe(d.id);
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 600, h: 400 } });
    expect(svg).toContain('200.00 pt');
    expect(svgToDocument(svg).leaves().length).toBe(items.length);
  });

  it('exports to PDF as vector lines and text', async () => {
    const d = createDimension('linear', { p1: P(100, 100), p2: P(300, 100) }, { orient: 'horizontal', at: P(200, 60) });
    const doc = docWith(d);
    const { bytes } = await writePDF(doc, doc.artboards, {});
    const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');
    const s = latin1(bytes);
    const re = /<<([^]*?)\/Length (\d+) >>\nstream\n/g;
    let content = '';
    let m;
    while ((m = re.exec(s))) {
      const raw = bytes.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[2]));
      content += /FlateDecode/.test(m[1]) ? latin1(inflateSync(raw)) : latin1(raw);
    }
    expect(content).toContain('(200.00 pt) Tj');
    expect(content).toMatch(/\nS\n/);
  });

  it('expands to plain paths and text', () => {
    const d = createDimension('angular', { vertex: P(100, 100), p1: P(200, 100), p2: P(100, 0) }, { at: P(140, 60) });
    const doc = docWith(d);
    let g;
    doc.transact('expand', () => {
      g = expandLive(doc, d.id);
    });
    expect(doc.get(d.id)).toBeUndefined();
    expect(g.type).toBe('group');
    const kids = g.children.map((c) => doc.get(c));
    expect(kids.some((k) => k.type === 'text' && k.text === '90.00°')).toBe(true);
    expect(kids.every((k) => k.type === 'path' || k.type === 'text')).toBe(true);
    expect(kids.every((k) => !isLive(k))).toBe(true);
    doc.undo();
    expect(doc.get(d.id)).toBeTruthy();
  });

  it('follows attached objects and keeps its offset', () => {
    const rect = createPath(rectangle(100, 100, 200, 50), true);
    const d = createDimension('linear', { p1: P(100, 100), p2: P(300, 100) }, { orient: 'horizontal', at: P(200, 80), attach: { p1: { id: rect.id, anchor: 0 }, p2: { id: rect.id, box: [1, 0] } } });
    const doc = docWith(rect, d);
    expect(isAttached(doc.get(d.id))).toBe(true);
    expect(layoutIn(doc, doc.get(d.id)).value).toBeCloseTo(200);
    // Resize the rectangle: the dimension follows.
    doc.transact('scale', () => transformNodes(doc, [rect.id], [1.5, 0, 0, 1, -50, 0]));
    const lay = layoutIn(doc, doc.get(d.id));
    expect(lay.value).toBeCloseTo(300);
    expect(lay.track[0].y).toBeCloseTo(80);
    expect(liveArtwork(doc, doc.get(d.id)).items.find((n) => n.type === 'text').text).toBe('300.00 pt');
    // A copy (new id) measures its stored points, not the original's objects.
    const copy = { ...doc.get(d.id), id: 'dcopy' };
    expect(isAttached(copy)).toBe(false);
    expect(resolvePoints(doc, copy).p2).toEqual(P(300, 100));
  });

  it('moves with transforms, detaching from its objects', () => {
    const rect = createPath(rectangle(100, 100, 200, 50), true);
    const d = createDimension('linear', { p1: P(100, 100), p2: P(300, 100) }, { orient: 'horizontal', at: P(200, 80), attach: { p1: { id: rect.id, anchor: 0 }, p2: { id: rect.id, anchor: 1 } } });
    const doc = docWith(rect, d);
    liveArtwork(doc, doc.get(d.id));
    doc.transact('move', () => transformNodes(doc, [d.id], [1, 0, 0, 1, 10, 20]));
    const n = doc.get(d.id);
    expect(n.attach).toBe(null);
    expect(n.p1).toEqual(P(110, 120));
    expect(layoutIn(doc, n).track[0].y).toBeCloseTo(100);
    // Rotating a horizontal dimension a quarter turn makes it vertical.
    const t = transformDimension(n, [0, 1, -1, 0, 0, 0], null);
    expect(t.orient).toBe('vertical');
    const r = transformDimension(n, [Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 0, 0], null);
    expect(r.orient).toBe('rotated');
    expect(dimensionLayout({ ...n, ...r }).value).toBeCloseTo(200);
    // Scaling with Scale Strokes & Effects scales the annotation sizes.
    expect(transformDimension(n, [2, 0, 0, 2, 0, 0], null, { scaleStrokes: true }).dim.fontSize).toBeCloseTo(dimOptions(n.dim).fontSize * 2);
  });

  it('keeps the dimension line in place when a measured point moves', () => {
    const d = createDimension('linear', { p1: P(100, 100), p2: P(300, 100) }, { orient: 'horizontal', at: P(200, 60) });
    const next = { ...d, ...movePointPatch(d, 'p2', P(400, 100)) };
    const lay = dimensionLayout(next);
    expect(lay.value).toBeCloseTo(300);
    expect(lay.track[0].y).toBeCloseTo(60);
    const a = createDimension('angular', { vertex: P(0, 0), p1: P(100, 0), p2: P(0, -100) }, { at: P(30, -30) });
    const moved = { ...a, ...movePointPatch(a, 'p2', P(-100, 0)) };
    expect(dimensionLayout(moved).value).toBeCloseTo(180);
  });
});
