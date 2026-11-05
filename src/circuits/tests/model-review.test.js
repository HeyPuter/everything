import { describe, it, expect, beforeEach } from 'vitest';
import { planSync, applySync } from '../src/model/sync.js';
import { Project, newProjectData, parseProject } from '../src/model/project.js';
import { findComponent, cloneDef } from '../src/model/library/builtin.js';
import fs from 'node:fs';
import path from 'node:path';
import { analyseBoard, itemDistance } from '../src/model/connectivity.js';
import { createKernel } from '../src/kernel/ops.js';
import { defaultRules } from '../src/model/schema.js';
import { buildNetlist } from '../src/model/netlist.js';
import { runErc } from '../src/model/erc.js';
import { portShape } from '../src/model/sch.js';
import { planAnnotation } from '../src/model/annotate.js';
import { placeFootprint } from '../src/model/place.js';
import { compFieldPlacement, flipComp } from '../src/model/pcb.js';
import { textStrokes } from '../src/render/font.js';
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

describe('netlist: sheet ports', () => {
  const res = cloneDef(findComponent('res-0603'));
  const lib = { [res.id]: res };
  const portW = (name) => portShape({ name, io: 'unspec' }).w;

  it('connects a wire at either end of a port, as the editor snaps to both', () => {
    const w = portW('DATA');
    // R1 pin 2 is at (200 mil, 0); the wire ends at the port's far end.
    const objects = [
      { id: 'p1', t: 'part', comp: res.id, designator: 'R1', x: 0, y: 0, rot: 0, uid: 'u1' },
      { id: 'w1', t: 'wire', pts: [mil(200), 0, mil(1000), 0] },
      { id: 'po', t: 'port', name: 'DATA', io: 'unspec', x: mil(1000) + w, y: 0, rot: 180 },
    ];
    const sheets = [{ id: 's', name: 'S', objects }];
    const nl = buildNetlist(sheets, lib);
    expect(nl.byPin.get('p1:2')).toBe('DATA');
    const erc = runErc(sheets, lib, nl);
    expect(erc.filter((e) => e.rule === 'dangling-wire')).toEqual([]);
    expect(erc.filter((e) => e.rule === 'unconnected-pin').map((e) => e.message)).toEqual([
      'Unconnected pin R1-1 (1)',
    ]);
  });
});

describe('annotation: custom designators', () => {
  const lib = { r: { prefix: 'R' }, u: { prefix: 'U' }, j: { prefix: 'J' } };
  const part = (id, designator, comp) => ({ id, t: 'part', comp, designator, x: 0, y: 0, rot: 0 });

  it('keeps unique designators that are not prefix + number', () => {
    const objects = [part('a', 'U1A', 'u'), part('b', 'J_PWR', 'j'), part('c', 'U?', 'u')];
    const plan = planAnnotation([{ id: 's', objects }], lib);
    expect(plan.map((p) => [p.id, p.to])).toEqual([['c', 'U1']]);
  });

  it('renumbers a repeated custom designator using its leading letters', () => {
    const objects = [part('a', 'U1A', 'u'), part('b', 'U1A', 'u')];
    const plan = planAnnotation([{ id: 's', objects }], lib);
    expect(plan.map((p) => [p.id, p.to])).toEqual([['b', 'U1']]);
  });
});

describe('board connectivity: pour holes', () => {
  const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
  const lib = {
    r: {
      id: 'r',
      symbol: { pins: [], graphics: [] },
      footprint: {
        name: 't',
        graphics: [],
        pads: [
          { num: '1', x: -mm(1.5), y: 0, shape: 'rect', w: mm(1), h: mm(1), side: 'top' },
          { num: '2', x: mm(1.5), y: 0, shape: 'rect', w: mm(1), h: mm(1), side: 'top' },
        ],
      },
    },
  };
  const doc = (objects) => ({
    id: 'b',
    kind: 'pcb',
    name: 'B',
    board: {
      outline: sq(0, 0, mm(30), mm(20)),
      origin: { x: 0, y: 0 },
      copper: 2,
      thickness: mm(1.6),
    },
    rules: defaultRules(),
    nets: { GND: {}, VCC: {} },
    objects,
  });

  it('connects rectangular pads to a same-net pour through thermal spokes', async () => {
    const kernel = await createKernel(
      fs.readFileSync(path.resolve(import.meta.dirname, '../src/kernel/kernel.wasm')),
    );
    for (const rot of [0, 45]) {
      const d = doc([
        {
          id: 'c1',
          t: 'comp',
          comp: 'r',
          x: mm(10),
          y: mm(10),
          rot,
          side: 'top',
          designator: 'R1',
          uid: 'u1',
          padNets: { 1: 'GND', 2: 'VCC' },
        },
        {
          id: 'c2',
          t: 'comp',
          comp: 'r',
          x: mm(20),
          y: mm(10),
          rot: 0,
          side: 'top',
          designator: 'R2',
          uid: 'u2',
          padNets: { 1: 'GND', 2: 'VCC' },
        },
        {
          id: 'p1',
          t: 'pour',
          layer: 'top',
          pts: sq(mm(1), mm(1), mm(29), mm(19)),
          net: 'GND',
          clearance: mm(0.3),
        },
      ]);
      const pourFills = await kernel.pours(d, lib);
      const a = analyseBoard(d, d.objects, lib, { pourFills });
      expect(a.ratsnest.map((r) => r.net)).toEqual(['VCC']);
      expect(a.shorts).toEqual([]);
    }
  });

  it('measures to the edges of a hole for copper inside it', () => {
    // A pour with a 2 mm square hole; a pad sits in the hole 0.25 mm from its edges.
    const pour = {
      kind: 'poly',
      pts: sq(0, 0, mm(10), mm(10)),
      holes: [sq(mm(4), mm(4), mm(6), mm(6))],
    };
    const pad = { kind: 'poly', pts: sq(mm(4.25), mm(4.25), mm(5.75), mm(5.75)) };
    expect(itemDistance(pad, pour)).toBeCloseTo(mm(0.25), -1);
    const via = { kind: 'disc', x: mm(5), y: mm(5), r: mm(0.5) };
    expect(itemDistance(via, pour)).toBeCloseTo(mm(0.5), -1);
    const track = { kind: 'seg', x1: mm(4.5), y1: mm(4.5), x2: mm(5.5), y2: mm(4.5), r: mm(0.1) };
    expect(itemDistance(track, pour)).toBeCloseTo(mm(0.4), -1);
    // A track crossing the copper between two holes touches it.
    const two = {
      kind: 'poly',
      pts: sq(0, 0, mm(10), mm(10)),
      holes: [sq(mm(2), mm(4), mm(4), mm(6)), sq(mm(6), mm(4), mm(8), mm(6))],
    };
    const across = { kind: 'seg', x1: mm(3), y1: mm(5), x2: mm(7), y2: mm(5), r: mm(0.1) };
    expect(itemDistance(across, two)).toBeLessThanOrEqual(0);
  });
});

describe('parseProject: damaged files', () => {
  it('opens a project with a damaged entry instead of failing as a whole', () => {
    const data = newProjectData('P');
    data.documents.push(null);
    data.documents[0].objects.push(
      { id: 'w1', t: 'wire' },
      { id: 'w2', t: 'wire', pts: [0, 0, 'x', 10] },
      { id: 'w3', t: 'wire', pts: [0, 0, mil(100), 0] },
    );
    data.documents[1].objects.push({ id: 'p1', t: 'pour', layer: 'top', pts: [0, 0, 1, 1] });
    const p = parseProject(JSON.parse(JSON.stringify(data)));
    expect(p.docs).toHaveLength(2);
    expect([...p.sheets[0].items()].map((o) => o.id)).toEqual(['w3']);
    expect([...p.boards[0].items()]).toEqual([]);
  });

  it('keeps objects whose id clashes with a document settings entry', () => {
    const data = newProjectData('P');
    data.documents[1].objects.push({
      id: 'board',
      t: 'track',
      layer: 'top',
      x1: 0,
      y1: 0,
      x2: mm(5),
      y2: 0,
      w: mm(0.25),
    });
    data.documents[0].objects.push({ id: 'sheet', t: 'junction', x: 0, y: 0 });
    const p = parseProject(JSON.parse(JSON.stringify(data)));
    const board = p.boards[0];
    expect(board.board.t).toBe('board');
    expect([...board.items()].map((o) => o.t)).toEqual(['track']);
    const hits = board.store.query({ minX: -mm(1), minY: -mm(1), maxX: mm(6), maxY: mm(1) });
    expect(hits.map((o) => o.t)).toEqual(['track']);
    expect([...p.sheets[0].items()].map((o) => o.t)).toEqual(['junction']);
    expect(p.sheets[0].sheet.t).toBe('sheet');
  });

  it('gives documents with the same id distinct ids', () => {
    const data = newProjectData('P');
    data.documents[1].id = data.documents[0].id;
    const p = parseProject(JSON.parse(JSON.stringify(data)));
    expect(new Set(p.docs.map((d) => d.id)).size).toBe(2);
    expect(p.getDoc(p.boards[0].id)).toBe(p.boards[0]);
  });
});

describe('footprint placement: text on the bottom side', () => {
  const def = (rot) => ({
    id: 'f',
    symbol: { pins: [], graphics: [] },
    footprint: {
      name: 'f',
      pads: [],
      graphics: [
        { t: 'text', x: mm(1), y: mm(0.5), text: 'AB', size: mm(1), rot, layer: 'topOverlay' },
      ],
    },
  });
  const strokes = (g) => textStrokes(g.text, g.x, g.y, g.size, g.rot, g.align, !!g.mirror).flat();

  for (const rot of [0, 90, 30, 270]) {
    it(`mirrors text at ${rot} degrees exactly like the rest of the footprint`, () => {
      for (const crot of [0, 90]) {
        const top = placeFootprint(def(rot), { x: 0, y: 0, rot: crot, side: 'top' }).graphics[0];
        const bot = placeFootprint(def(rot), { x: 0, y: 0, rot: -crot, side: 'bottom' })
          .graphics[0];
        expect(bot.layer).toBe('bottomOverlay');
        // Flipping a part at rot r to the bottom gives rot -r: the bottom copy is the
        // top copy mirrored across the y axis.
        const a = strokes(top),
          b = strokes(bot);
        expect(b.length).toBe(a.length);
        for (let i = 0; i < a.length; i += 2) {
          expect(b[i]).toBeCloseTo(-a[i], -1);
          expect(b[i + 1]).toBeCloseTo(a[i + 1], -1);
        }
      }
    });
  }
});

describe('board component fields', () => {
  // Footprint with its origin on pad 1 and pad 2 five millimetres up.
  const def = {
    footprint: {
      name: 'x',
      graphics: [],
      pads: [
        { num: '1', x: 0, y: 0, shape: 'rect', w: mm(1), h: mm(1), side: 'top' },
        { num: '2', x: 0, y: mm(5), shape: 'rect', w: mm(1), h: mm(1), side: 'top' },
      ],
    },
  };

  it('mirrors the default designator position with the part when flipped', () => {
    for (const rot of [0, 90, 180, 270, 30]) {
      const top = { t: 'comp', x: mm(10), y: mm(10), rot, side: 'top' };
      const bottom = flipComp(top);
      const ft = compFieldPlacement(top, 'designator', def);
      const fb = compFieldPlacement(bottom, 'designator', def);
      expect(fb.x - bottom.x).toBeCloseTo(-(ft.x - top.x), -1);
      expect(fb.y - bottom.y).toBeCloseTo(ft.y - top.y, -1);
      // The designator stays beyond pad 2 on both sides.
      const pad2 = placeFootprint(def, bottom).pads[1];
      expect(Math.hypot(fb.x - pad2.x, fb.y - pad2.y)).toBeLessThan(mm(1.5));
    }
  });
});
