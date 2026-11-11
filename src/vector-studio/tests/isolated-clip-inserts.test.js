import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { gridOf } from '../src/features/perspective/model.js';
import { setPState } from '../src/features/perspective/state.js';
import { placeSymbol } from '../src/features/symbols/commands.js';
import { placeLibrarySymbol } from '../src/features/symbols/library-window.js';
import { SYMBOL_LIBRARIES } from '../src/features/symbols/libraries.js';
import { setSymbolismOptions } from '../src/features/symbols/tools.js';
import { placeGraphic } from '../src/features/libraries/panel.js';
import { createTrimMarks } from '../src/features/panels/object-commands.js';
import { insertGeneratedText } from '../src/features/generative/text-ai.js';
import { placementTarget } from '../src/features/generative/place.js';

// In isolation mode on a clip group the last child is the clipping path: new artwork must go below it.
let app;
let ed;
let doc;
let clip;
let mask;

function ev(x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, clicks: 1, ...extra };
}
function drag(from, to) {
  const t = app.tool;
  t.onPointerDown(ev(from.x, from.y));
  for (let i = 1; i <= 4; i++) t.onPointerMove(ev(from.x + ((to.x - from.x) * i) / 4, from.y + ((to.y - from.y) * i) / 4));
  return t.onPointerUp(ev(to.x, to.y));
}
const add = (x, size) => {
  const p = createPath(rectangle(x, x, size, size), true, { fill: { type: 'solid', color: '#ff0000' } });
  doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
  return p.id;
};
/** The clipping path stays the clip group's last child, and `id` (when given) went inside the group. */
function expectMaskKept(id) {
  const kids = doc.get(clip).children;
  expect(kids[kids.length - 1]).toBe(mask);
  if (id) expect(kids).toContain(id);
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  ed = app.newDocument({ width: 800, height: 600 });
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  doc = ed.doc;
  const art = add(0, 400);
  mask = add(25, 300);
  ed.select([art, mask]);
  await app.commands.run('object.clipMake');
  [clip] = ed.selection;
  await app.commands.run('object.isolate');
  ed.clearSelection();
});

describe('new artwork in an isolated clip group', () => {
  it('flare tool drag', async () => {
    app.setTool('flare');
    await drag({ x: 100, y: 100 }, { x: 150, y: 100 });
    expectMaskKept([...ed.selection][0]);
  });

  it('dimension tool', () => {
    app.prefs.set('dimensionTool', null);
    app.setTool('dimension');
    const t = app.tool;
    for (const [x, y] of [[60, 60], [200, 60], [200, 120]]) {
      t.onPointerDown(ev(x, y));
      t.onPointerUp(ev(x, y));
    }
    const dim = [];
    doc.walk((n) => {
      if (n.type === 'dimension') dim.push(n.id);
      return true;
    });
    expect(dim).toHaveLength(1);
    expectMaskKept(dim[0]);
  });

  it('graph tool', async () => {
    app.setTool('graph-column');
    await drag({ x: 60, y: 60 }, { x: 200, y: 160 });
    expectMaskKept([...ed.selection][0]);
    document.querySelector('.graph-data')?.remove();
  });

  it('symbol placing and spraying', async () => {
    // The symbol's artwork sits outside the clip group.
    const a = createPath(rectangle(500, 500, 40, 40), true);
    doc.transact('Rect', () => doc.insert(a, doc.layers()[0].id));
    ed.select([a.id]);
    const { def } = await app.commands.run('symbol.new', { direct: true, name: 'Card' });
    ed.clearSelection();
    const inst = placeSymbol(app, def.id, { x: 100, y: 100 });
    expectMaskKept(inst.id);
    const lib = SYMBOL_LIBRARIES[0];
    const inst2 = placeLibrarySymbol(app, lib, lib.symbols[0], { x: 120, y: 120 });
    expectMaskKept(inst2.id);
    ed.clearSelection();
    setSymbolismOptions(app, { diameter: 100, intensity: 10, density: 3 });
    app.setTool('symbol-sprayer');
    const t = app.tool;
    t.onPointerDown(ev(150, 150));
    for (let i = 0; i < 5; i++) t.step(ev(150, 150), 0.1);
    t.onPointerUp(ev(150, 150));
    expectMaskKept([...ed.selection][0]);
  });

  it('library graphics, trim marks, generated text and generated art', () => {
    const ids = placeGraphic(app, { items: [doc.exportSubtree(mask)] }, { x: 100, y: 100 });
    expectMaskKept(ids[0]);
    const tm = createTrimMarks(ed);
    expectMaskKept(tm);
    ed.clearSelection();
    const text = insertGeneratedText(app, 'Hello', 'paragraph', []);
    expectMaskKept(text);
    ed.clearSelection();
    const target = placementTarget(ed);
    expect(target.parentId).toBe(clip);
    expect(target.index).toBe(doc.get(clip).children.length - 1);
  });

  it('Release Guides', async () => {
    doc.transact('Guide', () => doc.updateRoot({ guides: [{ axis: 'x', pos: 100 }] }));
    await app.commands.run('view.releaseGuides');
    expectMaskKept([...ed.selection][0]);
  });

  it('drawing on a perspective plane', () => {
    setPState(ed, { visible: true, plane: 'right', snap: false });
    const g = gridOf(doc);
    app.setTool('rectangle');
    drag({ x: g.ox + 40, y: g.oy - 150 }, { x: g.ox + 140, y: g.oy - 60 });
    expectMaskKept(ed.topSelection()[0]);
  });
});
