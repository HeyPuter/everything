import { describe, expect, it } from 'vitest';
import { readPsd } from 'ag-psd';
import { newDocument, resizeDocument, cropDocument, type PhotoDocument } from '../src/model/document';
import { transformedVectorMask, validateVectorShape, vectorBounds, type VectorMask } from '../src/model/vector';
import { validateDocument } from '../src/model/serialization';
import { validateLiveShape } from '../src/model/live-shape';
import { importVectorStroke } from '../src/model/vector-stroke';
import { savePsd } from '../src/model/psd';
import { closedPath, rectKnots, ellipseKnots, liveKnots, corner } from '../src/features/vector/geometry';
import { setShapeMask, shapeLayer, writeTarget, docLive, translation, sanitizeStroke, shapeDocMask } from '../src/features/vector/state';
import { reshape, setLive } from '../src/features/vector/edit';
import { applyStroke, buildStroke, gradientPaint, defaultStroke, specsOf } from '../src/features/vector/paint';
import type { Editor } from '../src/editor';

const doc = () => newDocument(400, 300, 'shapes');
const solid = { rgb: [1, 0, 0] as [number, number, number], space: 'srgb' as const };
const roundRect = (d: PhotoDocument) => {
  const live = { kind: 'rect' as const, x: 40, y: 30, width: 120, height: 80, radii: [10, 10, 10, 10] as [number, number, number, number] };
  return shapeLayer(d, 'Rectangle 1', { paths: [closedPath(liveKnots(live))] }, solid, undefined, live);
};
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('shape layers from the tools', () => {
  it('create valid layers whose transform equals the knot bounds', () => {
    const d = doc();
    const l = roundRect(d);
    validateVectorShape(l.vector!);
    expect(l.transform).toEqual({ x: 40, y: 30, width: 120, height: 80, rotation: 0 });
    expect(l.vector!.reference).toEqual({ x: 40, y: 30, width: 120, height: 80 });
    expect(transformedVectorMask(l)).toEqual(l.vector!.mask);
  });
  it('bake a transformed layer when its path is edited, keeping document geometry', () => {
    const d = doc();
    const l = roundRect(d);
    // A free transform doubles the width and moves the layer.
    l.transform = { x: 10, y: 20, width: 240, height: 80, rotation: 0 };
    const before = shapeDocMask(l);
    setShapeMask(l, before);
    const after = shapeDocMask(l);
    expect(vectorBounds(after)).toEqual({ x: 10, y: 20, width: 240, height: 80 });
    for (let p = 0; p < before.paths.length; p++)
      for (let k = 0; k < before.paths[p].knots.length; k++)
        before.paths[p].knots[k].points.forEach((v, i) => close(after.paths[p].knots[k].points[i], v, 1e-9));
    expect(l.vector!.live).toBeUndefined();
  });
  it('keep live shapes live when moved and drop them when reshaped', () => {
    const d = doc();
    d.layers.push(roundRect(d));
    const l = d.layers[0];
    const moved: VectorMask = structuredClone(l.vector!.mask);
    for (const k of moved.paths[0].knots) for (let i = 0; i < 6; i += 2) (k.points[i] += 15), (k.points[i + 1] -= 5);
    expect(translation(l.vector!.mask, moved)).toEqual([15, -5]);
    writeTarget(d, { kind: 'shape', id: l.id, name: '', mask: l.vector!.mask }, moved);
    expect(d.layers[0].vector!.live).toMatchObject({ kind: 'rect', x: 55, y: 25, width: 120, height: 80 });
    const edited = structuredClone(d.layers[0].vector!.mask);
    edited.paths[0].knots[0].points[2] += 3;
    writeTarget(d, { kind: 'shape', id: l.id, name: '', mask: d.layers[0].vector!.mask }, edited);
    expect(d.layers[0].vector!.live).toBeUndefined();
  });
  it('resize live rectangles without scaling their corner radii', () => {
    const d = doc();
    const l = roundRect(d);
    reshape(l, { width: 240 });
    expect(l.vector!.live).toEqual({ kind: 'rect', x: 40, y: 30, width: 240, height: 80, radii: [10, 10, 10, 10] });
    expect(vectorBounds(shapeDocMask(l))).toEqual({ x: 40, y: 30, width: 240, height: 80 });
    setLive(l, { ...docLive(l)!, radii: [0, 40, 0, 40] } as never);
    expect(l.vector!.mask.paths[0].knots).toHaveLength(6);
    validateVectorShape(l.vector!);
  });
  it('reshape plain paths by scaling their knots', () => {
    const d = doc();
    const l = shapeLayer(d, 'Ellipse', { paths: [closedPath(ellipseKnots(0, 0, 100, 50))] }, solid, undefined);
    reshape(l, { x: 10, y: 10, width: 50, height: 100 });
    expect(vectorBounds(shapeDocMask(l))).toEqual({ x: 10, y: 10, width: 50, height: 100 });
  });
  it('a width or height of zero is refused instead of flattening the shape for good', () => {
    const d = doc();
    const l = shapeLayer(d, 'Ellipse', { paths: [closedPath(ellipseKnots(0, 0, 100, 50))] }, solid, undefined);
    reshape(l, { width: 0 });
    reshape(l, { height: -5 });
    expect(vectorBounds(shapeDocMask(l))).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    const r = roundRect(d);
    reshape(r, { width: 0, x: 50 });
    expect(vectorBounds(shapeDocMask(r))).toEqual({ x: 50, y: 30, width: 120, height: 80 });
  });
  it('builds strokes for no-fill shapes and keeps dashes valid', () => {
    const s = buildStroke({ ...defaultStroke(), type: 'none' }, false, false)!;
    expect(s.enabled).toBe(false);
    expect(s.fillEnabled).toBe(false);
    expect(buildStroke(defaultStroke(), true, false)).toBeUndefined();
    const dashed = buildStroke({ ...defaultStroke(), type: 'color', dash: 'dashed' }, true, false)!;
    const d = doc();
    const l = shapeLayer(d, 'R', { paths: [closedPath(rectKnots(0, 0, 50, 50)), closedPath(rectKnots(10, 10, 10, 10), 'subtract')] }, solid, dashed);
    expect(l.vector!.stroke!.lineDashSet).toBeUndefined();
    validateVectorShape(l.vector!);
    const open = { paths: [{ open: true, fillRule: 'non-zero' as const, operation: 'combine' as const, knots: [corner(0, 0), corner(40, 30)] }] };
    const v = { mask: open, reference: { x: 0, y: 0, width: 40, height: 30 }, fill: solid, stroke: buildStroke({ ...defaultStroke(), type: 'color' }, true, false)! };
    sanitizeStroke(v);
    expect(v.stroke.alignment).toBe('center');
  });
  it('changing a stroke color keeps its dash offset and miter limit', () => {
    const d = doc();
    const stroke = { ...buildStroke({ ...defaultStroke(), type: 'color', dash: 'dashed', width: 4 }, true, false)!, lineDashOffset: { value: 3, units: 'Pixels' as const }, miterLimit: 4 };
    const l = shapeLayer(d, 'R', { paths: [closedPath(rectKnots(0, 0, 50, 50))] }, solid, stroke);
    const e = { doc: d } as unknown as Editor;
    const spec = specsOf(e, l.vector!).stroke;
    applyStroke(l.vector!, { ...spec, color: '#00ff00' });
    const s = l.vector!.stroke!;
    expect(s.color).toEqual({ rgb: [0, 1, 0], space: 'srgb' });
    expect(s.lineDashOffset).toEqual({ value: 3, units: 'Pixels' });
    expect(s.miterLimit).toBe(4);
    expect(s.lineDashSet?.map((v) => v.value)).toEqual([4, 2]);
    // An odd dash list from a file survives too, and an offset in points becomes pixels.
    l.vector!.stroke = { ...s, lineDashSet: [4, 2, 1].map((value) => ({ value, units: 'None' as const })), lineDashOffset: { value: 1, units: 'Points' }, resolution: 144 };
    applyStroke(l.vector!, { ...specsOf(e, l.vector!).stroke, color: '#0000ff' });
    expect(l.vector!.stroke!.lineDashSet?.map((v) => v.value)).toEqual([4, 2, 1]);
    expect(l.vector!.stroke!.lineDashOffset).toEqual({ value: 2, units: 'Pixels' });
    validateVectorShape(l.vector!);
  });
});

describe('document paths', () => {
  it('validate saved paths, the work path, layer vector masks and live shapes', () => {
    const d = doc();
    d.paths = [{ id: 'a', name: 'Path 1', mask: { paths: [closedPath(rectKnots(0, 0, 10, 10))] } }];
    d.workPath = { paths: [] };
    const l = roundRect(d);
    l.vectorMask = { mask: { paths: [], fillStartsWithAllPixels: true } };
    d.layers.push(l);
    expect(() => validateDocument(structuredClone(d))).not.toThrow();
    const bad = structuredClone(d);
    bad.paths!.push({ id: 'a', name: 'dup', mask: { paths: [] } });
    expect(() => validateDocument(bad)).toThrow();
    const badKnot = structuredClone(d);
    badKnot.workPath = { paths: [{ open: false, fillRule: 'non-zero', knots: [{ linked: false, points: [0, 0, NaN, 0, 0, 0] }] }] };
    expect(() => validateDocument(badKnot)).toThrow();
    expect(() => validateLiveShape({ kind: 'polygon', x: 0, y: 0, width: 1, height: 1, sides: 2, star: 0, radius: 0, smoothIndents: false })).toThrow();
    expect(() => validateLiveShape({ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, weight: 1, arrowStart: false, arrowEnd: true, arrowWidth: 5, arrowLength: 10, concavity: 0.2 })).not.toThrow();
  });
  it('follow canvas resizes and crops', () => {
    const d = doc();
    d.paths = [{ id: 'a', name: 'Path 1', mask: { paths: [closedPath(rectKnots(100, 100, 50, 50))] } }];
    d.workPath = { paths: [closedPath(rectKnots(0, 0, 10, 10))] };
    resizeDocument(d, 800, 600);
    expect(vectorBounds(d.paths[0].mask)).toEqual({ x: 200, y: 200, width: 100, height: 100 });
    cropDocument(d, { x: 50, y: 20, width: 600, height: 500 });
    expect(vectorBounds(d.paths[0].mask)).toEqual({ x: 150, y: 180, width: 100, height: 100 });
    expect(vectorBounds(d.workPath!)).toEqual({ x: -50, y: -20, width: 20, height: 20 });
  });
});

describe('PSD export of tool-made shapes', () => {
  it('writes editable shape layers with knots, fill, gradient and stroke', async () => {
    const d = doc();
    const rect = roundRect(d);
    rect.vector!.stroke = buildStroke({ ...defaultStroke(), type: 'color', color: '#0000ff', width: 4, align: 'center' }, true, false);
    d.layers.push(rect);
    const ellipseMask = { paths: [closedPath(ellipseKnots(200, 100, 120, 90))] };
    const grad = gradientPaint({ type: 'gradient', from: '#ff0000', to: '#0000ff', style: 'linear', angle: 30, reverse: false }, { x: 0, y: 0, width: 400, height: 300 }, vectorBounds(ellipseMask));
    d.layers.push(shapeLayer(d, 'Ellipse 1', ellipseMask, grad, undefined, { kind: 'ellipse', x: 200, y: 100, width: 120, height: 90 }));
    const blob = await savePsd(d, async () => new Uint8Array(400 * 300 * 4));
    const psd = readPsd(new Uint8Array(await blob.arrayBuffer()), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
    const [r, e] = psd.children!;
    expect(r.name).toBe('Rectangle 1');
    expect(r.vectorMask!.paths[0].knots).toHaveLength(rect.vector!.mask.paths[0].knots.length);
    // PSD stores knots as signed 8.24 fractions of the canvas size.
    r.vectorMask!.paths[0].knots.forEach((k, i) => k.points.forEach((v, j) => close(v, rect.vector!.mask.paths[0].knots[i].points[j], 1e-3)));
    expect(r.vectorFill).toMatchObject({ type: 'color' });
    expect(r.vectorStroke?.lineWidth).toEqual({ value: 4, units: 'Pixels' });
    expect(importVectorStroke(r)).toBeDefined();
    expect(e.vectorFill?.type).toBe('solid');
    expect(e.vectorMask!.paths[0].knots).toHaveLength(4);
  });
});
