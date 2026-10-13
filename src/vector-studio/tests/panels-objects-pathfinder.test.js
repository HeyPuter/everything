import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom, runGeomSync } from '../src/features/geometry/engine/index.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { hardMixColor, softMixColor, tint, mixTrapCombine, luminance } from '../src/features/geometry/mix-trap.js';
import { removeRedundantAnchors, pathfinderOptions } from '../src/features/geometry/pathfinder.js';
import { isCompoundShape, compoundShapeMode } from '../src/features/geometry/pathfinder-extras.js';
import { geomEffectDef } from '../src/model/geom-effects.js';
import { liveArtwork } from '../src/model/live.js';

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

const solid = (color) => ({ type: 'solid', color });
const sq = (x, y, s, color) => ({ style: { fill: solid(color), stroke: null }, subpaths: [{ anchors: rectangle(x, y, s, s), closed: true }], fillRule: 'nonzero' });
const engine = (op, shapes, params) => runGeomSync(op, shapes, params);
const colorAt = (items, x, y) => {
  // The item whose box contains the point and is smallest (faces do not overlap).
  let best = null;
  for (const it of items) {
    const xs = it.subpaths.flatMap((s) => s.anchors.map((a) => a.x));
    const ys = it.subpaths.flatMap((s) => s.anchors.map((a) => a.y));
    const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 && (!best || (b.x1 - b.x0) * (b.y1 - b.y0) < best.area)) best = { it, area: (b.x1 - b.x0) * (b.y1 - b.y0) };
  }
  return best?.it.style.fill?.color;
};

describe('color mixing', () => {
  it('hard mixes to the darkest channels and soft mixes at a rate', () => {
    expect(hardMixColor(['#ff8000', '#00ff80'])).toBe('#008000');
    expect(softMixColor(['#ff0000', '#0000ff'], 0.5)).toBe('#800080');
    expect(softMixColor(['#ff0000', '#0000ff'], 0)).toBe('#ff0000');
    expect(tint('#000000', 0.4)).toBe('#999999');
    expect(luminance('#ffffff')).toBeCloseTo(1);
  });

  it('recolors the overlap of a group with Hard Mix and Soft Mix', () => {
    const items = [sq(0, 0, 100, '#ff0000'), sq(50, 50, 100, '#0000ff')];
    const hard = mixTrapCombine(items, { type: 'hardMix' }, engine);
    expect(hard).toHaveLength(3);
    expect(colorAt(hard, 75, 75)).toBe('#000000');
    expect(colorAt(hard, 25, 25)).toBe('#ff0000');
    expect(colorAt(hard, 125, 125)).toBe('#0000ff');
    const soft = mixTrapCombine(items, { type: 'softMix', rate: 0.5 }, engine);
    expect(colorAt(soft, 75, 75)).toBe('#800080');
    // A single shape has nothing to mix.
    expect(mixTrapCombine(items.slice(0, 1), { type: 'hardMix' }, engine)).toEqual(items.slice(0, 1));
  });

  it('traps the lighter color into the darker one along their shared edge', () => {
    const items = [sq(0, 0, 100, '#ffff00'), sq(100, 0, 100, '#000000')];
    const out = mixTrapCombine(items, { type: 'trap', thickness: 2, tint: 0.5, reverse: false }, engine);
    expect(out).toHaveLength(3);
    const trap = out[2];
    expect(trap.style.overprintFill).toBe(true);
    expect(trap.style.fill.color).toBe(tint('#ffff00', 0.5));
    const xs = trap.subpaths.flatMap((s) => s.anchors.map((a) => a.x));
    // The strip lies inside the black square, within the trap width of the edge.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100 - 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(102 + 1e-3);
    const reversed = mixTrapCombine(items, { type: 'trap', thickness: 2, tint: 1, reverse: true }, engine);
    const rx = reversed[2].subpaths.flatMap((s) => s.anchors.map((a) => a.x));
    expect(Math.max(...rx)).toBeLessThanOrEqual(100 + 1e-6);
    expect(reversed[2].style.fill.color).toBe('#000000');
  });

  it('registers Hard Mix, Soft Mix and Trap as group effects', () => {
    for (const t of ['hardMix', 'softMix', 'trap']) expect(geomEffectDef(t)?.combine).toBeTypeOf('function');
  });
});

describe('Pathfinder options', () => {
  it('removes redundant points', () => {
    const pts = [anchor(0, 0), anchor(50, 0), anchor(100, 0), anchor(100, 100), anchor(100, 100), anchor(0, 100), anchor(0, 50)];
    expect(removeRedundantAnchors(pts, true).map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    // Curved anchors stay.
    const curved = [anchor(0, 0), anchor(50, 0, 40, 0, 60, 10), anchor(100, 0)];
    expect(removeRedundantAnchors(curved, false)).toHaveLength(3);
  });

  it('saves the options and restores defaults', async () => {
    app.dialogs.form = async () => ({ precision: 0.5, removeRedundant: false, removeUnpainted: true });
    await app.commands.run('pathfinder.options');
    expect(pathfinderOptions).toMatchObject({ precision: 0.5, removeRedundant: false, removeUnpainted: true });
    expect(app.prefs.get('pathfinderOptions').removeUnpainted).toBe(true);
    app.dialogs.form = async () => ({ __action: 'defaults' });
    await app.commands.run('pathfinder.options');
    expect(pathfinderOptions).toMatchObject({ precision: 0.028, removeRedundant: true, removeUnpainted: false });
  });
});

describe('compound shapes and trap in the app', () => {
  function setup() {
    const ed = app.newDocument({ name: 'Pathfinder' });
    const doc = ed.doc;
    const layer = doc.layers()[0];
    const a = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ffff00'), stroke: null });
    const b = createPath(rectangle(100, 0, 100, 100), true, { fill: solid('#000000'), stroke: null });
    const c = createPath(rectangle(50, 50, 100, 100), true, { fill: solid('#00ff00'), stroke: null });
    doc.transact('Build', () => [a, b, c].forEach((n) => doc.insert(n, layer.id)));
    return { ed, doc, layer, a, b, c };
  }

  it('lists the panel menu commands', () => {
    const panel = app.dock.panels.get('pathfinder');
    panel.ensureBuilt();
    for (const id of panel.menu().filter((x) => x !== '-')) expect(app.commands.get(id), id).toBeTruthy();
  });

  it('makes a live compound shape, changes its mode, releases and expands it', async () => {
    const { ed, doc, layer, a, c } = setup();
    ed.select([a.id, c.id]);
    await app.commands.run('pathfinder.makeCompoundShape', { kind: 'minusFront' });
    const g = doc.get(ed.topSelection()[0]);
    expect(isCompoundShape(g)).toBe(true);
    expect(compoundShapeMode(g)).toBe('minusFront');
    expect(g.children).toEqual([a.id, c.id]);
    // The live result is one shape: the front square cut from the back one.
    const art = liveArtwork(doc, g);
    expect(art.items.length).toBeGreaterThan(0);
    // Alt-click on another mode with the compound shape selected switches its mode.
    await app.commands.run('pathfinder.makeCompoundShape', { kind: 'intersect' });
    expect(compoundShapeMode(doc.get(g.id))).toBe('intersect');
    await app.commands.run('pathfinder.releaseCompoundShape');
    expect(doc.has(g.id)).toBe(false);
    expect(ed.topSelection().sort()).toEqual([a.id, c.id].sort());
    await app.commands.run('pathfinder.makeCompoundShape', { kind: 'unite' });
    await app.commands.run('pathfinder.expandCompoundShape');
    const out = doc.get(ed.topSelection()[0]);
    expect(out.type).toBe('path');
    expect(out.fill.color).toBe('#00ff00');
    expect(doc.get(layer.id).children).toContain(out.id);
  });

  it('adds trap strips above the selection', async () => {
    const { ed, doc, layer, a, b } = setup();
    ed.select([a.id, b.id]);
    app.dialogs.form = async () => ({ thickness: 1, tint: 40, reverse: false });
    await app.commands.run('pathfinder.trap');
    const g = doc.get(ed.topSelection()[0]);
    expect(g.type).toBe('group');
    expect(g.name).toBe('Traps');
    const strip = doc.get(g.children[0]);
    expect(strip.overprintFill).toBe(true);
    expect(strip.fill.color).toBe(tint('#ffff00', 0.4));
    expect(doc.get(layer.id).children.indexOf(g.id)).toBe(2);
  });

  it('applies Hard Mix as an effect on a group from the Effect menu', async () => {
    const { ed, doc, layer, a, c } = setup();
    let g;
    doc.transact('G', () => {
      g = createGroup([]);
      doc.insert(g, layer.id);
      doc.move(a.id, g.id);
      doc.move(c.id, g.id);
      doc.update(c.id, { fill: solid('#00ffff') });
    });
    ed.select([g.id]);
    await app.commands.run('effect.pathfinder.hardMix');
    expect(doc.get(g.id).effects.map((e) => e.type)).toEqual(['hardMix']);
    const art = liveArtwork(doc, doc.get(g.id));
    const root = art.items[0];
    const colors = root.children.map((id) => art.vdoc.get(id).fill.color).sort();
    expect(colors).toEqual(['#00ff00', '#00ffff', '#ffff00']);
  });
});
