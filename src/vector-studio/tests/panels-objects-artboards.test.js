import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addArtboard } from '../src/features/artboards/artboard-ops.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

function setup() {
  const ed = app.newDocument({ name: 'Artboards menu', width: 100, height: 100 });
  const doc = ed.doc;
  doc.transact('Boards', () => {
    addArtboard(doc, { x: 200, y: 0, w: 100, h: 100 });
    addArtboard(doc, { x: 400, y: 0, w: 100, h: 100 });
    // Artwork on the first artboard only.
    doc.insert(createPath(rectangle(10, 10, 20, 20), true), doc.layers()[0].id);
  });
  const panel = app.dock.panels.get('artboards');
  panel.ensureBuilt();
  panel.update();
  return { ed, doc, panel };
}

const run = (id) => app.commands.run(id);

describe('Artboards panel menu', () => {
  it('has a menu of artboard commands', () => {
    const { panel } = setup();
    for (const id of panel.menu().filter((x) => x !== '-')) expect(app.commands.get(id), id).toBeTruthy();
  });

  it('picks several artboards and duplicates them to the right with their artwork', async () => {
    const { ed, doc, panel } = setup();
    panel.pick(0, {});
    panel.pick(1, { metaKey: true });
    panel.update();
    expect(app.commands.label('artboards.duplicate')).toBe('Duplicate Artboards');
    const before = doc.layers()[0].children.length;
    await run('artboards.duplicate');
    expect(doc.artboards.length).toBe(5);
    expect(doc.artboards[3]).toMatchObject({ name: 'Artboard 1 copy', x: 520 });
    expect(doc.artboards[4]).toMatchObject({ x: 640 });
    expect(doc.layers()[0].children.length).toBe(before + 1);
    expect(ed.activeArtboard).toBe(4);
  });

  it('deletes picked artboards and empty artboards', async () => {
    const { doc, panel } = setup();
    panel.pick(1, {});
    panel.pick(2, { shiftKey: true });
    panel.update();
    expect(panel.list.querySelectorAll('[aria-selected="true"]').length).toBe(2);
    await run('artboards.delete');
    expect(doc.artboards.length).toBe(1);
    expect(doc.artboards[0].name).toBe('Artboard 1');

    const s = setup();
    await run('artboards.deleteEmpty');
    expect(s.doc.artboards.map((b) => b.name)).toEqual(['Artboard 1']);
  });

  it('moves the active artboard and resets names', async () => {
    const { ed, doc, panel } = setup();
    panel.pick(2, {});
    await run('artboards.moveUp');
    expect(doc.artboards.map((b) => b.name)).toEqual(['Artboard 1', 'Artboard 3', 'Artboard 2']);
    expect(ed.activeArtboard).toBe(1);
    expect(app.commands.isEnabled('artboards.resetNames')).toBe(true);
    await run('artboards.resetNames');
    expect(doc.artboards.map((b) => b.name)).toEqual(['Artboard 1', 'Artboard 2', 'Artboard 3']);
    await run('artboards.moveDown');
    expect(ed.activeArtboard).toBe(2);
  });
});
