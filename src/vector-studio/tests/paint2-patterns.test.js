import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { transformNodes } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { editLayer, editTile, editDef } from '../src/features/patterns/edit.js';
import { previewCopies, copiesIn, lattice, tileOutline } from '../src/features/patterns/model.js';

beforeAll(() => installCanvasStub());

const solid = (color) => ({ type: 'solid', color });

async function editing() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ width: 300, height: 300 });
  const doc = ed.doc;
  const r = createPath(rectangle(20, 20, 10, 10), true, { fill: solid('#00ff00'), stroke: null });
  doc.transact('add', () => doc.insert(r, doc.layers()[0].id));
  ed.select([r.id]);
  await app.commands.run('pattern.make');
  app.openPanel('patternOptions');
  const panel = app.dock.panels.get('patternOptions');
  panel.ensureBuilt();
  panel.update();
  return { app, ed, doc, panel };
}

const change = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('Pattern Options panel', () => {
  it('sets tile types, brick offsets and the copies preview', async () => {
    const { ed, doc, panel } = await editing();
    const pattern = () => editLayer(doc).pattern;
    // Brick offset is only for brick tiles.
    expect(panel.offset.el.disabled).toBe(true);
    change(panel.type.el.querySelector('select') || panel.type.el, 'brickColumn');
    panel.update();
    expect(pattern().tileType).toBe('brickColumn');
    expect(panel.offset.el.disabled).toBe(false);
    change(panel.offset.el.querySelector('select') || panel.offset.el, '1/3');
    expect(pattern().brickOffset).toBe('1/3');
    const { a, b } = lattice(editDef(doc, editLayer(doc)));
    // Columns shift down by a third of a tile.
    expect(a[0]).toBeCloseTo(10, 6);
    expect(a[1]).toBeCloseTo(10 / 3, 6);
    expect(b[0]).toBeCloseTo(0, 6);
    expect(b[1]).toBeCloseTo(10, 6);
    change(panel.type.el.querySelector('select') || panel.type.el, 'hexRow');
    expect(tileOutline(editDef(doc, editLayer(doc))).length).toBe(6);
    change(panel.copies.el.querySelector('select') || panel.copies.el, '1x3');
    expect(previewCopies(editDef(doc, editLayer(doc)), pattern().copies).length).toBe(3);
    // Every option is one undo step.
    doc.undo();
    expect(pattern().copies).toBe('5x5');
    expect(ed.isolation).toBe(editLayer(doc).id);
  });

  it('sizes the tile to the art with spacing, and moves the tile with the art', async () => {
    const { doc, panel } = await editing();
    const layer = () => editLayer(doc);
    panel.sizeToArt.input.checked = true;
    panel.sizeToArt.input.dispatchEvent(new Event('change'));
    panel.update();
    expect(panel.hs.input.disabled).toBe(false);
    expect(panel.moveWithArt.input.disabled).toBe(true);
    panel.hs.input.value = '6';
    panel.hs.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editTile(doc, layer())).toMatchObject({ w: 16, h: 10 });
    panel.sizeToArt.input.checked = false;
    panel.sizeToArt.input.dispatchEvent(new Event('change'));
    // Turning it off keeps the size.
    expect(editTile(doc, layer())).toMatchObject({ w: 16, h: 10 });
    // Move Tile with Art (on by default): moving the art takes the tile along.
    const before = editTile(doc, layer());
    doc.transact('move', () => transformNodes(doc, layer().children, translate(30, 5)));
    expect(editTile(doc, layer())).toMatchObject({ x: before.x + 30, y: before.y + 5 });
    panel.moveWithArt.input.checked = false;
    panel.moveWithArt.input.dispatchEvent(new Event('change'));
    const fixed = editTile(doc, layer());
    doc.transact('move', () => transformNodes(doc, layer().children, translate(-30, 0)));
    expect(editTile(doc, layer())).toEqual(fixed);
  });

  it('sets overlap order, dimming and the tile edge and swatch bounds', async () => {
    const { doc, panel, menuItem } = await editing().then((r) => ({ ...r, menuItem: (label) => r.panel.menu().find((x) => x?.label === label) }));
    const pattern = () => editLayer(doc).pattern;
    const order = () => copiesIn(editDef(doc, editLayer(doc)), { x: -20, y: 0, w: 40, h: 1 }, { x: 0, y: 0, w: 10, h: 10 }).map((c) => c.dx);
    const leftFirst = order();
    panel.overlapH.el.querySelector('[aria-label="Right in Front"]').click();
    expect(pattern().overlapH).toBe('right');
    // The other copy comes last (in front) now.
    expect(order()).toEqual([...leftFirst].reverse());
    panel.dimCopies.input.checked = false;
    panel.dimCopies.input.dispatchEvent(new Event('change'));
    panel.update();
    expect(pattern().dimCopies).toBe(false);
    expect(panel.dim.el.disabled).toBe(true);
    menuItem('Show Swatch Bounds').run();
    expect(pattern().showSwatchBounds).toBe(true);
    menuItem('Show Tile Edge').run();
    expect(pattern().showTileEdge).toBe(false);
  });
});
