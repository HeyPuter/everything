import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { transformNodes } from '../src/model/geometry.js';
import { applyStyle, commonStyle } from '../src/ops/paint-ops.js';
import { TOOL_LAYOUT } from '../src/ui/toolbar.js';
import { layoutIn, isAttached, dimOptions } from '../src/features/dimension/dimension-model.js';
import { setToolSettings, toolSettings, findAttachment, autoOrient } from '../src/features/dimension/dimension-tool.js';
import { dimensionOptionsDialog } from '../src/features/dimension/dimension-ui.js';
import { dimensionHandleHook } from '../src/features/dimension/dimension-tool.js';

beforeAll(() => installCanvasStub());

const tick = () => new Promise((r) => setTimeout(r, 0));
let app;
let doc;

function ev(x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}
const click = (t, x, y, extra) => {
  t.onPointerDown(ev(x, y, extra));
  t.onPointerUp(ev(x, y, extra));
};
const dims = () => {
  const out = [];
  doc.walk((n) => {
    if (n.type === 'dimension') out.push(n);
    return true;
  });
  return out;
};
function addRect(x, y, w, h) {
  const r = createPath(rectangle(x, y, w, h), true);
  doc.transact('Add', () => doc.insert(r, app.editor.targetLayer().id));
  return r.id;
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument({ width: 800, height: 600 });
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  doc = app.editor.doc;
  app.prefs.set('dimensionTool', null);
  app.prefs.set('dimensionOptions', null);
  app.setTool('dimension');
});

describe('dimension tool', () => {
  it('sits beside the Measure tool', () => {
    const group = TOOL_LAYOUT.flatMap((s) => s.groups).find((g) => g.includes('measure'));
    expect(group.indexOf('dimension')).toBe(group.indexOf('measure') + 1);
    expect(app.toolClasses.get('dimension').label).toBe('Dimension Tool');
  });

  it('places a linear dimension with three clicks, attached to the object it measures', () => {
    const rid = addRect(100, 200, 200, 80);
    const t = app.tool;
    const before = doc.history().steps.length;
    click(t, 101, 201);
    click(t, 299, 199);
    expect(dims()).toHaveLength(1);
    // Moving above the points places a horizontal dimension.
    t.onHover(ev(200, 150));
    click(t, 200, 150);
    const [d] = dims();
    expect(d.orient).toBe('horizontal');
    expect(isAttached(d)).toBe(true);
    expect(d.attach.p1).toEqual({ id: rid, anchor: 0 });
    const lay = layoutIn(doc, d);
    expect(lay.value).toBeCloseTo(200);
    expect(lay.track[0].y).toBeCloseTo(150);
    expect([...app.editor.selection]).toEqual([d.id]);
    // One undo step.
    expect(doc.history().steps.length).toBe(before + 1);
    // Stays measuring the rectangle as it changes.
    doc.transact('Scale', () => transformNodes(doc, [rid], [2, 0, 0, 1, -100, 0]));
    expect(layoutIn(doc, doc.get(d.id)).value).toBeCloseTo(400);
    doc.undo();
    doc.undo();
    expect(dims()).toHaveLength(0);
  });

  it('places the line in the same gesture: press on the last point and drag', () => {
    const t = app.tool;
    click(t, 100, 100);
    t.onPointerDown(ev(250, 180));
    t.onPointerMove(ev(300, 140));
    t.onPointerMove(ev(320, 140));
    t.onPointerUp(ev(320, 140));
    const [d] = dims();
    // Beside the points: vertical.
    expect(d.orient).toBe('vertical');
    expect(layoutIn(doc, d).value).toBeCloseTo(80);
    expect(app.tool.pick).toBe(null);
  });

  it('takes both points from a drag, then a click places the line', () => {
    const t = app.tool;
    t.onPointerDown(ev(100, 100));
    t.onPointerMove(ev(200, 200));
    t.onPointerUp(ev(200, 200));
    expect(dims()).toHaveLength(1);
    t.onHover(ev(140, 160));
    click(t, 140, 160);
    const [d] = dims();
    expect(d.orient).toBe('aligned');
    expect(layoutIn(doc, d).value).toBeCloseTo(Math.hypot(100, 100));
  });

  it('constrains the second point to 45° steps with Shift', () => {
    const t = app.tool;
    click(t, 100, 100);
    click(t, 300, 110, { shift: true });
    t.onHover(ev(200, 50));
    click(t, 200, 50);
    const [d] = dims();
    expect(d.p2.y).toBeCloseTo(100);
  });

  it('honors a fixed orientation setting', () => {
    setToolSettings(app, { orient: 'aligned' });
    const t = app.tool;
    click(t, 100, 100);
    click(t, 300, 200);
    click(t, 200, 50);
    expect(dims()[0].orient).toBe('aligned');
    expect(autoOrient({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 5, y: -5 })).toBe('horizontal');
    expect(autoOrient({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 15, y: 5 })).toBe('vertical');
    expect(autoOrient({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 })).toBe('aligned');
  });

  it('places angular dimensions: corner, two arms, then the arc', () => {
    setToolSettings(app, { kind: 'angular' });
    const t = app.tool;
    click(t, 100, 300);
    click(t, 300, 300);
    click(t, 100, 100);
    t.onHover(ev(160, 240));
    click(t, 160, 240);
    const [d] = dims();
    expect(d.kind).toBe('angular');
    expect(layoutIn(doc, d).text).toBe('90.00°');
  });

  it('measures a circle with one click in radial mode', () => {
    const c = createPath(ellipse(250, 250, 100, 100), true);
    doc.transact('Add', () => doc.insert(c, app.editor.targetLayer().id));
    setToolSettings(app, { kind: 'radial', radial: 'diameter' });
    const t = app.tool;
    click(t, 350, 300);
    t.onHover(ev(420, 300));
    click(t, 420, 300);
    const [d] = dims();
    expect(d.kind).toBe('radial');
    expect(d.orient).toBe('diameter');
    expect(layoutIn(doc, d).value).toBeCloseTo(100, 0);
    expect(layoutIn(doc, d).text.startsWith('Ø')).toBe(true);
    expect(isAttached(d)).toBe(true);
  });

  it('cancels with Escape and removes the last point with Backspace', () => {
    const t = app.tool;
    const before = doc.history().steps.length;
    click(t, 100, 100);
    expect(t.onKeyDown({ key: 'Backspace' })).toBe(true);
    expect(t.pick).toBe(null);
    click(t, 100, 100);
    click(t, 200, 100);
    expect(dims()).toHaveLength(1);
    expect(t.onKeyDown({ key: 'Escape' })).toBe(true);
    expect(dims()).toHaveLength(0);
    expect(doc.history().steps.length).toBe(before);
  });

  it('finds attachments: anchors first, then bounds points', () => {
    const rid = addRect(100, 100, 100, 100);
    expect(findAttachment(doc, { x: 100, y: 100 }, 1)).toEqual({ id: rid, anchor: 0 });
    expect(findAttachment(doc, { x: 150, y: 150 }, 1)).toEqual({ id: rid, box: [0.5, 0.5] });
    expect(findAttachment(doc, { x: 500, y: 500 }, 1)).toBe(null);
  });
});

describe('editing dimensions', () => {
  function make() {
    const t = app.tool;
    click(t, 100, 300);
    click(t, 300, 300);
    click(t, 200, 250);
    return dims()[0];
  }

  it('drags a measured point, the dimension line and the label', () => {
    const d = make();
    const t = app.tool;
    const before = doc.history().steps.length;
    t.onPointerDown(ev(300, 300));
    t.onPointerMove(ev(350, 300));
    t.onPointerMove(ev(400, 300));
    t.onPointerUp(ev(400, 300));
    expect(layoutIn(doc, doc.get(d.id)).value).toBeCloseTo(300);
    expect(layoutIn(doc, doc.get(d.id)).track[0].y).toBeCloseTo(250);
    expect(doc.history().steps.length).toBe(before + 1);
    // The dimension line: drag it further up.
    const lay = layoutIn(doc, doc.get(d.id));
    const onLine = { x: lay.track[0].x + 20, y: 250 };
    t.onPointerDown(ev(onLine.x, onLine.y));
    t.onPointerMove(ev(onLine.x, 220));
    t.onPointerUp(ev(onLine.x, 220));
    expect(layoutIn(doc, doc.get(d.id)).track[0].y).toBeCloseTo(220);
    // The label slides along the line.
    const L = layoutIn(doc, doc.get(d.id)).label;
    t.onPointerDown(ev(L.x, L.y));
    t.onPointerMove(ev(L.x + 40, L.y - 10));
    t.onPointerUp(ev(L.x + 40, L.y - 10));
    expect(doc.get(d.id).labelShift).toBeCloseTo(40);
    expect(layoutIn(doc, doc.get(d.id)).label.x).toBeCloseTo(L.x + 40);
  });

  it('starts a chained dimension when a measured point is clicked rather than dragged', () => {
    const d = make();
    const t = app.tool;
    click(t, 300, 300);
    expect(t.pick?.pts).toHaveLength(1);
    expect(t.pick.pts[0]).toMatchObject({ x: 300, y: 300 });
    click(t, 450, 300);
    click(t, 375, 250);
    expect(dims()).toHaveLength(2);
    expect(layoutIn(doc, doc.get(d.id)).value).toBeCloseTo(200);
    expect(layoutIn(doc, dims()[1]).value).toBeCloseTo(150);
    // The context menu offers the options for selected dimensions only.
    expect(app.commands.isEnabled('dimension.edit')).toBe(true);
    app.editor.clearSelection();
    expect(app.commands.isEnabled('dimension.edit')).toBe(false);
  });

  it('edits with the Direct Selection tool too', () => {
    const d = make();
    app.setTool('direct-selection');
    app.editor.select([d.id]);
    const e = ev(100, 300);
    const handler = dimensionHandleHook.pointerDown(app.tool, e);
    expect(handler).toBeTruthy();
    handler.move(ev(50, 300));
    handler.up();
    expect(layoutIn(doc, doc.get(d.id)).value).toBeCloseTo(250);
    expect(dimensionHandleHook.hover(app.tool, ev(700, 700))).toBe(null);
  });

  it('recolors lines with the stroke and the label with the fill', () => {
    const d = make();
    app.editor.select([d.id]);
    applyStyle(app.editor, { stroke: { type: 'solid', color: '#ff0000' } });
    applyStyle(app.editor, { fill: { type: 'solid', color: '#0000ff' } });
    applyStyle(app.editor, { strokeWidth: 2 });
    const o = dimOptions(doc.get(d.id).dim);
    expect(o.lineColor).toBe('#ff0000');
    expect(o.textColor).toBe('#0000ff');
    expect(o.lineWidth).toBe(2);
    expect(commonStyle(app.editor, 'stroke')).toEqual({ type: 'solid', color: '#ff0000' });
    expect(commonStyle(app.editor, 'strokeWidth')).toBe(2);
  });

  it('edits options in a dialog with a live preview, in one undo step', async () => {
    const d = make();
    const before = doc.history().steps.length;
    const done = dimensionOptionsDialog(app, { nodes: [doc.get(d.id)] });
    await tick();
    const dlg = document.querySelector('dialog[open]');
    expect(dlg.querySelector('.dim-sample')).toBeTruthy();
    const units = dlg.querySelector('select[aria-label="Units"]');
    units.value = 'in';
    units.dispatchEvent(new Event('change', { bubbles: true }));
    // Previewed in the document.
    expect(layoutIn(doc, doc.get(d.id)).text).toContain('in');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(dimOptions(doc.get(d.id).dim).units).toBe('in');
    expect(layoutIn(doc, doc.get(d.id)).text).toBe('2.78 in');
    expect(doc.history().steps.length).toBe(before + 1);
    // New dimensions use the options last chosen.
    expect(app.prefs.get('dimensionOptions').units).toBe('in');
  });

  it('cancelling the dialog leaves the dimension unchanged', async () => {
    const d = make();
    const done = dimensionOptionsDialog(app, { nodes: [doc.get(d.id)] });
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const ends = dlg.querySelector('select[aria-label="Ends"]');
    ends.value = 'tick';
    ends.dispatchEvent(new Event('change', { bubbles: true }));
    expect(dimOptions(doc.get(d.id).dim).ends).toBe('tick');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await done;
    expect(dimOptions(doc.get(d.id).dim).ends).toBe('arrow');
  });

  it('sets tool options from the tool dialog', async () => {
    const done = dimensionOptionsDialog(app, { tool: true });
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const kind = dlg.querySelector('select[aria-label="Type"]');
    kind.value = 'angular';
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(toolSettings(app).kind).toBe('angular');
  });

  it('shows a Properties section with the value, and expands, detaches and flips from commands', async () => {
    const rid = addRect(100, 400, 100, 50);
    const t = app.tool;
    click(t, 100, 400);
    click(t, 200, 400);
    click(t, 150, 380);
    const d = dims()[0];
    expect(isAttached(d)).toBe(true);
    app.openPanel?.('properties');
    const panel = app.dock.panels.get('properties');
    panel.update();
    const sec = [...panel.el.querySelectorAll('.panel-section')].find((s) => s.querySelector('.section-title')?.textContent === 'Dimension');
    expect(sec.hidden).toBe(false);
    expect(sec.querySelector('.dim-value').textContent).toBe('100.00 pt');
    sec.querySelector('select[aria-label="Precision"]').value = '0';
    sec.querySelector('select[aria-label="Precision"]').dispatchEvent(new Event('change'));
    expect(layoutIn(doc, doc.get(d.id)).text).toBe('100 pt');
    app.commands.run('dimension.flipLabel');
    expect(dimOptions(doc.get(d.id).dim).labelPosition).toBe('below');
    app.commands.run('dimension.detach');
    expect(isAttached(doc.get(d.id))).toBe(false);
    doc.transact('move', () => transformNodes(doc, [rid], [1, 0, 0, 1, 50, 0]));
    expect(layoutIn(doc, doc.get(d.id)).effective.p1.x).toBeCloseTo(100);
    app.commands.run('object.expand');
    expect(dims()).toHaveLength(0);
    const g = doc.get([...app.editor.selection][0]);
    expect(g.type).toBe('group');
    expect(g.children.map((c) => doc.get(c).type)).toContain('text');
  });

  it('shows the tool settings while the tool is active', () => {
    app.editor.clearSelection();
    const panel = app.dock.panels.get('properties');
    panel.update();
    const sec = [...panel.el.querySelectorAll('.panel-section')].find((s) => s.querySelector('.section-title')?.textContent === 'Dimension Tool');
    expect(sec.hidden).toBe(false);
    [...sec.querySelectorAll('.seg-btn')].find((b) => b.getAttribute('aria-label') === 'Radial').click();
    expect(toolSettings(app).kind).toBe('radial');
    app.setTool('selection');
    panel.update();
    expect(sec.hidden).toBe(true);
  });

  it('opens Dimension Options on double-click with the Selection tool', async () => {
    const d = make();
    app.setTool('selection');
    const lay = layoutIn(doc, doc.get(d.id));
    const p = lay.track[0];
    app.tool.onDoubleClick(ev(p.x + 30, p.y));
    await tick();
    const dlg = document.querySelector('dialog[open]');
    expect(dlg?.querySelector('.dialog-title').textContent).toBe('Dimension Options');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  });
});
