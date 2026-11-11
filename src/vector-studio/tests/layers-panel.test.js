import { describe, it, expect, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function setup() {
  const app = bootApp();
  const ed = app.newDocument({ name: 'Layers' });
  const doc = ed.doc;
  const layer = doc.layers()[0];
  const ids = {};
  doc.transact('Build', () => {
    for (const k of ['a', 'b', 'c']) {
      const p = createPath(rectangle(0, 0, 10, 10), true);
      doc.insert(p, layer.id);
      ids[k] = p.id;
    }
    const g = createGroup([], { clip: true });
    doc.insert(g, layer.id);
    const art = createPath(rectangle(0, 0, 20, 20), true);
    const mask = createPath(rectangle(5, 5, 5, 5), true);
    doc.insert(art, g.id);
    doc.insert(mask, g.id);
    Object.assign(ids, { clip: g.id, art: art.id, mask: mask.id });
  });
  const panel = app.dock.panels.get('layers');
  panel.ensureBuilt();
  return { app, ed, doc, layer: doc.get(layer.id), ids, panel };
}

describe('layers panel drag and drop', () => {
  it('drops just below an expanded layer row at the top of that layer', () => {
    const { doc, layer, ids, panel } = setup();
    panel.expanded.add(layer.id);
    panel.dropOn(ids.a, doc.get(layer.id), 'below');
    expect(doc.get(layer.id).children.at(-1)).toBe(ids.a);
  });

  it('keeps a collapsed layer drop below at the bottom of the layer', () => {
    const { doc, layer, ids, panel } = setup();
    panel.dropOn(ids.c, doc.get(layer.id), 'below');
    expect(doc.get(layer.id).children[0]).toBe(ids.c);
  });

  it('never puts dropped objects above the clipping path of a clip group', () => {
    const { doc, ids, panel } = setup();
    panel.dropOn(ids.b, doc.get(ids.clip), 'into');
    let kids = doc.get(ids.clip).children;
    expect(kids.at(-1)).toBe(ids.mask);
    expect(kids).toContain(ids.b);
    panel.dropOn(ids.a, doc.get(ids.mask), 'above');
    kids = doc.get(ids.clip).children;
    expect(kids.at(-1)).toBe(ids.mask);
    expect(kids).toContain(ids.a);
  });
});

describe('layers panel multi-row drag', () => {
  it('moves every dragged row together, keeping their order', () => {
    const { app, doc, layer, ids, panel } = setup();
    let other;
    doc.transact('Layer', () => {
      other = doc.addLayer('Other');
    });
    const target = createPath(rectangle(0, 0, 1, 1), true);
    doc.transact('T', () => doc.insert(target, other.id));
    panel.dropOn([ids.c, ids.a], doc.get(target.id), 'below');
    const kids = doc.get(other.id).children;
    // a is behind c; both sit right below the target.
    expect(kids).toEqual([ids.a, ids.c, target.id]);
    expect(doc.get(layer.id).children).not.toContain(ids.a);
    expect(app.editor.doc.undoStack.at(-1).label).toBe('Reorder');
  });
});

describe('layer options and outline', () => {
  const field = (label) => {
    const l = [...document.querySelectorAll('dialog[open] label')].find((x) => x.textContent.trim() === label);
    return document.getElementById(l.getAttribute('for'));
  };

  it('edits an existing layer: template locks it and stops printing', async () => {
    const { doc, layer, panel } = setup();
    const done = panel.layerOptions(doc.get(layer.id));
    field('Name').value = 'Sketch';
    field('Template').checked = true;
    field('Color').value = '#ff0000';
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'OK').click();
    await done;
    const l = doc.get(layer.id);
    expect(l).toMatchObject({ name: 'Sketch', template: true, locked: true, print: false, color: '#ff0000', hidden: false, outline: false });
  });

  it('opens Layer Options on a double-click outside the layer name', async () => {
    const { app, doc, layer, panel } = setup();
    app.openPanel('layers');
    panel.update();
    const row = document.getElementById(`lrow-${layer.id}`);
    row.querySelector('.lr-colorbar').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(document.querySelector('dialog[open] .dialog-title')?.textContent).toBe('Layer Options');
    document.querySelector('dialog[open]').close();
    row.querySelector('.lr-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(row.querySelector('.lr-rename')).not.toBeNull();
    expect(doc.get(layer.id).name).toBe('Layer 1');
  });

  it('switches a layer to outline with a Cmd-click on its eye', () => {
    const { app, doc, layer, panel } = setup();
    app.openPanel('layers');
    panel.update();
    document.querySelector(`#lrow-${layer.id} .lr-eye`).dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(doc.get(layer.id)).toMatchObject({ outline: true, hidden: false });
  });
});

describe('layers panel thumbnails', () => {
  it('redraws container thumbnails once edits settle instead of on every change', async () => {
    const { app, doc, layer, ids, panel } = setup();
    app.openPanel('layers');
    panel.update();
    let calls = 0;
    const orig = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      calls++;
      return 'data:image/png;base64,';
    };
    try {
      // Prime the cache for the layer row.
      doc.transact('Move', () => doc.update(ids.a, { name: 'A' }));
      panel.thumbsSettled = true;
      panel.renderRows();
      panel.thumbsSettled = false;
      calls = 0;
      doc.transact('Move', () => doc.update(ids.a, { name: 'B' }));
      panel.renderRows();
      expect(calls).toBe(0);
      await new Promise((r) => setTimeout(r, 450));
      expect(calls).toBeGreaterThan(0);
      expect(document.querySelector(`#lrow-${layer.id} .lr-thumb img`)).not.toBeNull();
    } finally {
      HTMLCanvasElement.prototype.toDataURL = orig;
    }
  });
});

describe('layers panel clipping mask button', () => {
  it('clips the active layer with its top object when nothing is selected', () => {
    const { ed, doc, layer, ids, panel } = setup();
    ed.select([]);
    panel.clipButton();
    const kids = doc.get(layer.id).children;
    expect(kids).toHaveLength(1);
    const g = doc.get(kids[0]);
    expect(g).toMatchObject({ type: 'group', clip: true });
    expect(g.children.at(-1)).toBe(ids.clip);
    expect(g.children).toContain(ids.a);
  });
});

describe('layers panel clicks and Shift ranges', () => {
  const rowOf = (panel, id) => panel.tree.querySelector(`#lrow-${CSS.escape(id)}`);

  it('keeps the rows in place when the tree takes focus, so the first click lands', () => {
    const { layer, ids, panel } = setup();
    panel.setOpen(layer.id, true);
    const before = rowOf(panel, ids.a);
    panel.tree.dispatchEvent(new FocusEvent('focus'));
    expect(rowOf(panel, ids.a)).toBe(before);
  });

  it('holds off the settled-thumbnail redraw while a row is pressed', () => {
    vi.useFakeTimers();
    try {
      const { layer, ids, panel } = setup();
      panel.setOpen(layer.id, true);
      const before = rowOf(panel, ids.a);
      panel.viewport.dispatchEvent(new Event('pointerdown'));
      panel.deferThumbs();
      vi.advanceTimersByTime(1000);
      expect(rowOf(panel, ids.a)).toBe(before);
      window.dispatchEvent(new Event('pointerup'));
      vi.advanceTimersByTime(1000);
      expect(rowOf(panel, ids.a)).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Shift-click on an object row selects every object row from the last one clicked', () => {
    const { ed, layer, ids, panel } = setup();
    panel.setOpen(layer.id, true);
    // Rows run top-first: clip group, c, b, a.
    panel.selectRow(ed.doc.get(ids.c), {});
    panel.selectRow(ed.doc.get(ids.a), { shiftKey: true });
    expect(new Set(ed.selection)).toEqual(new Set([ids.a, ids.b, ids.c]));
    // A new Shift-click re-ranges from the same anchor.
    panel.selectRow(ed.doc.get(ids.clip), { shiftKey: true });
    expect(new Set(ed.selection)).toEqual(new Set([ids.clip, ids.c]));
  });

  it('Shift-click on the target square still adds just that object', () => {
    const { ed, layer, ids, panel } = setup();
    panel.setOpen(layer.id, true);
    panel.selectRow(ed.doc.get(ids.c), {});
    panel.selectRow(ed.doc.get(ids.a), { shiftKey: true }, { range: false });
    expect(new Set(ed.selection)).toEqual(new Set([ids.a, ids.c]));
  });

  it('Shift-click on a layer row picks the range from the last picked layer, replacing the picks', async () => {
    const { layerPicks } = await import('../src/ops/layer-ops.js');
    const { ed, doc, panel } = setup();
    const made = [];
    doc.transact('Layers', () => {
      for (const name of ['B', 'C', 'D', 'E']) made.push(doc.addLayer(name).id);
    });
    panel.update();
    const [b, c, d, e] = made;
    panel.pickLayer(doc.get(b), {});
    panel.pickLayer(doc.get(d), { shiftKey: true });
    expect(new Set(layerPicks(ed))).toEqual(new Set([b, c, d]));
    panel.pickLayer(doc.get(e), { shiftKey: true });
    expect(new Set(layerPicks(ed))).toEqual(new Set([b, c, d, e]));
    panel.pickLayer(doc.get(c), { shiftKey: true });
    expect(new Set(layerPicks(ed))).toEqual(new Set([b, c]));
  });
});
