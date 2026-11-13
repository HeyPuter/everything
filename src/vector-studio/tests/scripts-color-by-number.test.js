// Built-in scripts Color by Number and Select Smallest Object, and the API at the scale of a coloring book.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { scriptAPI } from '../src/features/scripts/runner.js';
import { BUILT_IN_SCRIPTS } from '../src/features/scripts/index.js';
import { createPath, createCompound } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

const solid = (color) => ({ type: 'solid', color });
const script = (id) => BUILT_IN_SCRIPTS.find((s) => s.id === id);

/** Run a script's source in-process against the API (the sandboxed iframe does this in the browser). */
async function runInline(source, name = 'Test') {
  const ed = app.editor;
  const { api, changes } = scriptAPI(app, ed, name);
  const root = ed.doc.root;
  const vs = {
    doc: { name: 'Doc', units: root.units || 'pt', pointsPerUnit: 1, artboards: root.artboards },
    ...Object.fromEntries(
      Object.entries(api).map(([k, fn]) => [
        k,
        async (...a) => JSON.parse(JSON.stringify((await fn(...a)) ?? null)),
      ]),
    ),
  };
  const fn = new Function('vs', `return (async () => {${source}\n})();`);
  return { value: await fn(vs), changes: changes() };
}

/** Answers for the Color by Number form. */
const SETTINGS = {
  scope: 'document',
  strokeWidth: 0.5,
  strokeColor: '#333333',
  minSize: 5,
  font: 'Inter',
  minFont: 4,
  maxFont: 14,
  numberColor: '#666666',
  legend: true,
};

function withForm(values, fn) {
  const original = app.dialogs.form;
  app.dialogs.form = async () => values;
  return fn().finally(() => {
    app.dialogs.form = original;
  });
}

/** A drawing: two red squares, a blue circle, a tiny red speck and a green ring (compound with a hole). */
function drawing() {
  const ed = app.newDocument();
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const nodes = {
    a: createPath(rectangle(10, 10, 40, 40), true, { fill: solid('#ff0000'), stroke: null }),
    b: createPath(ellipse(60, 10, 30, 30), true, { fill: solid('#0000ff'), stroke: null }),
    c: createPath(rectangle(100, 10, 20, 20), true, { fill: solid('#FF0000'), stroke: null }),
    speck: createPath(rectangle(130, 10, 2, 2), true, { fill: solid('#ff0000'), stroke: null }),
    open: createPath(rectangle(10, 80, 20, 20), false, { fill: null }),
  };
  const ring = createCompound(
    [],
    { fill: solid('#00aa00'), stroke: null },
    { fillRule: 'evenodd' },
  );
  const kids = [rectangle(150, 10, 60, 60), rectangle(160, 20, 40, 40)].map((r) => ({
    ...createPath(r, true, {}),
    parent: ring.id,
  }));
  ring.children = kids.map((k) => k.id);
  doc.transact('draw', () => {
    for (const n of Object.values(nodes)) doc.insert(n, layer);
    doc.insert(ring, layer, Infinity, kids);
  });
  return {
    ed,
    doc,
    layer,
    ids: { ...Object.fromEntries(Object.entries(nodes).map(([k, n]) => [k, n.id])), ring: ring.id },
  };
}

describe('Color by Number', () => {
  it('numbers regions by fill color, outlines them, keeps small ones filled, adds a legend', async () => {
    const { ed, doc, layer, ids } = drawing();
    const before = doc.undoStack.length;
    const r = await withForm(SETTINGS, () =>
      runInline(script('color-by-number').source, 'Color by Number'),
    );
    expect(r.value).toBe('Numbered 4 regions in 3 colors; 1 too small to color kept their fill.');
    // One undo step for the whole run.
    expect(doc.undoStack.length).toBe(before + 1);
    // The original art is kept, on its layer, hidden.
    expect(doc.get(layer).hidden).toBe(true);
    expect(doc.get(ids.a).fill.color).toBe('#ff0000');
    const result = doc.layers().find((l) => l.name === 'Color by Number');
    expect(result.hidden).toBe(false);
    const groups = result.children.map((c) => doc.get(c));
    expect(groups.map((g) => g.name)).toEqual(['Regions', 'Numbers', 'Legend']);
    const [regions, numbers, legend] = groups;
    expect(regions.children).toHaveLength(5);
    const outlined = regions.children.map((c) => doc.get(c));
    const filled = outlined.filter((n) => n.fill);
    // Only the speck keeps its fill; every region gets the thin outline.
    expect(filled).toHaveLength(1);
    expect(filled[0].fill.color).toBe('#ff0000');
    expect(outlined.every((n) => n.stroke?.color === '#333333' && n.strokeWidth === 0.5)).toBe(
      true,
    );
    // Red is 1 (first seen, any letter case), blue 2, green 3; one number per region except the speck.
    const texts = numbers.children.map((c) => doc.get(c));
    expect(texts.map((t) => t.text)).toEqual(['1', '2', '1', '3']);
    // Sizes follow the room inside: the big square's number is at the largest size, the ring's smaller.
    expect(texts[0].char.fontSize).toBe(14);
    expect(texts[3].char.fontSize).toBeLessThan(14);
    expect(texts[3].char.fontSize).toBeGreaterThanOrEqual(4);
    // The big square's number sits at its center, the ring's in the band, not in the hole.
    const tb = (t) => {
      const b = ed.nodeBounds(t.id);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    };
    expect(tb(texts[0]).x).toBeCloseTo(30, 0);
    expect(tb(texts[0]).y).toBeCloseTo(30, 0);
    const ringSpot = tb(texts[3]);
    expect(ringSpot.x > 160 && ringSpot.x < 200 && ringSpot.y > 20 && ringSpot.y < 60).toBe(false);
    // The legend: a swatch per color, right of the artboard.
    const board = doc.root.artboards[0];
    const swatches = legend.children.map((c) => doc.get(c)).filter((n) => n.type === 'path');
    expect(swatches.map((s) => s.fill.color)).toEqual(['#ff0000', '#0000ff', '#00aa00']);
    expect(swatches.every((s) => s.anchors[0].x > board.x + board.w)).toBe(true);
    const legendNumbers = legend.children.map((c) => doc.get(c)).filter((n) => n.type === 'text');
    expect(legendNumbers.map((t) => t.text)).toEqual(['1', '2', '3']);
    doc.undo();
    expect(doc.layers().some((l) => l.name === 'Color by Number')).toBe(false);
    expect(doc.get(layer).hidden).toBe(false);
  });

  it('works on the selection only, hiding just the selected art', async () => {
    const { ed, doc, layer, ids } = drawing();
    ed.select([ids.a, ids.b]);
    const r = await withForm({ ...SETTINGS, scope: 'auto', legend: false }, () =>
      runInline(script('color-by-number').source),
    );
    expect(r.value).toBe('Numbered 2 regions in 2 colors.');
    expect(doc.get(layer).hidden).toBe(false);
    expect(doc.get(ids.a).hidden).toBe(true);
    expect(doc.get(ids.c).hidden).toBe(false);
  });

  it('changes nothing when the form is cancelled', async () => {
    const { doc } = drawing();
    const before = doc.undoStack.length;
    const r = await withForm(null, () => runInline(script('color-by-number').source));
    expect(r.changes).toBe(0);
    expect(doc.undoStack.length).toBe(before);
  });
});

describe('Select Smallest Object', () => {
  it('selects the closed filled object with the least area and reports it', async () => {
    const { ed, ids } = drawing();
    const r = await runInline(script('select-smallest').source);
    expect(ed.topSelection()).toEqual([ids.speck]);
    expect(r.value).toBe('Smallest of 5: path, 4.000 sq pt.');
  });
});

describe('scripts at the scale of a coloring book', () => {
  it('runs 2,000 shapes through the batch calls and Color by Number', async () => {
    const ed = app.newDocument();
    const doc = ed.doc;
    const layer = ed.targetLayer().id;
    const colors = [
      '#e6194b',
      '#3cb44b',
      '#ffe119',
      '#4363d8',
      '#f58231',
      '#911eb4',
      '#46f0f0',
      '#f032e6',
    ];
    const shapes = [];
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) * 12;
      const y = Math.floor(i / 50) * 12;
      // Every 10th cell is a speck too small to color.
      const size = i % 10 === 9 ? 2 : 10;
      shapes.push(
        createPath(rectangle(x, y, size, size), true, { fill: solid(colors[i % 8]), stroke: null }),
      );
    }
    doc.transact('draw', () => {
      shapes.forEach((n) => doc.insert(n, layer));
      doc.updateRoot({ artboards: [{ ...doc.root.artboards[0], x: 0, y: 0, w: 600, h: 480 }] });
    });

    const t0 = performance.now();
    const batch = await runInline(`
const all = await vs.objects({ type: 'path', fill: true, fields: ['fill'] });
await vs.updateMany(all.map((n) => ({ id: n.id, patch: { opacity: 0.9 } })));
const areas = await vs.area(all.map((n) => n.id));
return all.length + ':' + Math.round(areas.reduce((a, b) => a + b, 0));`);
    const t1 = performance.now();
    expect(batch.value).toBe(`2000:${1800 * 100 + 200 * 4}`);
    expect(doc.get(shapes[0].id).opacity).toBe(0.9);

    const before = doc.undoStack.length;
    const r = await withForm({ ...SETTINGS, minSize: 5 }, () =>
      runInline(script('color-by-number').source, 'Color by Number'),
    );
    const t2 = performance.now();
    expect(r.value).toBe(
      'Numbered 1800 regions in 8 colors; 200 too small to color kept their fill.',
    );
    expect(doc.undoStack.length).toBe(before + 1);
    const result = doc.layers().find((l) => l.name === 'Color by Number');
    const [regions, numbers] = result.children.map((c) => doc.get(c));
    expect(regions.children).toHaveLength(2000);
    expect(numbers.children).toHaveLength(1800);
    console.log(
      `scripts scale: batch ${Math.round(t1 - t0)} ms, Color by Number on 2,000 shapes ${Math.round(t2 - t1)} ms`,
    );
  }, 120000);
});
