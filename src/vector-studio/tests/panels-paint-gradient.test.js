import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { defaultFreeform, sampleFreeform, freeformPixels, averageColor, freeformCss, addPoint, removePoint, setPoint } from '../src/features/paint/freeform.js';
import { setGradientType } from '../src/features/paint/gradient-model.js';
import { paintState } from '../src/features/paint/ui-common.js';
import { swatchesOf } from '../src/features/paint/swatch-model.js';
import { paintCss } from '../src/ui/widgets.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { exportView } from '../src/features/io/export-view.js';

const solid = (color) => ({ type: 'solid', color });
const ff = (points) => ({ type: 'freeform', points });

describe('Freeform gradient model', () => {
  it('blends point colors by distance, solid at the points', () => {
    const p = ff([{ x: 0, y: 0, color: '#ff0000' }, { x: 1, y: 1, color: '#0000ff' }]);
    const a = sampleFreeform(p, 0, 0);
    expect([Math.round(a.r), Math.round(a.b)]).toEqual([255, 0]);
    const m = sampleFreeform(p, 0.5, 0.5);
    expect(Math.round(m.r)).toBe(128);
    expect(Math.round(m.b)).toBe(128);
    const near = sampleFreeform(p, 0.2, 0.2);
    expect(near.r).toBeGreaterThan(near.b);
    expect(sampleFreeform(p, 0.3, 0.3).a).toBeCloseTo(1);
  });

  it('keeps a point solid within its spread', () => {
    const p = ff([{ x: 0.5, y: 0.5, color: '#00ff00', spread: 0.3 }, { x: 0, y: 0, color: '#000000' }]);
    const c = sampleFreeform(p, 0.6, 0.55);
    expect(Math.round(c.g)).toBe(255);
  });

  it('renders pixels, averages and CSS previews', () => {
    const p = ff([{ x: 0, y: 0.5, color: '#ff0000' }, { x: 1, y: 0.5, color: '#0000ff' }]);
    const px = freeformPixels(p, 4, 1);
    expect(px[0]).toBeGreaterThan(px[2]);
    expect(px[12 + 2]).toBeGreaterThan(px[12]);
    expect(px[3]).toBe(255);
    expect(averageColor(p)).toBe('#800080');
    expect(freeformCss(p)).toMatch(/radial-gradient\(circle at 0% 50%/);
  });

  it('adds, moves and removes points, and converts to and from linear', () => {
    let p = defaultFreeform();
    expect(p.points.length).toBe(3);
    const r = addPoint(p, 1.5, -1, '#123456');
    expect(r.paint.points[r.index]).toMatchObject({ x: 1, y: 0, color: '#123456' });
    p = setPoint(r.paint, 0, { spread: 0.5 });
    expect(p.points[0].spread).toBe(0.5);
    p = removePoint(p, 0);
    expect(p.points.length).toBe(3);
    const lin = setGradientType(p, 'linear');
    expect(lin.type).toBe('linear');
    expect(lin.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    const back = setGradientType({ type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] }, 'freeform');
    expect(back.points.map((q) => q.color)).toEqual(['#ffffff', '#000000']);
  });
});

describe('Gradient panel', () => {
  it('switches to freeform from the menu and edits the selected point', async () => {
    const { ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: solid('#ffffff') }, [0, 0, 100, 50]);
    ed.select([id]);
    const p = panel('gradient');
    const labels = p.menu().filter((x) => typeof x === 'object').map((x) => x.label);
    expect(labels).toEqual(['Hide Options', 'Linear Gradient', 'Radial Gradient', 'Freeform Gradient', 'Reverse Gradient', 'Fit Gradient to Object', 'Edit Gradient', 'Add to Swatches']);
    menuItem(p, 'Freeform Gradient').run();
    expect(ed.doc.get(id).fill.type).toBe('freeform');
    p.update();
    expect(p.freeform.hidden).toBe(false);
    expect(p.linearOnly.hidden).toBe(true);
    expect(menuItem(p, 'Reverse Gradient').enabled).toBe(false);
    paintState.setStop(1);
    p.spread.el.querySelector('input').value = '40';
    p.spread.el.querySelector('input').dispatchEvent(new Event('change'));
    p.spread.el.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(ed.doc.get(id).fill.points[1].spread).toBeCloseTo(0.4);
    // The Color panel edits the selected point.
    const cp = panel('color');
    cp.apply('#00ff00');
    expect(ed.doc.get(id).fill.points[1].color).toBe('#00ff00');
    expect(paintCss(ed.doc.get(id).fill)).toContain('radial-gradient');
    p.update();
    const count = ed.doc.get(id).fill.points.length;
    p.delPoint.click();
    expect(ed.doc.get(id).fill.points.length).toBe(count - 1);
    menuItem(p, 'Linear Gradient').run();
    expect(ed.doc.get(id).fill.type).toBe('linear');
    paintState.setStop(0);
  });

  it('reverses, adds to swatches, shows presets and hides options', async () => {
    const { ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }] } });
    ed.select([id]);
    const p = panel('gradient');
    menuItem(p, 'Reverse Gradient').run();
    expect(ed.doc.get(id).fill.stops[0].color).toBe('#0000ff');
    const n = swatchesOf(ed.doc).length;
    await menuItem(p, 'Add to Swatches').run();
    expect(swatchesOf(ed.doc).length).toBe(n + 1);
    p.update();
    const presets = [...p.presets.querySelectorAll('.gp-preset')];
    expect(presets.length).toBeGreaterThan(0);
    menuItem(p, 'Hide Options').run();
    expect(p.options.hidden).toBe(true);
  });
});

describe('Freeform gradients on the canvas', () => {
  it('adds, moves and deletes points with the Gradient tool', async () => {
    const { app, ed, add } = await paintSetup();
    const id = add({ fill: ff([{ x: 0, y: 0, color: '#ff0000' }, { x: 1, y: 1, color: '#0000ff' }]) }, [0, 0, 100, 100]);
    ed.select([id]);
    app.setTool('gradient');
    const tool = app.getTool('gradient');
    const ev = (x, y, extra = {}) => {
      const s = ed.view.toScreen(x, y);
      return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, ...extra };
    };
    tool.onPointerDown(ev(50, 40));
    tool.onPointerUp(ev(50, 40));
    let fill = ed.doc.get(id).fill;
    expect(fill.points.length).toBe(3);
    expect(fill.points[2]).toMatchObject({ x: 0.5, y: 0.4 });
    expect(paintState.stop).toBe(2);
    tool.onPointerDown(ev(50, 40));
    tool.onPointerMove(ev(70, 80));
    tool.onPointerUp(ev(70, 80));
    fill = ed.doc.get(id).fill;
    expect(fill.points[2].x).toBeCloseTo(0.7);
    expect(fill.points[2].y).toBeCloseTo(0.8);
    expect(tool.onKeyDown({ key: 'Delete' })).toBe(true);
    expect(ed.doc.get(id).fill.points.length).toBe(2);
    ed.doc.undo();
    expect(ed.doc.get(id).fill.points.length).toBe(3);
    paintState.setStop(0);
  });

  it('exports the average color where blends are not native', async () => {
    const { ed, add } = await paintSetup();
    add({ fill: ff([{ x: 0, y: 0, color: '#ff0000' }, { x: 1, y: 1, color: '#0000ff' }]) });
    const view = exportView(ed.doc);
    let found = null;
    view.walk((n) => {
      if (n.type === 'path') found = n;
    });
    expect(found.fill).toEqual(solid('#800080'));
    // SVG writes a paint server when it can rasterize, else no fill (never a broken reference).
    const svg = exportSVG(ed.doc, { rect: { x: 0, y: 0, w: 20, h: 20 } });
    expect(svg).not.toContain('url(#undefined');
  });
});

describe('Stroke panel menu', () => {
  it('hides everything but the weight', async () => {
    const { panel, menuItem, app } = await paintSetup();
    const p = panel('stroke');
    expect(p.menu().map((x) => x.label)).toEqual(['Hide Options']);
    menuItem(p, 'Hide Options').run();
    expect(p.options.hidden).toBe(true);
    expect(p.weight.el.isConnected).toBe(true);
    expect(app.prefs.get('strokeOptions')).toBe(false);
    expect(menuItem(p, 'Show Options')).toBeTruthy();
  });
});
