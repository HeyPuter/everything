import { describe, it, expect, beforeEach } from 'vitest';
import { planSync, applySync } from '../src/model/sync.js';
import { Project, newProjectData } from '../src/model/project.js';
import { findComponent, cloneDef } from '../src/model/library/builtin.js';
import { analyseBoard } from '../src/model/connectivity.js';
import { mil, mm } from '../src/core/units.js';

describe('schematic to board sync: renamed nets', () => {
  let project, sheet, board;
  beforeEach(() => {
    project = new Project(newProjectData('Sync'));
    project.ensureComponent(cloneDef(findComponent('res-0603')));
    sheet = project.sheets[0];
    board = project.boards[0];
    sheet.store.transact('setup', (s) => {
      s.add({
        id: 'p1',
        t: 'part',
        comp: 'res-0603',
        designator: 'R1',
        value: '10k',
        x: 0,
        y: 0,
        rot: 0,
        uid: 'u1',
      });
      s.add({
        id: 'p2',
        t: 'part',
        comp: 'res-0603',
        designator: 'R2',
        value: '1k',
        x: mil(1000),
        y: 0,
        rot: 0,
        uid: 'u2',
      });
      s.add({ id: 'w1', t: 'wire', pts: [mil(200), 0, mil(800), 0] });
    });
    applySync(board, planSync(project, board));
  });

  const comp = (des) => [...board.items()].find((o) => o.t === 'comp' && o.designator === des);

  /** Routes a track between the two pads that share a net and returns the net. */
  const route = () => {
    const r1 = comp('R1'),
      r2 = comp('R2');
    board.store.transact('place', (s) => {
      s.update(r1.id, { x: mm(10), y: mm(10) });
      s.update(r2.id, { x: mm(20), y: mm(10) });
    });
    const net = comp('R1').padNets[2];
    expect(comp('R2').padNets[1]).toBe(net);
    // res-0603 pads sit at +/-0.8 mm.
    board.store.transact('route', (s) => {
      s.add({
        id: 't1',
        t: 'track',
        layer: 'top',
        x1: mm(10.8),
        y1: mm(10),
        x2: mm(19.2),
        y2: mm(10),
        w: mm(0.25),
        net,
      });
      s.add({
        id: 'v1',
        t: 'via',
        x: mm(15),
        y: mm(10),
        d: mm(0.6),
        drill: mm(0.3),
        from: 'top',
        to: 'bottom',
        net,
      });
    });
    return net;
  };

  it('moves routed copper to the new name when annotation renames an automatic net', () => {
    const before = route();
    expect(before).toBe('NetR1_2');
    const rules = board.rules;
    board.store.transact('class', (s) =>
      s.update('rules', {
        netClasses: { ...rules.netClasses, Power: { ...rules.netClasses.Power, nets: [before] } },
      }),
    );
    sheet.store.transact('annotate', (s) => s.update('p1', { designator: 'R0' }));
    const plan = planSync(project, board);
    const rename = plan.find((c) => c.kind === 'rename');
    expect(rename).toBeTruthy();
    expect(rename.label).toContain('NetR1_2');
    expect(rename.detail).toContain('NetR0_2');
    applySync(board, plan);
    expect(board.store.get('t1').net).toBe('NetR0_2');
    expect(board.store.get('v1').net).toBe('NetR0_2');
    expect(board.rules.netClasses.Power.nets).toEqual(['NetR0_2']);
    const a = analyseBoard(board, [...board.items()], project.library);
    expect(a.shorts).toEqual([]);
    expect(a.unrouted.get('NetR0_2') || 0).toBe(0);
    // Idempotent: nothing left to do.
    expect(planSync(project, board)).toEqual([]);
    // One undo step restores the old names.
    board.store.undo();
    expect(board.store.get('t1').net).toBe('NetR1_2');
  });

  it('keeps the net class assignment when a net is renamed', () => {
    const before = route();
    board.store.transact('class', (s) =>
      s.update('nets', { nets: { ...board.nets, [before]: { class: 'Power' } } }),
    );
    sheet.store.transact('label', (s) =>
      s.add({ id: 'lab', t: 'label', text: 'SIG', x: mil(500), y: 0, rot: 0 }),
    );
    applySync(board, planSync(project, board));
    expect(board.nets.SIG).toEqual({ class: 'Power' });
    expect(board.store.get('t1').net).toBe('SIG');
  });

  it('does not rename when the old net still exists (pads moved between nets)', () => {
    route();
    // R2 pin 1 moves off the net; NetR1_2 still exists (R1 pin 2 keeps it).
    sheet.store.transact('rewire', (s) => s.update('w1', { pts: [mil(200), 0, mil(500), 0] }));
    const plan = planSync(project, board);
    expect(plan.some((c) => c.kind === 'rename')).toBe(false);
  });
});
