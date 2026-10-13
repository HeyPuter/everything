import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { readDXF, convertDXF, dxfPairs } from '../src/features/interop/dxf/dxf-import.js';
import { patternTile } from '../src/features/interop/dxf/dxf-hatch.js';
import { writeDXF } from '../src/features/interop/dxf/dxf-export.js';
import { prepareDXF, clipPolyline } from '../src/features/interop/dxf/dxf-clip.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createImage } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { encodePNGSync } from '../src/features/interop/codec/png.js';
import { bytesToDataUrl } from '../src/features/io/image-info.js';

const dxf = (body) => `0\nSECTION\n2\nENTITIES\n${body.trim()}\n0\nENDSEC\n0\nEOF\n`;
const ent = (type, pairs) => `0\n${type}\n${pairs.map(([c, v]) => `${c}\n${v}`).join('\n')}`;
const convert = (text) => convertDXF(readDXF(text), { unitPt: 1, families: ['Inter'] });

const square = (s) => [[91, 1], [92, 2], [72, 0], [73, 1], [93, 4], [10, 0], [20, 0], [10, s], [20, 0], [10, s], [20, s], [10, 0], [20, s], [97, 0]];
const hatch = (lines, extra = []) =>
  ent('HATCH', [[8, 0], [62, 1], [2, 'TEST'], [70, 0], [71, 0], ...square(20), [75, 0], [76, 1], [52, 0], [41, 1], [77, 0], [78, lines.length], ...lines.flatMap((l) => [[53, l.angle], [43, l.base[0]], [44, l.base[1]], [45, l.offset[0]], [46, l.offset[1]], [79, l.dashes.length], ...l.dashes.map((d) => [49, d])]), ...extra]);

describe('DXF hatch patterns', () => {
  it('finds the repeating tile of line families', () => {
    const diag = patternTile([{ angle: 45, base: [0, 0], offset: [-2.245064, 2.245064], dashes: [] }]);
    expect(diag.w).toBeCloseTo(3.175 * Math.SQRT2, 2);
    expect(diag.h).toBeCloseTo(3.175 * Math.SQRT2, 2);
    // Dashes shifted along the line by 0.5 per row repeat every four rows.
    const dashed = patternTile([{ angle: 0, base: [0, 0], offset: [0.5, 2], dashes: [1, -1] }]);
    expect(dashed.w).toBeCloseTo(2);
    expect(dashed.h).toBeCloseTo(8);
    expect(dashed.segments.every(([x0, y0, x1, y1]) => y0 === y1 && x1 - x0 <= 1 + 1e-9)).toBe(true);
    const cross = patternTile([{ angle: 45, base: [0, 0], offset: [-2, 2], dashes: [] }, { angle: 135, base: [0, 0], offset: [-2, -2], dashes: [] }]);
    expect(cross.w).toBeCloseTo(4);
    expect(cross.h).toBeCloseTo(4);
    // Every piece stays inside the tile.
    for (const t of [diag, dashed, cross]) for (const [x0, y0, x1, y1] of t.segments) for (const v of [x0, x1]) expect(v).toBeGreaterThanOrEqual(-1e-9), expect(v).toBeLessThanOrEqual(t.w + 1e-9);
  });

  it('imports pattern hatches as pattern fills with a pattern definition', () => {
    const r = convert(dxf(hatch([{ angle: 45, base: [0, 0], offset: [-2.245064, 2.245064], dashes: [] }])));
    expect(r.patterns).toHaveLength(1);
    const def = r.patterns[0];
    expect(def).toMatchObject({ name: 'TEST', tileType: 'grid' });
    const art = def.art.nodes.find((n) => n.id === def.art.roots[0]);
    expect(art.stroke.color).toBe('#ff0000');
    const shape = [...r.nodes.values()].find((n) => n.fill?.type === 'pattern');
    expect(shape.fill.id).toBe(def.id);
    expect(shape.fill.transform).toEqual([1, 0, 0, -1, 0, 0]);
    expect(r.warnings.join(' ')).not.toMatch(/solid/);
    // Two hatches with the same pattern share one definition; solid hatches stay solid.
    const two = convert(dxf([hatch([{ angle: 0, base: [0, 0], offset: [0, 3], dashes: [] }]), hatch([{ angle: 0, base: [0, 0], offset: [0, 3], dashes: [] }])].join('\n')));
    expect(two.patterns).toHaveLength(1);
  });

  it('opens drawings with pattern hatches as documents with pattern swatches', async () => {
    const { openForeign } = await import('../src/features/interop/lazy.js');
    const text = dxf(hatch([{ angle: 0, base: [0, 0], offset: [0, 3], dashes: [2, -1] }]));
    const app = { prefs: { get: () => null, set: () => {} }, dialogs: { open: async (o) => o.buttons.find((b) => b.primary).value() }, notify: () => {} };
    const doc = await openForeign(app, new TextEncoder().encode(text), { name: 'hatch.dxf', format: 'dxf' });
    expect(doc.root.patterns).toHaveLength(1);
    expect(doc.root.swatches.some((s) => s.paint?.type === 'pattern' && s.paint.id === doc.root.patterns[0].id)).toBe(true);
    const shape = [...doc.nodes.values()].find((n) => n.fill?.type === 'pattern');
    // The drawing moved to the artboard corner, and its pattern with it.
    expect(shape.anchors.map((a) => Math.round(a.x))).toContain(0);
    expect(shape.fill.transform[5]).not.toBe(0);
  });
});

describe('DXF mesh polylines', () => {
  it('draws the edges of polygon meshes', () => {
    const v = (x, y) => ent('VERTEX', [[8, 0], [10, x], [20, y], [30, 0], [70, 64]]);
    const text = dxf([ent('POLYLINE', [[8, 0], [66, 1], [70, 16], [71, 3], [72, 2]]), v(0, 0), v(10, 0), v(0, 10), v(10, 10), v(0, 20), v(10, 20), '0\nSEQEND'].join('\n'));
    const r = convert(text);
    const subs = [...r.nodes.values()].filter((n) => n.type === 'path' && n.anchors.length === 2);
    expect(subs).toHaveLength(7);
    expect(r.warnings.join(' ')).not.toMatch(/mesh/);
  });

  it('draws the visible edges of polyface meshes once', () => {
    const v = (x, y) => ent('VERTEX', [[8, 0], [10, x], [20, y], [30, 0], [70, 192]]);
    const f = (a, b, c) => ent('VERTEX', [[8, 0], [10, 0], [20, 0], [30, 0], [70, 128], [71, a], [72, b], [73, c]]);
    // Two triangles sharing the edge 2-3; the second hides its edge from 3 to 4.
    const text = dxf([ent('POLYLINE', [[8, 0], [66, 1], [70, 64], [71, 4], [72, 2]]), v(0, 0), v(10, 0), v(0, 10), v(10, 10), f(1, 2, 3), f(2, -4, 3), '0\nSEQEND'].join('\n'));
    const r = convert(text);
    const subs = [...r.nodes.values()].filter((n) => n.type === 'path' && n.anchors.length === 2);
    expect(subs).toHaveLength(4);
  });
});

describe('DXF export of images and clipping masks', () => {
  beforeAll(async () => {
    setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
    await loadGeom();
  });

  const png = bytesToDataUrl(encodePNGSync({ width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4).fill(255) }), 'image/png');

  it('writes images as IMAGE entities with image definitions', () => {
    const doc = VDocument.create({ width: 200, height: 100 });
    doc.assets.set('a1', { mime: 'image/png', data: png });
    doc.transact('x', () => doc.insert(createImage('a1', 4, 2, [10, 0, 0, 10, 20, 30]), doc.layers()[0].id));
    const { text, images, warnings } = writeDXF(doc, { rect: doc.artboards[0], unit: 'pt', imageName: (id, i, ext) => `art-${i}.${ext}` });
    expect(warnings).toEqual([]);
    expect(images).toEqual([{ assetId: 'a1', name: 'art-1.png' }]);
    const pairs = dxfPairs(text);
    const at = pairs.findIndex(([c, v]) => c === 0 && v === 'IMAGE');
    const rec = new Map();
    for (let i = at + 1; i < pairs.length && pairs[i][0] !== 0; i++) if (!rec.has(pairs[i][0])) rec.set(pairs[i][0], Number(pairs[i][1]));
    // Lower-left corner at (20, 100 - 50) with 10-point pixels (y up).
    expect([rec.get(10), rec.get(20), rec.get(11), rec.get(22), rec.get(13), rec.get(23)]).toEqual([20, 50, 10, 10, 4, 2]);
    expect(text).toContain('\r\nIMAGEDEF\r\n');
    expect(text).toContain('\r\nIMAGEDEF_REACTOR\r\n');
    expect(text).toContain('\r\nACAD_IMAGE_DICT\r\n');
    expect(text).toMatch(/\r\nCLASS\r\n1\r\nIMAGE\r\n/);
    expect(text).toContain('art-1.png');
    // Release 12 has no images.
    expect(writeDXF(doc, { rect: doc.artboards[0], version: 'R12' }).warnings.join(' ')).toMatch(/AutoCAD 2000/);
    // The drawing still reads back.
    expect(() => convert(text)).not.toThrow();
  });

  it('clips polylines to a region', () => {
    const square = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]];
    expect(clipPolyline([{ x: -5, y: 5 }, { x: 15, y: 5 }], square)).toEqual([[{ x: 0, y: 5 }, { x: 10, y: 5 }]]);
    expect(clipPolyline([{ x: -5, y: -5 }, { x: -1, y: -1 }], square)).toEqual([]);
  });

  it('cuts clipped artwork to the mask', async () => {
    const doc = VDocument.create({ width: 200, height: 200 });
    doc.assets.set('a1', { mime: 'image/png', data: png });
    const layer = doc.layers()[0];
    doc.transact('x', () => {
      const big = createPath(rectangle(0, 0, 120, 120), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: { type: 'solid', color: '#0000ff' }, strokeWidth: 1 });
      const img = createImage('a1', 4, 2, [50, 0, 0, 50, 0, 0]);
      const mask = createPath(ellipse(50, 50, 100, 100), true, { fill: null, stroke: null });
      const g = createGroup([big.id, img.id, mask.id], { clip: true });
      doc.insert(g, layer.id, Infinity, [{ ...big, parent: g.id }, { ...img, parent: g.id }, { ...mask, parent: g.id }]);
    });
    const prep = await prepareDXF(doc);
    const { text, warnings } = writeDXF(doc, { rect: doc.artboards[0], unit: 'pt', view: prep.view, clipped: prep.clipped });
    expect(warnings.join(' ')).not.toMatch(/Clipping/);
    const r = convert(text);
    const shapes = [...r.nodes.values()].filter((n) => n.anchors);
    // Every exported point lies on or inside the circle (center 100, 100 in DXF y-up = -100 after import, radius 50).
    for (const s of shapes) for (const a of s.anchors) expect(Math.hypot(a.x - 100, a.y + 100)).toBeLessThan(50.5);
    expect(shapes.some((s) => s.fill?.color === '#ff0000')).toBe(true);
    expect(shapes.some((s) => s.stroke?.color === '#0000ff')).toBe(true);
    // The image has a polygonal clip boundary in pixels.
    const pairs = dxfPairs(text);
    const at = pairs.findIndex(([c, v]) => c === 0 && v === 'IMAGE');
    const rec = pairs.slice(at + 1, pairs.findIndex(([c], i) => i > at && c === 0));
    expect(rec.find(([c]) => c === 71)[1]).toBe('2');
    expect(Number(rec.find(([c]) => c === 91)[1])).toBeGreaterThan(8);
  });
});
