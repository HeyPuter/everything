// Global and spot swatches travel with copied artwork into other documents.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addSwatch, swatchesOf, findSwatch, updateSwatch, paintFromSwatch } from '../src/features/paint/swatch-model.js';

let app;

function rect(doc, ed, style) {
  const p = createPath(rectangle(0, 0, 50, 50), true, style);
  doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
  return p.id;
}

/** A document with a spot and a global swatch, and a rectangle painted with them. */
function source() {
  const ed = app.newDocument();
  const doc = ed.doc;
  let spot, glob;
  doc.transact('Swatches', () => {
    spot = addSwatch(doc, { name: 'PANTONE 185 C', paint: { type: 'solid', color: '#e4002b' }, spot: true });
    glob = addSwatch(doc, { name: 'Brand Blue', paint: { type: 'solid', color: '#0033a0' }, global: true });
  });
  const fill = { ...paintFromSwatch(findSwatch(doc, spot)), tint: 0.5 };
  const id = rect(doc, ed, { fill, stroke: paintFromSwatch(findSwatch(doc, glob)), strokeWidth: 2 });
  return { ed, doc, spot, glob, id, fill };
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
});

describe('copying artwork painted with global and spot swatches', () => {
  it('adds the swatches to the document it is pasted into, still linked', async () => {
    const src = source();
    src.ed.select([src.id]);
    await app.commands.run('edit.copy');
    const ed = app.newDocument();
    const doc = ed.doc;
    const before = swatchesOf(doc).length;
    await app.commands.run('edit.paste');
    const [copy] = ed.topSelection();
    const n = doc.get(copy);
    const spot = findSwatch(doc, n.fill.swatchId);
    const glob = findSwatch(doc, n.stroke.swatchId);
    expect(spot).toMatchObject({ name: 'PANTONE 185 C', spot: true, global: true, paint: { color: '#e4002b' } });
    expect(glob).toMatchObject({ name: 'Brand Blue', global: true, paint: { color: '#0033a0' } });
    expect(n.fill.tint).toBe(0.5);
    expect(swatchesOf(doc)).toHaveLength(before + 2);
    // Editing the global swatch recolors the pasted artwork.
    doc.transact('Edit', () => updateSwatch(doc, glob.id, { paint: { type: 'solid', color: '#112233' } }));
    expect(doc.get(copy).stroke.color).toBe('#112233');
    // Pasting again adds nothing new; undo takes the swatches back out.
    await app.commands.run('edit.paste');
    expect(swatchesOf(doc)).toHaveLength(before + 2);
    doc.undo();
    doc.undo();
    doc.undo();
    expect(swatchesOf(doc)).toHaveLength(before);
  });

  it('pasting in the same document adds no swatches', async () => {
    const src = source();
    const before = swatchesOf(src.doc).length;
    src.ed.select([src.id]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.paste');
    const [copy] = src.ed.topSelection();
    expect(swatchesOf(src.doc)).toHaveLength(before);
    expect(src.doc.get(copy).fill.swatchId).toBe(src.spot);
    expect(src.doc.get(copy).stroke.swatchId).toBe(src.glob);
  });

  it('uses a spot ink of the same name the target document already has', async () => {
    const src = source();
    src.ed.select([src.id]);
    await app.commands.run('edit.copy');
    const ed = app.newDocument();
    const doc = ed.doc;
    let mine;
    doc.transact('Swatch', () => {
      mine = addSwatch(doc, { name: 'PANTONE 185 C', paint: { type: 'solid', color: '#ff0000' }, spot: true });
    });
    await app.commands.run('edit.paste');
    const n = doc.get(ed.topSelection()[0]);
    expect(n.fill.swatchId).toBe(mine);
    expect(swatchesOf(doc).filter((s) => s.name === 'PANTONE 185 C')).toHaveLength(1);
  });

  it('carries swatches used by gradient stops, type runs and extra fills', async () => {
    const ed0 = app.newDocument();
    const d0 = ed0.doc;
    let a, b, c;
    d0.transact('Swatches', () => {
      a = addSwatch(d0, { name: 'Stop', paint: { type: 'solid', color: '#00ff00' }, global: true });
      b = addSwatch(d0, { name: 'Run', paint: { type: 'solid', color: '#0000ff' }, global: true });
      c = addSwatch(d0, { name: 'Extra', paint: { type: 'solid', color: '#ff00ff' }, global: true });
    });
    const grad = { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#00ff00', swatchId: a }, { offset: 1, color: '#000000' }] };
    const r = rect(d0, ed0, { fill: grad });
    const t = createText('Hello', 0, 100, { runs: [{ len: 2, fill: { type: 'solid', color: '#0000ff', swatchId: b } }] });
    d0.transact('Add', () => d0.insert(t, ed0.targetLayer().id));
    d0.transact('Extra', () => d0.update(r, { appearance: [{ type: 'fill', fill: { type: 'solid', color: '#ff00ff', swatchId: c } }, { base: true }] }));
    ed0.select([r, t.id]);
    await app.commands.run('edit.copy');
    const ed = app.newDocument();
    await app.commands.run('edit.paste');
    const names = swatchesOf(ed.doc).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['Stop', 'Run', 'Extra']));
  });
});
