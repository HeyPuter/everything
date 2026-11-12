// Stylus work: reordering layers by dragging with any pointer, the Knife's fidelity, and pen pressure in the Paintbrush and Merge Brush.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { toolSettings } from '../src/features/tool-props/index.js';
import { pressureScale, pressureWidthProfile, roundBrushOutline } from '../src/features/brushes/pressure.js';
import { anchor } from '../src/model/bezier.js';

const solid = (color) => ({ type: 'solid', color });

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

function newDoc() {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  return ed;
}

function ev(x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

describe('Layers panel pointer drag', () => {
  const ROW = 28;
  /** Three objects a (back), b, c (front) in an expanded layer: rows are layer, c, b, a. */
  function setup() {
    const ed = newDoc();
    const doc = ed.doc;
    const layer = doc.layers()[0];
    const ids = {};
    doc.transact('Build', () => {
      for (const k of ['a', 'b', 'c']) {
        const p = createPath(rectangle(0, 0, 10, 10), true);
        doc.insert(p, layer.id);
        ids[k] = p.id;
      }
    });
    app.openPanel('layers');
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    panel.cancelDrag();
    panel.expanded.add(layer.id);
    ed.select([]);
    panel.update();
    const row = (id) => document.getElementById(`lrow-${id}`);
    const rowY = (id, f = 0.5) => (panel.rows.findIndex((r) => r.id === id) + f) * ROW;
    const kids = () => doc.get(layer.id).children;
    return { ed, doc, layer, ids, panel, row, rowY, kids };
  }
  const fire = (target, type, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 20, clientY: y, ...extra }));

  it('rows no longer rely on the browser drag and drop', () => {
    const { ids, row } = setup();
    expect(row(ids.a).getAttribute('draggable')).toBeNull();
  });

  it('a mouse drag moves a row above another and shows where it lands', () => {
    const { ids, row, rowY, kids, doc } = setup();
    expect(kids()).toEqual([ids.a, ids.b, ids.c]);
    fire(row(ids.a), 'pointerdown', rowY(ids.a));
    fire(window, 'pointermove', rowY(ids.c, 0.1));
    expect(row(ids.c).dataset.drop).toBe('above');
    expect(row(ids.a).classList.contains('dragging')).toBe(true);
    fire(window, 'pointerup', rowY(ids.c, 0.1));
    expect(kids()).toEqual([ids.b, ids.c, ids.a]);
    expect(doc.undoStack.at(-1).label).toBe('Reorder');
    expect(document.querySelector('.layer-row[data-drop]')).toBeNull();
    expect(document.querySelector('.layer-row.dragging')).toBeNull();
  });

  it('a press that does not move is still a click, and a small wobble drags nothing', () => {
    const { ids, row, rowY, kids, panel } = setup();
    fire(row(ids.b), 'pointerdown', rowY(ids.b));
    fire(window, 'pointermove', rowY(ids.b) + 2);
    expect(panel.dragState).toBeNull();
    fire(window, 'pointerup', rowY(ids.b) + 2);
    expect(kids()).toEqual([ids.a, ids.b, ids.c]);
    expect(panel.drag).toBeNull();
  });

  it('dragging a selected row moves the whole selection', () => {
    const { ed, ids, row, rowY, kids } = setup();
    ed.select([ids.b, ids.c]);
    fire(row(ids.c), 'pointerdown', rowY(ids.c));
    fire(window, 'pointermove', rowY(ids.a, 0.9));
    expect(row(ids.b).classList.contains('dragging')).toBe(true);
    fire(window, 'pointerup', rowY(ids.a, 0.9));
    expect(kids()).toEqual([ids.b, ids.c, ids.a]);
  });

  it('releasing below the last row drops below it', () => {
    const { ids, row, rowY, kids } = setup();
    fire(row(ids.c), 'pointerdown', rowY(ids.c));
    fire(window, 'pointermove', rowY(ids.a) + 500);
    expect(row(ids.a).dataset.drop).toBe('below');
    fire(window, 'pointerup', rowY(ids.a) + 500);
    expect(kids()).toEqual([ids.c, ids.a, ids.b]);
  });

  it('Escape and a cancelled pointer drop nothing', () => {
    const { ids, row, rowY, kids, panel } = setup();
    fire(row(ids.a), 'pointerdown', rowY(ids.a));
    fire(window, 'pointermove', rowY(ids.c, 0.1));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(panel.drag).toBeNull();
    fire(window, 'pointerup', rowY(ids.c, 0.1));
    expect(kids()).toEqual([ids.a, ids.b, ids.c]);
    fire(row(ids.a), 'pointerdown', rowY(ids.a));
    fire(window, 'pointermove', rowY(ids.c, 0.1));
    fire(window, 'pointercancel', rowY(ids.c, 0.1));
    expect(kids()).toEqual([ids.a, ids.b, ids.c]);
    expect(document.querySelector('.layer-row[data-drop]')).toBeNull();
  });

  it('a finger picks a row up by holding it; moving first scrolls instead', () => {
    vi.useFakeTimers();
    try {
      const { ids, row, rowY, kids, panel } = setup();
      const touch = { pointerType: 'touch', pointerId: 7 };
      // A swipe: movement before the hold is up never becomes a drag.
      fire(row(ids.a), 'pointerdown', rowY(ids.a), touch);
      fire(window, 'pointermove', rowY(ids.a) - 30, touch);
      expect(panel.drag).toBeNull();
      vi.advanceTimersByTime(1000);
      fire(window, 'pointerup', rowY(ids.c, 0.1), touch);
      expect(kids()).toEqual([ids.a, ids.b, ids.c]);
      // Press and hold, then drag.
      fire(row(ids.a), 'pointerdown', rowY(ids.a), touch);
      expect(panel.dragState).toBeNull();
      vi.advanceTimersByTime(400);
      expect(panel.dragState.ids).toEqual([ids.a]);
      const move = new Event('touchmove', { bubbles: true, cancelable: true });
      row(ids.a).dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      fire(window, 'pointermove', rowY(ids.c, 0.1), touch);
      fire(window, 'pointerup', rowY(ids.c, 0.1), touch);
      expect(kids()).toEqual([ids.b, ids.c, ids.a]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hovering pen drags at once, and stops the list panning under it only while it hovers', () => {
    const { ids, row, rowY, kids, panel } = setup();
    const pen = { pointerType: 'pen', pointerId: 3 };
    fire(panel.viewport, 'pointermove', rowY(ids.a), { ...pen, buttons: 0 });
    expect(panel.viewport.classList.contains('pen-direct')).toBe(true);
    fire(row(ids.a), 'pointerdown', rowY(ids.a), pen);
    fire(window, 'pointermove', rowY(ids.c, 0.1), { ...pen, buttons: 1 });
    fire(window, 'pointerup', rowY(ids.c, 0.1), pen);
    expect(kids()).toEqual([ids.b, ids.c, ids.a]);
    fire(panel.viewport, 'pointermove', 10, { pointerType: 'touch', pointerId: 9 });
    expect(panel.viewport.classList.contains('pen-direct')).toBe(false);
  });
});

describe('Knife fidelity', () => {
  const wiggle = () => {
    const pts = [];
    for (let x = 0; x <= 200; x += 4) pts.push({ x, y: 50 + (((x / 4) % 2) ? 3 : -3) });
    return pts;
  };

  it('follows the drag closely when accurate and smooths it when not', () => {
    newDoc();
    app.setTool('knife');
    const tool = app.tool;
    expect(tool.fidelity).toBe(10);
    tool.fidelity = 0;
    const accurate = tool.cutAnchors(wiggle()).length;
    tool.fidelity = 100;
    const smooth = tool.cutAnchors(wiggle()).length;
    expect(accurate).toBeGreaterThan(smooth * 2);
    expect(tool.cutAnchors([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toHaveLength(2);
    tool.fidelity = 250;
    expect(tool.fidelity).toBe(100);
    app.prefs.set('knifeFidelity', undefined);
    app.setTool('selection');
  });

  it('is a setting in the Properties panel and still cuts', async () => {
    const ed = newDoc();
    const doc = ed.doc;
    const sq = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000'), stroke: null });
    doc.transact('Add', () => doc.insert(sq, ed.targetLayer().id));
    ed.select([]);
    app.setTool('knife');
    const s = toolSettings(app);
    expect(s.fields.map((f) => f.key)).toEqual(['fidelity']);
    s.set('fidelity', 40);
    expect(app.tool.fidelity).toBe(40);
    app.tool.onPointerDown(ev(50, -10));
    for (let y = 0; y <= 110; y += 10) app.tool.onPointerMove(ev(50 + (y % 20 ? 2 : -2), y));
    await app.tool.onPointerUp(ev(50, 110));
    expect(doc.leaves()).toHaveLength(2);
    app.prefs.set('knifeFidelity', undefined);
    app.setTool('selection');
  });
});

describe('pen pressure', () => {
  it('maps pressure to size around the set size', () => {
    expect(pressureScale(0.5)).toBe(1);
    expect(pressureScale(0)).toBe(0.1);
    expect(pressureScale(1)).toBe(2);
    expect(pressureWidthProfile([[0, 0.5], [1, 0.5]])).toBeNull();
    expect(pressureWidthProfile([[0, 0.25], [1, 0.75]])).toEqual([{ t: 0, l: 0.5, r: 0.5 }, { t: 1, l: 1.5, r: 1.5 }]);
  });

  it('sweeps a round brush whose width follows the pressure', () => {
    const [ring] = roundBrushOutline([anchor(0, 0), anchor(100, 0)], (u) => 2 + 18 * u, 20);
    const ys = (x0, x1) => ring.anchors.filter((a) => a.x >= x0 && a.x <= x1).map((a) => Math.abs(a.y));
    expect(Math.max(...ys(-5, 15))).toBeLessThan(3);
    expect(Math.max(...ys(85, 115))).toBeGreaterThan(8);
  });

  function penStroke(tool, pressureAt, n = 20) {
    const pen = (i) => ({ pointerType: 'pen', pressure: pressureAt(i / n) });
    tool.onPointerDown(ev(100, 100, pen(0)));
    for (let i = 1; i <= n; i++) tool.onPointerMove(ev(100 + i * 10, 100, pen(i)));
    return tool.onPointerUp(ev(100 + n * 10, 100, { pointerType: 'pen' }));
  }

  it('the Paintbrush turns pen pressure into the width of a plain stroke', () => {
    const ed = newDoc();
    app.brushState.currentId = null;
    app.setTool('paintbrush');
    const tool = app.tool;
    expect(tool.opts.pressure).toBe(true);
    penStroke(tool, (u) => 0.1 + 0.8 * u);
    let [n] = ed.doc.leaves();
    expect(n.brush).toBeUndefined();
    expect(n.widthProfile.length).toBeGreaterThan(5);
    expect(n.widthProfile[0].l).toBeLessThan(0.5);
    expect(n.widthProfile.at(-1).l).toBeGreaterThan(1.5);
    expect(n.widthProfile.every((p) => p.l === p.r)).toBe(true);
    // A mouse, an even pressure, or the option switched off leave the stroke uniform.
    ed.doc.transact('Clear', () => ed.doc.remove(n.id));
    tool.onPointerDown(ev(100, 100));
    for (let i = 1; i <= 10; i++) tool.onPointerMove(ev(100 + i * 10, 100));
    tool.onPointerUp(ev(200, 100));
    [n] = ed.doc.leaves();
    expect(n.widthProfile).toBeUndefined();
    ed.doc.transact('Clear', () => ed.doc.remove(n.id));
    penStroke(tool, () => 0.5);
    [n] = ed.doc.leaves();
    expect(n.widthProfile).toBeUndefined();
    ed.doc.transact('Clear', () => ed.doc.remove(n.id));
    toolSettings(app).set('pressure', false);
    penStroke(tool, (u) => 0.1 + 0.8 * u);
    [n] = ed.doc.leaves();
    expect(n.widthProfile).toBeUndefined();
    toolSettings(app).set('pressure', true);
    app.setTool('selection');
  });

  it('a brush that reads pressure itself keeps doing so', () => {
    const ed = newDoc();
    app.brushState.currentId = 'lib.cal.pressure-pen';
    app.setTool('paintbrush');
    penStroke(app.tool, (u) => 0.1 + 0.8 * u);
    const [n] = ed.doc.leaves();
    expect(n.brushPressure.length).toBeGreaterThan(5);
    expect(n.widthProfile).toBeUndefined();
    app.brushState.currentId = null;
    app.setTool('selection');
  });

  it('the Merge Brush paints thin where the pen is light and wide where it presses', async () => {
    const ed = newDoc();
    app.setTool('blob-brush');
    const tool = app.tool;
    tool.size = 20;
    expect(tool.pressureSize).toBe(true);
    await penStroke(tool, (u) => 0.05 + 0.9 * u);
    let [n] = ed.doc.leaves();
    const heightAt = (node, x0, x1) => {
      const ys = (node.anchors || []).filter((a) => a.x >= x0 && a.x <= x1).map((a) => a.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    const b = nodeBounds(ed.doc, n);
    // Up to twice the size at full pressure, far thinner at the light end.
    expect(b.h).toBeGreaterThan(30);
    expect(b.h).toBeLessThanOrEqual(40.5);
    expect(heightAt(n, 90, 130)).toBeLessThan(12);
    ed.doc.transact('Clear', () => ed.doc.remove(n.id));
    // With the option off (or a mouse) the stroke is the set size throughout.
    toolSettings(app).set('pressure', false);
    expect(tool.pressureSize).toBe(false);
    await penStroke(tool, (u) => 0.05 + 0.9 * u);
    [n] = ed.doc.leaves();
    expect(nodeBounds(ed.doc, n).h).toBeCloseTo(20, 0);
    toolSettings(app).set('pressure', true);
    app.setTool('selection');
  });

  it('a pressure stroke that crosses itself is one clean shape and still merges', async () => {
    const ed = newDoc();
    app.setTool('blob-brush');
    const tool = app.tool;
    tool.size = 10;
    const pen = (i) => ({ pointerType: 'pen', pressure: 0.3 + 0.4 * Math.abs(Math.sin(i / 5)) });
    // A loop: right, up, left, down through the start.
    const path = [];
    for (let i = 0; i <= 10; i++) path.push([100 + i * 10, 100]);
    for (let i = 1; i <= 10; i++) path.push([200, 100 - i * 10]);
    for (let i = 1; i <= 5; i++) path.push([200 - i * 10, 0]);
    for (let i = 1; i <= 15; i++) path.push([150, i * 10]);
    tool.onPointerDown(ev(...path[0], pen(0)));
    path.slice(1).forEach((p, i) => tool.onPointerMove(ev(...p, pen(i + 1))));
    await tool.onPointerUp(ev(...path.at(-1), { pointerType: 'pen' }));
    expect(ed.doc.leaves()).toHaveLength(1);
    const first = ed.doc.leaves()[0];
    // The loop encloses a hole: a compound (outline and hole), not a pile of overlapping rings.
    expect(first.type).toBe('compound');
    // A second stroke across it merges into the same object.
    tool.onPointerDown(ev(90, 50, pen(0)));
    for (let i = 1; i <= 13; i++) tool.onPointerMove(ev(90 + i * 10, 50, pen(i)));
    await tool.onPointerUp(ev(220, 50, { pointerType: 'pen' }));
    expect(ed.doc.get(ed.targetLayer().id).children).toHaveLength(1);
    app.setTool('selection');
  });
});
