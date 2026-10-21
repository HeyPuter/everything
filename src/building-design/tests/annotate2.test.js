import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { createGroup, placeGroup, membersOf } from '../src/core/groups.js';
import { deleteElements } from '../src/core/ops.js';

describe('detail groups', () => {
  it('group view-specific elements and place copies in a view', () => {
    const { doc, add } = project();
    const view = doc.all('plan')[0];
    const l1 = add({ kind: 'detailLine', viewId: view.id, a: [0, 0], b: [1000, 0], style: 'thin' });
    const l2 = add({ kind: 'detailLine', viewId: view.id, a: [0, 0], b: [0, 1000], style: 'thin' });
    let g;
    doc.transact('g', () => (g = createGroup(doc, [l1.id, l2.id], { name: 'Detail A', levelId: view.levelId })));
    expect(g.viewId).toBe(view.id);
    const type = doc.get(g.typeId);
    expect(type.detail).toBe(true);
    const other = doc.all('plan')[1];
    let copy;
    doc.transact('p', () => (copy = placeGroup(doc, type, [5000, 5000], 0, other.levelId, other.id)));
    const members = membersOf(doc, copy.id);
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.viewId === other.id)).toBe(true);
  });

  it('keep model and view-specific elements apart', () => {
    const { doc, add, wall } = project();
    const view = doc.all('plan')[0];
    const w = wall([0, 0], [4000, 0]);
    const l = add({ kind: 'detailLine', viewId: view.id, a: [0, 0], b: [1000, 0], style: 'thin' });
    let g;
    doc.transact('g', () => (g = createGroup(doc, [w.id, l.id], { name: 'Mixed', levelId: view.levelId })));
    expect(g.viewId).toBeUndefined();
    expect(doc.get(l.id).groupId).toBeFalsy();
  });
});

describe('tread numbers and arc lengths', () => {
  it('number every tread but the last of each flight and go away with the stair', () => {
    const { doc, add, L1, L2 } = project();
    const st = add({ kind: 'stair', typeId: doc.all('stairType')[0].id, levelId: L1.id, topLevelId: L2.id, a: [0, 0], b: [0, 4000], width: 1000, shape: 'straight' });
    const view = doc.all('plan').find((v) => v.levelId === L1.id);
    const tn = add({ kind: 'treadNumbers', viewId: view.id, stairId: st.id, side: 'right', start: 1 });
    const scene = new Scene(doc);
    const g = scene.planOf(view, doc.get(tn.id));
    expect(g.texts.length).toBeGreaterThan(5);
    expect(g.texts[0].text).toBe('1');
    doc.transact('del', () => deleteElements(doc, [st.id]));
    expect(doc.has(tn.id)).toBe(false);
  });

  it('measure along an arc', () => {
    const { doc, add } = project();
    const view = doc.all('plan')[0];
    const arc = add({ kind: 'detailArc', viewId: view.id, c: [0, 0], r: 1000, a0: 0, a1: Math.PI / 2, style: 'thin' });
    const dim = add({ kind: 'radialDim', viewId: view.id, targetId: arc.id, c: [0, 0], r: 1000, arcLength: true, offset: 500, angle: 0 });
    const g = new Scene(doc).planOf(view, doc.get(dim.id));
    expect(g.texts.map((t) => t.text).join()).toContain('1571');
  });
});
