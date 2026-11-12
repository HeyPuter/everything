import { it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { makeEnvelope } from '../src/features/envelope/envelope-ops.js';
import { makeBlend } from '../src/features/artboards/blend.js';
import { envelopeAt } from '../src/features/envelope/envelope-edit.js';

let app;

beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

const rect = (x, y, color) =>
  createPath(rectangle(x, y, 20, 20), true, { fill: { type: 'solid', color } });

it('in isolation mode the Selection tool passes over envelopes and blends outside the group', () => {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const a = rect(0, 100, '#f00');
  const b1 = rect(0, 300, '#f00');
  const b2 = rect(200, 300, '#00f');
  // Something inside the isolated group under the envelope, picked once the envelope is passed over.
  const g = createGroup([]);
  const under = createPath(rectangle(-10, 90, 40, 40), true, {
    fill: { type: 'solid', color: '#0f0' },
  });
  let env;
  let bl;
  doc.transact('x', () => {
    doc.insert(g, layer);
    doc.insert(under, g.id);
    doc.insert(createPath(rectangle(500, 500, 10, 10), true), g.id);
    doc.insert(a, layer);
    doc.insert(b1, layer);
    doc.insert(b2, layer);
    env = makeEnvelope(doc, [a.id], { mode: 'mesh', rows: 2, cols: 2 });
    bl = makeBlend(doc, [b1.id, b2.id]);
  });
  const ev = (x, y) => {
    const s = ed.view.toScreen(x, y);
    return { x, y, sx: s.x, sy: s.y };
  };
  app.setTool('selection');
  // Outside isolation both live objects are picked (through their generated artwork).
  expect(ed.selectionTarget(app.tool.hitAt(ev(10, 110)).id).id).toBe(env);
  expect(ed.selectionTarget(app.tool.hitAt(ev(100, 310)).id).id).toBe(bl);
  app.commands.run('object.isolate', { id: g.id });
  expect(ed.isolation).toBe(g.id);
  // The envelope is passed over: the object below it inside the group is picked.
  expect(app.tool.hitAt(ev(10, 110))?.id).toBe(under.id);
  // The blend's generated steps are not pickable either.
  expect(app.tool.hitAt(ev(100, 310))).toBeNull();
  // Envelope editing ignores the envelope outside the group too.
  expect(envelopeAt(ed, 10, 110)).toBeNull();
});

it('blend steps clipped away by a clipping mask are not clickable', () => {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const b1 = rect(0, 300, '#f00');
  const b2 = rect(200, 300, '#00f');
  const clip = createGroup([]);
  let bl;
  doc.transact('x', () => {
    doc.insert(clip, layer);
    doc.insert(b1, clip.id);
    doc.insert(b2, clip.id);
    bl = makeBlend(doc, [b1.id, b2.id]);
    // The mask shows only the left key and the first steps.
    doc.insert(createPath(rectangle(-10, 290, 60, 40), true), clip.id);
    doc.update(clip.id, { clip: true });
  });
  expect(doc.get(bl).parent).toBe(clip.id);
  app.setTool('selection');
  const ev = (x, y) => {
    const s = ed.view.toScreen(x, y);
    return { x, y, sx: s.x, sy: s.y };
  };
  expect(ed.selectionTarget(app.tool.hitAt(ev(40, 310)).id).id).toBe(clip.id);
  expect(app.tool.hitAt(ev(150, 310))).toBeNull();
});
