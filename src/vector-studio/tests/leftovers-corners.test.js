import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { rectangle, shapeAnchors } from '../src/model/shapes.js';
import { applyCorners, cornerLimits } from '../src/model/corners.js';
import { createPath } from '../src/model/nodes.js';
import { flattenPath } from '../src/model/bezier.js';
import { transformNodes } from '../src/model/geometry.js';
import { scale } from '../src/lib/matrix.js';
import { cornerTargets, cornersDialog } from '../src/features/corners/index.js';
import { widgetAt } from '../src/tools/widgets.js';
import { exportSVG } from '../src/features/io/svg-export.js';

const ev = (app, x, y, extra = {}) => {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
};

async function setup(shapeExtra = {}) {
  const app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  const doc = app.editor.doc;
  const shape = { kind: 'rect', cx: 200, cy: 160, w: 200, h: 120, radii: [10, 10, 10, 10], angle: 0, ...shapeExtra };
  const n = createPath(shapeAnchors(shape), true, { fill: { type: 'solid', color: '#3366cc' } }, { shape });
  doc.transact('add', () => doc.insert(n, app.editor.targetLayer().id));
  app.editor.select([n.id]);
  app.setTool('selection');
  return { app, doc, id: n.id };
}

describe('live rectangle corner types', () => {
  it('builds chamfered and inverted corners', () => {
    const ch = rectangle(0, 0, 100, 100, [10, 0, 0, 0], ['chamfer']);
    expect(ch).toHaveLength(5);
    expect(ch[0]).toMatchObject({ x: 0, y: 10, ox: 0, oy: 10 });
    expect(ch[1]).toMatchObject({ x: 10, y: 0, ix: 10, iy: 0 });
    const inv = rectangle(0, 0, 100, 100, [10, 0, 0, 0], ['inverted']);
    const near = flattenPath(inv, true, 0.01).filter((p) => p.x < 9.99 && p.y < 9.99);
    expect(near.length).toBeGreaterThan(2);
    for (const p of near) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 0);
    // Round corners are unchanged without types.
    expect(rectangle(0, 0, 100, 100, 10)).toEqual(rectangle(0, 0, 100, 100, 10, ['round', 'round', 'round', 'round']));
  });

  it('Option-click on a live rectangle widget cycles the corner type', async () => {
    const { app, doc, id } = await setup();
    const c = cornerTargets(app)[0];
    expect(c.type).toBe('round');
    const p = { x: c.x + c.bisector.x * (14 + 10 * (Math.SQRT2 - 1)), y: c.y + c.bisector.y * (14 + 10 * (Math.SQRT2 - 1)) };
    const h = widgetAt(app.editor, ev(app, p.x, p.y));
    expect(h?.id).toMatch(/^corner:/);
    const d = h.begin(ev(app, p.x, p.y, { alt: true }));
    d.end(ev(app, p.x, p.y, { alt: true }));
    expect(doc.get(id).shape.cornerTypes).toEqual(['inverted', 'inverted', 'inverted', 'inverted']);
    expect(doc.get(id).shape.radii).toEqual([10, 10, 10, 10]);
    expect(cornerTargets(app)[2].type).toBe('inverted');
  });

  it('the Corners dialog sets type, radius and rounding', async () => {
    const { app, doc, id } = await setup();
    let seen = null;
    app.dialogs.form = async (spec) => {
      seen = spec;
      return { type: 'chamfer', r: 20, rounding: 'relative' };
    };
    await cornersDialog(app, cornerTargets(app)[0]);
    expect(seen.fields.map((f) => f.key)).toEqual(['type', 'r', 'rounding']);
    const s = doc.get(id).shape;
    expect(s.cornerTypes).toEqual(['chamfer', 'chamfer', 'chamfer', 'chamfer']);
    expect(s.radii).toEqual([20, 20, 20, 20]);
    expect(s.rounding).toBe('relative');
    expect(doc.get(id).anchors).toHaveLength(8);
    doc.undo();
    expect(doc.get(id).shape.cornerTypes).toBeUndefined();
  });

  it('mirroring keeps each corner type with its corner', async () => {
    const { app, doc, id } = await setup({ radii: [10, 0, 0, 0], cornerTypes: ['chamfer', 'round', 'round', 'round'] });
    doc.transact('Flip', () => transformNodes(doc, [id], scale(1, -1, 200, 160)));
    const s = doc.get(id).shape;
    expect(s.radii).toEqual([0, 0, 0, 10]);
    expect(s.cornerTypes).toEqual(['round', 'round', 'round', 'chamfer']);
    expect(app.editor).toBeTruthy();
  });

  it('exports chamfered rectangles as paths, round ones as rects', async () => {
    const { app, doc, id } = await setup();
    expect(exportSVG(doc, { rect: { x: 0, y: 0, w: 500, h: 400 } })).toMatch(/<rect[^>]*rx="10"/);
    doc.transact('Corners', () => {
      const shape = { ...doc.get(id).shape, cornerTypes: ['chamfer', 'chamfer', 'chamfer', 'chamfer'] };
      doc.update(id, { shape, anchors: shapeAnchors(shape) });
    });
    expect(exportSVG(doc, { rect: { x: 0, y: 0, w: 500, h: 400 } })).not.toMatch(/<rect[^>]*rx=/);
    expect(app).toBeTruthy();
  });
});

describe('relative rounding on path corners', () => {
  it('measures the radius along the segments', () => {
    // A 60 degree corner: absolute rounding trims r / tan(30deg), relative trims r.
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 50 * Math.sqrt(3) },
    ].map((p) => ({ ...p, ix: p.x, iy: p.y, ox: p.x, oy: p.y }));
    const abs = cornerLimits(pts.map((a) => ({ ...a, corner: { r: 10, type: 'round' } })), true);
    const rel = cornerLimits(pts.map((a) => ({ ...a, corner: { r: 10, type: 'round', rounding: 'relative' } })), true);
    expect(abs[0].d).toBeCloseTo(10 / Math.tan(Math.PI / 6));
    expect(rel[0].d).toBeCloseTo(10);
    expect(applyCorners(pts.map((a) => ({ ...a, corner: { r: 10, type: 'round', rounding: 'relative' } })), true)).toHaveLength(6);
  });
});

describe('shape section in the Properties and Transform panels', () => {
  const commit = (input, value) => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.blur();
  };
  const select = (root, label) => [...root.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === label);
  const input = (root, label) => [...root.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === label);

  it('sets one corner type for all corners, or each corner on its own', async () => {
    const { app, doc, id } = await setup();
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    const sel = select(props.el, 'Corner type');
    sel.value = 'chamfer';
    sel.dispatchEvent(new Event('change'));
    expect(doc.get(id).shape.cornerTypes).toEqual(['chamfer', 'chamfer', 'chamfer', 'chamfer']);
    props.el.querySelector('[aria-label="Link corner radius values"]').click();
    props.update();
    const tr = select(props.el, 'Top right corner type');
    tr.value = 'round';
    tr.dispatchEvent(new Event('change'));
    expect(doc.get(id).shape.cornerTypes).toEqual(['chamfer', 'round', 'chamfer', 'chamfer']);
    commit(input(props.el, 'Bottom left corner radius'), '30');
    expect(doc.get(id).shape.radii).toEqual([10, 10, 10, 30]);
    const rel = props.el.querySelector('[role=radio][aria-label="Relative"]');
    rel.click();
    expect(doc.get(id).shape.rounding).toBe('relative');
  });

  it('the Transform panel shows the same rich section', async () => {
    const { app, doc, id } = await setup();
    app.openPanel('transform');
    const tp = app.dock.panels.get('transform');
    tp.ensureBuilt?.();
    tp.update();
    expect(tp.shapeSection.hidden).toBe(false);
    expect(tp.shapeTitle.textContent).toBe('Rectangle Properties');
    const sel = select(tp.el, 'Corner type');
    expect(sel).toBeTruthy();
    sel.value = 'inverted';
    sel.dispatchEvent(new Event('change'));
    expect(doc.get(id).shape.cornerTypes).toEqual(['inverted', 'inverted', 'inverted', 'inverted']);
    commit(input(tp.el, 'Shape angle'), '30');
    expect(doc.get(id).shape.angle).toBeCloseTo(330);
    commit(input(tp.el, 'Shape width'), '150');
    expect(doc.get(id).shape.w).toBe(150);
  });

  it('polygon corner type applies to every anchor corner', async () => {
    const { app, doc } = await setup();
    const shape = { kind: 'polygon', cx: 500, cy: 300, r: 80, sides: 6, angle: 0 };
    const n = createPath(shapeAnchors(shape), true, {}, { shape });
    doc.transact('add', () => doc.insert(n, app.editor.targetLayer().id));
    app.editor.select([n.id]);
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    commit(input(props.el, 'Corner radius'), '8');
    const sel = select(props.el, 'Corner type');
    sel.value = 'chamfer';
    sel.dispatchEvent(new Event('change'));
    expect(doc.get(n.id).anchors.every((a) => a.corner?.type === 'chamfer' && a.corner.r === 8)).toBe(true);
  });
});
