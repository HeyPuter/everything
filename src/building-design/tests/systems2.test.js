import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { groupFromProject, placeGroup, membersOf } from '../src/core/groups.js';
import { upgradeDoc } from '../src/core/template.js';
import { Scene } from '../src/core/scene.js';

describe('load as group', () => {
  it('brings another project\'s first level in, centred, with the types it lacks', () => {
    const src = project();
    const w1 = src.wall([10000, 10000], [14000, 10000]);
    src.add({ kind: 'door', typeId: src.doc.all('doorType')[0].id, hostId: w1.id, t: 2000 });
    src.wall([10000, 20000], [14000, 20000], { levelId: src.L2.id });
    const custom = src.add({ kind: 'wallType', name: 'Imported Wall', layers: [{ function: 'structure', thickness: 300, materialId: 'mat-concrete' }] });
    src.doc.transact('t', () => src.doc.update(w1.id, { typeId: custom.id }));
    const { doc, L1 } = project();
    let type;
    doc.transact('load', () => (type = groupFromProject(src.doc, doc, 'Annex')));
    // The wall and its door; the second-level wall stays behind.
    expect(type.members).toHaveLength(2);
    expect(type.members[0].a).toEqual([-2000, 0]);
    expect(doc.get(custom.id).name).toBe('Imported Wall');
    let g;
    doc.transact('place', () => (g = placeGroup(doc, type, [500, 500], 0, L1.id)));
    const m = membersOf(doc, g.id);
    expect(m).toHaveLength(2);
    const door = m.find((x) => x.kind === 'door');
    expect(doc.get(door.hostId).kind).toBe('wall');
  });
});

describe('sprinklers and wires', () => {
  it('older projects receive component categories added since', () => {
    const { doc } = project();
    doc.transact('strip', () => {
      for (const t of doc.filter((x) => x.kind === 'componentType' && x.category === 'sprinklers')) doc.remove(t.id);
    });
    upgradeDoc(doc);
    expect(doc.has('cpt-sprinkler')).toBe(true);
  });

  it('draw wiring as an arc with conductor ticks', () => {
    const { doc, add, L1 } = project();
    const w = add({ kind: 'wire', levelId: L1.id, a: [0, 0], b: [3000, 0], ticks: 3, circuit: 'L1-4' });
    const plan = doc.all('plan').find((v) => v.levelId === L1.id);
    const g = new Scene(doc).planOf(plan, doc.get(w.id));
    // 24 arc segments and three ticks.
    expect(g.lines).toHaveLength(27);
    expect(g.texts[0].text).toBe('L1-4');
    expect(Math.max(...g.lines.map((l) => l.a[1]))).toBeGreaterThan(400);
  });
});
