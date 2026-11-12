import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const stops = [
  { offset: 0, color: '#ffffff', opacity: 1 },
  { offset: 1, color: '#000000', opacity: 1 },
];
// A gradient dragged across the left half of a 100 x 100 square at (0, 0).
const dragged = { type: 'linear', angle: 0, stops, x1: 0, y1: 50, x2: 50, y2: 50 };
const blue = { type: 'solid', color: '#0000ff' };

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return {
    x,
    y,
    sx: s.x,
    sy: s.y,
    shift: false,
    alt: false,
    mod: false,
    button: 0,
    pointerType: 'mouse',
    pressure: 0.5,
    native: {},
    ...extra,
  };
}

describe('Gradients with end points moved to other objects', () => {
  let app;
  let add;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    add = (node) => {
      const doc = app.editor.doc;
      doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
      return node.id;
    };
  });

  it('the Eyedropper places the gradient on the target where it sat on the source', () => {
    const src = add(createPath(rectangle(0, 0, 100, 100), true, { fill: dragged }));
    const dst = add(createPath(rectangle(400, 300, 200, 100), true, { fill: blue }));
    app.editor.select([dst]);
    app.setTool('eyedropper');
    app.tool.onPointerDown(ev(app, 50, 50));
    const fill = app.editor.doc.get(dst).fill;
    expect(fill.stops).toEqual(stops);
    expect([fill.x1, fill.y1, fill.x2, fill.y2]).toEqual([400, 350, 500, 350]);
    // The source keeps its own.
    expect(app.editor.doc.get(src).fill).toEqual(dragged);
  });

  it('a target with no height gets the gradient fitted at its angle', () => {
    add(createPath(rectangle(0, 0, 100, 100), true, { fill: dragged }));
    const line = createPath(
      [
        { x: 400, y: 300 },
        { x: 600, y: 300 },
      ].map((p) => ({ ...p, ix: p.x, iy: p.y, ox: p.x, oy: p.y })),
      false,
      { fill: blue },
    );
    const dst = add(line);
    app.editor.select([dst]);
    app.setTool('eyedropper');
    app.tool.onPointerDown(ev(app, 50, 50));
    const fill = app.editor.doc.get(dst).fill;
    expect(fill.x1).toBe(400);
    expect(fill.x2).toBe(500);
    // A vertical gradient would collapse to a point there: it fits instead.
    add(
      createPath(rectangle(0, 200, 100, 100), true, {
        fill: { ...dragged, angle: -90, x1: 50, y1: 200, x2: 50, y2: 250 },
      }),
    );
    app.editor.select([dst]);
    app.tool.onPointerDown(ev(app, 50, 250));
    expect(app.editor.doc.get(dst).fill).toEqual({ type: 'linear', angle: -90, stops });
  });

  it('new objects get the picked gradient fitted to their own bounds', () => {
    add(createPath(rectangle(0, 0, 100, 100), true, { fill: dragged }));
    app.editor.select([]);
    app.setTool('eyedropper');
    app.tool.onPointerDown(ev(app, 50, 50));
    expect(app.editor.style.fill).toEqual({ type: 'linear', angle: 0, stops });
  });

  it('a gradient given end points on one object does not carry them to new objects', async () => {
    const { applyStyle } = await import('../src/ops/paint-ops.js');
    const { newPathStyle } = await import('../src/tools/pen.js');
    const id = add(createPath(rectangle(0, 0, 100, 100), true, { fill: blue }));
    app.editor.select([id]);
    applyStyle(app.editor, { fill: dragged }, 'Gradient');
    expect(app.editor.doc.get(id).fill).toEqual(dragged);
    expect(newPathStyle(app.editor).fill).toEqual({ type: 'linear', angle: 0, stops });
  });
});

describe('Gradient swatches made from a dragged gradient', () => {
  it('fit each object they are applied to', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const { createSwatchFromFocused } = await import('../src/features/paint/swatches-panel.js');
    const { addSwatch, findSwatch, paintFromSwatch } =
      await import('../src/features/paint/swatch-model.js');
    const { applyStyle } = await import('../src/ops/paint-ops.js');
    const ed = app.editor;
    const doc = ed.doc;
    const add = (node) => (
      doc.transact('Add', () => doc.insert(node, ed.targetLayer().id)),
      node.id
    );
    const src = add(createPath(rectangle(0, 0, 100, 100), true, { fill: dragged }));
    const dst = add(createPath(rectangle(400, 300, 200, 100), true, { fill: blue }));
    ed.select([src]);
    ed.focusPaint = 'fill';
    const id = await createSwatchFromFocused(app, { direct: true });
    expect(findSwatch(doc, id).paint).toEqual({ type: 'linear', angle: 0, stops });
    ed.select([dst]);
    applyStyle(ed, { fill: paintFromSwatch(findSwatch(doc, id)) }, 'Apply Swatch');
    expect(doc.get(dst).fill).toEqual({ type: 'linear', angle: 0, stops });
    // Swatches saved with end points by earlier versions apply the same way.
    let old;
    doc.transact('Add Swatch', () => (old = addSwatch(doc, { name: 'Old', paint: dragged })));
    expect(paintFromSwatch(findSwatch(doc, old))).toEqual({ type: 'linear', angle: 0, stops });
    // The source keeps its own placement.
    expect(doc.get(src).fill).toEqual(dragged);
  });
});

describe('Graphic styles made from a dragged gradient', () => {
  it('fit each object they are applied to and stay linked to their source', async () => {
    const { paintSetup } = await import('./panels-paint-helpers.js');
    const { graphicStylesOf, linkedStyle, setGraphicStyles } =
      await import('../src/features/paint/graphic-styles.js');
    const { app, ed, doc, add, panel } = await paintSetup();
    const src = add({ fill: dragged }, [0, 0, 100, 100]);
    const dst = add({ fill: blue }, [400, 300, 200, 100]);
    const gp = panel('graphicStyles');
    app.dialogs.form = async () => ({ name: 'Dragged' });
    ed.select([src]);
    await gp.newStyle();
    const gs = graphicStylesOf(doc).find((g) => g.name === 'Dragged');
    expect(gs.style.fill).toEqual({ type: 'linear', angle: 0, stops });
    expect(linkedStyle(doc, doc.get(src))?.id).toBe(gs.id);
    ed.select([dst]);
    gp.onClick(gs, {});
    expect(doc.get(dst).fill).toEqual({ type: 'linear', angle: 0, stops });
    expect(linkedStyle(doc, doc.get(dst))?.id).toBe(gs.id);
    // Styles saved with end points by earlier versions apply the same way, also when added (Alt).
    const old = { id: 'gs-old', name: 'Old', style: { fill: dragged } };
    doc.transact('Add Style', () => setGraphicStyles(doc, [...graphicStylesOf(doc), old]));
    gp.onClick(old, {});
    expect(doc.get(dst).fill).toEqual({ type: 'linear', angle: 0, stops });
    ed.select([dst]);
    gp.apply(old, true);
    expect(doc.get(dst).fill).toEqual({ type: 'linear', angle: 0, stops });
    expect(doc.get(src).fill).toEqual(dragged);
  });
});
