// Schematic to board sync, round 2: nets whose names move between nets.
import { describe, it, expect, beforeEach } from 'vitest';
import { planSync, applySync } from '../src/model/sync.js';
import { Project, newProjectData } from '../src/model/project.js';
import { findComponent, cloneDef } from '../src/model/library/builtin.js';
import { pcbBounds } from '../src/model/pcb.js';
import { mil } from '../src/core/units.js';

let project, sheet, board;

beforeEach(() => {
  project = new Project(newProjectData('Sync'));
  project.ensureComponent(cloneDef(findComponent('res-0603')));
  sheet = project.sheets[0];
  board = project.boards[0];
  // R1 pin 2 (200, 0) wired to R2 pin 1 (800, 0).
  const part = { t: 'part', comp: 'res-0603', y: 0, rot: 0 };
  sheet.store.transact('setup', (s) => {
    s.add({ ...part, id: 'p1', designator: 'R1', value: '10k', x: 0, uid: 'u1' });
    s.add({ ...part, id: 'p2', designator: 'R2', value: '1k', x: mil(1000), uid: 'u2' });
    s.add({ id: 'w1', t: 'wire', pts: [mil(200), 0, mil(800), 0] });
  });
  applySync(board, planSync(project, board));
  const track = { t: 'track', layer: 'top', x1: 0, y1: 0, x2: 1000, y2: 0, w: 250000 };
  board.store.transact('route', (s) => {
    s.add({ ...track, id: 'joined', net: 'NetR1_2' });
    s.add({ ...track, id: 'stub', net: 'NetR2_2', y1: 5000, y2: 5000 });
    s.update('rules', (r) => ({
      ...r,
      netClasses: {
        ...r.netClasses,
        a: { ...r.netClasses?.Default, nets: ['NetR1_2'] },
        b: { ...r.netClasses?.Default, nets: ['NetR2_2'] },
      },
    }));
    s.update('nets', (n) => ({
      ...n,
      nets: { ...n.nets, NetR1_2: { note: 'joined' }, NetR2_2: { note: 'stub' } },
    }));
  });
});

describe('planSync after annotation shifts the designators', () => {
  it('moves routed copper, net classes and net settings along with every renamed net', () => {
    // R1 becomes R2 and R2 becomes R3: the name NetR2_2 passes from one net to the other.
    sheet.store.transact('annotate', (s) => {
      s.update('p1', { designator: 'R2' });
      s.update('p2', { designator: 'R3' });
    });
    const byUid = () =>
      Object.fromEntries([...board.items()].filter((o) => o.t === 'comp').map((c) => [c.uid, c]));
    expect(byUid().u1.padNets[2]).toBe('NetR1_2');
    expect(byUid().u2.padNets[2]).toBe('NetR2_2');
    applySync(board, planSync(project, board));
    const joined = byUid().u1.padNets[2];
    const stub = byUid().u2.padNets[2];
    expect(joined).toBe('NetR2_2');
    expect(stub).toBe('NetR3_2');
    expect(byUid().u2.padNets[1]).toBe(joined);
    expect(board.store.get('joined').net).toBe(joined);
    expect(board.store.get('stub').net).toBe(stub);
    expect(board.rules.netClasses.a.nets).toEqual([joined]);
    expect(board.rules.netClasses.b.nets).toEqual([stub]);
    expect(board.nets[joined]).toEqual({ note: 'joined' });
    expect(board.nets[stub]).toEqual({ note: 'stub' });
    expect(planSync(project, board)).toEqual([]);
  });

  it('follows two nets that swap names', () => {
    sheet.store.transact('annotate', (s) => {
      s.update('p1', { designator: 'R2' });
      s.update('p2', { designator: 'R1' });
    });
    applySync(board, planSync(project, board));
    const comp = (uid) => [...board.items()].find((o) => o.uid === uid);
    expect(board.store.get('joined').net).toBe(comp('u1').padNets[2]);
    expect(board.store.get('stub').net).toBe(comp('u2').padNets[2]);
    expect(board.store.get('joined').net).not.toBe(board.store.get('stub').net);
    expect(board.rules.netClasses.a.nets).toEqual([comp('u1').padNets[2]]);
    expect(board.rules.netClasses.b.nets).toEqual([comp('u2').padNets[2]]);
  });
});

describe('planSync placing new components', () => {
  it('does not stack a new part on parts still waiting beside the board', () => {
    const part = { t: 'part', comp: 'res-0603', y: mil(2000), rot: 0 };
    sheet.store.transact('add', (s) => {
      s.add({ ...part, id: 'p3', designator: 'R3', value: '47k', x: 0, uid: 'u3' });
      s.add({ ...part, id: 'p4', designator: 'R4', value: '47k', x: mil(1000), uid: 'u4' });
    });
    applySync(board, planSync(project, board));
    const comps = [...board.items()].filter((o) => o.t === 'comp');
    expect(comps).toHaveLength(4);
    const boxes = comps.map((c) => pcbBounds(c, project.library));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
        expect(apart, `${comps[i].designator} overlaps ${comps[j].designator}`).toBe(true);
      }
    }
  });
});
