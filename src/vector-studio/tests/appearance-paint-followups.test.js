import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { transformNodes } from '../src/model/geometry.js';
import { rotate } from '../src/lib/matrix.js';
import { writePDF } from '../src/features/io/pdf.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { sampleFreeform, addPoint, removePoint, insertLinePoint, setFreeformMode, freeformFrame, framePoint, frameFraction, installFreeform } from '../src/features/paint/freeform.js';
import { svgPaintHooks } from '../src/features/io/hooks.js';

beforeAll(() => {
  installCanvasStub();
  installFreeform();
});

const solid = (color) => ({ type: 'solid', color });
const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');

function docWith(...nodes) {
  const doc = VDocument.create({ width: 200, height: 200 });
  const layer = doc.layers()[0].id;
  doc.transact('build', () => nodes.forEach((n) => doc.insert(n, layer)));
  return doc;
}

const FF = { type: 'freeform', points: [{ x: 0, y: 0.5, color: '#ff0000' }, { x: 1, y: 0.5, color: '#0000ff' }, { x: 0.5, y: 1, color: '#00ff00' }] };

describe('freeform gradients: lines mode', () => {
  it('spreads colors along lines', () => {
    const lines = setFreeformMode({ ...FF, lines: [[0, 1]] }, 'lines');
    // Halfway along the red-blue line the color is their mix, whatever the green point does.
    const c = sampleFreeform(lines, 0.5, 0.5, 1);
    expect(c.r).toBeCloseTo(127.5, 0);
    expect(c.b).toBeCloseTo(127.5, 0);
    expect(c.g).toBeCloseTo(0, 0);
    // In points mode the same spot is a blend of all three.
    const p = sampleFreeform(FF, 0.5, 0.5, 1);
    expect(p.g).toBeGreaterThan(20);
    // Just off the line the line dominates over the farther green point.
    const near = sampleFreeform(lines, 0.5, 0.55, 1);
    expect(near.r + near.b).toBeGreaterThan(near.g * 3);
  });

  it('continues, splits and shortens lines as points come and go', () => {
    let paint = setFreeformMode(FF, 'lines');
    let r = addPoint(paint, 0.2, 0.2, '#ffffff', { after: 0 });
    expect(r.paint.lines).toEqual([[0, 3]]);
    r = addPoint(r.paint, 0.4, 0.1, '#000000', { after: 3 });
    expect(r.paint.lines).toEqual([[0, 3, 4]]);
    // A point on its own (no `after`) joins nothing.
    const alone = addPoint(r.paint, 0.9, 0.9, '#000000');
    expect(alone.paint.lines).toEqual([[0, 3, 4]]);
    // Clicking a segment inserts a point with the color there.
    const ins = insertLinePoint({ ...paint, lines: [[0, 1]] }, 0, 0, 0.5);
    expect(ins.paint.lines).toEqual([[0, 3, 1]]);
    expect(ins.paint.points[3]).toMatchObject({ x: 0.5, y: 0.5 });
    expect(ins.paint.points[3].color).toBe('#800080');
    // Removing a point renumbers the lines and drops lines left with one point.
    paint = removePoint(r.paint, 3);
    expect(paint.lines).toEqual([[0, 3]]);
    expect(removePoint({ ...paint, lines: [[0, 1]] }, 1).lines).toEqual([]);
    // Points mode does not connect new points.
    expect(addPoint(FF, 0.1, 0.1, '#fff', { after: 0 }).paint.lines).toBeUndefined();
  });
});

describe('freeform gradients: positions turn with the object', () => {
  it('keeps points on the object when it rotates', () => {
    const node = createPath(rectangle(0, 0, 100, 40), true, { fill: FF, stroke: null });
    const doc = docWith(node);
    let f = freeformFrame(doc, doc.get(node.id));
    expect(f).toMatchObject({ x: 0, y: 0, w: 100, h: 40, angle: 0 });
    const before = framePoint(f, 1, 0.5);
    expect(before.x).toBeCloseTo(100);
    expect(before.y).toBeCloseTo(20);
    doc.transact('Rotate', () => transformNodes(doc, [node.id], rotate(90, 50, 20)));
    f = freeformFrame(doc, doc.get(node.id));
    expect(f.w).toBeCloseTo(100);
    expect(f.h).toBeCloseTo(40);
    // The blue point at the right end is now at the bottom end, where that corner went.
    const after = framePoint(f, 1, 0.5);
    expect(after.x).toBeCloseTo(50);
    expect(after.y).toBeCloseTo(70);
    const back = frameFraction(f, after.x, after.y);
    expect(back.u).toBeCloseTo(1);
    expect(back.v).toBeCloseTo(0.5);
  });

  it('writes a turned image pattern in SVG', () => {
    const node = createPath(rectangle(0, 0, 100, 40), true, { fill: FF, stroke: null });
    const doc = docWith(node);
    doc.transact('Rotate', () => transformNodes(doc, [node.id], rotate(30, 50, 20)));
    expect(svgPaintHooks.freeform).toBeTypeOf('function');
    // A canvas that can encode (jsdom's cannot).
    const proto = HTMLCanvasElement.prototype;
    const saved = [proto.toDataURL, proto.getContext];
    proto.toDataURL = () => `data:image/png;base64,${'A'.repeat(40)}`;
    proto.getContext = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} });
    let svg;
    try {
      svg = exportSVG(doc, { rect: { x: -100, y: -100, w: 400, h: 400 } });
    } finally {
      [proto.toDataURL, proto.getContext] = saved;
    }
    // One pattern unit is the turned frame: 100 x 40 at 30 degrees.
    const m = /patternTransform="matrix\(([^)]*)\)"/.exec(svg)[1].split(' ').map(Number);
    expect(m[0]).toBeCloseTo(100 * Math.cos(Math.PI / 6), 2);
    expect(m[1]).toBeCloseTo(100 * Math.sin(Math.PI / 6), 2);
    expect(m[3]).toBeCloseTo(40 * Math.cos(Math.PI / 6), 2);
    expect(svg).toMatch(/fill="url\(#ff\d+\)"/);
  });
});

describe('PDF export of freeform fills and opacity masks', () => {
  it('draws a freeform fill as an image inside its shape', async () => {
    const node = createPath(rectangle(20, 20, 100, 40), true, { fill: FF, stroke: { ...FF }, strokeWidth: 2 });
    const { bytes } = await writePDF(docWith(node), [{ x: 0, y: 0, w: 200, h: 200 }], { compress: false });
    const s = latin1(bytes);
    expect(s).toMatch(/\/Subtype \/Image \/Width 256 \/Height \d+/);
    expect(s).toMatch(/W n\n[-\d. ]+ cm\n\/Im\d+ Do/);
    // The stroke paints with a tiling pattern holding the blend.
    expect(s).toMatch(/\/Pattern CS \/P\d+ SCN\n/);
    expect(s).toMatch(/\/PatternType 1 \/PaintType 1 \/TilingType 1/);
  });

  it('writes opacity masks as luminosity soft masks', async () => {
    const mask = createPath(rectangle(20, 20, 50, 50), true, { fill: solid('#ffffff'), stroke: null });
    const art = { root: mask.id, nodes: [mask] };
    const node = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000'), stroke: null }, { opacityMask: { art, transform: [1, 0, 0, 1, 10, 0], clip: true, invert: true } });
    const { bytes } = await writePDF(docWith(node), [{ x: 0, y: 0, w: 200, h: 200 }], { compress: false });
    const s = latin1(bytes);
    expect(s).toMatch(/\/SMask << \/Type \/Mask \/S \/Luminosity \/G \d+ 0 R \/BC \[0 0 0\] \/TR/);
    expect(s).toContain('/Group << /S /Transparency /CS /DeviceRGB /I true >>');
    // The mask art (white square) is drawn under the mask's transform.
    expect(s).toMatch(/1 0 0 1 10 0 cm\n/);
    expect(s).toMatch(/1 1 1 rg/);
    // A disabled mask draws the object plainly.
    const plain = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000'), stroke: null }, { opacityMask: { art, transform: [1, 0, 0, 1, 0, 0], disabled: true } });
    expect(latin1((await writePDF(docWith(plain), [{ x: 0, y: 0, w: 200, h: 200 }], { compress: false })).bytes)).not.toContain('/Luminosity');
  });
});
