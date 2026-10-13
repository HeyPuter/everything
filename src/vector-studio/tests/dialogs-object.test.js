import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { gradientSteps } from '../src/features/geometry/expand-gradient.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog[open]');
const rowsOf = () => [...dlg().querySelectorAll('.form-row')];
/** The nth input whose row label is `label`. */
const field = (label, nth = 0) => {
  const ls = [...dlg().querySelectorAll('label')].filter((x) => x.textContent.trim() === label);
  const l = ls[nth];
  return l && (document.getElementById(l.htmlFor) || l.querySelector('input'));
};
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const button = (label) => [...dlg().querySelectorAll('button')].find((b) => b.textContent === label).click();

const GRAD = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };

async function setup(style = { fill: { type: 'solid', color: '#cc3333' } }, rect = [0, 0, 100, 60]) {
  const app = await bootAppWithFeatures();
  app.newDocument();
  const doc = app.editor.doc;
  const n = createPath(rectangle(...rect), true, style);
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  app.editor.select([n.id]);
  return { app, doc, id: n.id };
}

describe('Expand gradients', () => {
  it('builds evenly colored bands across a linear gradient', () => {
    const steps = gradientSteps(GRAD, { x: 0, y: 0, w: 100, h: 60 }, 5);
    expect(steps).toHaveLength(5);
    expect(steps[0].paint.color).toBe('#000000');
    expect(steps[4].paint.color).toBe('#ffffff');
    // The middle band sits in the middle of the gradient.
    const xs = steps[2].anchors.map((a) => a.x);
    expect(Math.min(...xs)).toBeCloseTo(40);
    expect(Math.max(...xs)).toBeCloseTo(60);
  });

  it('builds nested rings for a radial gradient', () => {
    const steps = gradientSteps({ ...GRAD, type: 'radial' }, { x: 0, y: 0, w: 100, h: 100 }, 4);
    // A covering rectangle plus one ring per step.
    expect(steps).toHaveLength(5);
    expect(steps[1].paint.color).toBe('#ffffff');
    expect(steps[4].paint.color).toBe('#000000');
  });

  it('Object > Expand turns a gradient fill into clipped steps', async () => {
    const { app, doc, id } = await setup({ fill: GRAD, stroke: { type: 'solid', color: '#ff0000' }, strokeWidth: 0 });
    expect(app.commands.isEnabled('object.expand')).toBe(true);
    const done = app.commands.run('object.expand');
    await tick();
    const steps = field('Number of steps');
    expect(steps.disabled).toBe(false);
    type(steps, '8');
    button('OK');
    await done;
    expect(doc.get(id)).toBeUndefined();
    const g = doc.get(app.editor.topSelection()[0]);
    expect(g).toMatchObject({ type: 'group', clip: true });
    expect(g.children).toHaveLength(9);
    const b = nodeBounds(doc, doc.get(g.children[8]));
    expect([b.w, b.h]).toEqual([100, 60]);
  });

  it('can expand a gradient to a mesh', async () => {
    const { app, doc } = await setup({ fill: GRAD, stroke: null });
    const done = app.commands.run('object.expand');
    await tick();
    const mesh = [...dlg().querySelectorAll('label.radio')].find((l) => l.textContent === 'Gradient Mesh').querySelector('input');
    mesh.checked = true;
    mesh.dispatchEvent(new Event('change', { bubbles: true }));
    expect(field('Number of steps').disabled).toBe(true);
    button('OK');
    await done;
    const out = doc.get(app.editor.topSelection()[0]);
    expect(out.type).toBe('mesh');
  });
});

describe('Split Into Grid', () => {
  it('keeps Number, size, Gutter and Total in step', async () => {
    const { app } = await setup();
    const done = app.commands.run('path.splitGrid');
    await tick();
    expect(parseFloat(field('Total', 0).value)).toBeCloseTo(60);
    type(field('Number', 0), '3');
    type(field('Gutter', 0), '0');
    expect(parseFloat(field('Height').value)).toBeCloseTo(20);
    type(field('Height'), '10');
    expect(parseFloat(field('Total', 0).value)).toBeCloseTo(30);
    button('Cancel');
    await done;
    expect(rowsOf).toBeTruthy();
  });

  it('previews and splits with the sizes entered', async () => {
    const { app, doc, id } = await setup();
    const done = app.commands.run('path.splitGrid');
    await tick();
    type(field('Number', 0), '2');
    type(field('Gutter', 0), '0');
    type(field('Number', 1), '4');
    type(field('Gutter', 1), '0');
    type(field('Width'), '10');
    const prev = field('Preview');
    prev.checked = true;
    prev.dispatchEvent(new Event('change', { bubbles: true }));
    expect(doc.get(id)).toBeUndefined();
    button('OK');
    await done;
    const cells = app.editor.topSelection().map((i) => nodeBounds(doc, doc.get(i)));
    expect(cells).toHaveLength(8);
    expect(cells.every((c) => Math.abs(c.w - 10) < 1e-6 && Math.abs(c.h - 30) < 1e-6)).toBe(true);
    expect(doc.undoStack.length).toBe(2);
  });
});

describe('Gap Options', () => {
  it('sets the defaults only on Set Default and resets to them', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const ids = [];
    doc.transact('r', () => {
      for (const x of [0, 50]) {
        const n = createPath(rectangle(x, 0, 80, 80), true, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 1 });
        doc.insert(n, app.editor.targetLayer().id);
        ids.push(n.id);
      }
    });
    app.editor.select(ids);
    await app.commands.run('paintRegions.make');
    const done = app.commands.run('paintRegions.gapOptions');
    await tick();
    const d = dlg();
    const size = d.querySelector('select');
    size.value = 'large';
    size.dispatchEvent(new Event('change'));
    button('Set Default');
    expect(app.prefs.get('regionGaps').size).toBe('large');
    size.value = 'small';
    size.dispatchEvent(new Event('change'));
    button('Reset');
    expect(size.value).toBe('large');
    size.value = 'medium';
    size.dispatchEvent(new Event('change'));
    button('OK');
    await done;
    expect(app.prefs.get('regionGaps').size).toBe('large');
    const g = doc.get(app.editor.topSelection()[0]);
    expect(g.live.gaps.size).toBe('medium');
  });
});
