import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { layerPicks } from '../src/ops/layer-ops.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

function setup() {
  const ed = app.newDocument({ name: 'Layers menu' });
  const doc = ed.doc;
  const layer = doc.layers()[0];
  const ids = [];
  doc.transact('Build', () => {
    for (let i = 0; i < 3; i++) {
      const p = createPath(rectangle(i * 20, 0, 10, 10), true, { fill: { type: 'solid', color: '#ff0000' } });
      doc.insert(p, layer.id);
      ids.push(p.id);
    }
  });
  const panel = app.dock.panels.get('layers');
  panel.ensureBuilt();
  return { ed, doc, layer, ids, panel };
}

const run = (id, args) => app.commands.run(id, args);
const names = (doc) => doc.layers().map((l) => l.name);

describe('Layers panel menu', () => {
  it('lists the layer commands in the panel menu', () => {
    setup();
    app.dock.showTab?.('layers');
    const panel = app.dock.panels.get('layers');
    const ids = panel.menu().filter((x) => typeof x === 'string' && x !== '-');
    for (const id of ids) expect(app.commands.get(id), id).toBeTruthy();
    expect(app.commands.label('layers.duplicate')).toMatch(/^Duplicate "Layer 1"/);
  });

  it('creates a sublayer inside the active layer', async () => {
    const { ed, doc, layer } = setup();
    app.dialogs.form = async () => ({ name: 'Inner', color: '#ff0000', template: false, locked: false, show: true });
    await run('layers.newSublayer');
    const sub = doc.get(ed.activeLayerId);
    expect(sub.name).toBe('Inner');
    expect(sub.parent).toBe(layer.id);
  });

  it('duplicates and deletes the picked layer', async () => {
    const { ed, doc, layer } = setup();
    await run('layers.duplicate');
    expect(doc.layers().length).toBe(2);
    expect(doc.layers()[1].name).toBe('Layer 1 copy');
    expect(doc.layers()[1].children.length).toBe(3);
    await run('layers.delete');
    expect(doc.layers().length).toBe(1);
    expect(doc.layers()[0].id).toBe(layer.id);
    // The last layer stays.
    await run('layers.delete');
    expect(doc.layers().length).toBe(1);
    expect(ed.activeLayerId).toBe(layer.id);
  });

  it('duplicates selected objects in place above each original', async () => {
    const { ed, doc, layer, ids } = setup();
    ed.select([ids[0]]);
    await run('layers.duplicate');
    const kids = doc.get(layer.id).children;
    expect(kids.length).toBe(4);
    expect(kids[0]).toBe(ids[0]);
    expect(ed.topSelection()).toEqual([kids[1]]);
  });

  it('merges picked layers into the active one, keeping the stacking order', async () => {
    const { ed, doc, layer, ids } = setup();
    let top;
    doc.transact('L', () => {
      top = doc.addLayer('Top');
      doc.move(ids[2], top.id);
    });
    const picks = layerPicks(ed);
    picks.clear();
    picks.add(layer.id);
    picks.add(top.id);
    ed.activeLayerId = layer.id;
    await run('layers.merge');
    expect(doc.layers().length).toBe(1);
    expect(doc.get(layer.id).children).toEqual(ids);
  });

  it('flattens visible layers and drops hidden artwork after confirming', async () => {
    const { doc, layer, ids } = setup();
    doc.transact('L', () => {
      const hidden = doc.addLayer('Hidden');
      doc.move(ids[2], hidden.id);
      doc.update(hidden.id, { hidden: true });
      const tpl = doc.addLayer('Template');
      doc.update(tpl.id, { template: true });
    });
    app.dialogs.confirm = async () => true;
    await run('layers.flatten');
    expect(names(doc)).toEqual(['Layer 1', 'Template']);
    expect(doc.get(layer.id).children).toEqual(ids.slice(0, 2));
    expect(doc.has(ids[2])).toBe(false);
  });

  it('collects selected objects in a new sublayer where they were', async () => {
    const { ed, doc, layer, ids } = setup();
    ed.select([ids[0], ids[1]]);
    await run('layers.collect');
    const kids = doc.get(layer.id).children;
    expect(kids.length).toBe(2);
    const sub = doc.get(kids[0]);
    expect(sub.type).toBe('layer');
    expect(sub.children).toEqual([ids[0], ids[1]]);
    expect(kids[1]).toBe(ids[2]);
  });

  it('releases a layer to sublayers in sequence and as a build', async () => {
    let { ed, doc, layer, ids } = setup();
    ed.clearSelection();
    await run('layers.releaseSequence');
    let subs = doc.get(layer.id).children.map((c) => doc.get(c));
    expect(subs.map((s) => s.type)).toEqual(['layer', 'layer', 'layer']);
    expect(subs.map((s) => s.children)).toEqual(ids.map((id) => [id]));

    ({ ed, doc, layer, ids } = setup());
    ed.clearSelection();
    await run('layers.releaseBuild');
    subs = doc.get(layer.id).children.map((c) => doc.get(c));
    expect(subs.map((s) => s.children.length)).toEqual([1, 2, 3]);
    expect(subs[2].children[2]).toBe(ids[2]);
  });

  it('releases a selected group to layers in its layer', async () => {
    const { ed, doc, layer, ids } = setup();
    let g;
    doc.transact('G', () => {
      g = createGroup([]);
      doc.insert(g, layer.id, 0);
      doc.move(ids[0], g.id);
      doc.move(ids[1], g.id);
    });
    ed.select([g.id]);
    await run('layers.releaseSequence');
    expect(doc.has(g.id)).toBe(false);
    const kids = doc.get(layer.id).children.map((c) => doc.get(c));
    expect(kids.map((k) => k.type)).toEqual(['layer', 'layer', 'path']);
  });

  it('reverses the stacking order of selected objects', async () => {
    const { ed, doc, layer, ids } = setup();
    ed.select(ids);
    await run('layers.reverse');
    expect(doc.get(layer.id).children).toEqual([...ids].reverse());
  });

  it('toggles Template, and Hide / Lock Others with their restore labels', async () => {
    const { ed, doc, layer } = setup();
    let other;
    doc.transact('L', () => {
      other = doc.addLayer('Other');
    });
    ed.activeLayerId = layer.id;
    layerPicks(ed).clear();
    await run('layers.template');
    expect(doc.get(layer.id)).toMatchObject({ template: true, locked: true, print: false });
    expect(app.commands.isChecked('layers.template')).toBe(true);
    await run('layers.template');
    expect(doc.get(layer.id).template).toBe(false);

    expect(app.commands.label('layers.hideOthers')).toBe('Hide Others');
    await run('layers.hideOthers');
    expect(doc.get(other.id).hidden).toBe(true);
    expect(app.commands.label('layers.hideOthers')).toBe('Show All Layers');
    await run('layers.hideOthers');
    expect(doc.get(other.id).hidden).toBe(false);
    await run('layers.lockOthers');
    expect(doc.get(other.id).locked).toBe(true);
    await run('layers.outlineOthers');
    expect(doc.get(other.id).outline).toBe(true);
    expect(app.commands.label('layers.outlineOthers')).toBe('Preview All Layers');
  });

  it('pastes into the layer an object was copied from when Paste Remembers Layers is on', async () => {
    const { ed, doc, ids } = setup();
    let second;
    doc.transact('L', () => {
      second = doc.addLayer('Second');
    });
    ed.select([ids[0]]);
    await run('edit.copy');
    ed.activeLayerId = second.id;
    await run('layers.pasteRemembers');
    expect(app.prefs.get('pasteRemembersLayers')).toBe(true);
    await run('edit.paste');
    const pasted = ed.topSelection()[0];
    expect(doc.layerOf(pasted).name).toBe('Layer 1');
    await run('layers.pasteRemembers');
    // Pasting selected the copy, which made its layer active again.
    ed.activeLayerId = second.id;
    await run('edit.paste');
    expect(doc.layerOf(ed.topSelection()[0]).id).toBe(second.id);
  });

  it('locates the selected object in the tree', async () => {
    const { ed, doc, layer, ids, panel } = setup();
    let g;
    doc.transact('G', () => {
      g = createGroup([]);
      doc.insert(g, layer.id);
      doc.move(ids[1], g.id);
    });
    panel.expanded.clear();
    ed.select([g.id]);
    ed.selection.clear();
    ed.selection.add(ids[1]);
    await run('layers.locate');
    expect(panel.expanded.has(g.id)).toBe(true);
    expect(panel.rows[panel.focusIndex].id).toBe(ids[1]);
  });

  it('applies panel options: layers only, row size and thumbnails', async () => {
    const { ed, doc, layer, panel } = setup();
    let sub;
    doc.transact('S', () => {
      sub = doc.addLayer('Sub');
      doc.move(sub.id, layer.id);
    });
    app.dialogs.form = async () => ({ layersOnly: true, rowSize: 'large', rowHeight: 28, thumbLayers: true, thumbTopOnly: true, thumbGroups: true, thumbObjects: false });
    await run('layers.panelOptions');
    panel.expanded.add(layer.id);
    panel.update();
    expect(panel.rows.map((r) => r.id)).toEqual([layer.id, sub.id]);
    expect(panel.rowH).toBe(44);
    app.prefs.set('layersPanel', null);
    panel.update();
    expect(panel.rows.length).toBe(5);
    expect(ed).toBeTruthy();
  });

  it('picks layers with Cmd-click and Shift-click on their rows', () => {
    const { ed, doc, layer, panel } = setup();
    let b;
    let c;
    doc.transact('L', () => {
      b = doc.addLayer('B');
      c = doc.addLayer('C');
    });
    panel.update();
    panel.pickLayer(doc.get(c.id), {});
    panel.pickLayer(doc.get(layer.id), { shiftKey: true });
    expect([...layerPicks(ed)].sort()).toEqual([layer.id, b.id, c.id].sort());
    panel.pickLayer(doc.get(b.id), { metaKey: true });
    expect(layerPicks(ed).has(b.id)).toBe(false);
    panel.pickLayer(doc.get(b.id), {});
    expect([...layerPicks(ed)]).toEqual([b.id]);
    expect(ed.activeLayerId).toBe(b.id);
  });
});
