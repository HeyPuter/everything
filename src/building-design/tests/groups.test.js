import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { createGroup, placeGroup, propagateGroup, membersOf, ungroup, swapGroupType } from '../src/core/groups.js';
import { deleteElements, moveElements, copyElements, translation } from '../src/core/ops.js';

function room(p) {
  const r = p.box(0, 0, 3000, 2000);
  const door = p.add({ kind: 'door', typeId: 'dt-single-36', hostId: r[0].id, t: 1500 });
  return { walls: r, door };
}

describe('model groups', () => {
  it('groups elements with their hosted doors and places copies', () => {
    const p = project();
    const { walls, door } = room(p);
    const { doc } = p;
    let g;
    doc.transact('Group', () => (g = createGroup(doc, walls.map((w) => w.id), { name: 'Unit', levelId: p.L1.id })));
    expect(membersOf(doc, g.id).length).toBe(5);
    expect(doc.get(door.id).groupId).toBe(g.id);
    expect(g.at).toEqual([1500, 1000]);
    const type = doc.get(g.typeId);
    expect(type.members.length).toBe(5);
    let g2;
    doc.transact('Place', () => (g2 = placeGroup(doc, type, [11500, 1000], 0, p.L1.id)));
    const m2 = membersOf(doc, g2.id);
    expect(m2.length).toBe(5);
    const walls2 = m2.filter((m) => m.kind === 'wall');
    expect(walls2.some((w) => w.a[0] === 10000 && w.a[1] === 0)).toBe(true);
    // The copied door is hosted by a copied wall.
    const d2 = m2.find((m) => m.kind === 'door');
    expect(walls2.map((w) => w.id)).toContain(d2.hostId);
  });

  it('rotated instances turn their members', () => {
    const p = project();
    const { walls } = room(p);
    const { doc } = p;
    let g;
    doc.transact('Group', () => (g = createGroup(doc, walls.map((w) => w.id), { name: 'Unit', levelId: p.L1.id })));
    let g2;
    doc.transact('Place', () => (g2 = placeGroup(doc, doc.get(g.typeId), [0, 10000], 90, p.L1.id)));
    const xs = membersOf(doc, g2.id)
      .filter((m) => m.kind === 'wall')
      .flatMap((w) => [w.a[0], w.b[0]]);
    // A 3000 x 2000 room turned 90 degrees spans 2000 in x.
    expect(Math.round(Math.max(...xs) - Math.min(...xs))).toBe(2000);
  });

  it('editing one instance updates the others', () => {
    const p = project();
    const { walls } = room(p);
    const { doc } = p;
    let g;
    doc.transact('Group', () => (g = createGroup(doc, walls.map((w) => w.id), { name: 'Unit', levelId: p.L1.id })));
    let g2;
    doc.transact('Place', () => (g2 = placeGroup(doc, doc.get(g.typeId), [11500, 1000], 0, p.L1.id)));
    // Add a partition to the first instance.
    doc.transact('Edit', () => doc.add({ kind: 'wall', typeId: 'wt-generic', levelId: p.L1.id, a: [1000, 0], b: [1000, 2000], baseOffset: 0, topLevelId: p.L2.id, topOffset: 0, height: 3000, groupId: g.id }));
    let n;
    doc.transact('Finish', () => (n = propagateGroup(doc, g.id)));
    expect(n).toBe(1);
    expect(doc.has(g2.id)).toBe(true);
    const ws = membersOf(doc, g2.id).filter((m) => m.kind === 'wall');
    expect(ws.length).toBe(5);
    expect(ws.some((w) => w.a[0] === 11000 && w.b[0] === 11000)).toBe(true);
  });

  it('moves, copies and deletes groups as a whole', () => {
    const p = project();
    const { walls } = room(p);
    const { doc } = p;
    let g;
    doc.transact('Group', () => (g = createGroup(doc, walls.map((w) => w.id), { name: 'Unit', levelId: p.L1.id })));
    doc.transact('Move', () => moveElements(doc, [g.id], [500, 0]));
    expect(doc.get(walls[0].id).a).toEqual([500, 0]);
    expect(doc.get(g.id).at).toEqual([2000, 1000]);
    let ids;
    doc.transact('Copy', () => (ids = copyElements(doc, [g.id], translation([0, 5000]))));
    const copy = ids.map((id) => doc.get(id)).find((el) => el.kind === 'group');
    expect(copy).toBeTruthy();
    expect(membersOf(doc, copy.id).length).toBe(5);
    expect(membersOf(doc, g.id).length).toBe(5);
    doc.transact('Delete', () => deleteElements(doc, [g.id]));
    expect(doc.count('wall')).toBe(4);
    expect(doc.count('group')).toBe(1);
  });

  it('ungroups and swaps group types', () => {
    const p = project();
    const { walls } = room(p);
    const { doc } = p;
    let g;
    doc.transact('Group', () => (g = createGroup(doc, walls.map((w) => w.id), { name: 'Unit', levelId: p.L1.id })));
    const w = p.wall([0, 5000], [4000, 5000]);
    let other;
    doc.transact('Group', () => (other = createGroup(doc, [w.id], { name: 'Bar', levelId: p.L1.id })));
    doc.transact('Swap', () => swapGroupType(doc, [g.id], doc.get(other.typeId)));
    expect(membersOf(doc, g.id).length).toBe(1);
    doc.transact('Ungroup', () => ungroup(doc, g.id));
    expect(doc.has(g.id)).toBe(false);
    expect(doc.all('wall').every((x) => x.groupId !== g.id)).toBe(true);
  });

  it('deleting the last member removes the group', () => {
    const p = project();
    const w = p.wall([0, 0], [1000, 0]);
    const { doc } = p;
    let g;
    doc.transact('Group', () => (g = createGroup(doc, [w.id], { name: 'One', levelId: p.L1.id })));
    doc.transact('Delete', () => deleteElements(doc, [w.id]));
    expect(doc.has(g.id)).toBe(false);
  });
});
