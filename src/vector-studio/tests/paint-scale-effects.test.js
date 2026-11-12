import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { transformNodes } from '../src/model/geometry.js';
import { scale, rotate } from '../src/lib/matrix.js';

const red = { type: 'solid', color: '#ff0000' };
const effects = [
  { type: 'dropShadow', mode: 'multiply', opacity: 0.75, x: 7, y: -3, blur: 5, color: '#000000' },
  { type: 'innerGlow', mode: 'screen', opacity: 0.75, blur: 4, color: '#ffffff', source: 'edge' },
  { type: 'outerGlow', mode: 'screen', opacity: 0.75, blur: 6, color: '#ffff00' },
  { type: 'blur', radius: 2 },
  { type: 'feather', radius: 3 },
];

async function setup(extra = {}) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const p = createPath(rectangle(0, 0, 100, 50), true, { fill: red, effects, ...extra });
  doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
  return { doc, id: p.id };
}

describe('Scale Strokes & Effects', () => {
  it('scales shadow, glow, blur and feather distances with the object', async () => {
    const { doc, id } = await setup();
    doc.transact('Scale', () => transformNodes(doc, [id], scale(2, 2), { scaleStrokes: true }));
    const [sh, ig, og, bl, fe] = doc.get(id).effects;
    expect([sh.x, sh.y, sh.blur]).toEqual([14, -6, 10]);
    expect(ig.blur).toBe(8);
    expect(og.blur).toBe(12);
    expect(bl.radius).toBe(4);
    expect(fe.radius).toBe(6);
    // Colors, opacity and modes stay.
    expect(sh.opacity).toBe(0.75);
    expect(og.color).toBe('#ffff00');
  });

  it('leaves effects alone when off, when only moving or rotating, and for other effect types', async () => {
    const { doc, id } = await setup({
      effects: [...effects, { type: 'roundCorners', radius: 10 }],
    });
    doc.transact('Scale', () => transformNodes(doc, [id], scale(2, 2), { scaleStrokes: false }));
    expect(doc.get(id).effects).toEqual([...effects, { type: 'roundCorners', radius: 10 }]);
    doc.transact('Rotate', () => transformNodes(doc, [id], rotate(30), { scaleStrokes: true }));
    expect(doc.get(id).effects[0]).toEqual(effects[0]);
  });

  it('scales the effects of groups and of extra fills and strokes', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    const doc = ed.doc;
    const p = createPath(rectangle(0, 0, 100, 50), true, {
      fill: red,
      appearance: [
        { type: 'fill', base: true },
        { type: 'fill', fill: red, effects: [{ type: 'blur', radius: 2 }] },
        { type: 'stroke', base: true },
      ],
    });
    const g = createGroup([p.id], { effects: [{ type: 'blur', radius: 3 }] });
    doc.transact('Add', () => {
      doc.insert(g, ed.targetLayer().id, Infinity, [p]);
    });
    doc.repairParents?.();
    doc.transact('Scale', () =>
      transformNodes(doc, [g.id], scale(0.5, 0.5), { scaleStrokes: true }),
    );
    expect(doc.get(g.id).effects[0].radius).toBe(1.5);
    expect(doc.get(p.id).appearance[1].effects[0].radius).toBe(1);
  });
});
