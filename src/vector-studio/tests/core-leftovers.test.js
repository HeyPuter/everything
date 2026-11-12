// Editing core leftovers from the first review wave.
import { describe, it, expect } from 'vitest';
import { bootApp, bootAppWithFeatures } from './helpers.js';
import { createPath, createCompound, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function setup(app = bootApp()) {
  const ed = app.newDocument();
  return { app, ed, doc: ed.doc, layer: ed.doc.layers()[0] };
}

describe('Reverse Path Direction', () => {
  it('reverses a subpath once when both it and its compound path are selected', async () => {
    const { app, ed, doc, layer } = setup();
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(20, 0, 10, 10), true);
    const c = createCompound([a.id, b.id], { fill: { type: 'solid', color: '#000000' } });
    doc.transact('t', () => doc.insert(c, layer.id, Infinity, [a, b]));
    const first = (id) => doc.get(id).anchors.map((p) => [p.x, p.y]);
    const [a0, b0] = [first(a.id), first(b.id)];
    ed.select([c.id, a.id]);
    await app.commands.run('path.reverse');
    expect(first(a.id)).not.toEqual(a0);
    expect(first(a.id)).toEqual(first(b.id).map(([x, y]) => [x - 20, y]));
    expect(first(b.id)).not.toEqual(b0);
  });
});

describe('Template layers', () => {
  it('turning Template off brings back the lock and print settings from before', async () => {
    const { app, ed, doc, layer } = setup(await bootAppWithFeatures());
    const run = (id) => app.commands.run(id);
    ed.activeLayerId = layer.id;
    // Locked before it became a template: stays locked after.
    doc.transact('t', () => doc.update(layer.id, { locked: true }));
    await run('layers.template');
    expect(doc.get(layer.id)).toMatchObject({ template: true, locked: true, print: false });
    await run('layers.template');
    expect(doc.get(layer.id)).toMatchObject({ template: false, locked: true, print: true });
    expect(doc.get(layer.id).templatePrev).toBeUndefined();
    // Unlocked and nonprinting before: unlocked and nonprinting after.
    doc.transact('t', () => doc.update(layer.id, { locked: false, print: false }));
    await run('layers.template');
    expect(doc.get(layer.id)).toMatchObject({ template: true, locked: true });
    await run('layers.template');
    expect(doc.get(layer.id)).toMatchObject({ template: false, locked: false, print: false });
    // Undo goes back to the template, Redo off it again.
    doc.undo();
    expect(doc.get(layer.id)).toMatchObject({ template: true, locked: true });
    doc.redo();
    expect(doc.get(layer.id)).toMatchObject({ template: false, locked: false });
  });

  it('a layer made a template in Layer Options comes back unlocked from the Template command', async () => {
    const { app, ed, doc, layer } = setup(await bootAppWithFeatures());
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    const cur = doc.get(layer.id);
    app.dialogs.form = async (spec) => ({
      ...Object.fromEntries(spec.fields.map((f) => [f.key, f.value])),
      template: true,
    });
    await panel.layerOptions(cur);
    expect(doc.get(layer.id)).toMatchObject({ template: true, locked: true, print: false });
    ed.activeLayerId = layer.id;
    await app.commands.run('layers.template');
    expect(doc.get(layer.id)).toMatchObject({ template: false, locked: false, print: true });
  });
});

describe('Layers panel rename', () => {
  it('keeps the old name of a layer renamed to nothing', () => {
    const { app, doc, layer } = setup();
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    app.openPanel('layers');
    panel.update();
    const rename = (value) => {
      const row = document.getElementById(`lrow-${layer.id}`);
      row.querySelector('.lr-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.lr-rename');
      input.value = value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    rename('   ');
    expect(doc.get(layer.id).name).toBe('Layer 1');
    rename('Sketch');
    expect(doc.get(layer.id).name).toBe('Sketch');
  });
});

describe('Group Selection in isolation mode', () => {
  function nested() {
    const { app, ed, doc, layer } = setup();
    const a = createPath(rectangle(0, 0, 10, 10), true, {
      fill: { type: 'solid', color: '#000000' },
    });
    const b = createPath(rectangle(20, 0, 10, 10), true, {
      fill: { type: 'solid', color: '#000000' },
    });
    const out = createPath(rectangle(100, 0, 10, 10), true, {
      fill: { type: 'solid', color: '#000000' },
    });
    const inner = createGroup([]);
    const outer = createGroup([]);
    doc.transact('t', () => {
      doc.insert(outer, layer.id);
      doc.insert(inner, outer.id);
      doc.insert(a, inner.id);
      doc.insert(b, inner.id);
      doc.insert(out, outer.id);
    });
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('group-selection');
    const click = (x, y) => {
      const s = ed.view.toScreen(x, y);
      const e = { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0 };
      app.tool.onPointerDown(e);
      app.tool.onPointerUp(e);
    };
    return { app, ed, doc, a, b, out, inner, outer, click };
  }

  it('climbs no higher than the isolated group', () => {
    const { ed, a, inner, outer, click } = nested();
    ed.isolation = inner.id;
    click(5, 5);
    expect([...ed.selection]).toEqual([a.id]);
    click(5, 5);
    expect(ed.selection.has(inner.id)).toBe(true);
    click(5, 5);
    expect(ed.selection.has(outer.id)).toBe(false);
    expect([...ed.selection].every((id) => ed.inIsolation(id))).toBe(true);
  });

  it('does not pick objects outside the isolated group', () => {
    const { app, ed, a, b, inner, click } = nested();
    ed.isolation = inner.id;
    click(105, 5);
    expect(ed.selection.size).toBe(0);
    // A marquee over everything takes only what is inside.
    const at = (x, y) => {
      const s = ed.view.toScreen(x, y);
      return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0 };
    };
    app.tool.onPointerDown(at(-5, -5));
    app.tool.onPointerMove(at(120, 20));
    app.tool.onPointerUp(at(120, 20));
    expect([...ed.selection].sort()).toEqual([a.id, b.id].sort());
  });
});
