import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup, createCompound } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { selectAll } from '../src/ops/select-ops.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

let app;
beforeEach(() => {
  app = bootApp();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  app.editor.setViewOption('snapToPoint', false);
  app.editor.setViewOption('alignmentGuides', false);
});

function addRect(x, y, w, h, parent) {
  const doc = app.editor.doc;
  const node = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#cc3333' }, stroke: null });
  doc.transact('Add', () => doc.insert(node, parent || app.editor.targetLayer().id));
  return node.id;
}

function click(x, y) {
  app.tool.onPointerDown(ev(app, x, y));
  app.tool.onPointerUp(ev(app, x, y));
}

describe('isolation mode for single objects', () => {
  it('double-clicking a path isolates it; only it is selectable; Esc-like exit restores selection', () => {
    const a = addRect(100, 100, 50, 50);
    const b = addRect(300, 100, 50, 50);
    app.setTool('selection');
    app.tool.onDoubleClick(ev(app, 120, 120));
    const ed = app.editor;
    expect(ed.isolation).toBe(a);
    app.refreshChrome();
    expect(app.isolationBar.hidden).toBe(false);
    expect(app.isolationBar.textContent).toContain('<Path>');
    click(320, 120);
    expect(ed.selection.size).toBe(0);
    click(120, 120);
    expect([...ed.selection]).toEqual([a]);
    selectAll(ed);
    expect([...ed.selection]).toEqual([a]);
    // Double-click on empty canvas leaves isolation and selects the object.
    app.tool.onDoubleClick(ev(app, 700, 700));
    expect(ed.isolation).toBeNull();
    expect([...ed.selection]).toEqual([a]);
    app.refreshChrome();
    expect(app.isolationBar.hidden).toBe(true);
    click(320, 120);
    expect([...ed.selection]).toEqual([b]);
  });

  it('isolates a compound path as one object', () => {
    const doc = app.editor.doc;
    const p1 = createPath(rectangle(100, 100, 100, 100), true, {});
    const p2 = createPath(rectangle(120, 120, 20, 20), true, {});
    const c = createCompound([p1.id, p2.id], { fill: { type: 'solid', color: '#000000' }, stroke: null }, { fillRule: 'evenodd' });
    p1.parent = c.id;
    p2.parent = c.id;
    doc.transact('Add', () => doc.insert(c, app.editor.targetLayer().id, Infinity, [p1, p2]));
    app.setTool('selection');
    app.tool.onDoubleClick(ev(app, 105, 105));
    expect(app.editor.isolation).toBe(c.id);
    click(105, 105);
    expect([...app.editor.selection]).toEqual([c.id]);
  });

  it('a path inside an isolated group can be isolated in turn', () => {
    const doc = app.editor.doc;
    const g = createGroup([]);
    doc.transact('Group', () => doc.insert(g, app.editor.targetLayer().id));
    const inner = addRect(100, 100, 50, 50, g.id);
    addRect(200, 100, 50, 50, g.id);
    app.setTool('selection');
    app.tool.onDoubleClick(ev(app, 120, 120));
    expect(app.editor.isolation).toBe(g.id);
    app.tool.onDoubleClick(ev(app, 120, 120));
    expect(app.editor.isolation).toBe(inner);
    click(220, 120);
    expect(app.editor.selection.size).toBe(0);
    expect(app.editor.selectionTarget(inner).id).toBe(inner);
  });

  it('drawing while a path is isolated groups the new artwork with it; undo goes back to the path', () => {
    const a = addRect(100, 100, 50, 50);
    const ed = app.editor;
    const layer = ed.targetLayer().id;
    app.commands.run('object.isolate', { id: a });
    expect(ed.isolation).toBe(a);
    // Outside a transaction the target is the object's parent.
    expect(ed.targetLayer().id).toBe(layer);
    app.setTool('rectangle');
    app.tool.onPointerDown(ev(app, 300, 300));
    app.tool.onPointerMove(ev(app, 330, 330));
    app.tool.onPointerMove(ev(app, 360, 360));
    app.tool.onPointerUp(ev(app, 360, 360));
    const g = ed.doc.get(ed.isolation);
    expect(g.type).toBe('group');
    expect(g.children).toHaveLength(2);
    expect(g.children[0]).toBe(a);
    expect(ed.doc.get(layer).children).toEqual([g.id]);
    ed.doc.undo();
    expect(ed.isolation).toBe(a);
    expect(ed.doc.get(a).parent).toBe(layer);
  });

  it('deleting the isolated object ends isolation', () => {
    const a = addRect(100, 100, 50, 50);
    const ed = app.editor;
    app.commands.run('object.isolate', { id: a });
    ed.doc.transact('Delete', () => ed.doc.remove(a));
    expect(ed.isolation).toBeNull();
  });

  it('Isolate command works on a single selected object', () => {
    const a = addRect(100, 100, 50, 50);
    const ed = app.editor;
    ed.select([a]);
    expect(app.commands.isEnabled('object.isolate')).toBe(true);
    expect(app.commands.label('object.isolate')).toBe('Isolate Selected Object');
    app.commands.run('object.isolate');
    expect(ed.isolation).toBe(a);
    app.commands.run('object.exitIsolation');
    expect(ed.isolation).toBeNull();
  });

  it('the Layers panel lists only the isolated object', () => {
    addRect(300, 100, 50, 50);
    const a = addRect(100, 100, 50, 50);
    app.openPanel('layers');
    const panel = app.dock.panels.get('layers');
    app.commands.run('object.isolate', { id: a });
    panel.update();
    expect(panel.rows.map((r) => r.id)).toEqual([a]);
    expect(panel.isoBar.hidden).toBe(false);
    expect(panel.isoBar.textContent).toContain('Isolation Mode');
    app.commands.run('object.exitIsolation');
    panel.update();
    expect(panel.isoBar.hidden).toBe(true);
    expect(panel.rows[0].node.type).toBe('layer');
  });
});
