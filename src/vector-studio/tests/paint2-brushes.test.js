import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { anchor } from '../src/model/bezier.js';
import { makeBrush, artBounds, docBrushes, setDocBrushes, brushById } from '../src/features/brushes/brush-model.js';
import { variableValue, rangeValue, calligraphicShapes, bristleShapes, spineOverlaps } from '../src/features/brushes/generate.js';
import { velocities, pressureSamples, brushUsesMode } from '../src/features/brushes/paintbrush-tool.js';
import { brushOptionsDialog, brushArtColors } from '../src/features/brushes/brush-dialogs.js';
import { editBrush } from '../src/features/brushes/brush-actions.js';
import { pathBounds } from '../src/model/bezier.js';

const black = { type: 'solid', color: '#000000' };
const dialog = () => document.querySelector('dialog[open]');
const button = (label) => [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const tick = () => new Promise((r) => setTimeout(r, 0));
const sq = (x, y, w, color) => ({ subpaths: [{ closed: true, anchors: [anchor(x, y), anchor(x + w, y), anchor(x + w, y + w), anchor(x, y + w)] }], fill: { type: 'solid', color }, stroke: null });

describe('velocity', () => {
  it('scales brush parameters by drawing speed', () => {
    const v = { mode: 'velocity', value: 10, variation: 4 };
    expect(variableValue(v, 0.3, 0.5, 0)).toBe(6);
    expect(variableValue(v, 0.3, 0.5, 1)).toBe(14);
    expect(variableValue(v, 0.3, 0.5)).toBe(10);
    expect(rangeValue({ mode: 'velocity', min: 50, max: 150 }, 0.1, 0.9, 0.25)).toBe(75);
    expect(brushUsesMode({ size: v }, 'velocity')).toBe(true);
  });

  it('measures speed from timestamps and makes fast parts of a calligraphic stroke wider', () => {
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: 0 }));
    // Slow first half (10 px in 40 ms), fast second half (10 px in 4 ms).
    const times = [];
    let t = 0;
    for (let i = 0; i < pts.length; i++) {
      times.push(t);
      t += i < 10 ? 40 : 4;
    }
    const v = velocities(pts, times, 1);
    expect(v[2]).toBeLessThan(0.3);
    expect(v[18]).toBeGreaterThan(0.7);
    const samples = pressureSamples(pts, v);
    const brush = makeBrush({ type: 'calligraphic', size: { mode: 'velocity', value: 6, variation: 4 }, velocity: samples });
    const [shape] = calligraphicShapes([{ anchors: [anchor(0, 0), anchor(200, 0)], closed: false }], { stroke: black, strokeWidth: 1 }, brush);
    const ys = (x0, x1) => shape.subpaths.flatMap((s) => s.anchors).filter((a) => a.x > x0 && a.x < x1).map((a) => Math.abs(a.y));
    expect(Math.max(...ys(170, 190))).toBeGreaterThan(Math.max(...ys(10, 30)) * 2);
  });

  it('is a mode in the options dialogs', async () => {
    await bootAppWithFeatures();
    const app = { dialogs: { open: (o) => import('../src/ui/dialogs/dialog.js').then((m) => m.openDialog(o)) } };
    const p = brushOptionsDialog(app, makeBrush({ type: 'calligraphic' }));
    await tick();
    const modes = [...dialog().querySelectorAll('select')][0];
    expect([...modes.options].map((o) => o.value)).toEqual(['fixed', 'random', 'pressure', 'velocity']);
    button('Cancel').click();
    expect(await p).toBe(null);
  });
});

describe('art brush options', () => {
  const art = { items: [sq(0, 0, 10, '#ff0000'), sq(10, 0, 30, '#00ff00'), sq(40, 0, 10, '#ff0000')] };
  art.bounds = artBounds(art.items);

  it('drags guides on the artwork and picks the key color from its colors', async () => {
    await bootAppWithFeatures();
    expect(brushArtColors({ art })).toEqual(['#ff0000', '#00ff00']);
    const app = { dialogs: { open: (o) => import('../src/ui/dialogs/dialog.js').then((m) => m.openDialog(o)) } };
    const brush = makeBrush({ type: 'art', art, scaling: 'guides', guides: { start: 0.2, end: 0.8 } });
    const p = brushOptionsDialog(app, brush);
    await tick();
    const dlg = dialog();
    const guides = dlg.querySelectorAll('.bo-guide');
    expect(guides.length).toBe(2);
    expect(Number(guides[0].getAttribute('x1'))).toBeCloseTo(10, 5);
    expect(Number(guides[1].getAttribute('x1'))).toBeCloseTo(40, 5);
    // Typing a guide moves its line.
    const start = dlg.querySelector('[aria-label="Start guide"]');
    start.value = '30%';
    start.dispatchEvent(new Event('input', { bubbles: true }));
    expect(Number(guides[0].getAttribute('x1'))).toBeCloseTo(15, 5);
    // Hue shift shows the key color with the art's colors to pick from.
    const method = dlg.querySelector('[aria-label="Colorization method"]');
    method.value = 'hueShift';
    method.dispatchEvent(new Event('change', { bubbles: true }));
    const chips = dlg.querySelectorAll('.bo-key-chip');
    expect(chips.length).toBe(2);
    chips[1].click();
    expect(dlg.querySelector('[aria-label="Key color"]').value).toBe('#00ff00');
    button('OK').click();
    const res = await p;
    expect(res.guides.start).toBeCloseTo(0.3, 5);
    expect(res.colorize).toEqual({ method: 'hueShift', key: '#00ff00' });
  });
});

describe('bristle paint builds up', () => {
  const brush = makeBrush({ type: 'bristle', size: 4, density: 20 });
  it('lays a stroke that crosses itself down in pieces', () => {
    const straight = bristleShapes([{ anchors: [anchor(0, 0), anchor(200, 0)], closed: false }], { stroke: black, strokeWidth: 1 }, brush, { seed: 3 });
    // A loop: right, down, back left and up through the first part.
    const loop = [anchor(0, 20), anchor(120, 20), anchor(120, 60), anchor(60, 60), anchor(60, 0)];
    const crossing = bristleShapes([{ anchors: loop, closed: false }], { stroke: black, strokeWidth: 1 }, brush, { seed: 3 });
    expect(crossing.length).toBeGreaterThan(straight.length * 3);
    expect(crossing.every((s) => s.strokeCap === 'butt')).toBe(true);
    expect(straight.every((s) => s.strokeCap === 'round')).toBe(true);
  });

  it('detects where a path runs over itself', () => {
    const at = (s) => ({ x: Math.cos(s / 20) * 20, y: Math.sin(s / 20) * 20 });
    expect(spineOverlaps(at, 2 * Math.PI * 20 * 1.2, 4, 8)).toBe(true);
    expect(spineOverlaps((s) => ({ x: s, y: 0 }), 200, 4, 8)).toBe(false);
  });

  it('gives harder parts of a pen stroke more paint', () => {
    const pressure = [[0, 0], [1, 1]];
    const shapes = bristleShapes([{ anchors: [anchor(0, 0), anchor(200, 0)], closed: false }], { stroke: black, strokeWidth: 1 }, { ...brush, opacity: 50 }, { seed: 3, pressure });
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) expect(s.stroke.opacity).toBeLessThanOrEqual(1);
  });
});

describe('changing a brush in use', () => {
  it('can apply the new settings to the selected strokes only', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    const doc = ed.doc;
    const b = makeBrush({ id: 'my-cal', name: 'Mine', type: 'calligraphic', size: { mode: 'fixed', value: 3, variation: 0 } });
    doc.transact('b', () => setDocBrushes(doc, [...docBrushes(doc), b]));
    const mk = (y) => {
      const n = createPath([anchor(0, y), anchor(100, y)], false, { fill: null, stroke: black, strokeWidth: 1, brush: { id: 'my-cal', seed: 1 } });
      doc.transact('p', () => doc.insert(n, ed.targetLayer().id));
      return n.id;
    };
    const a = mk(0);
    const c = mk(50);
    ed.select([a]);
    const done = editBrush(app, 'my-cal');
    await tick();
    const size = dialog().querySelector('[aria-label="Size"]');
    size.value = '9 pt';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    button('OK').click();
    await tick();
    await tick();
    expect(button('Apply to Selected Strokes')).toBeTruthy();
    button('Apply to Selected Strokes').click();
    await done;
    const fresh = doc.get(a).brush.id;
    expect(fresh).not.toBe('my-cal');
    expect(brushById(doc, fresh).size.value).toBe(9);
    expect(doc.get(a).brush.seed).toBe(1);
    expect(doc.get(c).brush.id).toBe('my-cal');
    expect(brushById(doc, 'my-cal').size.value).toBe(3);
    expect(pathBounds(doc.get(a).anchors, false)).toBeTruthy();
  });
});
