import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { shearAlong } from '../src/ui/dialogs/transform-dialogs.js';
import { apply } from '../src/lib/matrix.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(rects = [[100, 100, 100, 50]]) {
  const app = await bootAppWithFeatures();
  app.newDocument();
  const doc = app.editor.doc;
  const ids = [];
  doc.transact('Rects', () => {
    for (const [x, y, w, hh] of rects) {
      const n = createPath(rectangle(x, y, w, hh), true, { fill: { type: 'solid', color: '#cc3333' } });
      doc.insert(n, app.editor.targetLayer().id);
      ids.push(n.id);
    }
  });
  app.editor.select(ids);
  return { app, doc, ids };
}

const dlg = () => document.querySelector('dialog[open]');
const field = (label) => {
  const l = [...dlg().querySelectorAll('label')].find((x) => x.textContent.trim() === label);
  return l && (document.getElementById(l.htmlFor) || l.querySelector('input'));
};
const type = (label, value) => {
  const el = field(label);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const check = (label, on = true) => {
  const el = field(label);
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const radio = (label) => {
  const r = [...dlg().querySelectorAll('label.radio')].find((x) => x.textContent.trim() === label).querySelector('input');
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
};
const button = (label) => [...dlg().querySelectorAll('button')].find((b) => b.textContent === label).click();

describe('Move dialog', () => {
  it('keeps Distance and Angle in step with Horizontal and Vertical', async () => {
    const { app } = await setup();
    const done = app.commands.run('object.transform.move');
    await tick();
    type('Horizontal', '30');
    type('Vertical', '-40');
    expect(parseFloat(field('Distance').value)).toBeCloseTo(50);
    // Up (negative y) is a positive angle.
    expect(parseFloat(field('Angle').value)).toBeCloseTo(53.13, 1);
    type('Distance', '10');
    type('Angle', '90');
    expect(parseFloat(field('Horizontal').value)).toBeCloseTo(0);
    expect(parseFloat(field('Vertical').value)).toBeCloseTo(-10);
    button('Cancel');
    await done;
  });

  it('moves by the polar offset', async () => {
    const { app, doc, ids } = await setup();
    const done = app.commands.run('object.transform.move');
    await tick();
    type('Distance', '20');
    type('Angle', '180');
    button('OK');
    await done;
    expect(nodeBounds(doc, doc.get(ids[0])).x).toBeCloseTo(80);
  });

  it('Transform Objects off leaves unpatterned objects alone', async () => {
    const { app, doc, ids } = await setup();
    const before = doc.get(ids[0]);
    const done = app.commands.run('object.transform.move');
    await tick();
    type('Horizontal', '50');
    check('Transform Objects', false);
    expect(field('Transform Patterns').disabled).toBe(true);
    button('OK');
    await done;
    expect(doc.get(ids[0])).toBe(before);
  });
});

describe('Scale dialog', () => {
  it('switches between uniform and non-uniform values', async () => {
    const { app, doc, ids } = await setup();
    const done = app.commands.run('object.transform.scale');
    await tick();
    expect(field('Horizontal').disabled).toBe(true);
    radio('Non-Uniform');
    expect(field('Horizontal').disabled).toBe(false);
    expect(field('Uniform scale').disabled).toBe(true);
    type('Horizontal', '200');
    type('Vertical', '100');
    button('OK');
    await done;
    const b = nodeBounds(doc, doc.get(ids[0]));
    expect(b.w).toBeCloseTo(200);
    expect(b.h).toBeCloseTo(50);
  });
});

describe('Shear dialog', () => {
  it('shears along an angled axis', async () => {
    // Shearing along a 90° axis moves points vertically by their horizontal offset.
    const m = shearAlong(45, 90, 0, 0);
    const p = apply(m, 10, 0);
    expect(p.x).toBeCloseTo(10);
    expect(Math.abs(p.y)).toBeCloseTo(10);
    const q = apply(shearAlong(45, 0, 0, 0), 0, 10);
    expect(q.x).toBeCloseTo(10);
    expect(q.y).toBeCloseTo(10);
  });

  it('enables the axis angle only for the Angle axis', async () => {
    const { app, doc, ids } = await setup();
    const before = nodeBounds(doc, doc.get(ids[0]));
    const done = app.commands.run('object.transform.shear');
    await tick();
    expect(field('Axis Angle').disabled).toBe(true);
    radio('Angle');
    expect(field('Axis Angle').disabled).toBe(false);
    type('Shear Angle', '30');
    type('Axis Angle', '90');
    button('OK');
    await done;
    const b = nodeBounds(doc, doc.get(ids[0]));
    expect(b.w).toBeCloseTo(before.w);
    expect(b.h).toBeGreaterThan(before.h + 10);
  });
});

describe('Transform Each dialog', () => {
  it('scales each object around the chosen reference point', async () => {
    const { app, doc, ids } = await setup([
      [0, 0, 100, 100],
      [200, 0, 100, 100],
    ]);
    const done = app.commands.run('object.transform.each');
    await tick();
    type('Horizontal', '50');
    // Top-left reference point.
    dlg().querySelector('.refpoint-cell[aria-label="Top left"]').click();
    button('OK');
    await done;
    const a = nodeBounds(doc, doc.get(ids[0]));
    const b = nodeBounds(doc, doc.get(ids[1]));
    expect([a.x, a.w, b.x, b.w]).toEqual([0, 50, 200, 50].map((v) => expect.closeTo(v, 5)));
  });

  it('sets an absolute size with constrained proportions', async () => {
    const { app, doc, ids } = await setup([
      [0, 0, 100, 50],
      [200, 0, 40, 20],
    ]);
    const done = app.commands.run('object.transform.each');
    await tick();
    radio('Absolute size');
    expect(field('Width').disabled).toBe(false);
    check('Constrain Proportions');
    type('Width', '60');
    // The first object is 2:1.
    expect(parseFloat(field('Height').value)).toBeCloseTo(30);
    button('OK');
    await done;
    for (const id of ids) {
      const b = nodeBounds(doc, doc.get(id));
      expect(b.w).toBeCloseTo(60);
      expect(b.h).toBeCloseTo(30);
    }
  });

  it('previews random values that match the applied result', async () => {
    const { app, doc, ids } = await setup([
      [0, 0, 100, 100],
      [200, 0, 100, 100],
    ]);
    const done = app.commands.run('object.transform.each');
    await tick();
    type('Horizontal', '50');
    check('Random');
    check('Preview');
    const previewed = ids.map((id) => nodeBounds(doc, doc.get(id)).w);
    button('OK');
    await done;
    expect(ids.map((id) => nodeBounds(doc, doc.get(id)).w)).toEqual(previewed.map((w) => expect.closeTo(w, 6)));
    expect(doc.undoStack.length).toBeGreaterThan(0);
  });
});

describe('Angle dial', () => {
  it('steps the Rotate angle with the keyboard and follows typing', async () => {
    const { app } = await setup();
    const done = app.commands.run('object.transform.rotate');
    await tick();
    const dial = dlg().querySelector('.angle-dial');
    expect(dial.getAttribute('role')).toBe('slider');
    dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    expect(parseFloat(field('Angle').value)).toBe(15);
    type('Angle', '90');
    expect(dial.getAttribute('aria-valuenow')).toBe('90');
    button('Cancel');
    await done;
  });
});
