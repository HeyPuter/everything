import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { liveArtwork, isLive } from '../src/model/live.js';
import { hitTest } from '../src/render/hit.js';
import { gradientGeometry, nodeBounds } from '../src/model/geometry.js';
import { strokeGradientShapes, hasStrokeGradient, setStrokeApply } from '../src/features/paint/stroke-gradient.js';
import { paintState } from '../src/features/paint/ui-common.js';
import { convertToMesh } from '../src/features/mesh/mesh-ops.js';
import { selectMeshPoints } from '../src/features/mesh/mesh-edit.js';
import { exportSVG } from '../src/features/io/svg-export.js';

const G = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }] };
const line = (x0, y0, x1, y1) => [{ x: x0, y: y0, ix: x0, iy: y0, ox: x0, oy: y0 }, { x: x1, y: y1, ix: x1, iy: y1, ox: x1, oy: y1 }];
const center = (pts) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

describe('gradients along and across strokes', () => {
  it('along: colors follow the path from start to end', () => {
    const shapes = strokeGradientShapes([{ anchors: line(0, 0, 100, 0), closed: false }], { ...G, strokeApply: 'along' }, { strokeWidth: 10, strokeCap: 'butt' });
    expect(shapes.length).toBeGreaterThan(10);
    const first = shapes[0];
    const last = shapes[shapes.length - 1];
    expect(center(first.points).x).toBeLessThan(5);
    expect(center(last.points).x).toBeGreaterThan(95);
    expect(parseInt(first.color.slice(1, 3), 16)).toBeGreaterThan(240);
    expect(parseInt(last.color.slice(5, 7), 16)).toBeGreaterThan(240);
    // The bands cover the stroke width.
    const ys = shapes.flatMap((s) => s.points.map((p) => p.y));
    expect(Math.min(...ys)).toBeCloseTo(-5, 5);
    expect(Math.max(...ys)).toBeCloseTo(5, 5);
  });

  it('across: colors run from one edge to the other; round caps curve the bands', () => {
    const shapes = strokeGradientShapes([{ anchors: line(0, 0, 100, 0), closed: false }], { ...G, strokeApply: 'across' }, { strokeWidth: 10, strokeCap: 'round' });
    const first = shapes[0];
    const last = shapes[shapes.length - 1];
    // Left of travel along +x in a y-down document is -y... the first band sits on one edge, the last on the other.
    expect(Math.sign(center(first.points).y)).toBe(-Math.sign(center(last.points).y));
    expect(parseInt(first.color.slice(1, 3), 16)).toBeGreaterThan(230);
    expect(parseInt(last.color.slice(5, 7), 16)).toBeGreaterThan(230);
    // Round caps reach half the width past the ends at the center line.
    const xs = shapes.flatMap((s) => s.points.map((p) => p.x));
    expect(Math.min(...xs)).toBeLessThan(-4.5);
    expect(Math.max(...xs)).toBeGreaterThan(104.5);
  });

  it('closed paths loop around', () => {
    const shapes = strokeGradientShapes([{ anchors: rectangle(0, 0, 50, 50), closed: true }], { ...G, strokeApply: 'across' }, { strokeWidth: 4 });
    expect(shapes.length).toBeGreaterThan(2);
    // Each band is a ring around the square.
    const xs = shapes[0].points.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(49);
  });

  it('is live artwork through the Gradient panel, clickable and exported', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    const doc = ed.doc;
    const p = createPath(line(10, 10, 210, 10), false, { fill: null, stroke: G, strokeWidth: 12 });
    doc.transact('add', () => doc.insert(p, ed.targetLayer().id));
    ed.select([p.id]);
    ed.focusPaint = 'stroke';
    expect(hasStrokeGradient(doc.get(p.id))).toBe(false);
    app.openPanel('gradient');
    const panel = app.dock.panels.get('gradient');
    panel.ensureBuilt();
    panel.update();
    expect(panel.strokeRow.hidden).toBe(false);
    panel.strokeMode.el.querySelector('[aria-label="Apply gradient along stroke"]').click();
    const n = doc.get(p.id);
    expect(n.stroke.strokeApply).toBe('along');
    expect(isLive(n)).toBe(true);
    const { items } = liveArtwork(doc, n);
    expect(items.every((it) => it.fill?.type === 'solid' && !it.stroke)).toBe(true);
    // Clicking the stroke picks the path.
    expect(hitTest(doc, 100, 14, 1)?.id).toBe(p.id);
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 300, h: 100 } });
    expect((svg.match(/<path/g) || []).length).toBeGreaterThan(20);
    doc.undo();
    expect(doc.get(p.id).stroke.strokeApply).toBeUndefined();
    expect(setStrokeApply(G, 'within')).toEqual(G);
  });
});

describe('on-canvas gradient controls', () => {
  let app;
  let ed;
  let doc;
  let node;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    ed = app.newDocument();
    doc = ed.doc;
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const p = createPath(rectangle(100, 100, 200, 100), true, { fill: { ...G, x1: 100, y1: 150, x2: 300, y2: 150 }, stroke: null });
    doc.transact('add', () => doc.insert(p, ed.targetLayer().id));
    node = p.id;
    ed.select([node]);
    ed.focusPaint = 'fill';
    app.setTool('gradient');
  });

  const stopPoint = (offset) => {
    const g = gradientGeometry(doc.get(node).fill, nodeBounds(doc, doc.get(node)));
    // Stop markers sit 13px below the bar.
    return { x: g.x1 + (g.x2 - g.x1) * offset, y: g.y1 + 13 };
  };

  it('Alt-drag copies a stop', () => {
    const t = app.tool;
    const a = stopPoint(0);
    t.onPointerDown(ev(app, a.x, a.y, { alt: true }));
    t.onPointerMove(ev(app, a.x + 50, a.y, { alt: true }));
    t.onPointerUp(ev(app, a.x + 50, a.y));
    const stops = doc.get(node).fill.stops;
    expect(stops.length).toBe(3);
    expect(stops.map((s) => s.color)).toEqual(['#ff0000', '#ff0000', '#0000ff']);
    expect(stops[1].offset).toBeCloseTo(0.25, 2);
    doc.undo();
    expect(doc.get(node).fill.stops.length).toBe(2);
  });

  it('double-clicking a stop edits it in place', () => {
    const t = app.tool;
    const b = stopPoint(1);
    t.onDoubleClick(ev(app, b.x, b.y, { native: { clientX: 10, clientY: 10 } }));
    const pop = document.querySelector('.gt-stop-popover');
    expect(pop).toBeTruthy();
    const inputs = pop.querySelectorAll('.num-input');
    inputs[0].value = '40';
    inputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(doc.get(node).fill.stops[1].opacity).toBeCloseTo(0.4, 5);
    inputs[1].value = '30';
    inputs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const stops = doc.get(node).fill.stops;
    expect(stops[0].offset).toBeCloseTo(0, 5);
    expect(stops[1].offset).toBeCloseTo(0.3, 5);
    [...pop.querySelectorAll('button')].find((x) => x.textContent === 'Delete Stop').click();
    expect(doc.get(node).fill.stops.length).toBe(2);
  });

  it('moves the focal point of a radial gradient and turns it from its ellipse', () => {
    doc.transact('radial', () => doc.update(node, { fill: { ...doc.get(node).fill, type: 'radial', x1: 200, y1: 150, x2: 260, y2: 150 } }));
    const t = app.tool;
    // Alt on the origin drags the focal point.
    t.onPointerDown(ev(app, 200, 150, { alt: true }));
    t.onPointerMove(ev(app, 230, 150, { alt: true }));
    t.onPointerUp(ev(app, 230, 150));
    const f = doc.get(node).fill.focal;
    expect(f[0]).toBeCloseTo(0.5, 3);
    expect(f[1]).toBeCloseTo(0, 3);
    // The ellipse outline (top of the circle) turns the gradient.
    t.onPointerDown(ev(app, 200, 90));
    t.onPointerMove(ev(app, 260, 150));
    t.onPointerUp(ev(app, 200, 210));
    const p = doc.get(node).fill;
    expect(p.x2 - p.x1).toBeCloseTo(0, 3);
    expect(p.y2 - p.y1).toBeCloseTo(60, 3);
  });
});

describe('mesh color picking', () => {
  it('the Eyedropper picks the mesh color under the pointer into selected points', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    const doc = ed.doc;
    const r = createPath(rectangle(100, 100, 200, 100), true, { fill: { type: 'solid', color: '#ffffff' }, stroke: null });
    doc.transact('add', () => doc.insert(r, ed.targetLayer().id));
    let m;
    doc.transact('Mesh', () => (m = convertToMesh(doc, r.id, { rows: 1, cols: 1 })));
    // Left corners red, right corners blue.
    doc.transact('color', () => doc.update(m.id, { points: doc.get(m.id).points.map((p) => ({ ...p, c: p.x < 200 ? '#ff0000' : '#0000ff' })) }));
    ed.select([m.id]);
    selectMeshPoints(ed, m.id, [0]);
    app.setTool('eyedropper');
    app.tool.onPointerDown(ev(app, 200, 150));
    // Halfway across: an even mix, applied to the selected point only.
    const pts = doc.get(m.id).points;
    expect(pts[0].c).toBe('#800080');
    expect(pts[1].c).toBe('#0000ff');
    expect(ed.style.fill).toEqual({ type: 'solid', color: '#800080' });
  });
});
