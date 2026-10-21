import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { spaceLoads, disconnects, PERSON_SENSIBLE, PERSON_LATENT, ENVELOPE_COOLING } from '../src/core/spaces.js';
import { legendEntries } from '../src/core/annotate.js';

describe('spaces', () => {
  it('measure the enclosed area and estimate loads from the space type', () => {
    const { doc, add, box, L1 } = project();
    box(0, 0, 10000, 5000);
    const s = add({ kind: 'space', levelId: L1.id, at: [5000, 2500], name: 'Open office', spaceType: 'office', height: 3000 });
    const scene = new Scene(doc);
    const l = spaceLoads(s, scene.rooms.room(s));
    // Interior of a 10 x 5 m box of walls, less half the wall thickness all round.
    expect(l.area).toBeGreaterThan(45);
    expect(l.area).toBeLessThan(50);
    expect(l.volume).toBeCloseTo(l.area * 3, 6);
    expect(l.people).toBe(Math.round(l.area * 0.1));
    expect(l.cooling).toBeCloseTo(l.area * (9 + 12 + ENVELOPE_COOLING) + l.people * (PERSON_SENSIBLE + PERSON_LATENT), 6);
    const crowded = spaceLoads({ ...s, people: 30 }, scene.rooms.room(s));
    expect(crowded.people).toBe(30);
    expect(crowded.cooling).toBeGreaterThan(l.cooling);
  });

  it('are not measured outside enclosed areas', () => {
    const { doc, add, L1 } = project();
    const s = add({ kind: 'space', levelId: L1.id, at: [5000, 2500] });
    expect(spaceLoads(s, new Scene(doc).rooms.room(s))).toBeNull();
  });

  it('colour legends list zones and duct systems', () => {
    const { doc, add, L1 } = project();
    const z = add({ kind: 'zone', name: 'North wing', color: '#ff0000' });
    add({ kind: 'space', levelId: L1.id, at: [0, 0], zoneId: z.id });
    add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [0, 0], b: [1000, 0], offset: 2700, system: 'supply' });
    const view = doc.all('plan').find((v) => v.levelId === L1.id);
    expect(legendEntries(doc, view, 'zones')).toEqual([['North wing', [255, 0, 0]]]);
    expect(legendEntries(doc, view, 'ducts')).toHaveLength(1);
  });
});

describe('systems check', () => {
  it('reports open ends but not joints or ends at equipment', () => {
    const { doc, add, L1 } = project();
    add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [0, 0], b: [4000, 0], offset: 2700 });
    add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [4000, 0], b: [4000, 3000], offset: 2700 });
    add({ kind: 'component', typeId: 'cpt-diffuser', levelId: L1.id, at: [4000, 3000], rotation: 0 });
    const open = disconnects(doc);
    expect(open).toHaveLength(1);
    expect(open[0].at).toEqual([0, 0]);
  });
});
